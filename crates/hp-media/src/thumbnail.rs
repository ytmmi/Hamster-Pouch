//! ffmpeg 首帧抽帧（D16）：扫描时同步生成视频首帧缩略图。
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

/// 生成图片缩略图：应用 EXIF 方向后等比缩放到长边不超过 `max_dim`，写入 `output_jpg`。
///
/// 小图不放大；读取 / 解码 / 写入失败返回 `HpError::Io`（调用方可降级为占位）。
pub fn generate_image_thumbnail(src: &Path, output_jpg: &Path, max_dim: u32) -> HpResult<()> {
    use image::{DynamicImage, ImageDecoder, ImageReader};

    let reader = ImageReader::open(src)
        .map_err(|e| HpError::Io(format!("打开图片失败: {e}")))?
        .with_guessed_format()
        .map_err(|e| HpError::Io(format!("识别图片格式失败: {e}")))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| HpError::Io(format!("创建图片解码器失败: {e}")))?;
    // 读取 EXIF 方向（缺失 / 不可读时按无变换处理，不报错）。
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder)
        .map_err(|e| HpError::Io(format!("解码图片失败: {e}")))?;
    img.apply_orientation(orientation);

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

        generate_image_thumbnail(&src, &out, 320).expect("生成缩略图失败");
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

        generate_image_thumbnail(&src, &out, 320).expect("生成缩略图失败");
        let thumb = image::open(&out).expect("读取缩略图失败");
        assert_eq!(thumb.width(), 100);
        assert_eq!(thumb.height(), 50);

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
