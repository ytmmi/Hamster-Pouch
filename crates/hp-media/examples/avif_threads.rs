//! AVIF / HEIC 解码的并行度基准（**排查/度量用**，不进产品路径）。
//!
//! 用法：
//! ```text
//! cargo run -q --release -p hp-media --example avif_threads -- <目录> \
//!     [--workers N] [--threads N] [--mode hook|direct|ffmpeg]
//! ```
//!
//! - `--mode hook`（默认）：走 `decode_image_fallback`，即产品当前的
//!   `libheif` → `image::open` 钩子路径；本机 libheif 没有 AV1 解码器时它会失败，
//!   产品的真路径因此是 ffmpeg 兜底——这正是 `--mode ffmpeg` 要测的。
//! - `--mode direct`：绕过钩子，直接用 `libheif_rs::HeifContext` 并显式
//!   `set_max_decoding_threads(N)`。
//! - `--mode ffmpeg`：**复刻产品 ffmpeg 兜底管线**
//!   `-hide_banner -loglevel error [-threads N] -i <src> -frames:v 1 -f image2pipe -vcodec png -`，
//!   只改 `-threads`，用来回答"文件级并行已经拉满时，单张再开内部线程是不是纯浪费"。
//! - `--workers`：并发解码的文件数（默认 = 逻辑核数）。
//!
//! 输出：总耗时、每张均耗时、失败数。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use hp_media::decode_image_fallback;
use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Hook,
    Direct,
    Ffmpeg,
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dir: PathBuf = args.next().expect("缺少目录").into();
    let mut workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let mut threads = 0u32;
    let mut mode = Mode::Hook;
    let mut ffmpeg = PathBuf::from("external-cli/ffmpeg/bin/ffmpeg.exe");
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--workers" => workers = args.next().expect("--workers 缺参").parse().expect("非法"),
            "--threads" => threads = args.next().expect("--threads 缺参").parse().expect("非法"),
            "--mode" => {
                mode = match args.next().expect("--mode 缺参").as_str() {
                    "hook" => Mode::Hook,
                    "direct" => Mode::Direct,
                    "ffmpeg" => Mode::Ffmpeg,
                    other => panic!("未知 mode：{other}"),
                }
            }
            "--ffmpeg" => ffmpeg = args.next().expect("--ffmpeg 缺参").into(),
            other => panic!("未知参数：{other}"),
        }
    }

    let mut files = Vec::new();
    collect(&dir, &mut files);
    files.sort();
    assert!(
        !files.is_empty(),
        "目录里没有可解码的图片：{}",
        dir.display()
    );

    let next = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    let started = Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..workers.max(1) {
            scope.spawn(|| {
                loop {
                    let idx = next.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = files.get(idx) else { break };
                    let result = match mode {
                        Mode::Hook => decode_image_fallback(
                            path,
                            // 产品在扫描/预览时总会带 ffmpeg 兜底；这里同样带上，
                            // 才能测到"本机 libheif 无 AV1 解码器"时的真实路径。
                            Some(&ffmpeg),
                            u32::MAX,
                            std::time::Duration::from_secs(30),
                        )
                        .map(|_| ())
                        .map_err(|e| e.to_string()),
                        Mode::Direct => decode_direct(path, threads),
                        Mode::Ffmpeg => decode_ffmpeg(&ffmpeg, path, threads),
                    };
                    if let Err(e) = result {
                        report(path, &e);
                        failed.fetch_add(1, Ordering::Relaxed);
                    }
                }
            });
        }
    });
    let elapsed = started.elapsed().as_secs_f64();
    let per = elapsed * 1000.0 / files.len() as f64;
    println!(
        "mode={:?} workers={workers} threads={threads} · {} 张 · {elapsed:.3} s · {per:.1} ms/张 · 失败 {}",
        mode,
        files.len(),
        failed.load(Ordering::Relaxed)
    );
}

fn decode_direct(path: &Path, threads: u32) -> Result<(), String> {
    let mut ctx = HeifContext::read_from_file(path.to_str().ok_or("路径非 UTF-8")?)
        .map_err(|e| e.to_string())?;
    ctx.set_max_decoding_threads(threads);
    let handle = ctx.primary_image_handle().map_err(|e| e.to_string())?;
    let img = LibHeif::new()
        .decode(&handle, ColorSpace::Rgb(RgbChroma::Rgb), None)
        .map_err(|e| e.to_string())?;
    let planes = img.planes();
    let data = planes.interleaved.ok_or("没有交错平面")?;
    let sum: u64 = data.data.iter().step_by(4096).map(|b| u64::from(*b)).sum();
    std::hint::black_box(sum);
    Ok(())
}

/// 与 `hp_media::decode::decode_image_with_ffmpeg` 完全同款参数，只多一个 `-threads`。
fn decode_ffmpeg(ffmpeg: &Path, src: &Path, threads: u32) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error"]);
    if threads > 0 {
        cmd.args(["-threads", &threads.to_string()]);
    }
    cmd.arg("-i")
        .arg(src)
        .args(["-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = cmd.output().map_err(|e| format!("启动 ffmpeg 失败: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffmpeg 解码失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.is_empty() {
        return Err("ffmpeg 未产出图像数据".into());
    }
    std::hint::black_box(output.stdout.len());
    Ok(())
}

/// 只打印前 3 条失败原因，避免刷屏。
fn report(path: &Path, message: &str) {
    static SHOWN: AtomicUsize = AtomicUsize::new(0);
    let n = SHOWN.fetch_add(1, Ordering::Relaxed);
    if n < 3 {
        println!("  失败 {}: {message}", path.display());
    }
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(ext.as_str(), "avif" | "heic" | "heif") {
            out.push(path);
        }
    }
}
