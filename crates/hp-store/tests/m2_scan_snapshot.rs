//! 扫描准备快照 + 写批次 + 标记分批装载（`docs/issues/0018` 第 43 轮）。
//!
//! 这一组测试钉住三件容易回退的事：
//! 1. 快照行**必须**带上标记与 `color_refs.color_json`（否则扫描会退回逐文件查询）；
//! 2. 标记装载**按 900 个 id 分块**，超过一个块的行数也不能漏标记、不能撞变量上限；
//! 3. 写批次能提交也能回滚（扫描按块包事务的前提）。

use hp_core::{FileId, FileIndexRow, MediaType, SourceId, ThumbStatus, VerifyStatus};
use hp_store::RepoDb;

fn temp_path(tag: &str) -> std::path::PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}.sqlite3"))
}

fn row(source_id: &str, rel: &str, hash: Option<&str>) -> FileIndexRow {
    FileIndexRow {
        id: FileId::generate(),
        source_id: SourceId::from_raw(source_id),
        relative_path: rel.to_string(),
        media_type: MediaType::Image,
        marks: Vec::new(),
        content_hash: hash.map(|h| h.to_string()),
        content_hash_algo: Some("BLAKE3".to_string()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size: 7,
        mtime: "123".to_string(),
        width: None,
        height: None,
        scan_time: "t".to_string(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::NotGenerated,
        missing_status: 0,
        media_info_json: None,
    }
}

#[test]
fn scan_snapshot_carries_marks_and_palette_lock() {
    let mut db = RepoDb::create(temp_path("snapshot"), "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let sid = s.id.as_str();

    let marked = row(sid, "a.jpg", Some("h-a"));
    let locked = row(sid, "b.jpg", Some("h-b"));
    let fresh = row(sid, "c.jpg", None);
    for r in [&marked, &locked, &fresh] {
        db.upsert_file(r).expect("写入文件索引失败");
    }
    // 标记是**多值**的（D102），且标记装载按 `mark` 升序——这里刻意反序插入。
    for mark in ["manga", "book"] {
        db.add_file_mark(marked.id.as_str(), mark)
            .expect("写入标记失败");
    }
    db.upsert_color_ref(
        locked.id.as_str(),
        r##"{"colors":["#112233"],"locked":true}"##,
    )
    .expect("写入色彩参考失败");

    let rows = db.list_files_for_scan(sid).expect("查询扫描准备行失败");
    assert_eq!(rows.len(), 3, "快照必须覆盖该源下全部文件");

    let get = |rel: &str| {
        rows.iter()
            .find(|r| r.relative_path == rel)
            .unwrap_or_else(|| panic!("快照缺少 {rel}"))
    };
    let a = get("a.jpg");
    assert_eq!(
        a.marks.iter().map(|m| m.as_str()).collect::<Vec<_>>(),
        vec!["book", "manga"],
        "标记必须随快照一起取回，且有序"
    );
    assert_eq!(a.content_hash.as_deref(), Some("h-a"));
    assert!(a.color_json.is_none(), "没有调色板行时该列为 NULL");
    assert_eq!(a.size, 7);
    assert_eq!(a.mtime, "123");

    let b = get("b.jpg");
    assert!(
        b.color_json.as_deref() == Some(r##"{"colors":["#112233"],"locked":true}"##),
        "锁定的调色板必须随快照取回，否则扫描会覆盖用户的判定"
    );
    assert!(b.marks.is_empty());

    // 哈希缺失（音频占位行的判据，D115）：快照必须如实给出 `None`。
    assert!(get("c.jpg").content_hash.is_none());

    // 缺失检测用的最小行：id 与路径，不带其余列。
    let mut locs = db
        .list_file_locations_by_source(sid)
        .expect("查询源文件位置失败");
    locs.sort_by(|x, y| x.relative_path.cmp(&y.relative_path));
    assert_eq!(locs.len(), 3);
    assert_eq!(locs[1].relative_path, "b.jpg");
    assert_eq!(locs[1].id.as_str(), locked.id.as_str());

    db.close().expect("关闭失败");
}

/// 标记装载**按 900 个 id 分块**：1001 行会跨两个块，一行都不能漏。
#[test]
fn scan_snapshot_loads_marks_across_chunks() {
    let mut db = RepoDb::create(temp_path("chunks"), "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/big", None, None)
        .expect("挂载失败");
    let sid = s.id.as_str();

    let count = 1001usize;
    db.begin_write_batch().expect("开始写批次失败");
    for i in 0..count {
        let r = row(sid, &format!("f{i:04}.jpg"), Some("h"));
        db.upsert_file(&r).expect("写入文件索引失败");
        db.add_file_mark(r.id.as_str(), "book")
            .expect("写入标记失败");
    }
    db.commit_write_batch().expect("提交写批次失败");

    let rows = db.list_files_for_scan(sid).expect("查询扫描准备行失败");
    assert_eq!(rows.len(), count);
    let with_marks = rows.iter().filter(|r| r.marks.len() == 1).count();
    assert_eq!(
        with_marks, count,
        "跨块的标记装载必须一行不漏（>900 行时旧实现会撞 SQLite 变量上限）"
    );

    // 同一批行也走一遍旧的批量查询路径：分块同样生效。
    let all = db.list_files_by_source(sid).expect("列出文件失败");
    assert_eq!(all.len(), count);
    assert!(all.iter().all(|r| r.marks.len() == 1));

    db.close().expect("关闭失败");
}

#[test]
fn write_batch_commits_and_rolls_back() {
    let mut db = RepoDb::create(temp_path("batch"), "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let sid = s.id.as_str();

    // 回滚：块内写过的行一条都不该留下。
    db.begin_write_batch().expect("开始写批次失败");
    db.upsert_file(&row(sid, "gone.jpg", Some("h")))
        .expect("写入失败");
    db.rollback_write_batch().expect("回滚写批次失败");
    assert_eq!(db.count_files().expect("统计失败"), 0, "回滚后不留行");

    // 提交：一次事务内写的多行全部可见。
    db.begin_write_batch().expect("开始写批次失败");
    db.upsert_file(&row(sid, "a.jpg", Some("h")))
        .expect("写入失败");
    db.upsert_file(&row(sid, "b.jpg", Some("h")))
        .expect("写入失败");
    db.commit_write_batch().expect("提交写批次失败");
    assert_eq!(db.count_files().expect("统计失败"), 2);

    db.close().expect("关闭失败");
}
