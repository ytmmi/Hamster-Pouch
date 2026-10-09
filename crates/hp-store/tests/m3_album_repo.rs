//! M3 验收测试：相册仓储（albums / album_member / album_sync_rule / album_sync_state / ops_history）。
//! 对应 docs/roadmap/phase-1-top-level-plan.md 的 M3 范围。

use hp_core::{
    AddedBy, AlbumKind, AlbumMediaType, AlbumSyncRule, AlbumSyncState, FileId, FileIndexRow,
    MediaType, SourceId, SyncMode, ThumbStatus, VerifyStatus,
};
use hp_store::RepoDb;

fn temp_path(tag: &str) -> std::path::PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}.sqlite3"))
}

fn seed_file(db: &mut RepoDb, source_id: &SourceId, rel: &str) -> FileId {
    let id = FileId::generate();
    let row = FileIndexRow {
        id: id.clone(),
        source_id: source_id.clone(),
        relative_path: rel.to_string(),
        media_type: MediaType::Image,
        marks: Vec::new(),
        content_hash: Some("hash".to_string()),
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
fn album_crud_and_media_type_change() {
    let path = temp_path("album_crud");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");

    let album = db
        .create_album("repo-1", "旅行", AlbumKind::Fixed, None, None)
        .expect("创建相册失败");
    assert_eq!(album.media_type, None, "未指定属性时应继承（空值）");

    let got = db
        .get_album(album.id.as_str())
        .expect("查询失败")
        .expect("相册应存在");
    assert_eq!(got.name, "旅行");
    assert_eq!(got.kind, AlbumKind::Fixed);

    db.update_album_media_type(album.id.as_str(), Some(AlbumMediaType::Image))
        .expect("修改属性失败");
    let got = db
        .get_album(album.id.as_str())
        .expect("查询失败")
        .expect("相册应存在");
    assert_eq!(got.media_type, Some(AlbumMediaType::Image));

    // 嵌套相册
    let child = db
        .create_album("repo-1", "子相册", AlbumKind::Fixed, None, Some(album.id.as_str()))
        .expect("创建子相册失败");
    assert_eq!(
        child.parent_album_id.as_ref().map(|p| p.as_str()),
        Some(album.id.as_str())
    );

    let list = db.list_albums("repo-1").expect("列出相册失败");
    assert_eq!(list.len(), 2);

    db.delete_album(child.id.as_str()).expect("删除相册失败");
    assert!(db
        .get_album(child.id.as_str())
        .expect("查询失败")
        .is_none());

    db.close().expect("关闭失败");
}

#[test]
fn album_member_roundtrip() {
    let path = temp_path("album_member");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let f1 = seed_file(&mut db, &s.id, "a.jpg");
    let f2 = seed_file(&mut db, &s.id, "b.mp4");

    let album = db
        .create_album(
            "repo-1",
            "相册",
            AlbumKind::Fixed,
            Some(AlbumMediaType::Multimedia),
            None,
        )
        .expect("创建相册失败");

    db.add_album_member(album.id.as_str(), f1.as_str(), AddedBy::User, true)
        .expect("加成员失败");
    db.add_album_member(album.id.as_str(), f2.as_str(), AddedBy::SyncRule, false)
        .expect("加成员失败");
    // 幂等：重复加入应被忽略
    db.add_album_member(album.id.as_str(), f1.as_str(), AddedBy::User, true)
        .expect("重复加成员应忽略");

    assert_eq!(db.count_album_members(album.id.as_str()).expect("统计失败"), 2);

    let members = db.list_album_members(album.id.as_str()).expect("列出成员失败");
    assert_eq!(members.len(), 2);

    let m1 = db
        .get_album_member(album.id.as_str(), f1.as_str())
        .expect("查询成员失败")
        .expect("成员应存在");
    assert!(m1.pinned);
    assert_eq!(m1.added_by, AddedBy::User);

    db.set_member_pinned(album.id.as_str(), f1.as_str(), false)
        .expect("修改 pinned 失败");
    let m1 = db
        .get_album_member(album.id.as_str(), f1.as_str())
        .expect("查询成员失败")
        .expect("成员应存在");
    assert!(!m1.pinned);

    let removed = db
        .remove_album_members(album.id.as_str(), &[f1.as_str().to_string()])
        .expect("移除成员失败");
    assert_eq!(removed, 1);
    assert_eq!(db.count_album_members(album.id.as_str()).expect("统计失败"), 1);

    db.close().expect("关闭失败");
}

#[test]
fn sync_rule_and_state_roundtrip() {
    let path = temp_path("album_sync");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");

    let album = db
        .create_album(
            "repo-1",
            "跟随",
            AlbumKind::FollowSource,
            Some(AlbumMediaType::Image),
            None,
        )
        .expect("创建相册失败");

    let rule = AlbumSyncRule {
        album_id: album.id.clone(),
        source_id: s.id.clone(),
        include_subsources: true,
        media_type: AlbumMediaType::Image,
        filter_json: Some("{}".to_string()),
        sync_mode: SyncMode::Mirror,
        enabled: true,
    };
    db.upsert_sync_rule(&rule).expect("写入同步规则失败");
    let got = db
        .get_sync_rule(album.id.as_str())
        .expect("查询同步规则失败")
        .expect("同步规则应存在");
    assert_eq!(got, rule);

    let state = AlbumSyncState {
        album_id: album.id.clone(),
        source_id: s.id.clone(),
        last_synced_at: Some("2026-01-01T00:00:00Z".to_string()),
        last_scan_cursor: None,
        status: Some("ok".to_string()),
    };
    db.upsert_sync_state(&state).expect("写入同步状态失败");
    let got = db
        .get_sync_state(album.id.as_str())
        .expect("查询同步状态失败")
        .expect("同步状态应存在");
    assert_eq!(got, state);

    db.close().expect("关闭失败");
}

#[test]
fn ops_history_insert_returns_id() {
    let path = temp_path("album_ops");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");

    let id = db
        .insert_ops_history("repo-1", "album_media_change", "{\"removed\":[]}", None)
        .expect("写入操作历史失败");
    assert!(!id.is_empty(), "操作历史应返回记录 ID");

    db.close().expect("关闭失败");
}
