//! 图片宽高进索引（缺陷 0043，迁移 0015）。
//!
//! 这一层只保证**存储语义**：写入、读回、以及"读不到尺寸时不得抹掉既有值"。
//! 尺寸怎么算出来的（EXIF 方向、读头）由 `hp-media` 的单测覆盖，
//! 扫描期怎么带进 `Computed` 由 `hp-scanner` 覆盖。

use hp_core::{FileId, FileIndexRow, MediaType, SourceId, ThumbStatus, VerifyStatus};
use hp_store::RepoDb;
use std::path::PathBuf;

fn temp_db(tag: &str) -> (PathBuf, RepoDb) {
    let dir = std::env::temp_dir().join(format!("hp-dims-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let path = dir.join("repo.sqlite3");
    let db = RepoDb::create(&path, "尺寸测试仓库").expect("创建仓库库失败");
    (dir, db)
}

fn row(
    id: &str,
    source_id: &SourceId,
    relative_path: &str,
    dims: Option<(u32, u32)>,
) -> FileIndexRow {
    FileIndexRow {
        id: FileId::from_raw(id.to_string()),
        source_id: source_id.clone(),
        relative_path: relative_path.to_string(),
        media_type: MediaType::Image,
        marks: Vec::new(),
        content_hash: Some(format!("hash-{relative_path}")),
        content_hash_algo: Some("blake3".into()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size: 1234,
        mtime: "1700000000000000000".into(),
        width: dims.map(|(w, _)| w),
        height: dims.map(|(_, h)| h),
        scan_time: "2026-11-11T00:00:00Z".into(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::NotGenerated,
        missing_status: 0,
        media_info_json: None,
    }
}

/// 宽高能落库、能读回，且**列序**与 `FILE_COLUMNS` 一致（读错列会表现为宽高互换）。
#[test]
fn dimensions_round_trip() {
    let (dir, mut db) = temp_db("roundtrip");
    let s = db
        .mount_source("repo-1", "C:/pics", None, None)
        .expect("挂载失败");
    db.upsert_file(&row("f1", &s.id, "a/竖拍.jpg", Some((3024, 4032))))
        .expect("写入失败");
    let got = db.get_file("f1").expect("查询失败").expect("应当存在");
    assert_eq!(got.width, Some(3024));
    assert_eq!(got.height, Some(4032));
    let _ = std::fs::remove_dir_all(&dir);
}

/// 非图片行没有宽高：列必须是 `NULL`，不是 0（0043 §2：NULL 才是"未知"口径）。
#[test]
fn non_image_rows_have_null_dimensions() {
    let (dir, mut db) = temp_db("null");
    let s = db
        .mount_source("repo-1", "C:/vids", None, None)
        .expect("挂载失败");
    let mut video = row("f2", &s.id, "b/clip.mp4", None);
    video.media_type = MediaType::Video;
    db.upsert_file(&video).expect("写入失败");
    let got = db.get_file("f2").expect("查询失败").expect("应当存在");
    assert_eq!(got.width, None);
    assert_eq!(got.height, None);
    let _ = std::fs::remove_dir_all(&dir);
}

/// **核心不变量**：重扫读不到尺寸时（`excluded.* == NULL`）不得抹掉既有宽高。
///
/// 否则一次"读头失败"的增量扫描就能把回填成果清零，用户看到的布局会在
/// "有宽高"与"估计值"之间反复跳。写入端用 `COALESCE(excluded, 既有)` 保证这点。
#[test]
fn rescan_without_dimensions_keeps_backfilled_values() {
    let (dir, mut db) = temp_db("coalesce");
    let s = db
        .mount_source("repo-1", "C:/fill", None, None)
        .expect("挂载失败");
    db.upsert_file(&row("f3", &s.id, "c/回填.jpg", Some((800, 600))))
        .expect("首次写入失败");
    // 第二次写入同路径、尺寸为 None（模拟读头失败/回填前后的一次重扫）。
    db.upsert_file(&row("f3", &s.id, "c/回填.jpg", None))
        .expect("二次写入失败");
    let got = db.get_file("f3").expect("查询失败").expect("应当存在");
    assert_eq!(got.width, Some(800), "重扫读不到尺寸时不该抹掉既有宽度");
    assert_eq!(got.height, Some(600), "重扫读不到尺寸时不该抹掉既有高度");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 扫描读到新尺寸时**要**覆盖旧值（图片被替换成另一个尺寸，布局必须跟着变）。
#[test]
fn rescan_with_dimensions_overwrites() {
    let (dir, mut db) = temp_db("overwrite");
    let s = db
        .mount_source("repo-1", "C:/swap", None, None)
        .expect("挂载失败");
    db.upsert_file(&row("f4", &s.id, "d/换图.jpg", Some((800, 600))))
        .expect("首次写入失败");
    db.upsert_file(&row("f4", &s.id, "d/换图.jpg", Some((1200, 900))))
        .expect("二次写入失败");
    let got = db.get_file("f4").expect("查询失败").expect("应当存在");
    assert_eq!((got.width, got.height), (Some(1200), Some(900)));
    let _ = std::fs::remove_dir_all(&dir);
}

/// 迁移之后 `PRAGMA user_version` 必须是 15（0015 是最后一条迁移）。
///
/// 版本号是**权威**（database-schema.md 第 5 节）；写入方（回填任务）会按它判断
/// 列是否存在，所以这里把它钉死在测试里。
#[test]
fn schema_version_bumped_to_15() {
    let (dir, db) = temp_db("version");
    assert_eq!(db.schema_version().expect("读版本失败"), 15);
    let meta = db.meta("schema_version").expect("读镜像失败");
    assert_eq!(
        meta.as_deref(),
        Some("15"),
        "repo_meta 镜像键必须与权威值同步"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
