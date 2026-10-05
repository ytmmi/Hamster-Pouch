//! 缺陷 0019 的**真实样本端到端验证**（AVIF / HEIC 解码 + 查看器全分辨率预览）。
//!
//! 由环境变量驱动，**不硬编码任何私人路径**：
//!
//! ```text
//! HP_SAMPLE_AVIF=<真实 .avif 文件>
//! HP_SAMPLE_HEIC=<真实 .heif/.heic 文件>
//! ```
//!
//! 两个变量都未设置时整条跳过（不卡 CI / 无样本的机器）；设置了哪个就验哪个。
//! 覆盖三条生产路径：扫描期 `analyze_image`（感知哈希 + 调色板）、按需缩略图
//! `generate_image_thumbnail`（320 有界）、查看器**全分辨率预览**
//! `generate_image_preview`（不缩放，用户 2026-10-06 裁定）。详见 `docs/issues/0019`。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use hp_media::{generate_image_preview, generate_image_thumbnail, IMAGE_THUMB_MAX_DIM};
use hp_scanner::analyze_image;

/// 仓库内捆绑 ffmpeg 的定位（与 `m2_video_scan.rs` 同款）。
fn bundled_ffmpeg() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let mut dir = cwd.as_path();
    loop {
        let candidate = dir.join("external-cli/ffmpeg/bin/ffmpeg.exe");
        if candidate.exists() {
            return Some(candidate);
        }
        dir = dir.parent()?;
    }
}

fn env_sample(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from)
}

/// 用捆绑 ffmpeg 探测原始分辨率（`-i` 输出里的 `WxH`，取最后一次出现的合理帧尺寸）。
///
/// 帧尺寸 token 可能带行尾标点（`11656x8742,`），且流 ID / 编码标签里也有伪 `WxH`
///（`0x31637668`、`0x1`）——先剥掉非数字字符，再要求两维都 ≥ 64（照片帧尺寸下限）
/// 排除这些干扰，取最后一次命中 = 帧尺寸。
fn probe_dims(ffmpeg: &Path, path: &Path) -> Option<(u32, u32)> {
    let out = std::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-i"])
        .arg(path)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stderr);
    text.split_whitespace()
        .filter_map(|tok| {
            let clean: String = tok
                .chars()
                .filter(|c| c.is_ascii_digit() || *c == 'x')
                .collect();
            let (w, h) = clean.split_once('x')?;
            let w = w.parse::<u32>().ok()?;
            let h = h.parse::<u32>().ok()?;
            (w >= 64 && h >= 64).then_some((w, h))
        })
        .last()
}

/// 对单个真实样本跑完整验证：扫描期派生数据 + 320 缩略图 + 全分辨率预览 + 确定性复现。
fn verify_sample(sample: &Path, label: &str, ffmpeg: &Path) {
    let started = Instant::now();

    // 扫描期路径：一次解码 → 感知哈希 + 调色板。
    let derived = analyze_image(sample, true, Some(ffmpeg), Duration::from_secs(60))
        .unwrap_or_else(|e| panic!("{label}: analyze_image 失败: {e}"));
    let perceptual = derived
        .perceptual
        .expect("{label}: 解码成功后必有感知哈希");
    let palette = derived
        .palette
        .expect("{label}: 请求调色板后必须产出");
    assert!(!palette.is_empty(), "{label}: 调色板不应为空");

    // 确定性：同一文件第二次扫描结果必须逐位相同（缓存可比性前提）。
    let again = analyze_image(sample, true, Some(ffmpeg), Duration::from_secs(60))
        .expect("{label}: 第二次分析失败");
    assert_eq!(
        again.perceptual.expect("二次哈希").value,
        perceptual.value,
        "{label}: 感知哈希必须按文件确定性（跨扫描可比）"
    );
    assert_eq!(again.palette.expect("二次调色板"), palette, "{label}: 调色板必须按文件确定性");

    // 按需缩略图路径：320 有界输出 jpg。
    let dir = std::env::temp_dir().join(format!(
        "hp-real-sample-{}-{}",
        std::process::id(),
        std::env::var_os("HP_SAMPLE_TAG").unwrap_or_default().to_string_lossy()
    ));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let out = dir.join(format!("{label}.jpg"));
    generate_image_thumbnail(sample, &out, IMAGE_THUMB_MAX_DIM, Some(ffmpeg), Duration::from_secs(60))
        .unwrap_or_else(|e| panic!("{label}: 缩略图生成失败: {e}"));
    let thumb = image::open(&out).expect("{label}: 缩略图文件应可被 image crate 读取");
    assert!(
        thumb.width() <= IMAGE_THUMB_MAX_DIM && thumb.height() <= IMAGE_THUMB_MAX_DIM,
        "{label}: 缩略图长边应 ≤ {IMAGE_THUMB_MAX_DIM}，实际 {}x{}",
        thumb.width(),
        thumb.height()
    );

    // 查看器**全分辨率预览**：不缩放、q90 JPEG，尺寸必须等于原始分辨率
    //（用户 2026-10-06 裁定：不要 2048 有界预览）。
    let original = probe_dims(ffmpeg, sample)
        .unwrap_or_else(|| panic!("{label}: ffmpeg 探测原始分辨率失败"));
    let preview_out = dir.join(format!("{label}.preview.jpg"));
    generate_image_preview(sample, &preview_out, Some(ffmpeg), Duration::from_secs(120))
        .unwrap_or_else(|e| panic!("{label}: 预览生成失败: {e}"));
    // 只读 JPEG **头部**取尺寸（全分辨率解码 102 MP 太慢，且不是本测试要验的东西；
    // 真实查看由 Chromium 硬件加速解码）。
    let preview_dims = image::ImageReader::open(&preview_out)
        .expect("{label}: 预览应可读")
        .with_guessed_format()
        .expect("{label}: 识别预览格式")
        .into_dimensions()
        .expect("{label}: 读取预览尺寸");
    assert_eq!(
        preview_dims,
        original,
        "{label}: 预览必须是原始分辨率 {original:?}（不许有界缩放），实际 {preview_dims:?}"
    );

    let elapsed = started.elapsed();
    eprintln!(
        "[real-sample] {label}: 原始 {orig_w}x{orig_h} ｜ 缩略图 {thumb_w}x{thumb_h} ｜ 预览 {prev_w}x{prev_h} ｜ 哈希 {perceptual_value} ｜ 调色板 {palette_len} 色 ｜ 全程 {elapsed:?}",
        orig_w = original.0,
        orig_h = original.1,
        thumb_w = thumb.width(),
        thumb_h = thumb.height(),
        prev_w = preview_dims.0,
        prev_h = preview_dims.1,
        perceptual_value = &perceptual.value,
        palette_len = palette.len(),
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn real_avif_heic_samples_decode_end_to_end() {
    let Some(ffmpeg) = bundled_ffmpeg() else {
        eprintln!("跳过：未找到 external-cli/ffmpeg");
        return;
    };
    let avif = env_sample("HP_SAMPLE_AVIF");
    let heic = env_sample("HP_SAMPLE_HEIC");
    if avif.is_none() && heic.is_none() {
        eprintln!("跳过：未设置 HP_SAMPLE_AVIF / HP_SAMPLE_HEIC（真实样本验证需环境变量）");
        return;
    }
    if let Some(avif) = avif {
        assert!(avif.exists(), "HP_SAMPLE_AVIF 指向的文件不存在: {avif:?}");
        verify_sample(&avif, "avif", &ffmpeg);
    }
    if let Some(heic) = heic {
        assert!(heic.exists(), "HP_SAMPLE_HEIC 指向的文件不存在: {heic:?}");
        verify_sample(&heic, "heif", &ffmpeg);
    }
}
