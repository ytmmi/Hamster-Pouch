//! 实时监听接线（D9）的库层契约：按 `(源, 相对路径)` 定位索引行、只改缺失标记。
//!
//! 判定本身（磁盘现状 vs 索引 → 发哪条事件）是纯函数，单测在
//! `crates/hp-scanner/src/watcher.rs`；这里钉的是它依赖的**库层两个动作**。

use hp_core::{FileId, FileIndexRow, MediaType, ThumbStatus, VerifyStatus};
use hp_store::RepoDb;

fn temp_path(tag: &str) -> std::path::PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}.sqlite3"))
}

fn make_row(source_id: &hp_core::SourceId, rel: &str, size: i64, mtime: &str) -> FileIndexRow {
    FileIndexRow {
        id: FileId::generate(),
        source_id: source_id.clone(),
        relative_path: rel.to_string(),
        media_type: MediaType::Image,
        marks: Vec::new(),
        content_hash: Some(format!("h-{rel}")),
        content_hash_algo: Some("BLAKE3".to_string()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size,
        mtime: mtime.to_string(),
        scan_time: "t".to_string(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::NotGenerated,
        missing_status: 0,
        media_info_json: None,
    }
}

#[test]
fn find_file_by_source_path_and_missing_flag() {
    let path = temp_path("watch");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let row = make_row(&s.id, "子目录/图 1.jpg", 100, "111");
    db.upsert_file(&row).expect("写入文件索引失败");

    // 命中：返回的正是那一行（监听要靠 size/mtime 判"内容变了"）。
    let hit = db
        .find_file_by_source_path(s.id.as_str(), "子目录/图 1.jpg")
        .expect("查询失败")
        .expect("应命中");
    assert_eq!(hit.id.as_str(), row.id.as_str());
    assert_eq!((hit.size, hit.mtime.as_str()), (100, "111"));
    assert_eq!(hit.missing_status, 0);
    assert!(hit.marks.is_empty());

    // 未命中：新增文件走这条路（契约里没有 created 语义，本轮不发事件）。
    assert!(
        db.find_file_by_source_path(s.id.as_str(), "新增.jpg")
            .expect("查询失败")
            .is_none()
    );

    // 只动 missing_status：verify_status 保持扫描时的值，别的列也不许被顺带改。
    db.set_file_missing(row.id.as_str(), 1)
        .expect("更新缺失标记失败");
    let missing = db
        .find_file_by_source_path(s.id.as_str(), "子目录/图 1.jpg")
        .expect("查询失败")
        .expect("应命中");
    assert_eq!(missing.missing_status, 1);
    assert_eq!(missing.verify_status, VerifyStatus::Ok);
    assert_eq!((missing.size, missing.mtime.as_str()), (100, "111"));

    // 恢复：标记回 0。
    db.set_file_missing(row.id.as_str(), 0)
        .expect("更新缺失标记失败");
    let back = db
        .find_file_by_source_path(s.id.as_str(), "子目录/图 1.jpg")
        .expect("查询失败")
        .expect("应命中");
    assert_eq!(back.missing_status, 0);

    db.close().expect("关闭失败");
}

#[test]
fn same_relative_path_in_two_sources_is_disambiguated_by_source() {
    let path = temp_path("watch-two");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let a = db
        .mount_source("repo-1", "C:/a", None, None)
        .expect("挂载失败");
    let b = db
        .mount_source("repo-1", "C:/b", None, None)
        .expect("挂载失败");
    let row_a = make_row(&a.id, "1.jpg", 10, "1");
    let row_b = make_row(&b.id, "1.jpg", 20, "2");
    db.upsert_file(&row_a).expect("写入失败");
    db.upsert_file(&row_b).expect("写入失败");

    let hit_a = db
        .find_file_by_source_path(a.id.as_str(), "1.jpg")
        .expect("查询失败")
        .expect("应命中");
    let hit_b = db
        .find_file_by_source_path(b.id.as_str(), "1.jpg")
        .expect("查询失败")
        .expect("应命中");
    assert_eq!(hit_a.id.as_str(), row_a.id.as_str());
    assert_eq!(hit_b.id.as_str(), row_b.id.as_str());
    assert_eq!((hit_a.size, hit_b.size), (10, 20));

    db.close().expect("关闭失败");
}
