//! 扫描期的**纯计算**：单个文件的内容哈希、感知哈希与调色板。
//!
//! **职责边界**：不碰数据库、不写任何文件。调用方（`scanner`）在**并行阶段**调用它，
//! 把结果带回**串行阶段**落库。因此并行部分没有任何共享可变状态，正确性不依赖锁顺序。
//!
//! **为什么要有这一层**（`docs/issues/0018`）：旧实现里"感知哈希"与"调色板"各自
//! `image::open` 一次，同一张图被完整解码并重采样两遍；而大图（9000² = 81 MP）的
//! 成本主要在**重采样**而非解码。这里**只解码一次**，两个派生结果都从同一张
//! `DynamicImage` 得出——算法本身一个字没改，因此结果与旧路径**逐位相同**
//! （`extract_palette_from_image` 与 `extract_palette` 是同一段代码）。

use std::path::Path;
use std::time::Duration;

use hp_core::{HpError, HpResult};
use hp_hash::{dhash_image, PerceptualHash};
use hp_media::extract_palette_from_image;

/// 一张图片经**一次解码**得出的派生数据。
#[derive(Debug, Clone, Default)]
pub struct ImageDerivations {
    /// 感知哈希（dHash）。解码成功即必然有值。
    pub perceptual: Option<PerceptualHash>,
    /// 调色板颜色（`#rrggbb` 列表）。`None` = 不需要（手动锁定）或解码失败。
    pub palette: Option<Vec<String>>,
}

/// 读图片**头部**取像素尺寸（不解码整张图），用于并行阶段的配额估算。
///
/// 读不到就返回最小配额 1：尺寸只影响限流，不影响正确性——最坏情况是并发略高，
/// 不会因此让扫描失败。`libheif` 特性下先确保 hooks 已注册：`ImageReader` 对
/// heic/heif/avif 也能只读头部（libheif 的容器解析，不整帧解码），因此这三类文件
/// 的配额是**真实尺寸**——它们现在进程内全分辨率解码，配额必须按像素加权，
/// 否则 102 MP 大图并发会把内存打爆（与 jpg 的既有模型一致）。
pub fn image_pixel_cost(path: &Path) -> u64 {
    hp_media::ensure_libheif_hooks();
    let Ok(reader) = image::ImageReader::open(path) else {
        return 1;
    };
    let Ok(reader) = reader.with_guessed_format() else {
        return 1;
    };
    match reader.into_dimensions() {
        Ok((width, height)) => crate::scan_pool::pixel_cost(width, height),
        Err(_) => 1,
    }
}

/// 扫描期 AVIF/HEIC 家族 ffmpeg 兜底解码的有界尺寸：dHash（9×8）与调色板（64×64）
/// 都不需要全分辨率像素；有界解码把大图成本从"全解码 + Triangle 重采样"压到
/// 与 256px 相当的规模。对 AVIF/HEIC 没有既存缓存可比对，按文件确定性地采用该
/// 中间尺寸是安全的（`hp_media::decode` 的模块文档）。
const SCAN_DECODE_BOUND: u32 = 256;

/// 对一张图片解码一次，同时得出感知哈希与（按需的）调色板。
///
/// `want_palette = false` 时**跳过调色板计算**：调用方已从库里读到它被手动锁定，
/// 重算出来也会被丢弃，不如省下这次重采样。
///
/// 解码优先走进程内 `image::open`（jpg/png 等既有格式输出与旧实现**逐位相同**）；
/// AVIF/HEIC 家族失败时回退捆绑 ffmpeg 有界解码（`ffmpeg_bin` 为 `None` 时无兜底）。
/// 解码失败返回 `HpError::Io`；调用方按既有口径处理（感知哈希缺失、调色板不写），
/// **不影响索引本身**——这与旧实现 `dhash_file(path).ok()` + `write_palette` 内部
/// `extract_palette(..).ok()` 的容错语义完全一致。
pub fn analyze_image(
    path: &Path,
    want_palette: bool,
    ffmpeg_bin: Option<&Path>,
    timeout: Duration,
) -> HpResult<ImageDerivations> {
    let img = hp_media::decode_image_fallback(path, ffmpeg_bin, SCAN_DECODE_BOUND, timeout)
        .map_err(|e| HpError::Io(format!("解码图片失败 {}: {e}", path.display())))?;
    let perceptual = Some(dhash_image(&img));
    let palette = want_palette.then(|| extract_palette_from_image(&img, 0).colors);
    Ok(ImageDerivations {
        perceptual,
        palette,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_png(path: &Path, width: u32, height: u32, color: [u8; 3]) {
        let img = image::RgbImage::from_pixel(width, height, image::Rgb(color));
        img.save(path).expect("写入测试图片失败");
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hp-scan-compute-{tag}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        dir
    }

    #[test]
    fn pixel_cost_reads_real_dimensions_from_header() {
        let dir = temp_dir("cost");
        let path = dir.join("mid.png");
        write_png(&path, 2000, 1500, [10, 20, 30]);
        // 2000x1500 = 3 MP 整 → 恰好 3。
        assert_eq!(image_pixel_cost(&path), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pixel_cost_falls_back_for_unreadable_file() {
        let missing = std::env::temp_dir().join("hp-scan-compute-does-not-exist.png");
        assert_eq!(image_pixel_cost(&missing), 1);
    }

    /// **核心不变量**：解码一次得到的两个派生结果，必须与"各自解码一次"的旧路径
    /// **逐位相同**。这是本优化敢上线的前提——否则 `perceptual_hash` 与
    /// `color_refs` 的既有缓存会与新建索引不可比。
    #[test]
    fn single_decode_matches_legacy_two_decode_path() {
        let dir = temp_dir("equiv");
        // 用不同内容的图覆盖多种分布：纯色、渐变、噪声。
        for (name, seed) in [("solid", 0u8), ("gradient", 1), ("noise", 2)] {
            let path = dir.join(format!("{name}.png"));
            let mut img = image::RgbImage::new(320, 240);
            for (x, y, px) in img.enumerate_pixels_mut() {
                let value = match seed {
                    0 => 77,
                    1 => ((x * 255) / 320) as u8,
                    _ => ((x * 31 + y * 17) % 256) as u8,
                };
                *px = image::Rgb([value, value.wrapping_add(seed), 200]);
            }
            img.save(&path).expect("写入测试图片失败");

            // 旧路径：两次独立解码。
            let legacy_hash = hp_hash::dhash_file(&path).expect("旧路径 dHash 失败");
            let legacy_palette = hp_media::extract_palette(&path, 0, None, Duration::from_secs(30))
                .expect("旧路径调色板失败");

            // 新路径：一次解码。
            let got = analyze_image(&path, true, None, Duration::from_secs(30))
                .expect("单次解码分析失败");

            assert_eq!(
                got.perceptual.expect("应有感知哈希").value,
                legacy_hash.value,
                "{name}: dHash 必须逐位相同"
            );
            assert_eq!(
                got.palette.expect("应有调色板"),
                legacy_palette.colors,
                "{name}: 调色板必须逐项相同"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn want_palette_false_skips_palette_but_keeps_hash() {
        let dir = temp_dir("skip");
        let path = dir.join("a.png");
        write_png(&path, 64, 64, [1, 2, 3]);
        let got = analyze_image(&path, false, None, Duration::from_secs(30)).expect("分析失败");
        assert!(got.perceptual.is_some(), "感知哈希仍须产出");
        assert!(got.palette.is_none(), "不需要调色板时不该算它");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decode_failure_is_an_io_error_not_a_panic() {
        let dir = temp_dir("bad");
        let path = dir.join("broken.png");
        std::fs::write(&path, b"this is not an image").expect("写入失败");
        let err = analyze_image(&path, true, None, Duration::from_secs(30))
            .expect_err("坏文件应当报错");
        assert!(matches!(err, HpError::Io(_)), "应当是 Io 错误，实际 {err:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
