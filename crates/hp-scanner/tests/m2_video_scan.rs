//! M2 视频扫描回归：真实 ffmpeg/ffprobe 下的视频索引、首帧缩略图、进度收敛。
//!
//! 依赖仓库内捆绑的 `external-cli/ffmpeg`；缺失时跳过（不把 CI 卡在外部依赖上）。

use std::path::{Path, PathBuf};
use std::time::Duration;

use hp_core::ThumbStatus;
use hp_scanner::{ScanOptions, ScanPhase, ScanProgress, Scanner};
use hp_store::RepoDb;

/// 捆绑的 ffmpeg/ffprobe；不存在则返回 None。
fn bundled_bins() -> Option<(PathBuf, PathBuf)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .parent()?
        .join("external-cli/ffmpeg/bin");
    let ffmpeg = dir.join("ffmpeg.exe");
    let ffprobe = dir.join("ffprobe.exe");
    (ffmpeg.exists() && ffprobe.exists()).then_some((ffmpeg, ffprobe))
}

/// 用捆绑 ffmpeg 生成一段确定性测试视频。
fn make_video(ffmpeg: &Path, path: &Path) {
    let out = std::process::Command::new(ffmpeg)
        .args(["-y", "-f", "lavfi", "-i"])
        .arg("testsrc=duration=3:size=640x360:rate=15")
        .args(["-pix_fmt", "yuv420p"])
        .arg(path)
        .output()
        .expect("启动 ffmpeg 失败");
    assert!(
        out.status.success(),
        "生成测试视频失败: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn options(ffmpeg: PathBuf, ffprobe: PathBuf, cache: hp_media::ThumbnailCache) -> ScanOptions {
    ScanOptions {
        full: false,
        ffmpeg_bin: Some(ffmpeg),
        ffprobe_bin: Some(ffprobe),
        thumbnail_cache: Some(cache),
        video_timeout: Duration::from_secs(20),
    }
}

#[test]
fn video_source_scans_with_thumbnail_and_progress_reaches_total() {
    let Some((ffmpeg, ffprobe)) = bundled_bins() else {
        eprintln!("跳过：未找到 external-cli/ffmpeg");
        return;
    };

    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let src_dir = tmp.path().join("videos");
    std::fs::create_dir_all(&src_dir).expect("创建媒体源目录失败");
    make_video(&ffmpeg, &src_dir.join("clip.mp4"));

    let mut db = RepoDb::create(tmp.path().join("repo.sqlite3"), "测试仓库").expect("创建仓库失败");
    let source = db
        .mount_source("test-repo", src_dir.to_str().unwrap(), None, None)
        .expect("挂载媒体源失败");

    let scanner = Scanner::new();
    let opts = options(ffmpeg, ffprobe, hp_media::ThumbnailCache::new(tmp.path().join("thumbs")));

    let mut frames: Vec<(ScanPhase, u64, u64)> = Vec::new();
    let outcome = {
        let mut progress = |p: &ScanProgress| frames.push((p.phase, p.processed, p.total));
        scanner
            .scan_source(&mut db, &source, &opts, &mut progress)
            .expect("扫描失败")
    };

    assert_eq!(outcome.indexed, 1, "视频应被索引");
    assert!(!outcome.cancelled);

    // 进度必须收敛到 100%：旧实现逐文件上报 processed=i，最后一格永远停在 total-1。
    let last_indexing = frames
        .iter()
        .filter(|(phase, _, _)| *phase == ScanPhase::Indexing)
        .next_back()
        .expect("应有索引阶段进度");
    assert_eq!(
        (last_indexing.1, last_indexing.2),
        (1, 1),
        "索引阶段最后一帧应为 1/1，实际 {last_indexing:?}"
    );
    // 进度单调不减（遍历阶段 total=0 表示未知，不参与比较）
    let mut prev = 0u64;
    for (phase, processed, total) in &frames {
        if *phase == ScanPhase::Indexing && *total > 0 {
            assert!(*processed >= prev, "进度不得回退: {frames:?}");
            prev = *processed;
        }
    }

    // 视频行：内容哈希 + 首帧缩略图 + 首帧感知哈希 + ffprobe 元数据
    let row = db
        .get_file_by_path(source.id.as_str(), "clip.mp4")
        .expect("查询失败")
        .expect("视频应已索引");
    assert!(row.content_hash.is_some(), "视频应有内容哈希");
    assert_eq!(row.thumb_status, ThumbStatus::Generated, "视频应生成首帧缩略图");
    assert!(row.perceptual_hash.is_some(), "首帧应产生感知哈希");
    assert!(
        row.media_info_json.as_deref().is_some_and(|j| j.contains("duration")),
        "应缓存 ffprobe 媒体信息"
    );

    // 二次扫描（size/mtime 未变）不应重复抽帧/探测
    let mut frames2: Vec<u64> = Vec::new();
    let outcome2 = {
        let mut progress = |p: &ScanProgress| frames2.push(p.processed);
        scanner
            .scan_source(&mut db, &source, &opts, &mut progress)
            .expect("二次扫描失败")
    };
    assert_eq!(outcome2.indexed, 0, "未变更的视频不应重新索引");
    assert_eq!(outcome2.changed, 0, "未变更的视频不应重建行（省掉重复哈希/抽帧）");
    assert!(frames2.contains(&1), "二次扫描同样应上报到 100%");
}

#[test]
fn cancel_is_not_an_error_and_reports_cancelled() {
    // 取消必须走"已完成部分"的 Ok 结果，而不是 Err——否则命令层会把它当扫描错误弹给用户。
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let src_dir = tmp.path().join("photos");
    std::fs::create_dir_all(&src_dir).expect("创建媒体源目录失败");
    for i in 0..50u8 {
        let img = image::GrayImage::from_fn(16, 16, |x, y| {
            image::Luma([(x.wrapping_add(y).wrapping_add(i as u32)) as u8])
        });
        img.save(src_dir.join(format!("p{i:02}.png"))).expect("写测试图失败");
    }

    let mut db = RepoDb::create(tmp.path().join("repo.sqlite3"), "测试仓库").expect("创建仓库失败");
    let source = db
        .mount_source("test-repo", src_dir.to_str().unwrap(), None, None)
        .expect("挂载媒体源失败");

    let scanner = Scanner::new();
    let scanner_for_scan = scanner.clone();
    let (tx, rx) = std::sync::mpsc::channel::<bool>();

    let handle = std::thread::spawn(move || {
        let options = ScanOptions::default();
        let mut progress = |p: &ScanProgress| {
            // current 非空 = 已进入逐文件索引（此时 reset 早已执行）
            let _ = tx.send(p.current.is_some());
        };
        let mut db = db;
        scanner_for_scan.scan_source(&mut db, &source, &options, &mut progress)
    });

    // 等到第一个"逐文件"进度帧后再取消，保证取消落在扫描进行中
    let mut started = false;
    while !started {
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(v) => started = v,
            Err(_) => panic!("未等到索引阶段进度帧"),
        }
    }
    scanner.cancel();

    let outcome = handle
        .join()
        .expect("扫描线程不应 panic")
        .expect("取消不应作为错误返回");
    assert!(outcome.cancelled, "取消后应标记 cancelled");
}
