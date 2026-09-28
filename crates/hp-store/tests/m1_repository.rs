//! M1 验收测试：仓库创建/打开/关闭、注册表一致、仓库文件分离。
//! 对应 docs/roadmap/phase-1-top-level-plan.md 的 M1 验证线。

use std::path::PathBuf;

use hp_store::{GlobalDb, RepoDb};

fn temp_global_path(tag: &str) -> PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}-global.sqlite3"))
}

fn temp_repo_path(tag: &str) -> PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}-repo.sqlite3"))
}

#[test]
fn create_two_repos_files_are_separate() {
    let a = temp_repo_path("a");
    let b = temp_repo_path("b");

    let da = RepoDb::create(&a, "仓库A").expect("创建仓库A失败");
    let db = RepoDb::create(&b, "仓库B").expect("创建仓库B失败");

    assert_ne!(a, b, "两个仓库库文件必须是不同路径");
    assert!(a.exists() && b.exists(), "两个仓库库文件都应存在");

    assert_eq!(da.schema_version().expect("读版本失败"), 7);
    assert_eq!(db.meta("name").expect("读名失败").as_deref(), Some("仓库B"));
    da.close().expect("关闭A失败");
    db.close().expect("关闭B失败");
}

#[test]
fn create_existing_path_fails() {
    let path = temp_repo_path("dup");
    let db = RepoDb::create(&path, "仓库").expect("创建失败");
    db.close().expect("关闭失败");

    let err = RepoDb::create(&path, "仓库").expect_err("重复创建应失败");
    assert!(matches!(err, hp_core::HpError::AlreadyExists(_)));
}

#[test]
fn open_missing_fails() {
    let err = RepoDb::open(temp_repo_path("missing")).expect_err("打开不存在的仓库应失败");
    assert!(matches!(err, hp_core::HpError::NotFound(_)));
}

#[test]
fn registry_survives_reopen() {
    let global_path = temp_global_path("reg");
    let repo_a = temp_repo_path("a");
    let repo_b = temp_repo_path("b");
    RepoDb::create(&repo_a, "仓库A").expect("创建A失败").close().expect("关闭A失败");
    RepoDb::create(&repo_b, "仓库B").expect("创建B失败").close().expect("关闭B失败");

    let ids = {
        let mut g = GlobalDb::open(&global_path).expect("打开全局库失败");
        let ra = g.register_repo("仓库A", repo_a.to_str().unwrap()).expect("注册A失败");
        let rb = g.register_repo("仓库B", repo_b.to_str().unwrap()).expect("注册B失败");
        g.set_setting("theme", "dark").expect("写设置失败");
        (ra.id, rb.id)
    };

    let g = GlobalDb::open(&global_path).expect("重开全局库失败");
    let repos = g.list_repos().expect("列出仓库失败");
    assert_eq!(repos.len(), 2, "重开后注册表应保留两个仓库");
    assert!(repos.iter().any(|r| r.id == ids.0 && r.name == "仓库A"));
    assert!(repos.iter().any(|r| r.id == ids.1 && r.name == "仓库B"));
    assert_eq!(g.get_setting("theme").expect("读设置失败").as_deref(), Some("dark"));
    assert!(g.repo_exists(&ids.0).expect("查存在性失败"));
}

#[test]
fn repo_meta_roundtrip_and_version() {
    let path = temp_repo_path("meta");
    let db = RepoDb::create(&path, "元信息仓库").expect("创建失败");
    assert_eq!(db.schema_version().expect("读版本失败"), 7);
    assert_eq!(db.meta("name").expect("读名失败").as_deref(), Some("元信息仓库"));
    assert_eq!(
        db.meta("schema_version").expect("读版本失败").as_deref(),
        Some("7"),
        "镜像键必须等于权威版本（缺陷 0006）"
    );
    db.close().expect("关闭失败");

    let db = RepoDb::open(&path).expect("重开失败");
    assert_eq!(db.schema_version().expect("读版本失败"), 7);
    assert_eq!(db.meta("schema_version").expect("读版本失败").as_deref(), Some("7"));
    db.close().expect("关闭失败");
}

/// 缺陷 0006 回归：由**旧版本**创建的仓库库被当前版本打开后，
/// 权威版本（`PRAGMA user_version`）与镜像键（`repo_meta.schema_version`）必须一致。
///
/// 构造方式：先把库退化成 v6 形态（删掉 `repo/0007` 建的那条索引 + 两处版本一起退回 6），
/// 再让 `RepoDb::open` 应用 `repo/0007`。修复前镜像键会停留在 6（本测试即红），
/// 修复后两边都是 7。
#[test]
fn upgraded_repo_schema_version_mirror_does_not_diverge() {
    let path = temp_repo_path("meta-upgrade");
    RepoDb::create(&path, "旧版仓库").expect("创建失败").close().expect("关闭失败");

    {
        let conn = rusqlite::Connection::open(&path).expect("打开原始库失败");
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_album_member_file;
             PRAGMA user_version = 6;
             INSERT INTO repo_meta (key, value) VALUES ('schema_version', '6')
               ON CONFLICT(key) DO UPDATE SET value = '6';",
        )
        .expect("退化为 v6 形态失败");
    }

    let db = RepoDb::open(&path).expect("重开并升级失败");
    assert_eq!(db.schema_version().expect("读版本失败"), 7, "迁移应把权威版本升到 7");
    assert_eq!(
        db.meta("schema_version").expect("读镜像键失败").as_deref(),
        Some("7"),
        "升级后镜像键必须跟随权威版本，不得停留在建库时的 6（缺陷 0006）"
    );
    db.close().expect("关闭失败");
}

#[test]
fn settings_upsert() {
    let g = GlobalDb::open(temp_global_path("settings")).expect("打开全局库失败");
    g.set_setting("lang", "zh").expect("写失败");
    g.set_setting("lang", "en").expect("覆盖失败");
    assert_eq!(g.get_setting("lang").expect("读失败").as_deref(), Some("en"));
    assert_eq!(g.get_setting("missing").expect("读失败"), None);
}

#[test]
fn get_repo_by_id() {
    let global_path = temp_global_path("get");
    let repo_path = temp_repo_path("g");
    RepoDb::create(&repo_path, "仓库").expect("创建失败").close().expect("关闭失败");

    let id = {
        let mut g = GlobalDb::open(&global_path).expect("打开全局库失败");
        g.register_repo("仓库", repo_path.to_str().unwrap()).expect("注册失败").id
    };

    let g = GlobalDb::open(&global_path).expect("重开全局库失败");
    let row = g.get_repo(&id).expect("查询失败").expect("应存在");
    assert_eq!(row.name, "仓库");
    assert_eq!(row.repo_db_path, repo_path.to_str().unwrap());
    assert!(g.get_repo("不存在").expect("查询失败").is_none());
}
