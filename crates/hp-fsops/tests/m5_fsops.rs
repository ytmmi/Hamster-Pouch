//! 源间复制/剪切/移动验收测试（RFC 0001 / commands-events.md §3.6）。
//!
//! 验证：内容哈希一致时 tag / 评分 / 相册成员关系不丢失；真实文件操作生成操作记录。

use std::fs;
use std::path::PathBuf;

use hp_core::{AddedBy, AlbumKind, FileId, FileIndexRow, MediaType, ThumbStatus, VerifyStatus};
use hp_fsops::FsOpsService;
use hp_store::RepoDb;

const REPO_ID: &str = "repo-1";

fn temp_dir(_tag: &str) -> PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
}

fn sample_file(id: &FileId, source_id: &hp_core::SourceId) -> FileIndexRow {
    FileIndexRow {
        id: id.clone(),
        source_id: source_id.clone(),
        relative_path: "pic.jpg".into(),
        media_type: MediaType::Image,
        subtype: None,
        content_hash: Some("hash-1".into()),
        content_hash_algo: Some("blake3".into()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size: 5,
        mtime: "2026-01-01T00:00:00Z".into(),
        scan_time: "2026-01-01T00:00:00Z".into(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::Generated,
        missing_status: 0,
        media_info_json: None,
    }
}

/// 建两个源 + 一个带 tag/评分/相册成员的文件，返回 (db, dir_a, dir_b, file_id, album_id)。
fn setup(tag: &str) -> (RepoDb, PathBuf, PathBuf, FileId, String) {
    let dir_a = temp_dir(&format!("{tag}-a"));
    let dir_b = temp_dir(&format!("{tag}-b"));
    let repo_path = temp_dir(&format!("{tag}-repo")).join("repo.sqlite3");
    let mut db = RepoDb::create(&repo_path, "仓库").expect("创建仓库失败");

    fs::write(dir_a.join("pic.jpg"), b"hello").expect("写入源文件失败");
    let src_a = db
        .mount_source(REPO_ID, dir_a.to_str().unwrap(), Some("A"), None)
        .expect("挂载源A失败");
    db.mount_source(REPO_ID, dir_b.to_str().unwrap(), Some("B"), None)
        .expect("挂载源B失败");

    let file_id = FileId::generate();
    db.upsert_file(&sample_file(&file_id, &src_a.id))
        .expect("写入文件索引失败");

    let tag = db.create_tag(REPO_ID, "风景", None).expect("创建 tag 失败");
    db.add_file_tag(file_id.as_str(), tag.id.as_str())
        .expect("建立 tag 关联失败");
    db.upsert_rating(file_id.as_str(), 4).expect("写入评分失败");
    let album = db
        .create_album(REPO_ID, "相册", AlbumKind::Fixed, None, None)
        .expect("创建相册失败");
    db.add_album_member(album.id.as_str(), file_id.as_str(), AddedBy::User, false)
        .expect("加入相册失败");

    (db, dir_a, dir_b, file_id, album.id.as_str().to_string())
}

#[test]
fn copy_preserves_associations_and_writes_op_record() {
    let (mut db, dir_a, dir_b, file_id, album_id) = setup("fsops-copy");
    let src_b = db
        .list_sources(REPO_ID)
        .expect("列出源失败")
        .into_iter()
        .find(|s| s.local_path == dir_b.to_str().unwrap())
        .expect("源B应存在");

    let out = FsOpsService
        .copy_files(
            &mut db,
            REPO_ID,
            &[file_id.as_str().to_string()],
            src_b.id.as_str(),
            None,
        )
        .expect("复制失败");

    assert_eq!(out.affected.len(), 1);
    assert!(!out.op_record_id.is_empty(), "必须返回操作记录 ID");
    assert!(dir_a.join("pic.jpg").exists(), "源文件应保留");
    assert!(dir_b.join("pic.jpg").exists(), "目标文件应生成");

    let new_id = out.affected[0].clone();
    assert_ne!(new_id, file_id, "复制应产生新文件 ID");
    let new_file = db.get_file(new_id.as_str()).expect("查询失败").unwrap();
    assert_eq!(new_file.source_id.as_str(), src_b.id.as_str());
    assert_eq!(new_file.content_hash.as_deref(), Some("hash-1"));

    // 解释数据继承（RFC 0001 决策 5）
    assert_eq!(db.list_tags_for_file(new_id.as_str()).expect("查询失败").len(), 1);
    assert_eq!(
        db.get_rating(new_id.as_str()).expect("查询失败").unwrap().rating,
        4
    );
    assert!(db
        .list_album_ids_for_file(new_id.as_str())
        .expect("查询失败")
        .contains(&album_id));

    let ops = db.list_ops_history(REPO_ID, 10).expect("查询操作历史失败");
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].op_type, "copy");
    assert_eq!(ops[0].id, out.op_record_id);
    db.close().expect("关闭失败");
}

#[test]
fn move_keeps_file_id_and_associations() {
    let (mut db, dir_a, dir_b, file_id, album_id) = setup("fsops-move");
    let src_b = db
        .list_sources(REPO_ID)
        .expect("列出源失败")
        .into_iter()
        .find(|s| s.local_path == dir_b.to_str().unwrap())
        .expect("源B应存在");

    let out = FsOpsService
        .move_files(
            &mut db,
            REPO_ID,
            &[file_id.as_str().to_string()],
            src_b.id.as_str(),
            None,
        )
        .expect("移动失败");

    assert_eq!(out.affected[0], file_id, "移动应保留原文件 ID");
    assert!(!dir_a.join("pic.jpg").exists(), "源位置文件应消失");
    assert!(dir_b.join("pic.jpg").exists(), "目标位置文件应存在");

    let moved = db.get_file(file_id.as_str()).expect("查询失败").unwrap();
    assert_eq!(moved.source_id.as_str(), src_b.id.as_str());
    assert_eq!(db.list_tags_for_file(file_id.as_str()).expect("查询失败").len(), 1);
    assert_eq!(
        db.get_rating(file_id.as_str()).expect("查询失败").unwrap().rating,
        4
    );
    assert!(db
        .list_album_ids_for_file(file_id.as_str())
        .expect("查询失败")
        .contains(&album_id));

    let ops = db.list_ops_history(REPO_ID, 10).expect("查询操作历史失败");
    assert_eq!(ops[0].op_type, "move");
    db.close().expect("关闭失败");
}

#[test]
fn move_to_same_location_is_rejected() {
    let (mut db, _dir_a, _dir_b, file_id, _album) = setup("fsops-same");
    let src_a = db
        .list_sources(REPO_ID)
        .expect("列出源失败")
        .into_iter()
        .find(|s| s.alias.as_deref() == Some("A"))
        .expect("源A应存在");

    let err = FsOpsService
        .move_files(
            &mut db,
            REPO_ID,
            &[file_id.as_str().to_string()],
            src_a.id.as_str(),
            None,
        )
        .expect_err("移动到原位置应被拒绝");
    assert!(matches!(err, hp_core::HpError::InvalidArgument(_)));
    db.close().expect("关闭失败");
}
