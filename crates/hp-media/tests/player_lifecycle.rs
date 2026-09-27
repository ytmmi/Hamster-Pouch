//! `MediaProcess` 全生命周期回归测试（需要本机 mpv，默认 `#[ignore]`）。
//!
//! 为什么单独写：IPC 管道在 Windows 上只有**一个**句柄可用（第二个 `open` 直接
//! `ERROR_PIPE_BUSY`），且**同一个文件对象上的阻塞读会挡住写**。这两条约束决定了
//! "后台线程常驻阻塞读 + 主线程写命令"必然死锁——表现为第一次播放正常、之后每次
//! 播放/取进度都永久挂起。
//!
//! 因此这里按真实使用顺序反复跑：启动 → 加载 → 取进度 → 暂停 → 再加载 → 再取进度，
//! 任一步阻塞都会让测试超时失败。
//!
//! 运行：`cargo test -p hp-media --test player_lifecycle -- --ignored --nocapture`

use std::path::PathBuf;
use std::time::{Duration, Instant};

use hp_media::MediaProcess;

/// 找仓库内的 mpv（向上查找，与宿主侧解析口径一致）。
fn mpv_path() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        let candidate = dir.join("external-cli/mpv/mpv.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// 找一个真实视频文件（仓库内测试数据不保证存在，缺失时跳过）。
fn sample_video() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HP_TEST_VIDEO") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

#[test]
#[ignore = "需要本机 mpv 与 HP_TEST_VIDEO 指向的视频文件"]
fn repeated_load_and_poll_never_blocks() {
    let Some(mpv) = mpv_path() else {
        eprintln!("跳过：未找到 external-cli/mpv/mpv.exe");
        return;
    };
    let Some(video) = sample_video() else {
        eprintln!("跳过：未设置 HP_TEST_VIDEO（指向一个真实视频文件）");
        return;
    };

    let mut process = MediaProcess::spawn(&mpv, None).expect("启动媒体子进程");

    for round in 1..=3 {
        let started = Instant::now();
        process.load_file(&video).expect("加载文件");
        eprintln!("round {round}: load_file 用时 {:?}", started.elapsed());

        // 等 mpv 探测出时长（最多 5s），期间反复取进度——这一步最容易暴露阻塞。
        let mut duration = None;
        for _ in 0..50 {
            let state = process.playback_state().expect("取播放进度");
            if let Some(d) = state.duration_ms {
                duration = Some(d);
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        eprintln!("round {round}: duration={duration:?}");

        // 位置应能推进
        std::thread::sleep(Duration::from_millis(700));
        let state = process.playback_state().expect("取播放进度");
        eprintln!("round {round}: position={:?} paused={:?}", state.position_ms, state.paused);

        // 暂停/继续也要能用
        process.set_pause(true).expect("暂停");
        let paused = process.playback_state().expect("取进度").paused;
        assert_eq!(paused, Some(true), "暂停后 paused 应为 true");
        process.set_pause(false).expect("继续");

        assert!(
            started.elapsed() < Duration::from_secs(30),
            "round {round} 用时过长，疑似阻塞"
        );
    }

    process.shutdown().expect("关闭子进程");
}
