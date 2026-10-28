//! M3 验收测试：同步相册的镜像子树、拖拽移动/排序与取消同步（D128 / D129 / D130 / D132）。
//!
//! 覆盖五项用户口径：
//! 1. 「创建为相册（仅当前对象）」= 一次性快照（固定型，之后不跟随源）；
//! 2. 「创建为同步相册」= 持续同步 + 按源目录层级镜像子相册，位置与源一致；
//! 3. 源侧子相册被删后，下次同步重建（不是把已删的当"更新"）；
//! 4. 同步成员「只增不删、尊重手动编辑」；取消同步后变一般相册；
//! 5. 拖拽排序：同级重排只在目标父级内重编号，插到原位是空操作，禁环口径与移动一致。

use hp_album::AlbumService;
use hp_core::{
    AlbumKind, AlbumMediaType, FileId, FileIndexRow, HpError, MediaType, SourceId, ThumbStatus,
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

fn seed_file(db: &mut RepoDb, source_id: &SourceId, rel: &str, media_type: MediaType) -> FileId {
    let id = FileId::generate();
    let row = FileIndexRow {
        id: id.clone(),
        source_id: source_id.clone(),
        relative_path: rel.to_string(),
        media_type,
        marks: Vec::new(),
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

fn member_ids(db: &RepoDb, album_id: &str) -> Vec<String> {
    db.list_album_members(album_id)
        .expect("成员查询失败")
        .into_iter()
        .map(|m| m.file_id.as_str().to_string())
        .collect()
}

/// 「创建为相册（仅当前对象）」是快照：创建后源新增/删除都不影响它。
#[test]
fn snapshot_album_is_frozen_after_creation() {
    let mut db = temp_db("m3_snapshot");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let f1 = seed_file(&mut db, &s.id, "a/x.jpg", MediaType::Image);

    let album = AlbumService::create_snapshot(
        &mut db,
        "repo-1",
        "子目录快照",
        Some(AlbumMediaType::Image),
        None,
        s.id.as_str(),
        Some("a"),
        false,
    )
    .expect("创建快照相册失败");

    // 快照是固定型：没有同步规则，也不会被同步。
    assert_eq!(album.kind, AlbumKind::Fixed);
    assert!(
        db.get_sync_rule(album.id.as_str())
            .expect("查询规则失败")
            .is_none(),
        "快照相册不应有同步规则"
    );
    assert_eq!(
        member_ids(&db, album.id.as_str()),
        vec![f1.as_str().to_string()]
    );

    // 源新增文件，快照不变。
    let _f2 = seed_file(&mut db, &s.id, "a/y.jpg", MediaType::Image);
    AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect_err("固定型相册同步应报错");
    assert_eq!(member_ids(&db, album.id.as_str()).len(), 1);
}

/// 快照只收目录前缀内部的文件（`a/` 不应匹配 `ab/`）。
#[test]
fn snapshot_respects_dir_prefix_boundary() {
    let mut db = temp_db("m3_snapshot_prefix");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let inside = seed_file(&mut db, &s.id, "a/x.jpg", MediaType::Image);
    let _outside = seed_file(&mut db, &s.id, "b/y.jpg", MediaType::Image);
    let _sibling = seed_file(&mut db, &s.id, "ab/z.jpg", MediaType::Image);

    let album = AlbumService::create_snapshot(
        &mut db,
        "repo-1",
        "a 目录",
        Some(AlbumMediaType::Image),
        None,
        s.id.as_str(),
        Some("a"),
        false,
    )
    .expect("创建快照相册失败");

    assert_eq!(
        member_ids(&db, album.id.as_str()),
        vec![inside.as_str().to_string()],
        "只应收录 a/ 下的文件（ab/ 不能命中）"
    );
}

/// 同步相册按源目录层级镜像子相册，位置与源一致，成员落在各自子相册里。
#[test]
fn sync_album_mirrors_source_directory_tree() {
    let mut db = temp_db("m3_sync_tree");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let root_file = seed_file(&mut db, &s.id, "top.jpg", MediaType::Image);
    let a_file = seed_file(&mut db, &s.id, "a/a.jpg", MediaType::Image);
    let b_file = seed_file(&mut db, &s.id, "a/b/b.jpg", MediaType::Image);

    let album = AlbumService::create_sync_album(
        &mut db,
        "repo-1",
        "同步",
        Some(AlbumMediaType::Image),
        None,
        s.id.as_str(),
        None,
    )
    .expect("创建同步相册失败");

    // 同步根指向自己，且是持续同步的跟随源型（只增不删）。
    assert_eq!(album.kind, AlbumKind::FollowSource);
    assert_eq!(
        album
            .sync_root_album_id
            .as_ref()
            .map(|r| r.as_str().to_string()),
        Some(album.id.as_str().to_string()),
        "同步根必须指向自己"
    );

    AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");

    // 根相册只收根目录文件；子目录各自成相册。
    assert_eq!(
        member_ids(&db, album.id.as_str()),
        vec![root_file.as_str().to_string()]
    );

    let a = db
        .find_sync_mirror_album(album.id.as_str(), "a")
        .expect("查询失败")
        .expect("a 目录应被镜像");
    assert_eq!(a.name, "a");
    assert_eq!(
        a.parent_album_id.as_ref().map(|p| p.as_str().to_string()),
        Some(album.id.as_str().to_string())
    );
    assert_eq!(
        member_ids(&db, a.id.as_str()),
        vec![a_file.as_str().to_string()]
    );

    let b = db
        .find_sync_mirror_album(album.id.as_str(), "a/b")
        .expect("查询失败")
        .expect("a/b 目录应被镜像");
    assert_eq!(
        b.parent_album_id.as_ref().map(|p| p.as_str().to_string()),
        Some(a.id.as_str().to_string()),
        "镜像层级必须与源目录层级一致"
    );
    assert_eq!(
        member_ids(&db, b.id.as_str()),
        vec![b_file.as_str().to_string()]
    );
}

/// 镜像子相册被用户删掉后，下次同步重建（"源对应子相册被删除则新建"）。
#[test]
fn deleted_mirror_album_is_recreated_on_next_sync() {
    let mut db = temp_db("m3_sync_recreate");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let _f = seed_file(&mut db, &s.id, "a/x.jpg", MediaType::Image);

    let album = AlbumService::create_sync_album(
        &mut db,
        "repo-1",
        "同步",
        Some(AlbumMediaType::Image),
        None,
        s.id.as_str(),
        None,
    )
    .expect("创建同步相册失败");
    AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");

    let first = db
        .find_sync_mirror_album(album.id.as_str(), "a")
        .expect("查询失败")
        .expect("a 应被镜像");

    db.delete_album(first.id.as_str())
        .expect("删除镜像子相册失败");
    assert!(
        db.find_sync_mirror_album(album.id.as_str(), "a")
            .expect("查询失败")
            .is_none()
    );

    AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("再次同步失败");
    let rebuilt = db
        .find_sync_mirror_album(album.id.as_str(), "a")
        .expect("查询失败")
        .expect("a 应在下次同步重建");
    assert_ne!(
        rebuilt.id.as_str(),
        first.id.as_str(),
        "重建应产生新的相册 ID（不是复用已删的）"
    );
}

/// 镜像子相册被拖到别处后，同步会把它搬回源对应位置（"更新位置与源保持一致"）。
#[test]
fn moved_mirror_album_is_restored_to_source_position() {
    let mut db = temp_db("m3_sync_restore_pos");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let _f = seed_file(&mut db, &s.id, "a/x.jpg", MediaType::Image);
    let other = AlbumService::create_fixed(&mut db, "repo-1", "别处", None, None, &[])
        .expect("创建固定相册失败");

    let album = AlbumService::create_sync_album(
        &mut db,
        "repo-1",
        "同步",
        Some(AlbumMediaType::Image),
        None,
        s.id.as_str(),
        None,
    )
    .expect("创建同步相册失败");
    AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");
    let a = db
        .find_sync_mirror_album(album.id.as_str(), "a")
        .expect("查询失败")
        .expect("a 应被镜像");

    AlbumService::move_album(&mut db, a.id.as_str(), Some(other.id.as_str()))
        .expect("移动镜像子相册失败");

    AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("再次同步失败");
    let restored = db
        .get_album(a.id.as_str())
        .expect("查询失败")
        .expect("镜像子相册应仍在");
    assert_eq!(
        restored
            .parent_album_id
            .as_ref()
            .map(|p| p.as_str().to_string()),
        Some(album.id.as_str().to_string()),
        "同步应把被挪走的镜像子相册搬回源对应位置"
    );
}

/// 同步成员「只增不删」：源里文件消失后成员保留，用户手动移除的不会被加回。
#[test]
fn sync_is_add_only_and_respects_manual_removal() {
    let mut db = temp_db("m3_sync_add_only");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let f1 = seed_file(&mut db, &s.id, "a.jpg", MediaType::Image);
    let f2 = seed_file(&mut db, &s.id, "b.jpg", MediaType::Image);

    let album = AlbumService::create_sync_album(
        &mut db,
        "repo-1",
        "同步",
        Some(AlbumMediaType::Image),
        None,
        s.id.as_str(),
        None,
    )
    .expect("创建同步相册失败");
    AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");
    assert_eq!(member_ids(&db, album.id.as_str()).len(), 2);

    // 用户手动移除 f1：应留痕，下一次同步不得加回。
    AlbumService::remove_members(&mut db, album.id.as_str(), &[f1.as_str().to_string()])
        .expect("移除成员失败");
    assert_eq!(
        db.list_album_sync_exclusions(album.id.as_str())
            .expect("查询排除失败"),
        vec![f1.as_str().to_string()],
        "手动移除必须留痕"
    );

    AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");
    assert_eq!(
        member_ids(&db, album.id.as_str()),
        vec![f2.as_str().to_string()],
        "被手动移除的成员不应被同步加回"
    );

    // 用户手动加回 = 撤销排除。
    AlbumService::add_members(&mut db, album.id.as_str(), &[f1.as_str().to_string()])
        .expect("加回成员失败");
    assert!(
        db.list_album_sync_exclusions(album.id.as_str())
            .expect("查询排除失败")
            .is_empty(),
        "手动加回应撤销排除留痕"
    );

    // 源里文件不再匹配（媒体类型变化）→ 只增不删，成员保留。
    let mut row = db
        .get_file(f2.as_str())
        .expect("查询文件失败")
        .expect("文件应存在");
    row.media_type = MediaType::Audio;
    db.upsert_file(&row).expect("更新文件失败");
    let out = AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");
    assert_eq!(out.removed, 0, "只增不删：同步不移除成员");
    assert_eq!(member_ids(&db, album.id.as_str()).len(), 2);
}

/// 拖拽移动：拒绝自包含与互相包含（D130）。
#[test]
fn move_album_rejects_self_and_mutual_containment() {
    let mut db = temp_db("m3_move_cycle");
    let parent =
        AlbumService::create_fixed(&mut db, "repo-1", "父", None, None, &[]).expect("创建相册失败");
    let child =
        AlbumService::create_fixed(&mut db, "repo-1", "子", None, Some(parent.id.as_str()), &[])
            .expect("创建子相册失败");

    let err = AlbumService::move_album(&mut db, parent.id.as_str(), Some(parent.id.as_str()))
        .expect_err("自包含必须被拒绝");
    assert!(
        matches!(err, HpError::InvalidArgument(_)),
        "错误类型应为 InvalidArgument"
    );

    let err = AlbumService::move_album(&mut db, parent.id.as_str(), Some(child.id.as_str()))
        .expect_err("互相包含必须被拒绝");
    assert!(
        matches!(err, HpError::InvalidArgument(ref msg) if msg.contains("互相包含")),
        "错误文案应说明互相包含，实际：{err:?}"
    );

    // 合法移动：子相册移到顶层。
    let outcome =
        AlbumService::move_album(&mut db, child.id.as_str(), None).expect("移动到顶层失败");
    assert!(outcome.parent_changed);
    assert!(outcome.parent_album_id.is_none());
    assert!(
        db.get_album(child.id.as_str())
            .expect("查询失败")
            .expect("相册应存在")
            .parent_album_id
            .is_none()
    );

    // 同父重复移动：不写库，parent_changed = false。
    let outcome =
        AlbumService::move_album(&mut db, child.id.as_str(), None).expect("重复移动应成功但无变化");
    assert!(!outcome.parent_changed);
}

/// 取消同步：同步根与镜像子相册一起退化为一般相册，成员保留（D129）。
#[test]
fn unsync_releases_root_and_mirrors_but_keeps_members() {
    let mut db = temp_db("m3_unsync");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let a_file = seed_file(&mut db, &s.id, "a/x.jpg", MediaType::Image);

    let album = AlbumService::create_sync_album(
        &mut db,
        "repo-1",
        "同步",
        Some(AlbumMediaType::Image),
        None,
        s.id.as_str(),
        None,
    )
    .expect("创建同步相册失败");
    AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");
    let mirror = db
        .find_sync_mirror_album(album.id.as_str(), "a")
        .expect("查询失败")
        .expect("a 应被镜像");
    assert_eq!(
        member_ids(&db, mirror.id.as_str()),
        vec![a_file.as_str().to_string()]
    );

    // 固定型相册不能取消同步。
    let fixed = AlbumService::create_fixed(&mut db, "repo-1", "普通", None, None, &[])
        .expect("创建固定相册失败");
    let err = AlbumService::unsync_album(&mut db, fixed.id.as_str()).expect_err("非同步相册应报错");
    assert!(matches!(err, HpError::InvalidArgument(_)));

    let outcome = AlbumService::unsync_album(&mut db, album.id.as_str()).expect("取消同步失败");
    assert_eq!(outcome.released_children, 1, "应释放一个镜像子相册");

    for id in [album.id.as_str(), mirror.id.as_str()] {
        let a = db.get_album(id).expect("查询失败").expect("相册应保留");
        assert_eq!(a.kind, AlbumKind::Fixed, "取消同步后应变一般相册");
        assert!(a.sync_root_album_id.is_none(), "同步身份应被清除");
        assert!(a.sync_dir_path.is_none(), "镜像目录应被清除");
        assert!(
            db.get_sync_rule(id).expect("查询规则失败").is_none(),
            "同步规则应被删除"
        );
    }
    assert_eq!(
        member_ids(&db, mirror.id.as_str()),
        vec![a_file.as_str().to_string()],
        "取消同步只改变后续是否跟随，不动已有成员"
    );

    // 取消后源新增文件不再自动加入。
    let _new = seed_file(&mut db, &s.id, "a/y.jpg", MediaType::Image);
    AlbumService::sync(&mut db, "repo-1", mirror.id.as_str())
        .expect_err("取消同步后不再是跟随源相册");
    assert_eq!(member_ids(&db, mirror.id.as_str()).len(), 1);
}

/// 同步根同步时会把整棵树一起同步：一次调用就补齐所有层级的成员。
#[test]
fn syncing_root_syncs_whole_mirror_tree_in_one_call() {
    let mut db = temp_db("m3_sync_whole_tree");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let _a = seed_file(&mut db, &s.id, "a/a.jpg", MediaType::Image);
    let _b = seed_file(&mut db, &s.id, "a/b/b.jpg", MediaType::Image);

    let album = AlbumService::create_sync_album(
        &mut db,
        "repo-1",
        "同步",
        Some(AlbumMediaType::Image),
        None,
        s.id.as_str(),
        None,
    )
    .expect("创建同步相册失败");

    let out = AlbumService::sync(&mut db, "repo-1", album.id.as_str()).expect("同步失败");
    assert_eq!(out.added, 2, "根同步应把整棵树的成员一次补齐");

    let a = db
        .find_sync_mirror_album(album.id.as_str(), "a")
        .expect("查询失败")
        .expect("a 应被镜像");
    let b = db
        .find_sync_mirror_album(album.id.as_str(), "a/b")
        .expect("查询失败")
        .expect("a/b 应被镜像");
    assert_eq!(db.count_album_members(a.id.as_str()).expect("统计失败"), 1);
    assert_eq!(db.count_album_members(b.id.as_str()).expect("统计失败"), 1);
}

/// 新建相册默认排在同级末尾，读侧按 `sort_order` 升序（D132）。
#[test]
fn new_album_appends_to_sibling_tail() {
    let mut db = temp_db("m3_reorder_tail");
    let a =
        AlbumService::create_fixed(&mut db, "repo-1", "A", None, None, &[]).expect("创建 A 失败");
    let b =
        AlbumService::create_fixed(&mut db, "repo-1", "B", None, None, &[]).expect("创建 B 失败");
    let c =
        AlbumService::create_fixed(&mut db, "repo-1", "C", None, None, &[]).expect("创建 C 失败");

    let ids: Vec<String> = db
        .list_albums("repo-1")
        .expect("列出相册失败")
        .into_iter()
        .map(|album| album.id.as_str().to_string())
        .collect();
    assert_eq!(
        ids,
        vec![
            a.id.as_str().to_string(),
            b.id.as_str().to_string(),
            c.id.as_str().to_string()
        ],
        "新相册应依次追加到同级末尾"
    );
    assert_eq!(a.sort_order, 0);
    assert_eq!(b.sort_order, 1);
    assert_eq!(c.sort_order, 2);
}

/// 拖拽排序：插到某个兄弟之前，只重排目标父级的序号（D132）。
#[test]
fn move_album_ordered_inserts_before_sibling() {
    let mut db = temp_db("m3_reorder_insert");
    let a =
        AlbumService::create_fixed(&mut db, "repo-1", "A", None, None, &[]).expect("创建 A 失败");
    let b =
        AlbumService::create_fixed(&mut db, "repo-1", "B", None, None, &[]).expect("创建 B 失败");
    let c =
        AlbumService::create_fixed(&mut db, "repo-1", "C", None, None, &[]).expect("创建 C 失败");

    // C 插到 A 之前：期望 C, A, B
    let outcome =
        AlbumService::move_album_ordered(&mut db, c.id.as_str(), None, Some(a.id.as_str()))
            .expect("排序失败");
    assert!(outcome.order_changed, "插到别人之前应视为顺序变化");
    assert!(!outcome.parent_changed, "父级没变");

    let ids: Vec<String> = db
        .list_albums("repo-1")
        .expect("列出相册失败")
        .into_iter()
        .map(|album| album.id.as_str().to_string())
        .collect();
    assert_eq!(
        ids,
        vec![
            c.id.as_str().to_string(),
            a.id.as_str().to_string(),
            b.id.as_str().to_string()
        ],
        "C 应排到 A 之前"
    );

    // 再把它插回 B 之后（同级末尾）：期望 A, B, C
    let outcome =
        AlbumService::move_album_ordered(&mut db, c.id.as_str(), None, None).expect("排序失败");
    assert!(outcome.order_changed);
    let ids: Vec<String> = db
        .list_albums("repo-1")
        .expect("列出相册失败")
        .into_iter()
        .map(|album| album.id.as_str().to_string())
        .collect();
    assert_eq!(
        ids,
        vec![
            a.id.as_str().to_string(),
            b.id.as_str().to_string(),
            c.id.as_str().to_string()
        ],
        "落点为 null 应排到同级末尾"
    );
}

/// 插到自己原来的位置是空操作：`order_changed` / `parent_changed` 都为假，不写库（D132）。
#[test]
fn move_album_ordered_noop_keeps_order() {
    let mut db = temp_db("m3_reorder_noop");
    let a =
        AlbumService::create_fixed(&mut db, "repo-1", "A", None, None, &[]).expect("创建 A 失败");
    let _b =
        AlbumService::create_fixed(&mut db, "repo-1", "B", None, None, &[]).expect("创建 B 失败");

    // A 已经是同级第一个，插到 B 之前 = 原位。
    let outcome =
        AlbumService::move_album_ordered(&mut db, a.id.as_str(), None, Some(_b.id.as_str()))
            .expect("排序失败");
    assert!(!outcome.parent_changed, "父级未变");
    assert!(!outcome.order_changed, "插回原位不应算顺序变化");
}

/// 拖拽排序同时改变父级：插到另一个父级下的兄弟之前，会先换父再重排（D132）。
#[test]
fn move_album_ordered_changes_parent_and_order() {
    let mut db = temp_db("m3_reorder_cross_parent");
    let target = AlbumService::create_fixed(&mut db, "repo-1", "目标父", None, None, &[])
        .expect("创建父失败");
    let x = AlbumService::create_fixed(&mut db, "repo-1", "X", None, Some(target.id.as_str()), &[])
        .expect("创建 X 失败");
    let y = AlbumService::create_fixed(&mut db, "repo-1", "Y", None, Some(target.id.as_str()), &[])
        .expect("创建 Y 失败");
    let outsider =
        AlbumService::create_fixed(&mut db, "repo-1", "外来", None, None, &[]).expect("创建失败");

    // 把顶层相册插到 Y 之前 → 父级变成 target，顺序 target 下为 X, 外来, Y
    let outcome = AlbumService::move_album_ordered(
        &mut db,
        outsider.id.as_str(),
        Some(target.id.as_str()),
        Some(y.id.as_str()),
    )
    .expect("跨父级排序失败");
    assert!(outcome.parent_changed, "父级应变化");
    assert!(outcome.order_changed, "同级顺序也应变化");
    assert_eq!(
        outcome.parent_album_id.as_deref(),
        Some(target.id.as_str()),
        "返回的新父级应为目标父"
    );

    let children: Vec<String> = db
        .list_child_albums(target.id.as_str())
        .expect("列出子相册失败")
        .into_iter()
        .map(|album| album.id.as_str().to_string())
        .collect();
    assert_eq!(
        children,
        vec![
            x.id.as_str().to_string(),
            outsider.id.as_str().to_string(),
            y.id.as_str().to_string()
        ],
        "外来相册应插在 Y 之前、X 之后"
    );
}

/// 排序落点不在目标父级下时报错，而不是静默塞到别处（D132）。
#[test]
fn move_album_ordered_rejects_foreign_anchor() {
    let mut db = temp_db("m3_reorder_bad_anchor");
    let parent =
        AlbumService::create_fixed(&mut db, "repo-1", "父", None, None, &[]).expect("创建父失败");
    let child =
        AlbumService::create_fixed(&mut db, "repo-1", "子", None, Some(parent.id.as_str()), &[])
            .expect("创建子失败");
    let other =
        AlbumService::create_fixed(&mut db, "repo-1", "别的", None, None, &[]).expect("创建失败");

    // 落点 other 与目标父 parent 不在同一层
    let err = AlbumService::move_album_ordered(
        &mut db,
        child.id.as_str(),
        Some(parent.id.as_str()),
        Some(other.id.as_str()),
    )
    .expect_err("落点跨层必须被拒绝");
    assert!(
        matches!(err, HpError::InvalidArgument(ref msg) if msg.contains("排序落点")),
        "错误文案应说明落点不合法，实际：{err:?}"
    );
}

/// 拖拽排序不得形成互相包含（D132 沿用 D130 的禁环口径）。
#[test]
fn move_album_ordered_rejects_mutual_containment() {
    let mut db = temp_db("m3_reorder_cycle");
    let parent =
        AlbumService::create_fixed(&mut db, "repo-1", "父", None, None, &[]).expect("创建父失败");
    let child =
        AlbumService::create_fixed(&mut db, "repo-1", "子", None, Some(parent.id.as_str()), &[])
            .expect("创建子失败");

    let err = AlbumService::move_album_ordered(
        &mut db,
        parent.id.as_str(),
        Some(parent.id.as_str()),
        None,
    )
    .expect_err("自包含必须被拒绝");
    assert!(matches!(err, HpError::InvalidArgument(_)));

    let err = AlbumService::move_album_ordered(
        &mut db,
        parent.id.as_str(),
        Some(child.id.as_str()),
        None,
    )
    .expect_err("互相包含必须被拒绝");
    assert!(
        matches!(err, HpError::InvalidArgument(ref msg) if msg.contains("互相包含")),
        "错误文案应说明互相包含，实际：{err:?}"
    );
}
