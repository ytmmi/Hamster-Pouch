//! M5 验收测试：仓库与布局预设的管理（重命名 / 删除 / 级联清理）。

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
fn layout_rename_and_delete() {
    let path = temp_global_path("layout-admin");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");
    g.save_panel_layout("repo-1", "旧名", r#"{"v":1}"#)
        .expect("保存失败");

    g.rename_panel_layout("repo-1", "旧名", "新名")
        .expect("重命名失败");
    assert!(g
        .get_panel_layout("repo-1", "旧名")
        .expect("查询失败")
        .is_none());
    let renamed = g
        .get_panel_layout("repo-1", "新名")
        .expect("查询失败")
        .expect("新名应存在");
    assert_eq!(renamed.layout_json, r#"{"v":1}"#);

    g.delete_panel_layout("repo-1", "新名").expect("删除失败");
    assert!(g
        .get_panel_layout("repo-1", "新名")
        .expect("查询失败")
        .is_none());
    assert!(g.delete_panel_layout("repo-1", "新名").is_err(), "重复删除应报错");
}

#[test]
fn repo_rename_and_delete_cascade() {
    let global_path = temp_global_path("repo-admin");
    let repo_path = temp_repo_path("r");
    RepoDb::create(&repo_path, "原仓库")
        .expect("创建仓库失败")
        .close()
        .expect("关闭失败");

    let id = {
        let mut g = GlobalDb::open(&global_path).expect("打开全局库失败");
        let row = g
            .register_repo("原仓库", repo_path.to_str().unwrap())
            .expect("注册失败");
        g.save_panel_layout(&row.id, "布局A", r#"{"v":1}"#)
            .expect("保存布局失败");
        g.rename_repo(&row.id, "新仓库").expect("重命名失败");
        row.id
    };

    {
        let g = GlobalDb::open(&global_path).expect("重开全局库失败");
        let row = g.get_repo(&id).expect("查询失败").expect("应存在");
        assert_eq!(row.name, "新仓库");
        assert_eq!(g.list_panel_layouts(&id).expect("列出布局失败").len(), 1);
    }

    // 删除仓库：注册行与关联布局一并清理。
    let mut g = GlobalDb::open(&global_path).expect("重开全局库失败");
    g.delete_repo(&id).expect("删除仓库失败");
    assert!(g.get_repo(&id).expect("查询失败").is_none());
    assert_eq!(g.list_panel_layouts(&id).expect("列出布局失败").len(), 0);
    assert!(g.delete_repo(&id).is_err(), "重复删除应报错");
}
