//! 图片解码层：进程内 `image` crate 优先（`libheif` 特性下 HEIC/HEIF/AVIF 由
//! libheif 挂进 `image` hooks，libde265/aom 进程内解码），失败时回退到捆绑 ffmpeg 的
//! **有界解码**（`docs/issues/0018` §7 的 P1-D，缺陷 0019，2026-10 落地）。
//!
//! ## 为什么需要这一层
//!
//! - **HEIC / HEIF**：`image` crate 自身没有任何 HEIC 解码器；Windows 的 WIC HEIF codec
//!   依赖系统扩展（本机未装，不可依赖）。`libheif` 特性启用后经 libheif-rs 进程内解码
//!   （libde265 解 HEVC）；未启用或解码失败时，捆绑 ffmpeg 的 `mov` demuxer + 原生
//!   `hevc` 解码器兜底（`docs/rfc/0005` D20 依赖本地化）。
//! - **AVIF**：`image` 0.25 的 `avif` feature 只含 ravif **编码器**；`avif-native`
//!   （dav1d）需要系统 dav1d / meson+ninja，实测不可用（2026-10）。libheif 特性下
//!   AVIF 由 libheif（aom）进程内解码；否则走捆绑 ffmpeg（libdav1d，asm 优化）。
//! - **libheif 的构建前提**（用户 2026-10-06 裁定）：libheif-sys 在 Windows/MSVC 下
//!   要求 **vcpkg 安装的 libheif**（`VCPKG_ROOT`，`D:\vcpkg`）；该环境缺失时用
//!   `--no-default-features` 关闭 `libheif` 特性，整条路径退回 ffmpeg 兜底。
//!
//! ## 性能要点（有界解码 + 尺寸分流）
//!
//! ffmpeg 兜底输出**先缩到 ≤ `max_dim` 再进内存**：AVIF/HEIC 的缩略图 / 调色板 /
//! 感知哈希都不需要全分辨率像素（`docs/issues/0018` 实测：大图成本主要在**重采样**
//! 而非解码，9000² 全解码 168 ms、dHash 813 ms、调色板 945 ms）。有界解码把这两项
//! 都压到与 `max_dim` 相当的规模。
//!
//! 进程内 libheif 只能**全分辨率**解码（无缩放解码 API），因此**尺寸分流**：
//! 常规尺寸（≤ [`LIBHEIF_FULL_RES_MAX_MP`]）有界请求走进程内 libheif（典型
//! 1536²–3096² 实测同速）；超大图的有界请求改走 ffmpeg 有界（实测 102 MP HEIF
//! 快 3.4×）。对 AVIF/HEIC 没有既存缓存可比对，因此按文件**确定性**地采用
//! 任一中间尺寸都是安全的（同一文件每次扫描结果一致）。
//!
//! **口径不变**：对 jpg/png/webp/gif/bmp/tiff 等既有格式，本层不做任何介入——它们仍走
//! `image::open`，结果与旧实现**逐位相同**（扫描期感知哈希 / 调色板的缓存可比性不受影响）。
//! 注册 libheif hooks 只**新增** heic/heif/avif 三种格式的解码能力，不改变既有格式。

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::run_with_timeout;

/// 把 libheif 的 heic/heif/avif 解码 hook 挂进 `image` crate（**一次性、幂等**）。
///
/// 注册后 `image::open` 直接进程内解码这三类文件（libde265 / aom）；注册本身返回
/// 的布尔只是"该格式名是否已被占用"，失败也不影响后续（ffmpeg 兜底仍在）。
/// `libheif` 特性关闭时为空操作。`pub(crate)`：`thumbnail` 的进程内解码分支同用。
#[cfg(feature = "libheif")]
pub fn ensure_libheif_hooks() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        libheif_rs::integration::image::register_all_decoding_hooks();
    });
}

#[cfg(not(feature = "libheif"))]
pub fn ensure_libheif_hooks() {}

/// AVIF / HEIC 家族扩展名（触发 ffmpeg 兜底；与 `hp-scanner::media_type.rs` 的图片
/// 判定一致，另含 `heif` 别名）。
const AVIF_FAMILY_EXTS: [&str; 3] = ["avif", "heic", "heif"];

/// **尺寸分流的像素阈值**（百万像素）：libheif-rs 没有缩放解码 API，进程内只能
/// **全分辨率**解码；超过该尺寸时，**有界请求**改走 ffmpeg 有界（实测 102 MP HEIF
/// 全链 10.5 s vs ffmpeg 有界 3.1 s，快 **3.4×** 且内存小）；不超过时进程内 libheif
/// （典型 1536²–3096² = 2.4–9.6 MP 同速、且不依赖 ffmpeg 子进程）。按用户图库口径
/// （`docs/issues/0018`：大量 9000×9000+）权衡：常规尺寸保住进程内解码，超大图保住
/// 0018 确立的有界性能。该值为**可调参数**。
const LIBHEIF_FULL_RES_MAX_MP: u64 = 16;

/// 是否属于 AVIF / HEIC 家族（按扩展名判定，扩展名优先是 D11 的既有口径）。
/// `pub(crate)`：`thumbnail` 模块的进程内失败分支需要它决定是否走 ffmpeg 兜底。
pub(crate) fn is_avif_family(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AVIF_FAMILY_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// AVIF/HEIC 家族是否属于"超大图"（像素数 > [`LIBHEIF_FULL_RES_MAX_MP`]）。
///
/// 只读**头部**尺寸（libheif hook 的容器解析，不整帧解码）；读不到返回 `false`
///（按常规尺寸处理，宁可进程内解码也不误伤正确性）。
pub(crate) fn is_huge_avif_family(src: &Path) -> bool {
    let Ok(reader) = image::ImageReader::open(src) else {
        return false;
    };
    let Ok(reader) = reader.with_guessed_format() else {
        return false;
    };
    match reader.into_dimensions() {
        Ok((w, h)) => (u64::from(w) * u64::from(h)) > LIBHEIF_FULL_RES_MAX_MP * 1_000_000,
        Err(_) => false,
    }
}

/// 用捆绑 ffmpeg 解码图片，返回 `DynamicImage`。
///
/// - `max_dim < u32::MAX`：**有界缩放**到长边不超过 `max_dim`（缩略图 / 调色板 /
///   感知哈希用，避免全分辨率解码 + 重采样，`docs/issues/0018`）；
/// - `max_dim == u32::MAX`：**不缩放**（查看器全分辨率预览用，缺陷 0019）。
///
/// 输出走 `image2pipe` + PNG 直接进内存（`run_with_timeout` 并发抽干 stdout，不会假超时）；
/// 不做任何磁盘落盘。ffmpeg 解码图片时默认应用旋转元数据（EXIF / irot）。
///
/// 失败返回 `HpError::Io`（调用方按既有口径降级：缩略图用占位、扫描跳过派生数据）。
pub(crate) fn decode_image_with_ffmpeg(
    src: &Path,
    ffmpeg_bin: &Path,
    max_dim: u32,
    timeout: Duration,
) -> HpResult<image::DynamicImage> {
    let mut cmd = Command::new(ffmpeg_bin);
    cmd.args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(src);
    if max_dim < u32::MAX {
        let scale = format!("scale='min({},iw)':-2", max_dim.max(2));
        cmd.args(["-frames:v", "1", "-vf", &scale, "-f", "image2pipe", "-vcodec", "png", "-"]);
    } else {
        cmd.args(["-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]);
    }

    let output = run_with_timeout(&mut cmd, timeout)?;
    if !output.status.success() {
        return Err(HpError::Io(format!(
            "ffmpeg 解码图片失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    if output.stdout.is_empty() {
        return Err(HpError::Io("ffmpeg 未产出图像数据".into()));
    }
    image::load_from_memory(&output.stdout)
        .map_err(|e| HpError::Io(format!("解析 ffmpeg 输出失败: {e}")))
}

/// 解码图片文件：进程内 `image::open` 优先；AVIF / HEIC 家族失败且 `ffmpeg_bin` 可用时
/// 回退到 ffmpeg 有界解码。
///
/// **既有格式（jpg/png/webp/gif/bmp/tiff…）绝不走 ffmpeg**：进程内成功或失败都原样返回，
/// 结果与旧实现逐位相同。仅 AVIF/HEIC 家族在进程内失败时尝试兜底——这类文件此前
/// **从来没有**解码成功过（`image::open` 对无解码器的格式返回 `Unsupported`），
/// 不存在需要保持兼容的旧缓存。
pub fn decode_image_fallback(
    src: &Path,
    ffmpeg_bin: Option<&Path>,
    max_dim: u32,
    timeout: Duration,
) -> HpResult<image::DynamicImage> {
    // 首次进入即注册 libheif hooks（幂等）：`image::open` 随之可进程内解
    // heic/heif/avif；既有格式不受影响。
    ensure_libheif_hooks();
    // **尺寸分流**（有界请求 + AVIF/HEIC 超大图 + 有 ffmpeg）：直接走 ffmpeg 有界，
    // 跳过进程内全分辨率解码（实测大图快 3.4×，见 [`LIBHEIF_FULL_RES_MAX_MP`]）。
    if max_dim < u32::MAX && is_avif_family(src) {
        if let Some(bin) = ffmpeg_bin {
            if is_huge_avif_family(src) {
                return decode_image_with_ffmpeg(src, bin, max_dim, timeout).map_err(|fe| {
                    HpError::Io(format!(
                        "解码图片失败 {}: 超大图走 ffmpeg 有界失败: {fe}",
                        src.display()
                    ))
                });
            }
        }
    }
    match image::open(src) {
        Ok(img) => Ok(img),
        Err(inproc_err) => {
            if is_avif_family(src) {
                if let Some(bin) = ffmpeg_bin {
                    return decode_image_with_ffmpeg(src, bin, max_dim, timeout).map_err(|fe| {
                        HpError::Io(format!(
                            "解码图片失败 {}: {inproc_err}；ffmpeg 兜底: {fe}",
                            src.display()
                        ))
                    });
                }
            }
            Err(HpError::Io(format!(
                "解码图片失败 {}: {inproc_err}",
                src.display()
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hp-decode-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        dir
    }

    /// 用捆绑 ffmpeg 生成一张**纯色** AVIF（libaom-av1，确定性内容便于断言像素）。
    fn make_avif(ffmpeg: &Path, out: &Path) {
        let status = Command::new(ffmpeg)
            .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x3355aa:s=640x480", "-frames:v", "1", "-c:v", "libaom-av1", "-crf", "20", "-still-picture", "1"])
            .arg(out)
            .status()
            .expect("启动 ffmpeg 失败");
        assert!(status.success(), "生成 AVIF 样本失败");
    }

    #[test]
    fn avif_decodes_in_process_or_bounded_by_feature() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到 external-cli/ffmpeg");
            return;
        };
        let dir = temp_dir("avif");
        let src = dir.join("sample.avif");
        make_avif(&ffmpeg, &src);

        let img = decode_image_fallback(
            &src,
            Some(&ffmpeg),
            256,
            Duration::from_secs(30),
        )
        .expect("AVIF 应能解码");
        // `libheif` 特性下走进程内（aom）**全分辨率**解码；关闭特性时走 ffmpeg
        // 有界兜底（长边 256）。
        let (expect_w, expect_h) = if cfg!(feature = "libheif") {
            (640, 480)
        } else {
            (256, 192)
        };
        assert_eq!(
            (img.width(), img.height()),
            (expect_w, expect_h),
            "特性模式下尺寸应符合该模式的解码路径"
        );
        // 纯色 (0x33,0x55,0xaa)：解码后角像素应当还原（高保真下肉眼不可辨）。
        let rgb = img.to_rgb8();
        let px = rgb.get_pixel(0, 0);
        let close = |a: u8, b: u8| a.abs_diff(b) <= 12;
        assert!(
            close(px[0], 0x33) && close(px[1], 0x55) && close(px[2], 0xaa),
            "角像素应为 #3355aa 附近，实际 {px:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_avif_failure_is_not_swallowed_by_ffmpeg() {
        // 有 ffmpeg 也不许劫持非 AVIF 家族的解码失败：坏 png 保持原错误（口径不变）。
        let dir = temp_dir("badpng");
        let src = dir.join("broken.png");
        std::fs::write(&src, b"this is not an image").expect("写入失败");
        let Some(ffmpeg) = bundled_ffmpeg() else {
            let err = decode_image_fallback(&src, None, 256, Duration::from_secs(5))
                .expect_err("坏 png 应报错");
            assert!(matches!(err, HpError::Io(_)));
            let _ = std::fs::remove_dir_all(&dir);
            return;
        };
        let err = decode_image_fallback(&src, Some(&ffmpeg), 256, Duration::from_secs(5))
            .expect_err("坏 png 应报错且不落 ffmpeg 兜底");
        assert!(matches!(err, HpError::Io(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn avif_without_ffmpeg_keeps_inprocess_error() {
        let dir = temp_dir("noff");
        let src = dir.join("x.avif");
        std::fs::write(&src, b"not really avif").expect("写入失败");
        let err = decode_image_fallback(&src, None, 256, Duration::from_secs(5))
            .expect_err("无 ffmpeg 时 AVIF 应保持进程内错误");
        assert!(matches!(err, HpError::Io(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
