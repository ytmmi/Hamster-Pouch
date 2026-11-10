//! 缩略图链路的**解码与编码小工具**（从 `thumbnail` 拆出，2026-11-11）。
//!
//! 为什么独立成模块：`thumbnail.rs` 已顶到门禁的 1200 行上限（`check:line-count`），
//! 而这一组函数（"按路径判 WebP / JPEG 落盘 / 解码源文件 / 解码失败兜底"）自成一个
//! 主题——它们都只关心"怎么把文件变成像素或字节"，与"该走 lowres 还是全解码"的策略
//! 无关（策略在 `thumbnail` 与 `lowres` 里）。
//!
//! 落盘的原子性仍复用 `crate::thumbnail::{temp_sibling, commit}`：同一份"先写临时文件
//! 再 rename"的口径只该有一处实现。

use std::path::Path;
use std::time::Duration;

use hp_core::{HpError, HpResult};

/// 目标路径是否为 WebP（按扩展名判断，大小写不敏感）。
pub(crate) fn is_webp_path(path: &Path) -> bool {
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
pub(crate) fn write_jpeg(img: &image::DynamicImage, output: &Path) -> HpResult<()> {
    // 原子落盘（见模块文档）：并行扫描下同一内容可能被多个线程同时生成。
    let temp = crate::thumbnail::temp_sibling(output);
    let result = (|| -> image::ImageResult<()> {
        let file = std::fs::File::create(&temp)?;
        let mut writer = std::io::BufWriter::new(file);
        img.to_rgb8()
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut writer,
                75,
            ))
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!("写入缩略图失败: {e}")));
    }
    crate::thumbnail::commit(&temp, output)
}

/// 解码图片源文件：进程内路径（EXIF 方向 + 解码，输出与旧实现逐位相同）；
/// 失败时若属 AVIF/HEIC 家族且 ffmpeg 可用，回退 ffmpeg 有界解码（见模块文档）。
///
/// **进程内没有解码器的格式直接走 ffmpeg**（2026-10-11，判据 [`crate::decode::needs_ffmpeg_decode`]）：
/// 对它们试 `into_decoder()` 是必然失败的无效动作（`image` crate 连格式都认不出）。
///
/// `into_decoder()` 与 `DynamicImage::from_decoder` **两处都可能是失败点**：
/// 未编译解码器时（如 AVIF 无 `avif-native`）前者报 `Unsupported`，文件损坏时后者报错，
/// 两处都要进兜底分支。
pub(crate) fn decode_thumbnail_src(
    src: &Path,
    ffmpeg_bin: Option<&Path>,
    max_dim: u32,
    timeout: Duration,
    known: Option<(u32, u32)>,
) -> HpResult<image::DynamicImage> {
    use image::{DynamicImage, ImageDecoder, ImageReader};

    // 首次进入即注册 libheif hooks（幂等）：heic/heif/avif 可进程内解码，
    // 失败才落 ffmpeg 兜底（见 `decode` 模块文档）。
    crate::decode::ensure_libheif_hooks();

    // **大 JPEG 的 -lowres 快路径**（D148 / 0018 §4.2 ②）：按像素分流，
    // 小图仍走进程内（外部进程固定开销反而更慢）。ffmpeg 已应用 EXIF 旋转，
    // 成功即直接返回；失败落回下面的既有进程内路径（行为与旧实现一致）。
    // `known` = 索引里的显示尺寸（缺陷 0043 阶段 3）：给了就不再读文件头，
    // 闸门与 `-lowres` 档位（L=1..3 由原图像素决定）都从它推。
    if let Some(bin) = ffmpeg_bin
        && crate::lowres::should_use_lowres_known(src, max_dim, known)
        && let Ok(img) =
            crate::lowres::decode_lowres_thumbnail_known(src, bin, max_dim, timeout, known)
    {
        return Ok(img);
    }

    // SVG / SVGZ（D112）：进程内 `resvg` 栅格化。**不碰 ffmpeg**——ffmpeg 对 SVG
    // 只有解复用器、没有解码器（`docs/rfc/0005` §4），试它必然失败。
    if crate::svg::is_svg(src) {
        return crate::svg::rasterize_svg(src, max_dim);
    }

    // 进程内**根本没有**解码器（JPEG 2000 / JPEG XL / PSD / PCX…）→ 直接 ffmpeg 有界，
    // 不白试一次必然失败的 `ImageReader`。
    if crate::decode::is_ffmpeg_only_image(src) {
        let Some(bin) = ffmpeg_bin else {
            return Err(HpError::Io(format!(
                "解码图片失败 {}: 该格式需要捆绑 ffmpeg（进程内无解码器）",
                src.display()
            )));
        };
        return crate::decode::decode_image_with_ffmpeg(src, bin, max_dim, timeout).map_err(|fe| {
            HpError::Io(format!(
                "解码图片失败 {}: 进程内无解码器，ffmpeg 兜底: {fe}",
                src.display()
            ))
        });
    }

    // **尺寸分流**（有界请求 + AVIF/HEIC 超大图 + 有 ffmpeg）：直接 ffmpeg 有界，
    // 跳过进程内全分辨率解码（实测大图快 3.4×，见 `decode::LIBHEIF_FULL_RES_MAX_MP`）。
    if max_dim < u32::MAX
        && crate::decode::is_avif_family(src)
        && let Some(bin) = ffmpeg_bin
        && crate::decode::is_huge_avif_family(src)
    {
        return crate::decode::decode_image_with_ffmpeg(src, bin, max_dim, timeout)
            .map_err(|fe| HpError::Io(format!("解码图片失败: 超大图走 ffmpeg 有界失败: {fe}")));
    }

    let reader = ImageReader::open(src)
        .map_err(|e| HpError::Io(format!("打开图片失败: {e}")))?
        .with_guessed_format()
        .map_err(|e| HpError::Io(format!("识别图片格式失败: {e}")))?;
    let mut decoder = match reader.into_decoder() {
        Ok(decoder) => decoder,
        Err(e) => {
            return fallback_decode(
                src,
                ffmpeg_bin,
                max_dim,
                timeout,
                &e.to_string(),
                "创建图片解码器失败",
            );
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
        Err(e) => fallback_decode(
            src,
            ffmpeg_bin,
            max_dim,
            timeout,
            &e.to_string(),
            "解码图片失败",
        ),
    }
}

/// 进程内解码失败后的兜底：AVIF/HEIC 家族且 ffmpeg 可用时走 ffmpeg 有界解码；
/// 其余情况原样返回进程内错误（既有格式口径不变）。
///
/// **进程内无解码器的格式不会走到这里**——它们在上面就被直接送往 ffmpeg 了。
pub(crate) fn fallback_decode(
    src: &Path,
    ffmpeg_bin: Option<&Path>,
    max_dim: u32,
    timeout: Duration,
    cause: &str,
    step: &str,
) -> HpResult<image::DynamicImage> {
    if crate::decode::needs_ffmpeg_decode(src)
        && let Some(bin) = ffmpeg_bin
    {
        return crate::decode::decode_image_with_ffmpeg(src, bin, max_dim, timeout)
            .map_err(|fe| HpError::Io(format!("{step}: {cause}；ffmpeg 兜底: {fe}")));
    }
    Err(HpError::Io(format!("{step}: {cause}")))
}
