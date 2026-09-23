//! 媒体源**完全卸载**回归：派生数据、文件索引、源记录一并删除；外键路径全部覆盖。
//!
//! 逐表核对的意义：`album_sync_rule` / `album_sync_state` / `sources.parent_source_id`
//! 都 `REFERENCES sources(id)`，漏掉任何一个都会让 `DELETE FROM sources` 直接
//! 报 `FOREIGN KEY constraint failed`（真正的"卸载失败"）。

use hp_core::{AlbumKind, FileId, FileIndexRow, MediaType, SourceId, SyncMode, ThumbStatus, VerifyStatus};
use hp_store::{PurgePhase, RepoDb};
use rusqlite::params;

fn temp_path(tag: &str) -> std::path::PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}.sqlite3"))
}

fn file_row(source_id: &SourceId, rel: &str) -> FileIndexRow {
    FileIndexRow {
        id: FileId::generate(),
        source_id: source_id.clone(),
        relative_path: rel.to_string(),
        media_type: MediaType::Image,
        content_hash: Some(format!("hash-{rel}")),
        content_hash_algo: Some("blake3".into()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size: 1,
        mtime: "1".into(),
        scan_time: "t".into(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::NotGenerated,
        missing_status: 0,
        media_info_json: None,
    }
}

/// 给文件挂上各类派生数据（人工 tag / 自动 tag / 评分 / 色彩 / AI 撤销）。
fn seed_derived(db: &mut RepoDb, path: &std::path::Path, file_id: &FileId, tag_name: &str) {
    let tag = db.create_tag("repo-1", tag_name, None).expect("建 tag 失败");
    db.add_file_tag(file_id.as_str(), tag.id.as_str())
        .expect("加人工 tag 失败");
    db.add_file_auto_tag(file_id.as_str(), tag.id.as_str(), Some(0.9), Some("model-x"))
        .expect("加自动 tag 失败");
    db.upsert_rating(file_id.as_str(), 5).expect("写评分失败");
    db.upsert_color_ref(file_id.as_str(), r##"["#112233"]"##)
        .expect("写色彩参考失败");

    let conn = rusqlite::Connection::open(path).expect("open raw");
    conn.execute(
        "INSERT INTO ai_tag_undo (id, repo_id, file_id, tag_id, prev_source, prev_confidence, prev_source_model, created_at)
         VALUES (?1, 'repo-1', ?2, ?3, 'user', 0.1, 'old', 't')",
        params![uuid::Uuid::new_v4().to_string(), file_id.as_str(), tag.id.as_str()],
    )
    .expect("写 ai_tag_undo 失败");
}

#[test]
fn complete_unmount_clears_every_source_derived_table() {
    let path = temp_path("purge-full");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");

    let target = db.mount_source("repo-1", "C:/target", None, None).expect("挂载失败");
    let other = db.mount_source("repo-1", "C:/other", None, None).expect("挂载失败");
    let f1 = file_row(&target.id, "a.jpg");
    let f2 = file_row(&target.id, "b.jpg");
    let keep = file_row(&other.id, "keep.jpg");
    for row in [&f1, &f2, &keep] {
        db.upsert_file(row).expect("写文件失败");
    }
    seed_derived(&mut db, &path, &f1.id, "tag-a");
    seed_derived(&mut db, &path, &f2.id, "tag-b");
    seed_derived(&mut db, &path, &keep.id, "tag-keep");

    let album = db
        .create_album("repo-1", "相册", AlbumKind::Fixed, None, None)
        .expect("建相册失败");
    for f in [&f1, &f2, &keep] {
        db.add_album_member(album.id.as_str(), f.id.as_str(), hp_core::AddedBy::User, false)
            .expect("加成员失败");
    }

    let counts = db.source_data_counts(target.id.as_str()).expect("清点失败");
    assert_eq!(counts.files, 2);
    assert_eq!(counts.album_members, 2);
    assert_eq!(counts.tags, 4, "两个文件各 1 人工 + 1 自动");
    assert_eq!(counts.ratings, 2);
    assert_eq!(counts.color_refs, 2);
    assert_eq!(counts.ai_undo, 2);

    let mut phases: Vec<PurgePhase> = Vec::new();
    let removed = db
        .purge_source_data(target.id.as_str(), &|| false, &mut |p, _, _| phases.push(p))
        .expect("完全卸载失败");
    assert_eq!(removed.counts.files, 2);
    assert_eq!(removed.counts.album_members, 2);
    assert_eq!(removed.counts.tags, 4);
    for expected in [
        PurgePhase::Counting,
        PurgePhase::SyncRules,
        PurgePhase::Children,
        PurgePhase::Derived,
        PurgePhase::Files,
        PurgePhase::Source,
    ] {
        assert!(phases.contains(&expected), "缺少阶段 {expected:?}：{phases:?}");
    }

    // 源记录、文件索引、派生数据全部消失
    assert!(db.get_source(target.id.as_str()).expect("查询源失败").is_none());
    assert!(db
        .get_file_by_path(target.id.as_str(), "a.jpg")
        .expect("查询失败")
        .is_none());
    let conn = rusqlite::Connection::open(&path).expect("open raw");
    let leftover: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM file_tags WHERE file_id IN (SELECT id FROM files WHERE source_id = ?1))
                  + (SELECT COUNT(*) FROM file_auto_tags WHERE file_id IN (SELECT id FROM files WHERE source_id = ?1))
                  + (SELECT COUNT(*) FROM ratings WHERE file_id IN (SELECT id FROM files WHERE source_id = ?1))
                  + (SELECT COUNT(*) FROM color_refs WHERE file_id IN (SELECT id FROM files WHERE source_id = ?1))
                  + (SELECT COUNT(*) FROM ai_tag_undo WHERE file_id IN (SELECT id FROM files WHERE source_id = ?1))
                  + (SELECT COUNT(*) FROM album_member WHERE file_id IN (SELECT id FROM files WHERE source_id = ?1))",
            params![target.id.as_str()],
            |r| r.get(0),
        )
        .expect("统计残留失败");
    assert_eq!(leftover, 0, "该源不应有任何残留派生数据");

    // 其他源的数据一行未动
    assert_eq!(db.count_files_by_source(other.id.as_str()).unwrap(), 1);
    assert_eq!(db.list_album_members(album.id.as_str()).unwrap().len(), 1);
    assert!(db.get_rating(keep.id.as_str()).unwrap().is_some());
    assert_eq!(db.list_file_tags(keep.id.as_str()).unwrap().len(), 1);
    assert!(
        db.get_rating(f1.id.as_str()).unwrap().is_none(),
        "被卸载文件的评分应随文件一起消失"
    );
}

#[test]
fn complete_unmount_handles_follow_album_and_nested_child_source() {
    // 这两条正是最容易漏掉的外键路径：
    // album_sync_rule/album_sync_state.source_id → sources，sources.parent_source_id → sources
    let path = temp_path("purge-fk");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");

    let parent = db.mount_source("repo-1", "C:/parent", None, None).expect("挂载失败");
    let child = db
        .mount_source("repo-1", "C:/parent/sub", None, Some(parent.id.as_str()))
        .expect("挂载子源失败");
    let child_file = file_row(&child.id, "c.jpg");
    db.upsert_file(&child_file).expect("写文件失败");

    // 跟随源相册（规则 + 状态都指向 parent）
    let album = db
        .create_album("repo-1", "跟随", AlbumKind::FollowSource, None, None)
        .expect("建相册失败");
    db.upsert_sync_rule(&hp_core::AlbumSyncRule {
        album_id: album.id.clone(),
        source_id: parent.id.clone(),
        include_subsources: true,
        media_type: hp_core::AlbumMediaType::Multimedia,
        filter_json: None,
        sync_mode: SyncMode::Mirror,
        enabled: true,
    })
    .expect("写同步规则失败");
    db.upsert_sync_state(&hp_core::AlbumSyncState {
        album_id: album.id.clone(),
        source_id: parent.id.clone(),
        last_synced_at: Some("t".into()),
        last_scan_cursor: None,
        status: Some("ok".into()),
    })
    .expect("写同步状态失败");

    let counts = db.source_data_counts(parent.id.as_str()).expect("清点失败");
    assert_eq!(counts.sync_albums, 1);
    assert_eq!(counts.child_sources, 1);

    let removed = db
        .purge_source_data(parent.id.as_str(), &|| false, &mut |_, _, _| {})
        .expect("完全卸载必须能穿过外键约束");
    assert_eq!(removed.counts.sync_albums, 1);
    assert_eq!(removed.counts.child_sources, 1);

    assert!(db.get_source(parent.id.as_str()).expect("查询失败").is_none());
    // 相册保留但降级为普通相册，且不再有指向已删除源的规则/状态
    let kept = db
        .get_album(album.id.as_str())
        .expect("查询相册失败")
        .expect("相册应保留");
    assert_eq!(kept.kind, AlbumKind::Fixed, "跟随相册应降级为普通相册");
    assert!(db.get_sync_rule(album.id.as_str()).expect("查询规则失败").is_none());
    // 子源保留并摘挂为顶层源（独立对象，不连带删除）
    let child_after = db
        .get_source(child.id.as_str())
        .expect("查询子源失败")
        .expect("子源应保留");
    assert!(child_after.parent_source_id.is_none(), "子源应被摘挂为顶层源");
    assert_eq!(db.count_files_by_source(child.id.as_str()).unwrap(), 1);
}

#[test]
fn complete_unmount_is_atomic_when_cancelled() {
    let path = temp_path("purge-cancel");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let target = db.mount_source("repo-1", "C:/target", None, None).expect("挂载失败");
    let f = file_row(&target.id, "a.jpg");
    db.upsert_file(&f).expect("写文件失败");
    seed_derived(&mut db, &path, &f.id, "tag-a");

    // 取消 → 整个事务回滚：源、索引、派生数据全部原样
    let removed = db
        .purge_source_data(target.id.as_str(), &|| true, &mut |_, _, _| {})
        .expect("取消不应报错");
    assert_eq!(
        removed.counts,
        hp_store::SourceDataCounts::default(),
        "取消应回滚，不产生任何删除"
    );
    assert!(db.get_source(target.id.as_str()).expect("查询源失败").is_some());
    assert!(db
        .get_file_by_path(target.id.as_str(), "a.jpg")
        .expect("查询失败")
        .is_some());

    // 再次执行（不取消）应能续完
    let removed = db
        .purge_source_data(target.id.as_str(), &|| false, &mut |_, _, _| {})
        .expect("完全卸载失败");
    assert_eq!(removed.counts.files, 1);
    assert!(db.get_source(target.id.as_str()).expect("查询源失败").is_none());
}

#[test]
fn purge_unknown_source_is_not_found() {
    let path = temp_path("purge-missing");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let err = db
        .purge_source_data("nope", &|| false, &mut |_, _, _| {})
        .expect_err("不存在的源应报错");
    assert!(matches!(err, hp_core::HpError::NotFound(_)));
}
