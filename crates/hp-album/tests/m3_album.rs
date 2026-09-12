//! M3 验收测试：虚拟相册（固定型 / 跟随源型、媒体属性、同步规则）。
//! 对应 docs/roadmap/phase-1-top-level-plan.md 的 M3 验证线。

use hp_album::AlbumService;
use hp_core::{
    AddedBy, AlbumMediaType, FileId, FileIndexRow, HpError, MediaType, SourceId, SyncMode,
    ThumbStatus, VerifyStatus,
};
use hp_store::RepoDb;

fn temp_db(tag: &str) -> RepoDb {
    let path = tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}.sqlite3"));
    RepoDb::create(&path, "仓库").expect("创建仓库失败")
}

fn seed_file(db: &mut RepoDb, source_id: &SourceId, rel: &str, media_type: MediaType) -> FileId {
    let id = FileId::generate();
    let row = FileIndexRow {
        id: id.clone(),
        source_id: source_id.clone(),
        relative_path: rel.to_string(),
        media_type,
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

fn change_media_type(db: &mut RepoDb, file_id: &FileId, media_type: MediaType) {
    let mut row = db
        .get_file(file_id.as_str())
        .expect("查询文件失败")
        .expect("文件应存在");
    row.media_type = media_type;
    db.upsert_file(&row).expect("更新文件媒体类型失败");
}

/// 固定型相册不随源变化。
#[test]
fn fixed_album_does_not_follow_source() {
    let mut db = temp_db("m3_fixed");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let f1 = seed_file(&mut db, &s.id, "a.jpg", MediaType::Image);

    let album = AlbumService::create_fixed(
        &mut db,
        "repo-1",
        "固定",
        Some(AlbumMediaType::Image),
        None,
        &[f1.as_str().to_string()],
    )
    .expect("创建固定型相册失败");
    assert_eq!(db.count_album_members(album.id.as_str()).expect("统计失败"), 1);

    // 源新增文件，固定型不自动跟随
    let _f2 = seed_file(&mut db, &s.id, "b.jpg", MediaType::Image);
    assert_eq!(
        db.count_album_members(album.id.as_str()).expect("统计失败"),
        1,
        "固定型相册不应随源变化"
    );
}

/// 跟随型 add_only 只增量加入、不移除成员。
#[test]
fn follow_source_add_only_keeps_members() {
    let mut db = temp_db("m3_add_only");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let f1 = seed_file(&mut db, &s.id, "a.jpg", MediaType::Image);

    let album = AlbumService::create_follow_source(
        &mut db,
        "repo-1",
        "跟随",
        Some(AlbumMediaType::Image),
        None,
        s.id.as_str(),
        SyncMode::AddOnly,
        false,
        None,
    )
    .expect("创建跟随型相册失败");

    let out = AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");
    assert_eq!(out.added, 1);

    // 新增匹配文件 → 再次同步加入
    let _f2 = seed_file(&mut db, &s.id, "b.jpg", MediaType::Image);
    let out = AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");
    assert_eq!(out.added, 1);
    assert_eq!(db.count_album_members(album.id.as_str()).expect("统计失败"), 2);

    // 原成员不再匹配规则 → add_only 仍保留
    change_media_type(&mut db, &f1, MediaType::Audio);
    let out = AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");
    assert_eq!(out.removed, 0, "add_only 不应移除成员");
    assert_eq!(db.count_album_members(album.id.as_str()).expect("统计失败"), 2);
}

/// 跟随型 mirror 移除非 pinned 成员，pinned 成员保留。
#[test]
fn follow_source_mirror_removes_unmatched_but_keeps_pinned() {
    let mut db = temp_db("m3_mirror");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let f1 = seed_file(&mut db, &s.id, "a.jpg", MediaType::Image);
    let f2 = seed_file(&mut db, &s.id, "b.jpg", MediaType::Image);

    let album = AlbumService::create_follow_source(
        &mut db,
        "repo-1",
        "镜像",
        Some(AlbumMediaType::Image),
        None,
        s.id.as_str(),
        SyncMode::Mirror,
        false,
        None,
    )
    .expect("创建跟随型相册失败");
    AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");
    assert_eq!(db.count_album_members(album.id.as_str()).expect("统计失败"), 2);

    // 手动固定 f2
    db.set_member_pinned(album.id.as_str(), f2.as_str(), true)
        .expect("设置 pinned 失败");

    // 两个文件都不再匹配 image
    change_media_type(&mut db, &f1, MediaType::Audio);
    change_media_type(&mut db, &f2, MediaType::Audio);

    let out = AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");
    assert_eq!(out.removed, 1, "非 pinned 成员应被移除");
    assert_eq!(out.pinned_kept, 1, "pinned 成员应保留");
    assert_eq!(db.count_album_members(album.id.as_str()).expect("统计失败"), 1);
}

/// 相册只显示属性匹配类型的文件。
#[test]
fn album_only_shows_matching_media_type() {
    let mut db = temp_db("m3_visible");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let img = seed_file(&mut db, &s.id, "a.jpg", MediaType::Image);
    let vid = seed_file(&mut db, &s.id, "b.mp4", MediaType::Video);

    let album = AlbumService::create_fixed(
        &mut db,
        "repo-1",
        "图",
        Some(AlbumMediaType::Image),
        None,
        &[],
    )
    .expect("创建相册失败");
    AlbumService::add_members(&mut db, album.id.as_str(), &[img.as_str().to_string()])
        .expect("加成员失败");
    // 直接写入一个不匹配成员，模拟历史数据；可见成员应过滤掉它
    db.add_album_member(album.id.as_str(), vid.as_str(), AddedBy::User, false)
        .expect("写入成员失败");

    let visible = AlbumService::visible_members(&db, album.id.as_str()).expect("查询可见成员失败");
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].id.as_str(), img.as_str());
}

/// 修改媒体属性：移除不匹配成员并写操作历史。
#[test]
fn set_media_type_removes_mismatched_and_records_history() {
    let mut db = temp_db("m3_set_media");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let img = seed_file(&mut db, &s.id, "a.jpg", MediaType::Image);
    let vid = seed_file(&mut db, &s.id, "b.mp4", MediaType::Video);

    let album = AlbumService::create_fixed(
        &mut db,
        "repo-1",
        "全部",
        Some(AlbumMediaType::Multimedia),
        None,
        &[img.as_str().to_string(), vid.as_str().to_string()],
    )
    .expect("创建相册失败");
    assert_eq!(db.count_album_members(album.id.as_str()).expect("统计失败"), 2);

    let out = AlbumService::set_media_type(
        &mut db,
        "repo-1",
        album.id.as_str(),
        Some(AlbumMediaType::Image),
    )
    .expect("修改属性失败");
    assert_eq!(out.removed_count, 1, "video 成员应被移除");
    assert!(out.op_record_id.is_some(), "移除成员必须写操作历史");
    assert_eq!(db.count_album_members(album.id.as_str()).expect("统计失败"), 1);
}

/// 修改跟随型相册属性会联动更新同步规则的媒体过滤字段（D13）。
#[test]
fn set_media_type_updates_sync_rule_media_filter() {
    let mut db = temp_db("m3_rule_link");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");

    let album = AlbumService::create_follow_source(
        &mut db,
        "repo-1",
        "跟随",
        Some(AlbumMediaType::Multimedia),
        None,
        s.id.as_str(),
        SyncMode::AddOnly,
        false,
        None,
    )
    .expect("创建跟随型相册失败");
    let rule = db
        .get_sync_rule(album.id.as_str())
        .expect("查询规则失败")
        .expect("规则应存在");
    assert_eq!(rule.media_type, AlbumMediaType::Multimedia);

    AlbumService::set_media_type(
        &mut db,
        "repo-1",
        album.id.as_str(),
        Some(AlbumMediaType::Video),
    )
    .expect("修改属性失败");
    let rule = db
        .get_sync_rule(album.id.as_str())
        .expect("查询规则失败")
        .expect("规则应存在");
    assert_eq!(rule.media_type, AlbumMediaType::Video, "D13 应联动同步规则");
}

/// 手动加入不匹配类型的文件被拒绝。
#[test]
fn add_member_rejects_mismatched_type() {
    let mut db = temp_db("m3_reject");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let vid = seed_file(&mut db, &s.id, "b.mp4", MediaType::Video);

    let album = AlbumService::create_fixed(
        &mut db,
        "repo-1",
        "图",
        Some(AlbumMediaType::Image),
        None,
        &[],
    )
    .expect("创建相册失败");

    let err = AlbumService::add_members(&mut db, album.id.as_str(), &[vid.as_str().to_string()])
        .expect_err("不匹配类型应被拒绝");
    assert!(matches!(err, HpError::InvalidArgument(_)));
    assert_eq!(db.count_album_members(album.id.as_str()).expect("统计失败"), 0);
}

/// 嵌套相册默认继承父相册媒体属性，可覆盖。
#[test]
fn nested_album_inherits_parent_media_type() {
    let mut db = temp_db("m3_nested");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let img = seed_file(&mut db, &s.id, "a.jpg", MediaType::Image);
    let vid = seed_file(&mut db, &s.id, "b.mp4", MediaType::Video);

    let parent = AlbumService::create_fixed(
        &mut db,
        "repo-1",
        "父",
        Some(AlbumMediaType::Image),
        None,
        &[],
    )
    .expect("创建父相册失败");

    // 子相册属性为空 → 继承 image
    let child = AlbumService::create_fixed(
        &mut db,
        "repo-1",
        "子",
        None,
        Some(parent.id.as_str()),
        &[],
    )
    .expect("创建子相册失败");
    let out = AlbumService::add_members(&mut db, child.id.as_str(), &[img.as_str().to_string()])
        .expect("加成员失败");
    assert_eq!(out.added, 1);

    // 继承 image 属性 → video 应被拒
    let err = AlbumService::add_members(&mut db, child.id.as_str(), &[vid.as_str().to_string()])
        .expect_err("继承属性应拒绝 video");
    assert!(matches!(err, HpError::InvalidArgument(_)));
}
