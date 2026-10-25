//! 栅格化结果 → JPEG 字节。
//!
//! ## 为什么是 JPEG 而不是 PNG / WebP
//!
//! 与 `hp-media` 的**视频首帧**同一条口径（那里也是 JPEG）：PDF 页面是
//! 照片与文字混合的**连续色调**图像，JPEG 在这个场景下体积远小于 PNG
//! （实测同样 800px 的封面：JPEG 138 KiB 对 PNG 的数百 KiB 量级），
//! 而文字在质量 90 下没有可见损伤。
//!
//! **图片缩略图为什么不用这套**：那是 `hp-media` 的既有裁决（D90/D91：
//! 同质量下 WebP 比 JPEG 小一半，且 libwebp 与 ffmpeg 逐字节相同），
//! 针对的是"照片缩略图"；PDF 页面这一侧没有那份等价性保证，因此不引入
//! WebP 依赖，沿用 `image` crate 的 JPEG 编码器（`hp-media` 的降级路径同款）。
//!
//! ## 质量 90 而不是 75
//!
//! `hp-media` 的缩略图用 75（小图、只作索引），而这里要的是**可读的页面**：
//! 正文文字、五线谱符号、表格线在 75 下会出现可见的振铃与糊边。
//! 用户口径是"逐页栅格化为图片"（即所见即原貌），因此按"阅读用图"给质量。

use hp_core::{HpError, HpResult};
use image::ImageEncoder;

/// PDF 页面 JPEG 的编码质量（见模块文档：阅读用图，不是索引缩略图）。
pub const PDF_JPEG_QUALITY: u8 = 90;

/// 把 RGBA8 像素编成 JPEG 字节。
///
/// JPEG **不支持 alpha 通道**，因此先丢弃 alpha 只留 RGB——这是安全的：
/// 本 crate 的栅格化统一用**白色背景**（见 `render` 模块），
/// 出来的像素 alpha 恒为 255，丢掉的是一列常量 255。
///
/// 尺寸为 0 或缓冲区长度不匹配一律报错（不静默产出一张空图：上层会把它
/// 当成"这页就是白的"，而实际是渲染出了错）。
pub fn encode_jpeg(rgba: &[u8], width: u32, height: u32) -> HpResult<Vec<u8>> {
    if width == 0 || height == 0 {
        return Err(HpError::Io(format!("PDF 页面尺寸非法: {width}x{height}")));
    }
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| HpError::Io("PDF 页面像素数溢出".to_string()))?;
    if rgba.len() != expected {
        return Err(HpError::Io(format!(
            "PDF 页面像素长度不符: 期望 {expected}，实际 {}",
            rgba.len()
        )));
    }

    // 只保留 RGB：JPEG 没有 alpha 通道。
    let mut rgb = Vec::with_capacity((width as usize) * (height as usize) * 3);
    for px in rgba.as_chunks::<4>().0 {
        rgb.extend_from_slice(&px[..3]);
    }

    let mut out = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, PDF_JPEG_QUALITY);
    encoder
        .write_image(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| HpError::Io(format!("PDF 页面 JPEG 编码失败: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一张纯色 RGBA 图。
    fn solid(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let mut v = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..(width * height) {
            v.extend_from_slice(&color);
        }
        v
    }

    #[test]
    fn encodes_a_real_jpeg() {
        let rgba = solid(32, 24, [200, 30, 40, 255]);
        let jpeg = encode_jpeg(&rgba, 32, 24).expect("编码应当成功");
        // 按**魔数**断言，而不是"非空"：JPEG 以 FF D8 FF 开头、以 FF D9 结尾。
        assert_eq!(&jpeg[..3], &[0xFF, 0xD8, 0xFF], "必须是 JPEG 魔数");
        assert_eq!(&jpeg[jpeg.len() - 2..], &[0xFF, 0xD9], "必须有 EOI 标记");
    }

    #[test]
    fn rejects_degenerate_size() {
        // 0 尺寸不产出"一张空图"（上层会当成"这页就是白的"）。
        assert!(encode_jpeg(&[], 0, 0).is_err());
        assert!(encode_jpeg(&[], 10, 0).is_err());
    }

    #[test]
    fn rejects_buffer_length_mismatch() {
        // 长度不符是渲染侧出了错，必须报出来而不是编一张错位图。
        let rgba = solid(4, 4, [0, 0, 0, 255]);
        assert!(encode_jpeg(&rgba, 8, 8).is_err());
        assert!(encode_jpeg(&rgba[..rgba.len() - 4], 4, 4).is_err());
    }
}
