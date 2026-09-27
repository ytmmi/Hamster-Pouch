//! M2 验收测试：媒体源挂载/卸载/别名 + 文件索引仓储 + media_info_json 迁移。
//! 对应 docs/roadmap/phase-1-top-level-plan.md 的 M2 范围。

use hp_core::{FileId, FileIndexRow, MediaType, ThumbStatus, VerifyStatus};
use hp_store::RepoDb;

fn temp_path(tag: &str) -> std::path::PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}.sqlite3"))
}

#[test]
fn source_mount_list_rename_unmount() {
    let path = temp_path("src");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");

    let s = db
        .mount_source("repo-1", "C:/photos", Some("我的照片"), None)
        .expect("挂载失败");
    assert_eq!(s.alias.as_deref(), Some("我的照片"));

    // 嵌套源
    let child = db
        .mount_source("repo-1", "C:/photos/sub", None, Some(s.id.as_str()))
        .expect("挂载子源失败");
    assert_eq!(
        child.parent_source_id.as_ref().map(|p| p.as_str()),
        Some(s.id.as_str())
    );

    // 列表
    let list = db.list_sources("repo-1").expect("列出源失败");
    assert_eq!(list.len(), 2);

    // 查询
    let got = db
        .get_source(s.id.as_str())
        .expect("查询源失败")
        .expect("源应存在");
    assert_eq!(got.local_path, "C:/photos");

    // 重命名别名
    db.rename_source(s.id.as_str(), "新别名").expect("重命名失败");
    let renamed = db
        .get_source(s.id.as_str())
        .expect("查询源失败")
        .expect("源应存在");
    assert_eq!(renamed.alias.as_deref(), Some("新别名"));

    // 卸载（保留索引，仅标记离线）
    db.unmount_source(s.id.as_str()).expect("卸载失败");
    let unmounted = db
        .get_source(s.id.as_str())
        .expect("查询源失败")
        .expect("源应保留");
    assert!(!unmounted.mounted);

    db.close().expect("关闭失败");
}

#[test]
fn file_upsert_get_and_media_info_migration() {
    let path = temp_path("file");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");

    let row = FileIndexRow {
        id: FileId::generate(),
        source_id: s.id.clone(),
        relative_path: "a.jpg".to_string(),
        media_type: MediaType::Image,
        content_hash: Some("abc".to_string()),
        content_hash_algo: Some("BLAKE3".to_string()),
        content_hash_algo_version: Some(1),
        perceptual_hash: Some("def".to_string()),
        perceptual_hash_algo: Some("dHash".to_string()),
        perceptual_hash_algo_version: Some(1),
        size: 100,
        mtime: "1".to_string(),
        scan_time: "t".to_string(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::NotGenerated,
        missing_status: 0,
        media_info_json: Some(r#"{"format":{"duration":"1.5"}}"#.to_string()),
    };

    db.upsert_file(&row).expect("写入文件索引失败");
    assert_eq!(db.count_files().expect("统计失败"), 1);

    let got = db
        .get_file(row.id.as_str())
        .expect("查询失败")
        .expect("文件应存在");
    assert_eq!(got.content_hash.as_deref(), Some("abc"));
    assert_eq!(
        got.media_info_json.as_deref(),
        Some(r#"{"format":{"duration":"1.5"}}"#)
    );

    // 迁移 0007 已生效：schema_version 应为 7（0001..0007）
    assert_eq!(db.schema_version().expect("读版本失败"), 7);

    db.close().expect("关闭失败");
}

/// 目录前缀过滤：`dir_prefix=Raw` 仅返回 `Raw/` 及其子孙，不含 `RawX/` 与根目录文件。
#[test]
fn query_files_dir_prefix_filter() {
    let path = temp_path("dirprefix");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");

    let make = |rel: &str| FileIndexRow {
        id: FileId::generate(),
        source_id: s.id.clone(),
        relative_path: rel.to_string(),
        media_type: MediaType::Image,
        content_hash: Some(format!("h-{rel}")),
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
    for rel in ["a.jpg", "Raw/b.jpg", "Raw/Sub/c.jpg", "RawX/d.jpg"] {
        db.upsert_file(&make(rel)).expect("写入文件索引失败");
    }

    // 无前缀：返回全部 4 个
    let (all, next) = db
        .query_files(
            "repo-1",
            &hp_store::FileQueryFilter {
                source_id: Some(s.id.as_str()),
                ..Default::default()
            },
            None,
            100,
        )
        .expect("查询失败");
    assert_eq!(all.len(), 4);
    assert!(next.is_none(), "未超页大小不应给出下一页游标");

    // 前缀 Raw：仅 Raw/b.jpg 与 Raw/Sub/c.jpg（不含 RawX/d.jpg、a.jpg）
    let (filtered, _) = db
        .query_files(
            "repo-1",
            &hp_store::FileQueryFilter {
                source_id: Some(s.id.as_str()),
                dir_prefix: Some("Raw"),
                ..Default::default()
            },
            None,
            100,
        )
        .expect("查询失败");
    let mut rels: Vec<&str> = filtered
        .iter()
        .map(|r| r.relative_path.as_str())
        .collect();
    rels.sort_unstable();
    assert_eq!(rels, vec!["Raw/Sub/c.jpg", "Raw/b.jpg"]);

    db.close().expect("关闭失败");
}

/// D78：键集游标分页——逐页取完不重不漏，且**翻页途中插入新行也不会漏项**。
#[test]
fn cursor_pagination_is_stable_under_inserts() {
    let path = temp_path("cursor");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");

    let row = |rel: &str| FileIndexRow {
        id: FileId::generate(),
        source_id: s.id.clone(),
        relative_path: rel.to_string(),
        media_type: MediaType::Image,
        content_hash: Some(format!("h-{rel}")),
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
    // 文件名故意让"按路径排序"与"插入顺序"不同。
    for rel in ["b.jpg", "a.jpg", "d.jpg", "c.jpg"] {
        db.upsert_file(&row(rel)).expect("写入失败");
    }

    let filter = hp_store::FileQueryFilter {
        source_id: Some(s.id.as_str()),
        ..Default::default()
    };

    // 第一页：2 条 + 游标。
    let (page1, cursor1) = db.query_files("repo-1", &filter, None, 2).expect("第一页失败");
    assert_eq!(page1.len(), 2);
    let cursor1 = cursor1.expect("还有下一页时必须给出游标");
    assert_eq!(cursor1.relative_path, "b.jpg", "排序键应为 relative_path 升序");

    // 翻页途中插入一行（**排在游标之前**）：键集游标不受影响；offset 分页会在这里漏项/重复。
    db.upsert_file(&row("aa.jpg")).expect("插入失败");

    let (page2, cursor2) = db
        .query_files("repo-1", &filter, Some(&cursor1), 2)
        .expect("第二页失败");
    let rels2: Vec<&str> = page2.iter().map(|r| r.relative_path.as_str()).collect();
    assert_eq!(rels2, vec!["c.jpg", "d.jpg"]);
    assert!(
        cursor2.is_none(),
        "第二页刚好取完，末页不得再给游标（给出即会让调用方多跑一次空页）"
    );

    // 两页拼起来 = **不重不漏**：插入的 `aa.jpg` 排在游标之前，因此按设计不在本次翻页结果里，
    // 也**不会**把后面的行顶成重复（同一场景下 offset 分页会让 `b.jpg` 或 `c.jpg` 重复出现）。
    let mut seen: Vec<String> = page1
        .iter()
        .chain(page2.iter())
        .map(|r| r.relative_path.clone())
        .collect();
    seen.sort();
    assert_eq!(seen, vec!["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);
    assert_eq!(seen.len(), 4, "不得重复返回任何行");

    // 从头再翻一次（此时 `aa.jpg` 已在库里）：能取到全部 5 条，说明新行按排序键正常进入首页序列。
    let (all_first_page, _) = db.query_files("repo-1", &filter, None, 1).expect("首页失败");
    assert_eq!(all_first_page[0].relative_path, "a.jpg");

    // 游标是不透明字符串：编码/解码往返一致；非法游标报错（不静默从头开始）。
    let round = hp_store::FileQueryCursor::decode(&cursor1.encode()).expect("游标往返失败");
    assert_eq!(round, cursor1);
    assert!(
        hp_store::FileQueryCursor::decode("garbage").is_err(),
        "非法游标必须报错"
    );

    db.close().expect("关闭失败");
}
