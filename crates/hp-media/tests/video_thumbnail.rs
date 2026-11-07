//! 视频缩略图的**行为**测试：默认首帧、片头黑屏跳过（D143）。
//!
//! 为什么单独写一个文件：`src/thumbnail.rs` 里的单测是"不需要 ffmpeg 也能跑"的纯逻辑
//! 与格式断言，而这里每一条都要先用 ffmpeg 造一个确定性视频、再抽帧比对字节——与
//! `player_lifecycle.rs` 同款的外部资源测试。找不到随包 ffmpeg 时**自动跳过**，不卡 CI。
//!
//! 运行：`cargo test -p hp-media --test video_thumbnail -- --nocapture`

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// 片头黑屏长度（秒）：**远小于** [`hp_media::VIDEO_BLACK_SKIP_WINDOW`]，用于验证"跳过"。
const SHORT_LEAD_SECS: u64 = 2;

/// 抽帧超时：与源扫描同量级（`SCAN_MEDIA_TIMEOUT`）。
const TIMEOUT: Duration = Duration::from_secs(20);

/// 从 `current_dir` 逐级上溯找随包 ffmpeg（与 `src/thumbnail.rs` 的辅助同源）。
fn bundled_ffmpeg() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        let candidate = dir
            .join("external-cli")
            .join("ffmpeg")
            .join("bin")
            .join("ffmpeg.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// 用 lavfi 造一个确定性视频；`-pix_fmt yuv420p` 保证 mjpeg 抽帧结果稳定。
fn make_video(ffmpeg: &Path, out: &Path, args: &[&str]) {
    let status = Command::new(ffmpeg)
        .arg("-y")
        .args(args)
        .args(["-pix_fmt", "yuv420p"])
        .arg(out)
        .status()
        .expect("运行 ffmpeg 生成夹具");
    assert!(status.success(), "生成夹具失败: {}", out.display());
}

/// 黑屏 + 内容的拼接夹具（内容段用 `testsrc`，帧内容可复现）。
fn black_then_content(lead_secs: u64, content_secs: u64) -> Vec<String> {
    vec![
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!("color=black:duration={lead_secs}:size=640x360:rate=15"),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!("testsrc=duration={content_secs}:size=640x360:rate=15"),
        "-filter_complex".into(),
        "[0:v][1:v]concat=n=2:v=1:a=0".into(),
    ]
}

/// **旧口径**（不带黑屏过滤）的参考实现，用来钉住"没有黑屏时产物一字不差"。
fn extract_reference(ffmpeg: &Path, video: &Path, out: &Path, seek: Option<&str>) {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-y");
    if let Some(seek) = seek {
        cmd.arg("-ss").arg(seek);
    }
    let status = cmd
        .args(["-i"])
        .arg(video)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale='min(512,iw)':-2",
            "-q:v",
            "3",
        ])
        .arg(out)
        .status()
        .expect("运行 ffmpeg 抽参考帧");
    assert!(status.success(), "抽参考帧失败: {}", video.display());
}

fn read(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| panic!("读产物 {} 失败: {e}", path.display()))
}

/// 逐字节相同的断言（失败时只报体积，避免把两张图 dump 进日志）。
fn assert_same(a: &[u8], b: &[u8], what: &str) {
    assert!(
        a == b,
        "{what}：产物体积不一致（{} B vs {} B）",
        a.len(),
        b.len()
    );
}

#[test]
fn first_frame_is_unchanged_when_it_is_not_black() {
    let Some(ffmpeg) = bundled_ffmpeg() else {
        eprintln!("跳过：未找到 external-cli/ffmpeg");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let video = dir.path().join("plain.mp4");
    make_video(
        &ffmpeg,
        &video,
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=3:size=640x360:rate=15",
        ],
    );

    let now = dir.path().join("now.jpg");
    let before = dir.path().join("before.jpg");
    hp_media::extract_thumbnail(&video, &now, &ffmpeg, TIMEOUT).expect("抽首帧");
    extract_reference(&ffmpeg, &video, &before, None);

    // 首帧非黑 ⇒ 过滤链一帧都不丢，产物必须与旧实现**逐字节相同**（零回归）。
    assert_same(&read(&now), &read(&before), "首帧非黑");
}

#[test]
fn black_lead_is_skipped() {
    let Some(ffmpeg) = bundled_ffmpeg() else {
        eprintln!("跳过：未找到 external-cli/ffmpeg");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let video = dir.path().join("lead.mp4");
    let args = black_then_content(SHORT_LEAD_SECS, 3);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    make_video(&ffmpeg, &video, &args);

    let now = dir.path().join("now.jpg");
    let first = dir.path().join("first.jpg");
    let after = dir.path().join("after.jpg");
    hp_media::extract_thumbnail(&video, &now, &ffmpeg, TIMEOUT).expect("抽首帧");
    extract_reference(&ffmpeg, &video, &first, None);
    extract_reference(
        &ffmpeg,
        &video,
        &after,
        Some(&format!("{SHORT_LEAD_SECS}.0")),
    );

    // 黑屏被跳过：产物不再是那帧全黑的首帧，而是黑屏之后的第一个画面。
    assert_ne!(read(&now), read(&first), "片头黑屏没有被跳过（仍是首帧）");
    assert_same(&read(&now), &read(&after), "跳过的落点");
}

#[test]
fn all_black_video_falls_back_to_the_first_frame() {
    let Some(ffmpeg) = bundled_ffmpeg() else {
        eprintln!("跳过：未找到 external-cli/ffmpeg");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let video = dir.path().join("black.mp4");
    make_video(
        &ffmpeg,
        &video,
        &[
            "-f",
            "lavfi",
            "-i",
            "color=black:duration=3:size=640x360:rate=15",
        ],
    );

    let now = dir.path().join("now.jpg");
    let before = dir.path().join("before.jpg");
    // 全黑视频：过滤链会一帧都不选中（ffmpeg 仍 exit 0、只是不建文件），此时回退抽首帧。
    hp_media::extract_thumbnail(&video, &now, &ffmpeg, TIMEOUT).expect("全黑视频也必须出图");
    extract_reference(&ffmpeg, &video, &before, None);

    assert_same(&read(&now), &read(&before), "全黑视频的兜底");
}

#[test]
fn black_lead_longer_than_the_window_falls_back_to_the_first_frame() {
    let Some(ffmpeg) = bundled_ffmpeg() else {
        eprintln!("跳过：未找到 external-cli/ffmpeg");
        return;
    };
    let window = hp_media::VIDEO_BLACK_SKIP_WINDOW.as_secs();
    let dir = tempfile::tempdir().unwrap();
    let video = dir.path().join("long-lead.mp4");
    // 黑开场**不短于**窗口 ⇒ 窗口内没有非黑帧可跳，如实退回首帧（边界，不是 bug）。
    let args = black_then_content(window + 1, 2);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    make_video(&ffmpeg, &video, &args);

    let now = dir.path().join("now.jpg");
    let before = dir.path().join("before.jpg");
    hp_media::extract_thumbnail(&video, &now, &ffmpeg, TIMEOUT).expect("抽首帧");
    extract_reference(&ffmpeg, &video, &before, None);

    assert_same(&read(&now), &read(&before), "黑开场长于窗口的兜底");
}
