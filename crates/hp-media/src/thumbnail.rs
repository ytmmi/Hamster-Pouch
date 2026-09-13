//! ffmpeg 首帧抽帧（D16）：扫描时同步生成视频首帧缩略图。

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::run_with_timeout;

/// 抽帧过滤器：宽度不超过 512、高度按比例，小图不放大。
const SCALE_FILTER: &str = "scale='min(512,iw)':-2";

/// 抽取视频首帧并写入 `output_jpg`；失败返回 `HpError::Io`（调用方可用占位图降级）。
pub fn extract_thumbnail(
    video_path: &Path,
    output_jpg: &Path,
    ffmpeg_bin: &Path,
    timeout: Duration,
) -> HpResult<()> {
    let mut cmd = Command::new(ffmpeg_bin);
    cmd.args(["-y", "-i"])
        .arg(video_path)
        .args(["-frames:v", "1", "-vf", SCALE_FILTER, "-q:v", "3"])
        .arg(output_jpg);

    let output = run_with_timeout(&mut cmd, timeout)?;
    if !output.status.success() {
        return Err(HpError::Io(format!(
            "ffmpeg 抽帧失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
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
    thumb
        .to_rgb8()
        .save(output_jpg)
        .map_err(|e| HpError::Io(format!("写入缩略图失败: {e}")))?;
    Ok(())
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
