//! 媒体源子目录排除（D149）回归：软排除的写入/幂等/视图过滤/可恢复性。
//!
//! 核心口径：排除**一行数据都不删**——文件索引、相册成员、标签评分全部原样保留，
//! 只是读侧把它们藏起来；「取消排除」后一切原样回来。
//! 因此下面每条断言都在钉"过滤只发生在读侧、写侧什么都没动"。

use hp_core::{
    AddedBy, AlbumKind, AlbumMediaType, FileId, FileIndexRow, MediaType, SourceId, ThumbStatus,
    VerifyStatus,
};
use hp_store::{FileQueryFilter, RepoDb, retain_visible_paths};

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
        content_hash: Some(format!("hash-{rel}")),
        content_hash_algo: Some("BLAKE3".to_string()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size: 1,
        mtime: "1".to_string(),
        width: None,
        height: None,
        scan_time: "t".to_string(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::NotGenerated,
        missing_status: 0,
        media_info_json: None,
    };
    db.upsert_file(&row).expect("写入文件索引失败");
    id
}

/// 查询媒体库可见文件的相对路径（升序，便于直接比对）。
fn visible_paths(db: &RepoDb) -> Vec<String> {
    let (rows, _) = db
        .query_files("repo-1", &FileQueryFilter::default(), None, 100)
        .expect("查询文件失败");
    rows.into_iter().map(|r| r.relative_path).collect()
}

/// 建一个源 + 四条文件：
/// `a/b/1.jpg`、`a/b/deep/2.jpg`（被排除的子树）、
/// `a/bc/3.jpg`（同前缀但不是后代）、`z.jpg`（无关兄弟）。
fn seed_tree(db: &mut RepoDb) -> (SourceId, Vec<FileId>) {
    let source = db
        .mount_source("repo-1", "C:/media", None, None)
        .expect("挂载源失败");
    let mut files = Vec::new();
    for rel in ["a/b/1.jpg", "a/b/deep/2.jpg", "a/bc/3.jpg", "z.jpg"] {
        files.push(seed_file(db, &source.id, rel));
    }
    (source.id, files)
}

/// 写入侧：幂等、留痕时间戳不被重复点击改写、非法路径与不存在的源被拒。
#[test]
fn exclude_is_idempotent_and_validated() {
    let path = temp_path("source_exclusion_write");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let (source_id, _) = seed_tree(&mut db);

    let first = db
        .exclude_source_dir(source_id.as_str(), "a\\b")
        .expect("排除失败");
    assert_eq!(first.relative_path, "a/b", "分隔符必须归一化为 /");
    assert_eq!(
        db.list_source_exclusions(source_id.as_str()).unwrap().len(),
        1
    );

    let again = db
        .exclude_source_dir(source_id.as_str(), "/a/b/")
        .expect("重复排除应当幂等");
    assert_eq!(again.relative_path, first.relative_path);
    assert_eq!(
        again.excluded_at, first.excluded_at,
        "重复点击不该改写'用户什么时候做的这次排除'"
    );
    assert_eq!(
        db.list_source_exclusions(source_id.as_str()).unwrap().len(),
        1,
        "重复排除不得写出第二行"
    );

    assert!(
        db.exclude_source_dir("no-such-source", "a/b").is_err(),
        "源不存在必须报错，不能留孤儿记录"
    );
    assert!(db.exclude_source_dir(source_id.as_str(), "").is_err());
    assert!(db.exclude_source_dir(source_id.as_str(), "a/../b").is_err());
    assert!(db.exclude_source_dir(source_id.as_str(), "a//b").is_err());
}

/// 读侧（媒体库）：被排除子树整棵消失，前缀相近的兄弟目录与无关目录照旧。
#[test]
fn excluded_subtree_is_hidden_from_file_query() {
    let path = temp_path("source_exclusion_query");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let (source_id, _) = seed_tree(&mut db);

    assert_eq!(
        visible_paths(&db),
        vec!["a/b/1.jpg", "a/b/deep/2.jpg", "a/bc/3.jpg", "z.jpg"]
    );

    db.exclude_source_dir(source_id.as_str(), "a/b")
        .expect("排除失败");
    assert_eq!(
        visible_paths(&db),
        vec!["a/bc/3.jpg", "z.jpg"],
        "被排除子树（含更深一层）必须消失，`a/bc` 不算 `a/b` 的后代"
    );

    db.unexclude_source_dirs(source_id.as_str(), &["a/b".to_string()])
        .expect("取消排除失败");
    assert_eq!(
        visible_paths(&db),
        vec!["a/b/1.jpg", "a/b/deep/2.jpg", "a/bc/3.jpg", "z.jpg"],
        "取消排除必须完整还原（文件索引一行都没删过）"
    );
}

/// 目录树的数据来源是 `list_relative_paths_by_source` + `retain_visible_paths`：
/// 前者保持原样（存储层不做隐藏），过滤只在建树前做一次。
#[test]
fn tree_paths_are_filtered_before_building() {
    let path = temp_path("source_exclusion_tree");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let (source_id, _) = seed_tree(&mut db);
    db.exclude_source_dir(source_id.as_str(), "a/b")
        .expect("排除失败");

    let raw = db
        .list_relative_paths_by_source(source_id.as_str())
        .expect("查询相对路径失败");
    assert_eq!(raw.len(), 4, "存储层查询必须是原始数据，过滤不在这里");

    let prefixes = db
        .source_exclusion_prefixes(source_id.as_str())
        .expect("查询排除前缀失败");
    let kept = retain_visible_paths(raw, &prefixes);
    let mut sorted = kept.clone();
    sorted.sort();
    assert_eq!(sorted, vec!["a/bc/3.jpg", "z.jpg"]);
}

/// 读侧（相册）：成员分页与可见计数必须同口径，否则列表数字与翻页条数分叉。
#[test]
fn excluded_subtree_is_hidden_from_album_views() {
    let path = temp_path("source_exclusion_album");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let (source_id, files) = seed_tree(&mut db);
    let album = db
        .create_album(
            "repo-1",
            "全部",
            AlbumKind::Fixed,
            Some(AlbumMediaType::Multimedia),
            None,
        )
        .expect("创建相册失败");
    for f in &files {
        db.add_album_member(album.id.as_str(), f.as_str(), AddedBy::User, false)
            .expect("加成员失败");
    }

    let count_visible = |db: &RepoDb| {
        let (rows, _) = db
            .query_album_members_page(album.id.as_str(), true, true, true, None, 100)
            .expect("查询成员失败");
        (
            rows.len() as i64,
            db.count_visible_album_members(album.id.as_str())
                .expect("统计可见成员失败"),
        )
    };

    assert_eq!(count_visible(&db), (4, 4));
    assert_eq!(
        db.count_album_members(album.id.as_str()).unwrap(),
        4,
        "原始成员数（存储层自检口径）不受排除影响"
    );

    db.exclude_source_dir(source_id.as_str(), "a/b")
        .expect("排除失败");
    assert_eq!(
        count_visible(&db),
        (2, 2),
        "分页结果与可见计数必须一致（a/bc/3.jpg、z.jpg）"
    );
    assert_eq!(
        db.count_album_members(album.id.as_str()).unwrap(),
        4,
        "成员行一行都没删——这正是'可恢复'的含义"
    );

    db.unexclude_source_dirs(source_id.as_str(), &["a/b".to_string()])
        .expect("取消排除失败");
    assert_eq!(count_visible(&db), (4, 4));
}

/// 取消排除：逐条删除、重复取消幂等、返回实际删除条数。
#[test]
fn unexclude_reports_and_is_idempotent() {
    let path = temp_path("source_exclusion_unexclude");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let (source_id, _) = seed_tree(&mut db);

    db.exclude_source_dir(source_id.as_str(), "a/b").unwrap();
    db.exclude_source_dir(source_id.as_str(), "a/bc").unwrap();

    let removed = db
        .unexclude_source_dirs(source_id.as_str(), &["a/b".to_string()])
        .expect("取消排除失败");
    assert_eq!(removed, 1);
    assert_eq!(
        db.list_source_exclusions(source_id.as_str())
            .unwrap()
            .into_iter()
            .map(|e| e.relative_path)
            .collect::<Vec<_>>(),
        vec!["a/bc"]
    );

    let removed = db
        .unexclude_source_dirs(source_id.as_str(), &["a/b".to_string()])
        .expect("重复取消不应报错");
    assert_eq!(removed, 0, "已经不存在了，删除 0 行");

    assert_eq!(
        db.unexclude_source_dirs(source_id.as_str(), &[])
            .expect("空清单应当是空操作"),
        0
    );
    assert!(
        db.unexclude_source_dirs(source_id.as_str(), &["a/../b".to_string()])
            .is_err(),
        "非法路径仍然要报参数错误"
    );
}

/// 仓库级清单只含**在线**源的排除：卸载的源本来就不在树里，不能让它把
/// 「取消排除」菜单项顶出来。
#[test]
fn repo_exclusions_only_cover_mounted_sources() {
    let path = temp_path("source_exclusion_repo_list");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let (source_id, _) = seed_tree(&mut db);

    db.exclude_source_dir(source_id.as_str(), "a/b").unwrap();
    assert_eq!(db.list_repo_exclusions("repo-1").unwrap().len(), 1);

    db.unmount_source(source_id.as_str()).expect("卸载失败");
    assert!(
        db.list_repo_exclusions("repo-1").unwrap().is_empty(),
        "离线源的排除不该出现在面板清单里"
    );
    assert_eq!(
        db.list_source_exclusions(source_id.as_str()).unwrap().len(),
        1,
        "但排除记录本身必须留着：重新挂载后要原样生效"
    );

    db.mount_source("repo-1", "C:/media", None, None)
        .expect("重新挂载失败");
    assert_eq!(
        db.list_repo_exclusions("repo-1").unwrap().len(),
        1,
        "重新挂载同一路径恢复原源，排除随之恢复"
    );
}

/// 彻底清除（purge）源时，排除记录随外键级联一并消失，不留孤儿行。
#[test]
fn purge_cascades_exclusions() {
    let path = temp_path("source_exclusion_purge");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let (source_id, _) = seed_tree(&mut db);
    db.exclude_source_dir(source_id.as_str(), "a/b").unwrap();

    db.purge_source_data(source_id.as_str(), &|| false, &mut |_, _, _| {})
        .expect("完全卸载失败");

    assert!(
        db.get_source(source_id.as_str()).unwrap().is_none(),
        "源行本身应当已被删除"
    );
    assert!(
        db.list_source_exclusions(source_id.as_str())
            .unwrap()
            .is_empty(),
        "源没了，它的排除记录必须级联消失"
    );
}
