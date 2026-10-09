//! 缺陷 0018（P0-2）回归：相册成员**分页**查询。
//!
//! 背景：`list_album_members` 没有上限，5 万成员的相册会一次性读进内存，
//! 前端还会为每个成员建一个 `IntersectionObserver`（`mediaPreviewCell.tsx`）。
//! 本文件断言新的键集游标分页在**不重不漏**、过滤语义、游标健壮性上成立。

use hp_core::{
    AddedBy, AlbumKind, AlbumMediaType, FileId, FileIndexRow, MediaType, SourceId, ThumbStatus,
    VerifyStatus,
};
use hp_store::{AlbumMemberCursor, RepoDb};

fn temp_path(tag: &str) -> std::path::PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}.sqlite3"))
}

fn seed_file(db: &mut RepoDb, source_id: &SourceId, rel: &str, media: MediaType) -> FileId {
    let id = FileId::generate();
    let row = FileIndexRow {
        id: id.clone(),
        source_id: source_id.clone(),
        relative_path: rel.to_string(),
        media_type: media,
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

/// 建一个含 `count` 张图片的相册，返回 (repo 相册 id, 全部 file id 顺序)。
fn seed_album(db: &mut RepoDb, count: usize) -> (String, Vec<String>) {
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let album = db
        .create_album(
            "repo-1",
            "大相册",
            AlbumKind::Fixed,
            Some(AlbumMediaType::Multimedia),
            None,
        )
        .expect("创建相册失败");
    let mut ids = Vec::new();
    for i in 0..count {
        let f = seed_file(db, &s.id, &format!("p{i:04}.jpg"), MediaType::Image);
        db.add_album_member(album.id.as_str(), f.as_str(), AddedBy::User, false)
            .expect("加成员失败");
        ids.push(f.as_str().to_string());
    }
    (album.id.as_str().to_string(), ids)
}

/// **核心不变量**：翻完所有页得到的集合，与一次性全量列出**完全相同**（不重不漏）。
#[test]
fn paging_covers_every_member_exactly_once() {
    let path = temp_path("album_page_all");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let (album_id, all_ids) = seed_album(&mut db, 250);

    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<AlbumMemberCursor> = None;
    let mut pages = 0;
    loop {
        let (rows, next) = db
            .query_album_members_page(&album_id, true, true, true, cursor.as_ref(), 40)
            .expect("分页查询失败");
        assert!(rows.len() <= 40, "单页不得超过请求的 limit");
        seen.extend(rows.iter().map(|r| r.id.as_str().to_string()));
        pages += 1;
        match next {
            Some(c) => cursor = Some(c),
            None => break,
        }
        assert!(pages < 100, "翻页次数异常，可能有环");
    }

    assert_eq!(pages, 7, "250 项按 40/页应当是 7 页（6 满页 + 1 个 10 项尾页）");
    assert_eq!(seen.len(), 250, "翻页总数必须等于成员总数");
    let mut uniq = seen.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(uniq.len(), 250, "不得有重复项");
    let mut expect = all_ids.clone();
    expect.sort();
    assert_eq!(uniq, expect, "翻页得到的集合必须与全量列出完全一致");

    db.close().expect("关闭失败");
}

/// 排序键是 `(added_at, file_id)`：`added_at` 同值（同一批加入）时，
/// 必须靠 `file_id` 决出全序，否则翻页会漏项或重复。
#[test]
fn paging_is_stable_when_added_at_is_identical() {
    let path = temp_path("album_page_ties");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    // 这批成员是在同一秒内加进去的，`added_at` 极可能同值。
    let (album_id, _) = seed_album(&mut db, 120);

    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<AlbumMemberCursor> = None;
    loop {
        let (rows, next) = db
            .query_album_members_page(&album_id, true, true, true, cursor.as_ref(), 7)
            .expect("分页查询失败");
        seen.extend(rows.iter().map(|r| r.id.as_str().to_string()));
        match next {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    let mut uniq = seen.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(seen.len(), 120, "同值 added_at 下也必须不重不漏");
    assert_eq!(uniq.len(), 120, "不得有重复项");

    db.close().expect("关闭失败");
}

/// 媒体属性过滤下推到 SQL 后语义不变：只返回属性包含的类型。
#[test]
fn media_type_filter_is_applied_in_sql() {
    let path = temp_path("album_page_filter");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let album = db
        .create_album(
            "repo-1",
            "混合",
            AlbumKind::Fixed,
            Some(AlbumMediaType::Multimedia),
            None,
        )
        .expect("创建相册失败");
    for (i, media) in [MediaType::Image, MediaType::Video, MediaType::Audio]
        .iter()
        .enumerate()
    {
        let f = seed_file(&mut db, &s.id, &format!("m{i}.bin"), *media);
        db.add_album_member(album.id.as_str(), f.as_str(), AddedBy::User, false)
            .expect("加成员失败");
    }

    let (all, _) = db
        .query_album_members_page(album.id.as_str(), true, true, true, None, 50)
        .expect("查询失败");
    assert_eq!(all.len(), 3, "multimedia 应当三种都返回");

    let (images, _) = db
        .query_album_members_page(album.id.as_str(), true, false, false, None, 50)
        .expect("查询失败");
    assert_eq!(images.len(), 1, "只要图片时应当只返回 1 条");
    assert_eq!(images[0].media_type, MediaType::Image);

    let (videos, _) = db
        .query_album_members_page(album.id.as_str(), false, true, false, None, 50)
        .expect("查询失败");
    assert_eq!(videos.len(), 1);
    assert_eq!(videos[0].media_type, MediaType::Video);

    db.close().expect("关闭失败");
}

/// 离线媒体源的文件不得出现在相册里（与 `hp-album::visible_members` 同口径）。
#[test]
fn offline_source_members_are_excluded() {
    let path = temp_path("album_page_offline");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let album = db
        .create_album("repo-1", "相册", AlbumKind::Fixed, None, None)
        .expect("创建相册失败");
    let f = seed_file(&mut db, &s.id, "a.jpg", MediaType::Image);
    db.add_album_member(album.id.as_str(), f.as_str(), AddedBy::User, false)
        .expect("加成员失败");

    let (before, _) = db
        .query_album_members_page(album.id.as_str(), true, true, true, None, 50)
        .expect("查询失败");
    assert_eq!(before.len(), 1, "在线源的文件应当可见");

    // 卸载（标记离线）后不再可见。
    db.unmount_source(s.id.as_str()).expect("标记离线失败");
    let (after, _) = db
        .query_album_members_page(album.id.as_str(), true, true, true, None, 50)
        .expect("查询失败");
    assert!(after.is_empty(), "离线源的文件不得展示");

    db.close().expect("关闭失败");
}

/// 游标编解码往返一致；非法游标报错而**不静默从头开始**。
#[test]
fn cursor_roundtrip_and_rejects_garbage() {
    let c = AlbumMemberCursor {
        added_at: "2026-01-02T03:04:05Z".to_string(),
        file_id: "abc-123".to_string(),
    };
    let raw = c.encode();
    assert_eq!(AlbumMemberCursor::decode(&raw).expect("往返应成功"), c);

    // 路径/值里出现分隔符也不能歧义（编码先写长度）。
    let tricky = AlbumMemberCursor {
        added_at: "2026-01-02T03:04:05Z".to_string(),
        file_id: "we\u{1f}ird".to_string(),
    };
    assert_eq!(
        AlbumMemberCursor::decode(&tricky.encode()).expect("含分隔符的值也应往返"),
        tricky
    );

    for bad in ["", "no-separator", "abc", "\u{1f}x", "9999\u{1f}short"] {
        assert!(
            AlbumMemberCursor::decode(bad).is_err(),
            "非法游标 {bad:?} 必须报错，不得静默从头开始"
        );
    }
}

/// 超过上限的 `limit` 被夹到 `ALBUM_MEMBERS_MAX_LIMIT`，不会一次吐出整本相册。
#[test]
fn limit_is_clamped_to_the_maximum() {
    let path = temp_path("album_page_clamp");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let (album_id, _) = seed_album(&mut db, 30);

    let (rows, _) = db
        .query_album_members_page(&album_id, true, true, true, None, i64::MAX)
        .expect("查询失败");
    assert_eq!(rows.len(), 30, "夹紧后仍应返回全部（30 < 上限）");

    let (rows_small, _) = db
        .query_album_members_page(&album_id, true, true, true, None, 0)
        .expect("查询失败");
    assert_eq!(rows_small.len(), 1, "limit=0 应夹到 1，而不是返回空或全部");

    db.close().expect("关闭失败");
}

/// 空相册返回空页且无游标。
#[test]
fn empty_album_yields_empty_page() {
    let path = temp_path("album_page_empty");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let album = db
        .create_album("repo-1", "空", AlbumKind::Fixed, None, None)
        .expect("创建相册失败");

    let (rows, next) = db
        .query_album_members_page(album.id.as_str(), true, true, true, None, 50)
        .expect("查询失败");
    assert!(rows.is_empty());
    assert!(next.is_none());

    db.close().expect("关闭失败");
}

/// 不存在的相册 → `not_found`，而不是空列表（不静默成功）。
#[test]
fn missing_album_is_not_found() {
    let path = temp_path("album_page_missing");
    let db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let err = db
        .query_album_members_page("does-not-exist", true, true, true, None, 50)
        .expect_err("不存在的相册应当报错");
    assert!(
        matches!(err, hp_core::HpError::NotFound(_)),
        "应当是 NotFound，实际 {err:?}"
    );
    db.close().expect("关闭失败");
}
