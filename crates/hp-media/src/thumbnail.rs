//! 缩略图生成：ffmpeg 首帧抽帧（D16，视频）+ 图片进程内缩放（AVIF/HEIC 家族回退
//! 捆绑 ffmpeg 有界解码，见 `docs/issues/0018` §7 P1-D）。
//!
//! **落盘格式按媒体类型分流**（用户 2026-10-08 口径：「同像素和质量的情况下，选择
//! 体积更小的格式」）：
//!
//! - **图片缩略图 → WebP**（ffmpeg 的 `libwebp`，质量 [`IMAGE_THUMB_WEBP_QUALITY`]）；
//! - **视频首帧缩略图 → JPEG**（ffmpeg 的 `mjpeg`，沿用既有 `-q:v 3`）。
//!
//! 实测依据（真实照片语料，长边 320、SSIM 对齐，见 `docs/issues/0029`）：WebP 在
//! **每张图**上都比 JPEG 小，等质量下体积约为 JPEG 的 **0.53–0.57**（省 43%–47%）；
//! 真实生产代码路径 A/B（60 张）实测 **0.572（省 42.8%）**。
//!
//! 视频**不跟着换**，理由是 `crates/hp-scanner` 在抽帧后对**缩略图本身**算 dHash
//! （`process_video` 的 `dhash_file(&thumb_path)`），换编码会轻微改变像素、使已入库的
//! 视频感知哈希与新值不再逐位可比（实测汉明距离中位 0、最大 5 bit），属需要独立裁决的
//! 迁移问题。图片路径不受影响：图片的 dHash 取自**源图**而非缩略图。
//!
//! **落盘是原子的**：一律先写同目录下的临时文件、成功后 `rename` 到目标名。
//! 原因是扫描已改为**并行**（`docs/issues/0018`）：同一份内容（内容哈希相同）
//! 可能被两个线程同时抽帧，直接写目标文件会交错出半张图；而 `rename` 在同一卷内
//! 是原子的，后到者覆盖先到者，读到的永远是**完整**文件。顺带也消除了
//! "生成中途崩溃留下损坏缩略图、此后一直被 `exists()` 命中"的问题。

use std::path::{Path, PathBuf};
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::{hidden_command, run_with_timeout, run_with_timeout_stdin};

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
    // `hidden_command`：GUI 父进程下不新建控制台窗口（源扫描抽帧）。
    let mut cmd = hidden_command(ffmpeg_bin);
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

/// 图片缩略图 WebP 质量（`libwebp -quality`）。
///
/// **为什么是 70**：用户口径是「**同质量**下取体积更小的格式」。实测（`docs/issues/0029`，
/// 真实照片语料、SSIM 对齐）WebP `-quality 70` 的平均 SSIM **0.9675**，与既有 JPEG
/// （`image` crate `JpegEncoder` quality 75、4:4:4）的 **0.9674** 基本相等，而体积为
/// **0.53×**——即"同质量、体积减半"。取更高只会白扔压缩收益：
/// `-quality 90` 的 SSIM 0.9908 已明显高于旧 JPEG，体积也反超（1.05×），不再是"同质量"比较。
pub const IMAGE_THUMB_WEBP_QUALITY: u8 = 70;

/// 用 ffmpeg 的 `libwebp` 把 `img` 编码成 WebP 并原子落盘到 `output_webp`。
///
/// 走**进程内解码 + 缩放 → ffmpeg 只做编码**（rawvideo 经 stdin 管道喂像素），而不是
/// `ffmpeg -i <源文件>` 一把梭：缩放仍在进程内完成，因此
/// - 结果与既有实现**同一套缩放算法**（`image::DynamicImage::thumbnail`），
/// - 源图若已由进程内路径解码（含 libheif 的 HEIC/AVIF），不必让 ffmpeg 再解一遍，
/// - 实测比"一把梭"更快（省掉 ffmpeg 的源图解码）。
///
/// 编码失败（ffmpeg 缺失 / 版本无 libwebp / 超时）返回 `HpError::Io`，调用方降级为 JPEG。
fn encode_webp_via_ffmpeg(
    img: &image::DynamicImage,
    output_webp: &Path,
    ffmpeg_bin: &Path,
    timeout: Duration,
) -> HpResult<()> {
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    // 先写到临时文件，成功后原子改名（见模块文档）。
    let temp = temp_sibling(output_webp);
    // `hidden_command`：GUI 父进程下不新建控制台窗口（首次生成图片缩略图）。
    let mut cmd = hidden_command(ffmpeg_bin);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error"])
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24"])
        .args(["-s", &format!("{w}x{h}")])
        .args(["-i", "-", "-frames:v", "1"])
        .args(["-c:v", "libwebp"])
        .args(["-quality", &IMAGE_THUMB_WEBP_QUALITY.to_string()])
        .arg(&temp);

    // 像素经 stdin 喂入：数据量（320×320 RGB ≈ 300 KiB）远超管道缓冲，必须并发写（见 process 文档）。
    let output = match run_with_timeout_stdin(&mut cmd, timeout, Some(rgb.into_raw())) {
        Ok(o) => o,
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    };
    if !output.status.success() {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!(
            "ffmpeg 编码 WebP 失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    commit(&temp, output_webp)
}

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
    // `hidden_command`：GUI 父进程下不新建控制台窗口（首次查看 HEIC/HEIF 的全分辨率预览）。
    let mut cmd = hidden_command(ffmpeg_bin);
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

/// 生成图片缩略图：应用 EXIF 方向后等比缩放到长边不超过 `max_dim`，写入 `output`。
///
/// **落盘格式由 `output` 的扩展名决定**（调用方经 `ThumbnailCache::path_for_image` 取路径）：
/// - `.webp` → ffmpeg `libwebp`（默认路径，体积约为 JPEG 的一半，见模块文档）；
/// - 其它（如 `.jpg`）→ 进程内 JPEG，沿用 `image` crate 的默认质量 75。
///
/// 解码优先走进程内 `image` crate（jpg/png 等既有格式输出与旧实现**逐位相同**）；
/// AVIF/HEIC 家族进程内失败时回退**捆绑 ffmpeg 有界解码**（`src/decode.rs`，输出已
/// 缩到 ≤ `max_dim`，ffmpeg 默认应用旋转元数据）。小图不放大；读取 / 解码 / 写入失败
/// 返回 `HpError::Io`（调用方可降级为占位）。
///
/// **WebP 失败时降级为 JPEG 同路径落盘**：`ffmpeg_bin` 缺失、或该构建没有 `libwebp`
/// 时，宁可用体积大些的 JPEG 也要有图（与 `ffmpeg` 缺失时既有行为一致）。
pub fn generate_image_thumbnail(
    src: &Path,
    output: &Path,
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

    if is_webp_path(output) {
        if let Some(bin) = ffmpeg_bin {
            if encode_webp_via_ffmpeg(&thumb, output, bin, timeout).is_ok() {
                return Ok(());
            }
        }
        // 降级：没有 ffmpeg / 无 libwebp / 编码失败——写 JPEG 到**同一个目标路径**
        // （后缀仍是 .webp，但内容按魔数自描述，Chromium 与 ffmpeg 都能按内容识别）。
        // 保证"有图"优先于"格式正确"；换路径会让调用方的缓存命中判断失效。
        return write_jpeg(&thumb, output);
    }

    write_jpeg(&thumb, output)
}

/// 目标路径是否为 WebP（按扩展名判断，大小写不敏感）。
fn is_webp_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("webp"))
}

/// 把图像编码为 JPEG 并原子落盘（沿用 `image` crate 的默认质量 75）。
///
/// **必须显式指定 JPEG 编码器**：`DynamicImage::save` 按**路径扩展名**选编码器，而本函数
/// 要写的是 `.webp` 目标（WebP 编码失败的降级路径），`save` 会因此选中
/// `WebPEncoder::new_lossless`——无损 WebP 实测体积约为 JPEG 的 **4.5×**，
/// 比不降级还糟。显式构造 `JpegEncoder` 后，内容与后缀不一致是**刻意**的：
/// 图片格式自描述（JPEG 魔数 `FF D8 FF`），Chromium 与 ffmpeg 都按内容识别。
fn write_jpeg(img: &image::DynamicImage, output: &Path) -> HpResult<()> {
    // 原子落盘（见模块文档）：并行扫描下同一内容可能被多个线程同时生成。
    let temp = temp_sibling(output);
    let result = (|| -> image::ImageResult<()> {
        let file = std::fs::File::create(&temp)?;
        let mut writer = std::io::BufWriter::new(file);
        img.to_rgb8().write_with_encoder(
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, 75),
        )
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!("写入缩略图失败: {e}")));
    }
    commit(&temp, output)
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
        let status = crate::process::hidden_command(&ffmpeg)
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

    /// 读文件头若干字节（判格式用）。
    fn magic(path: &Path) -> Vec<u8> {
        use std::io::Read;
        let mut buf = vec![0u8; 16];
        let mut f = std::fs::File::open(path).expect("打开文件失败");
        let n = f.read(&mut buf).expect("读取失败");
        buf.truncate(n);
        buf
    }

    /// `.webp` 目标 + 有 ffmpeg：应落盘**真正的有损 WebP**（RIFF....WEBP），且能解回。
    ///
    /// 这条断言钉住的是"用户口径"本身：图片缩略图必须是 WebP。若哪天退回 JPEG，
    /// 体积优势（实测约一半）会静默消失，而功能测试不会发现。
    #[test]
    fn image_thumbnail_is_lossy_webp_when_ffmpeg_available() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到 external-cli/ffmpeg");
            return;
        };
        let dir = std::env::temp_dir().join(format!("hp-thumb-webp-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("src.png");
        let out = dir.join("out.webp");
        // 有梯度、非纯色，避免退化成"随便编码都极小"的平凡样本。
        let img = image::RgbImage::from_fn(800, 400, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
        });
        img.save(&src).expect("写入测试图片失败");

        generate_image_thumbnail(&src, &out, 320, Some(&ffmpeg), Duration::from_secs(30))
            .expect("WebP 缩略图应生成成功");

        let head = magic(&out);
        assert_eq!(&head[0..4], b"RIFF", "应为 RIFF 容器，实际 {head:?}");
        assert_eq!(&head[8..12], b"WEBP", "应为 WebP，实际 {head:?}");
        let thumb = image::open(&out).expect("WebP 缩略图应可解码");
        assert_eq!((thumb.width(), thumb.height()), (320, 160));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 没有 ffmpeg 时（`None`）降级为 JPEG：内容须是 JPEG，且**不得**退化成无损 WebP。
    ///
    /// 这是本改动的关键回归点：`DynamicImage::save` 按**扩展名**选编码器，写 `.webp`
    /// 目标会选中 `WebPEncoder::new_lossless`——实测无损 WebP 体积约为 JPEG 的 **4.5×**。
    /// 因此降级必须显式用 `JpegEncoder`，本断言按魔数钉死。
    #[test]
    fn webp_target_without_ffmpeg_falls_back_to_jpeg_not_lossless_webp() {
        let dir = std::env::temp_dir().join(format!("hp-thumb-fallback-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("src.png");
        let out = dir.join("out.webp");
        let img = image::RgbImage::from_fn(800, 400, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
        });
        img.save(&src).expect("写入测试图片失败");

        generate_image_thumbnail(&src, &out, 320, None, Duration::from_secs(30))
            .expect("无 ffmpeg 时应降级成功");
        let head = magic(&out);
        assert_eq!(&head[0..3], &[0xFF, 0xD8, 0xFF], "降级产物应为 JPEG，实际 {head:?}");
        assert_ne!(&head[0..4], b"RIFF", "降级**不得**写成无损 WebP");
        // 按**内容**解码（`image::open` 按扩展名选解码器，而这里后缀与内容刻意不一致）。
        let thumb = image::ImageReader::open(&out)
            .expect("打开失败")
            .with_guessed_format()
            .expect("识别格式失败")
            .decode()
            .expect("降级 JPEG 应可解码");
        assert_eq!((thumb.width(), thumb.height()), (320, 160));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `.jpg` 目标仍走进程内 JPEG（视频首帧抽帧那条路径不受影响）。
    #[test]
    fn jpg_target_stays_jpeg() {
        let dir = std::env::temp_dir().join(format!("hp-thumb-jpg-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("src.png");
        let out = dir.join("out.jpg");
        image::RgbImage::from_pixel(400, 200, image::Rgb([1, 2, 3]))
            .save(&src)
            .expect("写入测试图片失败");

        generate_image_thumbnail(&src, &out, 320, None, Duration::from_secs(30))
            .expect("生成缩略图失败");
        assert_eq!(&magic(&out)[0..3], &[0xFF, 0xD8, 0xFF], "应为 JPEG");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// WebP 质量常量必须在 `libwebp` 的合法区间内（0–100），且是我们实测选定的 70。
    #[test]
    fn webp_quality_is_within_libwebp_range() {
        assert!(IMAGE_THUMB_WEBP_QUALITY <= 100);
        assert_eq!(IMAGE_THUMB_WEBP_QUALITY, 70);
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
