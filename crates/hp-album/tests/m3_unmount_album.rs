//! 卸载相关的相册侧不变量。
//!
//! 说明：**完全卸载**（删源 + 删索引 + 删派生数据）在 `hp-store::purge_source_data`
//! （`crates/hp-store/tests/m2_source_purge.rs` 覆盖）。本文件只管相册侧的两条读取规则：
//! 1. 离线媒体源的文件不出现在相册可见成员里（历史离线行兜底）；
//! 2. 跟随源相册的根源离线时，同步必须是空操作（否则 mirror 会误清空相册）。

use hp_album::AlbumService;
use hp_core::{
    AddedBy, AlbumKind, FileId, FileIndexRow, MediaType, SourceId, SyncMode, ThumbStatus,
    VerifyStatus,
};
use hp_store::RepoDb;

fn temp_db(tag: &str) -> RepoDb {
    let path = tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}.sqlite3"));
    RepoDb::create(&path, "仓库").expect("创建仓库失败")
}

fn seed_file(db: &mut RepoDb, source_id: &SourceId, rel: &str) -> FileId {
    let id = FileId::generate();
    let row = FileIndexRow {
        id: id.clone(),
        source_id: source_id.clone(),
        relative_path: rel.to_string(),
        media_type: MediaType::Image,
        subtype: None,
        content_hash: Some(format!("hash-{rel}")),
        content_hash_algo: Some("BLAKE3".to_string()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size: 1,
        mtime: "1".to_string(),
        scan_time: "t".to_string(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::NotGenerated,
        missing_status: 0,
        media_info_json: None,
    };
    db.upsert_file(&row).expect("写入文件索引失败");
    id
}

#[test]
fn albums_hide_files_of_offline_source() {
    let mut db = temp_db("offline-hide");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let f = seed_file(&mut db, &s.id, "a.jpg");
    let album = db
        .create_album("repo-1", "相册", AlbumKind::Fixed, None, None)
        .expect("建相册失败");
    db.add_album_member(album.id.as_str(), f.as_str(), AddedBy::User, false)
        .expect("加成员失败");

    assert_eq!(
        AlbumService::visible_members(&db, album.id.as_str())
            .expect("查可见成员失败")
            .len(),
        1
    );

    // 只标记离线、**不清理成员**：显示侧也必须过滤掉（历史离线行兜底）
    db.unmount_source(s.id.as_str()).expect("标记离线失败");
    assert!(
        AlbumService::visible_members(&db, album.id.as_str())
            .expect("查可见成员失败")
            .is_empty(),
        "离线源的文件不得出现在相册可见成员里"
    );
    assert_eq!(db.count_album_members(album.id.as_str()).unwrap(), 1);
}

#[test]
fn sync_is_noop_when_rule_source_is_offline() {
    let mut db = temp_db("offline-sync");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let _f1 = seed_file(&mut db, &s.id, "a.jpg");
    let f2 = seed_file(&mut db, &s.id, "b.jpg");

    let album = AlbumService::create_follow_source(
        &mut db,
        "repo-1",
        "跟随",
        None,
        None,
        s.id.as_str(),
        SyncMode::Mirror,
        false,
        None,
    )
    .expect("建跟随相册失败");
    // 手工加入一个成员（非同步来源），用于验证"根源离线时同步不得误删"
    db.add_album_member(album.id.as_str(), f2.as_str(), AddedBy::User, false)
        .expect("加成员失败");
    AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("首次同步失败");
    assert_eq!(
        db.count_album_members(album.id.as_str()).unwrap(),
        2,
        "同步应把源的 2 个文件加入相册（1 条手工成员与之一重合）"
    );

    db.unmount_source(s.id.as_str()).expect("标记离线失败");

    let outcome = AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步不应失败");
    assert_eq!(
        (outcome.added, outcome.removed),
        (0, 0),
        "根源离线时同步必须是空操作"
    );
    assert_eq!(
        db.count_album_members(album.id.as_str()).unwrap(),
        2,
        "成员不得被误删"
    );
    assert_eq!(
        AlbumService::visible_members(&db, album.id.as_str())
            .expect("查可见成员失败")
            .len(),
        0,
        "离线源的文件不显示"
    );
}
