//! 缩略图生成：ffmpeg 首帧抽帧（D16，视频）+ 图片进程内缩放（AVIF/HEIC 家族回退
//! 捆绑 ffmpeg 有界解码，见 `docs/issues/0018` §7 P1-D）。
//!
//! **落盘是原子的**：一律先写同目录下的临时文件、成功后 `rename` 到目标名。
//! 原因是扫描已改为**并行**（`docs/issues/0018`）：同一份内容（内容哈希相同）
//! 可能被两个线程同时抽帧，直接写目标文件会交错出半张图；而 `rename` 在同一卷内
//! 是原子的，后到者覆盖先到者，读到的永远是**完整**文件。顺带也消除了
//! "生成中途崩溃留下损坏缩略图、此后一直被 `exists()` 命中"的问题。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::run_with_timeout;

/// 抽帧过滤器：宽度不超过 512、高度按比例，小图不放大。
const SCALE_FILTER: &str = "scale='min(512,iw)':-2";

/// 为 `target` 生成一个同目录、同扩展名的唯一临时路径。
///
/// 必须**同目录**：跨卷 `rename` 会退化成复制，就不再是原子替换了。
/// 进程号 + 计数器保证并发线程之间不撞名。
fn temp_sibling(target: &Path) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let name = target
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("thumb");
    target.with_file_name(format!(".{name}.{}.{seq}.tmp{ext}", std::process::id()))
}

/// 把 `temp` 原子地替换到 `target`；失败时清理临时文件。
fn commit(temp: &Path, target: &Path) -> HpResult<()> {
    match std::fs::rename(temp, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(temp);
            Err(HpError::Io(format!("写入缩略图失败: {e}")))
        }
    }
}

/// 抽取视频首帧并写入 `output_jpg`；失败返回 `HpError::Io`（调用方可用占位图降级）。
pub fn extract_thumbnail(
    video_path: &Path,
    output_jpg: &Path,
    ffmpeg_bin: &Path,
    timeout: Duration,
) -> HpResult<()> {
    // 先写到临时文件，成功后原子改名（见模块文档）。
    let temp = temp_sibling(output_jpg);
    let mut cmd = Command::new(ffmpeg_bin);
    cmd.args(["-y", "-i"])
        .arg(video_path)
        .args(["-frames:v", "1", "-vf", SCALE_FILTER, "-q:v", "3"])
        .arg(&temp);

    let output = match run_with_timeout(&mut cmd, timeout) {
        Ok(o) => o,
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    };
    if !output.status.success() {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!(
            "ffmpeg 抽帧失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    commit(&temp, output_jpg)
}

/// 图片缩略图长边上限（像素）。缩略图只缩小不放大，足够覆盖网格单元。
pub const IMAGE_THUMB_MAX_DIM: u32 = 320;

/// 生成**全分辨率** JPEG 预览（`preview.get` 命令，供 Chromium 无法原生解码的
/// HEIC/HEIF 查看器使用，缺陷 0019）。
///
/// - 有 ffmpeg：**ffmpeg 直出 JPEG**（`-q:v 2`，单趟解码 + 编码，libjpeg 级质量 ≈90；
///   无中间像素往返，102 MP 也只需数秒）——查看器要能 100% 检视细节；
/// - 无 ffmpeg（测试夹具等）：进程内解码（仅可解格式）→ JPEG 质量 90。
///
/// **不缩放**：用户 2026-10-06 裁定（不要 2048 有界预览），预览尺寸 = 原始分辨率。
/// 代价是首次生成耗时与缓存体积按原始分辨率走，之后缓存命中即显示。
pub fn generate_image_preview(
    src: &Path,
    output_jpg: &Path,
    ffmpeg_bin: Option<&Path>,
    timeout: Duration,
) -> HpResult<()> {
    if let Some(bin) = ffmpeg_bin {
        return generate_preview_via_ffmpeg(src, output_jpg, bin, timeout);
    }
    generate_preview_via_image(src, output_jpg, timeout)
}

/// ffmpeg 直出 JPEG：一条管线（解码 → mjpeg 编码），无中间像素往返。
fn generate_preview_via_ffmpeg(
    src: &Path,
    output_jpg: &Path,
    ffmpeg_bin: &Path,
    timeout: Duration,
) -> HpResult<()> {
    // 先写到临时文件，成功后原子改名（见模块文档）。
    let temp = temp_sibling(output_jpg);
    let mut cmd = Command::new(ffmpeg_bin);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(src)
        .args(["-frames:v", "1", "-q:v", "2"])
        .arg(&temp);
    let output = match run_with_timeout(&mut cmd, timeout) {
        Ok(o) => o,
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    };
    if !output.status.success() {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!(
            "ffmpeg 生成预览失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    commit(&temp, output_jpg)
}

/// 进程内解码 → JPEG 质量 90（仅 ffmpeg 缺失时的兜底；`u32::MAX` = 不缩放）。
fn generate_preview_via_image(
    src: &Path,
    output_jpg: &Path,
    timeout: Duration,
) -> HpResult<()> {
    let img = decode_thumbnail_src(src, None, u32::MAX, timeout)?;
    // 原子落盘（见模块文档）：与缩略图同款，并发安全。
    let temp = temp_sibling(output_jpg);
    let result = (|| -> image::ImageResult<()> {
        let file = std::fs::File::create(&temp)?;
        let mut writer = std::io::BufWriter::new(file);
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, 90);
        img.to_rgb8().write_with_encoder(encoder)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!("写入预览失败: {e}")));
    }
    commit(&temp, output_jpg)
}

/// 生成图片缩略图：应用 EXIF 方向后等比缩放到长边不超过 `max_dim`，写入 `output_jpg`。
///
/// 解码优先走进程内 `image` crate（jpg/png 等既有格式输出与旧实现**逐位相同**）；
/// AVIF/HEIC 家族进程内失败时回退**捆绑 ffmpeg 有界解码**（`src/decode.rs`，输出已
/// 缩到 ≤ `max_dim`，ffmpeg 默认应用旋转元数据）。小图不放大；读取 / 解码 / 写入失败
/// 返回 `HpError::Io`（调用方可降级为占位）。
pub fn generate_image_thumbnail(
    src: &Path,
    output_jpg: &Path,
    max_dim: u32,
    ffmpeg_bin: Option<&Path>,
    timeout: Duration,
) -> HpResult<()> {
    let img = decode_thumbnail_src(src, ffmpeg_bin, max_dim, timeout)?;

    // 仅当长边超过上限时缩放，避免小图被放大。
    let thumb = if img.width() > max_dim || img.height() > max_dim {
        img.thumbnail(max_dim, max_dim)
    } else {
        img
    };
    // 原子落盘（见模块文档）：并行扫描下同一内容可能被多个线程同时生成。
    let temp = temp_sibling(output_jpg);
    if let Err(e) = thumb.to_rgb8().save(&temp) {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!("写入缩略图失败: {e}")));
    }
    commit(&temp, output_jpg)
}

/// 解码图片源文件：进程内路径（EXIF 方向 + 解码，输出与旧实现逐位相同）；
/// 失败时若属 AVIF/HEIC 家族且 ffmpeg 可用，回退 ffmpeg 有界解码（见模块文档）。
///
/// `into_decoder()` 与 `DynamicImage::from_decoder` **两处都可能是失败点**：
/// 未编译解码器时（如 AVIF 无 `avif-native`）前者报 `Unsupported`，文件损坏时后者报错，
/// 两处都要进兜底分支。
fn decode_thumbnail_src(
    src: &Path,
    ffmpeg_bin: Option<&Path>,
    max_dim: u32,
    timeout: Duration,
) -> HpResult<image::DynamicImage> {
    use image::{DynamicImage, ImageDecoder, ImageReader};

    // 首次进入即注册 libheif hooks（幂等）：heic/heif/avif 可进程内解码，
    // 失败才落 ffmpeg 兜底（见 `decode` 模块文档）。
    crate::decode::ensure_libheif_hooks();
    // **尺寸分流**（有界请求 + AVIF/HEIC 超大图 + 有 ffmpeg）：直接 ffmpeg 有界，
    // 跳过进程内全分辨率解码（实测大图快 3.4×，见 `decode::LIBHEIF_FULL_RES_MAX_MP`）。
    if max_dim < u32::MAX && crate::decode::is_avif_family(src) {
        if let Some(bin) = ffmpeg_bin {
            if crate::decode::is_huge_avif_family(src) {
                return crate::decode::decode_image_with_ffmpeg(src, bin, max_dim, timeout)
                    .map_err(|fe| {
                        HpError::Io(format!("解码图片失败: 超大图走 ffmpeg 有界失败: {fe}"))
                    });
            }
        }
    }

    let reader = ImageReader::open(src)
        .map_err(|e| HpError::Io(format!("打开图片失败: {e}")))?
        .with_guessed_format()
        .map_err(|e| HpError::Io(format!("识别图片格式失败: {e}")))?;
    let mut decoder = match reader.into_decoder() {
        Ok(decoder) => decoder,
        Err(e) => {
            return fallback_decode(src, ffmpeg_bin, max_dim, timeout, &e.to_string(), "创建图片解码器失败");
        }
    };
    // 读取 EXIF 方向（缺失 / 不可读时按无变换处理，不报错）。
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    match DynamicImage::from_decoder(decoder) {
        Ok(mut img) => {
            img.apply_orientation(orientation);
            Ok(img)
        }
        Err(e) => fallback_decode(src, ffmpeg_bin, max_dim, timeout, &e.to_string(), "解码图片失败"),
    }
}

/// 进程内解码失败后的兜底：仅 AVIF/HEIC 家族且 ffmpeg 可用时走 ffmpeg 有界解码；
/// 其余情况原样返回进程内错误（既有格式口径不变）。
fn fallback_decode(
    src: &Path,
    ffmpeg_bin: Option<&Path>,
    max_dim: u32,
    timeout: Duration,
    cause: &str,
    step: &str,
) -> HpResult<image::DynamicImage> {
    if crate::decode::is_avif_family(src) {
        if let Some(bin) = ffmpeg_bin {
            return crate::decode::decode_image_with_ffmpeg(src, bin, max_dim, timeout).map_err(
                |fe| HpError::Io(format!("{step}: {cause}；ffmpeg 兜底: {fe}")),
            );
        }
    }
    Err(HpError::Io(format!("{step}: {cause}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downscales_longest_side_without_upscaling() {
        let dir = std::env::temp_dir().join(format!("hp-thumb-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("big.png");
        let out = dir.join("big.jpg");
        let img = image::RgbImage::from_pixel(800, 400, image::Rgb([10, 20, 30]));
        img.save(&src).expect("写入测试图片失败");

        generate_image_thumbnail(&src, &out, 320, None, Duration::from_secs(30))
            .expect("生成缩略图失败");
        let thumb = image::open(&out).expect("读取缩略图失败");
        assert_eq!(thumb.width(), 320);
        assert_eq!(thumb.height(), 160);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn small_image_keeps_original_size() {
        let dir = std::env::temp_dir().join(format!("hp-thumb-small-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("small.png");
        let out = dir.join("small.jpg");
        let img = image::RgbImage::from_pixel(100, 50, image::Rgb([200, 100, 0]));
        img.save(&src).expect("写入测试图片失败");

        generate_image_thumbnail(&src, &out, 320, None, Duration::from_secs(30))
            .expect("生成缩略图失败");
        let thumb = image::open(&out).expect("读取缩略图失败");
        assert_eq!(thumb.width(), 100);
        assert_eq!(thumb.height(), 50);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 仓库内捆绑 ffmpeg 的定位（与 `hp-scanner/tests/m2_video_scan.rs` 同款）。
    fn bundled_ffmpeg() -> Option<std::path::PathBuf> {
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

    /// 端到端：AVIF 走 ffmpeg 兜底生成缩略图（依赖捆绑 ffmpeg；缺失时跳过，不卡 CI）。
    #[test]
    fn avif_thumbnail_falls_back_to_bundled_ffmpeg() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到 external-cli/ffmpeg");
            return;
        };
        let dir = std::env::temp_dir().join(format!("hp-thumb-avif-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("sample.avif");
        let out = dir.join("out.jpg");
        let status = std::process::Command::new(&ffmpeg)
            .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=800x600", "-frames:v", "1", "-c:v", "libaom-av1", "-crf", "20", "-still-picture", "1"])
            .arg(&src)
            .status()
            .expect("启动 ffmpeg 失败");
        assert!(status.success(), "生成 AVIF 样本失败");

        generate_image_thumbnail(&src, &out, 320, Some(&ffmpeg), Duration::from_secs(30))
            .expect("AVIF 缩略图应生成成功");
        let thumb = image::open(&out).expect("读取缩略图失败");
        // 800×600 → 长边 320：宽 320、高 240；纯红角像素保留。
        assert_eq!((thumb.width(), thumb.height()), (320, 240));
        let rgb = thumb.to_rgb8();
        let px = rgb.get_pixel(0, 0);
        assert!(px[0] > 200 && px[1] < 60 && px[2] < 60, "角像素应为红色，实际 {px:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn nanos() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{n}")
    }
}
