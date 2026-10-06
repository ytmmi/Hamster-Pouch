//! M2 进度上报验收：遍历阶段必须**看得到进度**（缺陷 0021）。
//!
//! 回归要点（缺一即红）：
//! 1. 遍历阶段**至少上报一帧**——旧实现只按时间节流（200 ms），而本地盘上几万个
//!    文件常常几十毫秒就遍历完，于是整段遍历一帧都不发，浮窗停在面板置入的
//!    "已发现 0 个文件"占位文案上直到扫描结束；
//! 2. **首帧**在第一个文件就发出（一次性，不逐文件上报）；
//! 3. **收尾帧**把"已发现 N"落到真实总数（旧实现最后可见的是一个偏小的数，
//!    随后直接切到索引阶段的 0/total）；
//! 4. 中间按**固定间隔**刷新（用户口径：固定间隔即可，不追求完全实时、不拖累性能）。

use hp_scanner::{ScanOptions, ScanPhase, ScanProgress, Scanner};
use hp_store::RepoDb;

/// `.bin` 非媒体类型：遍历照常计入，索引阶段全部跳过 → 用例跑得很快。
const FILES: u64 = 500;

#[test]
fn walking_phase_reports_progress_from_the_first_file() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let root = tmp.path().join("lib");
    std::fs::create_dir_all(&root).expect("创建媒体源目录失败");
    for i in 0..FILES {
        std::fs::write(root.join(format!("f{i:04}.bin")), b"x").expect("写文件失败");
    }

    let mut db = RepoDb::create(tmp.path().join("repo.sqlite3"), "测试仓库").expect("创建仓库失败");
    let source = db
        .mount_source("test-repo", root.to_str().unwrap(), None, None)
        .expect("挂载媒体源失败");

    let scanner = Scanner::new();
    let mut frames: Vec<(ScanPhase, u64, u64)> = Vec::new();
    let outcome = {
        let mut progress = |p: &ScanProgress| frames.push((p.phase, p.processed, p.total));
        scanner
            .scan_source(&mut db, &source, &ScanOptions::default(), &mut progress)
            .expect("扫描失败")
    };
    assert_eq!(outcome.skipped, FILES, "全部 .bin 应按未知类型跳过");

    let walking: Vec<(u64, u64)> = frames
        .iter()
        .filter(|f| f.0 == ScanPhase::Walking)
        .map(|f| (f.1, f.2))
        .collect();
    assert!(
        !walking.is_empty(),
        "遍历阶段必须上报进度——首个文件就要发一帧（旧实现一帧不发）；实际帧: {frames:?}"
    );
    assert_eq!(
        walking.first().copied(),
        Some((1, 0)),
        "首帧应在第一个文件就发出: {walking:?}"
    );

    let mut prev = 0;
    for (processed, total) in &walking {
        assert_eq!(*total, 0, "遍历阶段总数未知应记 0");
        assert!(*processed >= prev, "遍历进度不得回退: {walking:?}");
        prev = *processed;
    }
    assert_eq!(
        walking.last().copied(),
        Some((FILES, 0)),
        "遍历收尾帧应把已发现数落到真实总数: {walking:?}"
    );
    // 首帧 + 收尾帧 = 至少 2 帧；固定间隔刷新只可能让它更多。
    assert!(
        walking.len() >= 2,
        "至少首帧与收尾帧，实际 {} 帧: {walking:?}",
        walking.len()
    );
}
