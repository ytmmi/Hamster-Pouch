//! 子目录排除（D149）在相册侧的不变量。
//!
//! 分页取数（`RepoDb::query_album_members_page`）的过滤由 `crates/hp-store/tests/m2_source_exclusion.rs`
//! 覆盖；本文件只管**全量可见成员**这条路（`AlbumService::visible_members` → `media::visible_members`）：
//! 它是逐行读索引再筛的，SQL 侧的排除谓词帮不到它，所以必须自己再判一次——否则会出现
//! 「源面板里没有了、相册里却还在」。

use hp_album::AlbumService;
use hp_core::{
    AddedBy, AlbumKind, FileId, FileIndexRow, MediaType, SourceId, ThumbStatus, VerifyStatus,
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

/// 相册全量可见成员必须过滤被排除子目录（含其后代），取消排除后原样回来。
///
/// 数据一行都没动是这条用例的关键断言：排除是**软排除**，`count_album_members`
/// 仍应看到全部成员行，只有"可见"这件事被改掉。
#[test]
fn visible_members_hide_excluded_subtree_and_come_back() {
    let mut db = temp_db("exclusion-visible");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let inside = seed_file(&mut db, &s.id, "a/b/1.jpg");
    let sibling = seed_file(&mut db, &s.id, "a/bc/2.jpg");
    let root = seed_file(&mut db, &s.id, "z.jpg");

    let album = db
        .create_album("repo-1", "相册", AlbumKind::Fixed, None, None)
        .expect("建相册失败");
    for f in [&inside, &sibling, &root] {
        db.add_album_member(album.id.as_str(), f.as_str(), AddedBy::User, false)
            .expect("加成员失败");
    }

    // 写成自由函数而不是闭包：闭包会一直借住 `db`，后面的写操作就没法可变借用了
    fn visible(db: &RepoDb, album_id: &str) -> Vec<String> {
        let mut rels: Vec<String> = AlbumService::visible_members(db, album_id)
            .expect("查可见成员失败")
            .into_iter()
            .map(|f| f.relative_path)
            .collect();
        rels.sort();
        rels
    }

    assert_eq!(
        visible(&db, album.id.as_str()),
        vec!["a/b/1.jpg", "a/bc/2.jpg", "z.jpg"],
        "排除前三个成员都该可见"
    );

    db.exclude_source_dir(s.id.as_str(), "a/b")
        .expect("排除失败");
    assert_eq!(
        visible(&db, album.id.as_str()),
        vec!["a/bc/2.jpg", "z.jpg"],
        "被排除子树的成员不得出现在相册可见成员里（a/bc 不在 a/b 之下，必须留着）"
    );

    db.unexclude_source_dirs(s.id.as_str(), &["a/b".to_string()])
        .expect("取消排除失败");
    assert_eq!(
        visible(&db, album.id.as_str()),
        vec!["a/b/1.jpg", "a/bc/2.jpg", "z.jpg"],
        "取消排除后必须原样回来（数据从未删除）"
    );
    assert_eq!(db.count_album_members(album.id.as_str()).unwrap(), 3);
}
