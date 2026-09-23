//! 扫描并发隔离：扫描线程用**独立连接**写库时，主连接仍可正常读取。
//!
//! 这条不变量是"扫描时界面不无响应"的底层依据：`source.scan` 不再持有主连接锁，
//! 而是自己 `RepoDb::open` 一份；若 WAL + busy_timeout 不足以支撑双连接，
//! 界面命令就会在扫描期间报错或阻塞。

use hp_core::{FileId, FileIndexRow, MediaType, ThumbStatus, VerifyStatus};
use hp_store::RepoDb;

fn sample_row(source_id: &str, relative_path: &str) -> FileIndexRow {
    FileIndexRow {
        id: FileId::generate(),
        source_id: hp_core::SourceId::from_raw(source_id),
        relative_path: relative_path.to_string(),
        media_type: MediaType::Image,
        content_hash: Some(format!("hash-{relative_path}")),
        content_hash_algo: Some("blake3".into()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size: 1,
        mtime: "1".into(),
        scan_time: "2026-01-01T00:00:00Z".into(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::NotGenerated,
        missing_status: 0,
        media_info_json: None,
    }
}

#[test]
fn main_connection_reads_while_scan_connection_writes() {
    let dir = tempfile::tempdir().expect("创建临时目录失败");
    let path = dir.path().join("repo.sqlite3");
    let mut main_db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let source = main_db
        .mount_source("repo-1", "C:/videos", None, None)
        .expect("挂载失败");

    // 扫描线程侧的独立连接
    let mut scan_db = RepoDb::open(&path).expect("扫描连接打开失败");
    scan_db
        .upsert_file(&sample_row(source.id.as_str(), "a.mp4"))
        .expect("扫描连接写入失败");

    // 主连接应能读到扫描连接已提交的数据（不被锁住、不报 SQLITE_BUSY）
    let seen = main_db
        .get_file_by_path(source.id.as_str(), "a.mp4")
        .expect("主连接读取失败")
        .expect("应读到扫描连接写入的行");
    assert_eq!(seen.relative_path, "a.mp4");

    // 反向：主连接写入后扫描连接也能读到（双向可见）
    main_db
        .upsert_file(&sample_row(source.id.as_str(), "b.mp4"))
        .expect("主连接写入失败");
    assert!(
        scan_db
            .get_file_by_path(source.id.as_str(), "b.mp4")
            .expect("扫描连接读取失败")
            .is_some(),
        "扫描连接应读到主连接写入的行"
    );

    // 两条连接交替写也不应报错（busy_timeout 兜住瞬时写冲突）
    for i in 0..20 {
        let name = format!("x{i}.mp4");
        scan_db
            .upsert_file(&sample_row(source.id.as_str(), &name))
            .expect("扫描连接连续写入失败");
        main_db
            .upsert_file(&sample_row(source.id.as_str(), &format!("y{i}.mp4")))
            .expect("主连接连续写入失败");
    }
    assert_eq!(
        main_db
            .list_files_by_source(source.id.as_str())
            .expect("列出文件失败")
            .len(),
        42
    );
}
