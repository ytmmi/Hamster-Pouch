//! 图片解码的**兜底层**：进程内 `image` crate 优先，AVIF/HEIC 家族失败时回退到
//! 捆绑 ffmpeg 的**有界解码**（`docs/issues/0018` §7 的 P1-D，2026-10 落地）。
//!
//! ## 为什么需要这一层
//!
//! - **AVIF**：`image` 0.25 的 `avif` feature 只含 ravif **编码器**，进程内解码需要
//!   `avif-native`（dav1d + mp4parse）；而 dav1d-sys 要求**系统 dav1d**（pkg-config）
//!   或 git+meson+ninja 内部构建——违反 D20「依赖与构建链本地化」（2026-10 实测：
//!   本机无系统 dav1d、无 meson/ninja）。故 AVIF 解码同样走捆绑 ffmpeg：捆绑构建
//!   自带 **libdav1d**（asm 优化），解码性能与进程内相当，仅多一次子进程启动开销。
//! - **HEIC / HEIF**：`image` crate 至今没有任何 HEIC 解码器；Windows 的 WIC HEIF codec
//!   依赖系统扩展（本机未装，不可依赖）。捆绑 ffmpeg 的 `mov` demuxer + 原生 `hevc`
//!   解码器是目前唯一**零新增依赖**的路径（`docs/rfc/0005` D20 依赖本地化）。
//!
//! ## 性能要点（有界解码）
//!
//! ffmpeg 输出**先缩到 ≤ `max_dim` 再进内存**：AVIF/HEIC 的缩略图 / 调色板 / 感知哈希
//! 都不需要全分辨率像素（`docs/issues/0018` 实测：大图成本主要在**重采样**而非解码，
//! 9000² 全解码 168 ms、dHash 813 ms、调色板 945 ms）。有界解码把这两项都压到
//! 与 `max_dim` 相当的规模；对 AVIF/HEIC 没有既存缓存可比对，因此按文件**确定性**地
//! 采用该中间尺寸是安全的（同一文件每次扫描结果一致）。
//!
//! **口径不变**：对 jpg/png/webp/gif/bmp/tiff 等既有格式，本层不做任何介入——它们仍走
//! `image::open`，结果与旧实现**逐位相同**（扫描期感知哈希 / 调色板的缓存可比性不受影响）。

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::run_with_timeout;

/// AVIF / HEIC 家族扩展名（触发 ffmpeg 兜底；与 `hp-scanner::media_type.rs` 的图片
/// 判定一致，另含 `heif` 别名）。
const AVIF_FAMILY_EXTS: [&str; 3] = ["avif", "heic", "heif"];

/// 是否属于 AVIF / HEIC 家族（按扩展名判定，扩展名优先是 D11 的既有口径）。
/// `pub(crate)`：`thumbnail` 模块的进程内失败分支需要它决定是否走 ffmpeg 兜底。
pub(crate) fn is_avif_family(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AVIF_FAMILY_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 用捆绑 ffmpeg 解码图片并**有界缩放**到长边不超过 `max_dim`，返回 `DynamicImage`。
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
    let max_dim = max_dim.max(2);
    let scale = format!("scale='min({max_dim},iw)':-2");
    let mut cmd = Command::new(ffmpeg_bin);
    cmd.args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(src)
        .args(["-frames:v", "1", "-vf", &scale, "-f", "image2pipe", "-vcodec", "png", "-"]);

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
    fn avif_decodes_via_bundled_ffmpeg_bounded() {
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
        .expect("AVIF 应能通过 ffmpeg 兜底解码");
        // 640×480 → 长边按 256 有界缩放：宽 256、高 192。
        assert_eq!((img.width(), img.height()), (256, 192));
        // 纯色 (0x33,0x55,0xaa)：有界解码后角像素应当还原（libaom 高保真下肉眼不可辨）。
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
