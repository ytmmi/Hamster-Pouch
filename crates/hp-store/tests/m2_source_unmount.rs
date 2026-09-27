//! "标记离线"底层能力回归（供**历史离线行**与恢复场景使用，RFC 0003 原文语义）。
//!
//! 注意：界面上的「卸载」现为**完全卸载**（删源 + 索引 + 派生数据），覆盖在
//! `m2_source_purge.rs`。本文件只守住不删数据的 `unmount_source` / `list_mounted_sources`
//! / 重新挂载复用这一组能力：
//!
//! - 标记离线后源从在线列表消失（旧实现所有查询都不看 `mounted`，刷新后源又冒出来）；
//! - 其文件不再出现在文件查询结果里；
//! - 文件索引与解释数据保留：重新挂载**同一路径**复用原源（同 id、同别名），不新建行。

use hp_core::{FileId, FileIndexRow, MediaType, SourceId, ThumbStatus, VerifyStatus};
use hp_store::RepoDb;

fn temp_path(tag: &str) -> std::path::PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}.sqlite3"))
}

fn file_row(source_id: &SourceId, relative_path: &str) -> FileIndexRow {
    FileIndexRow {
        id: FileId::generate(),
        source_id: source_id.clone(),
        relative_path: relative_path.to_string(),
        media_type: MediaType::Video,
        content_hash: Some(format!("hash-{relative_path}")),
        content_hash_algo: Some("blake3".into()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size: 10,
        mtime: "1".into(),
        scan_time: "2026-01-01T00:00:00Z".into(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::NotGenerated,
        missing_status: 0,
        media_info_json: None,
    }
}

#[test]
fn unmount_hides_source_from_lists_and_queries_but_keeps_index() {
    let path = temp_path("unmount");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");

    let s = db
        .mount_source("repo-1", "C:/Photos", Some("我的视频"), None)
        .expect("挂载失败");
    db.upsert_file(&file_row(&s.id, "clip.mp4"))
        .expect("写入文件失败");

    // 挂载后：在线列表有它，文件可查
    assert_eq!(
        db.list_mounted_sources("repo-1").expect("列出在线源失败").len(),
        1
    );
    assert_eq!(
        db.query_files("repo-1", &Default::default(), None, 100)
            .expect("查询文件失败")
            .0
            .len(),
        1
    );

    // 卸载
    db.unmount_source(s.id.as_str()).expect("卸载失败");

    // 1) 「已添加的媒体源」必须为空（这是本次修复的核心：旧实现刷新后源会重新出现）
    assert!(
        db.list_mounted_sources("repo-1")
            .expect("列出在线源失败")
            .is_empty(),
        "卸载后在线源列表必须为空"
    );

    // 2) 源行与文件索引仍保留（RFC 0003：仅标记离线）
    assert_eq!(
        db.list_sources("repo-1").expect("列出全部源失败").len(),
        1,
        "源行应保留（仅标记离线）"
    );
    assert!(!db
        .get_source(s.id.as_str())
        .expect("查询源失败")
        .expect("源应存在")
        .mounted);
    assert_eq!(
        db.list_files_by_source(s.id.as_str())
            .expect("列出源文件失败")
            .len(),
        1,
        "文件索引应保留"
    );

    // 3) 离线源的文件不得参与文件查询（否则界面上"卸载了还在"）
    assert!(
        db.query_files("repo-1", &Default::default(), None, 100)
            .expect("查询文件失败")
            .0
            .is_empty(),
        "离线源的文件不应出现在查询结果里"
    );

    // 4) 重新挂载同一路径（改写大小写与尾部分隔符，走路径归一化）→ 恢复原源
    let restored = db
        .mount_source("repo-1", "c:/photos/", None, None)
        .expect("重新挂载失败");
    assert_eq!(
        restored.id.as_str(),
        s.id.as_str(),
        "重新挂载同一路径应恢复原源 id，而不是新建一行"
    );
    assert!(restored.mounted, "恢复后应在线");
    assert_eq!(
        restored.alias.as_deref(),
        Some("我的视频"),
        "恢复应保留用户改过的别名"
    );
    assert_eq!(
        db.list_mounted_sources("repo-1").expect("列出在线源失败").len(),
        1,
        "恢复后在线列表应恰好一行（不产生重复源）"
    );
    assert_eq!(
        db.list_sources("repo-1").expect("列出全部源失败").len(),
        1,
        "恢复不应新增源行"
    );
    assert_eq!(
        db.query_files("repo-1", &Default::default(), None, 100)
            .expect("查询文件失败")
            .0
            .len(),
        1,
        "恢复后原文件索引应重新可见（解释数据不丢）"
    );
}

#[test]
fn remount_different_path_creates_new_source() {
    let path = temp_path("remount-other");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");

    let a = db
        .mount_source("repo-1", "C:/Photos", None, None)
        .expect("挂载失败");
    db.unmount_source(a.id.as_str()).expect("卸载失败");

    // 不同路径：应新建源，不能错误复用
    let b = db
        .mount_source("repo-1", "C:/Other", None, None)
        .expect("挂载失败");
    assert_ne!(a.id.as_str(), b.id.as_str());
    assert_eq!(
        db.list_mounted_sources("repo-1").expect("列出在线源失败").len(),
        1
    );
}
