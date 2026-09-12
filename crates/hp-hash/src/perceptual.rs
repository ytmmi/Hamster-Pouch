//! 感知哈希：dHash（差异哈希，仅用于相似/重复检索，不参与身份判定）。

use std::path::Path;

use hp_core::{HpError, HpResult};
use image::imageops::FilterType;
use image::DynamicImage;

/// 感知哈希算法名（写入 `files.perceptual_hash_algo`）。
pub const PERCEPTUAL_HASH_ALGO: &str = "dHash";
/// 感知哈希算法版本（写入 `files.perceptual_hash_algo_version`）。
pub const PERCEPTUAL_HASH_ALGO_VERSION: i64 = 1;

/// dHash 尺寸：宽 9、高 8，共 64 位差异。
const DHASH_WIDTH: u32 = 9;
const DHASH_HEIGHT: u32 = 8;

/// 感知哈希结果：值 + 算法名 + 算法版本。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PerceptualHash {
    /// 16 个十六进制字符（64 位 dHash，小写零填充）。
    pub value: String,
    pub algo: String,
    pub algo_version: i64,
}

/// 对已解码图像计算 dHash。
pub fn dhash_image(img: &DynamicImage) -> PerceptualHash {
    let gray = img.to_luma8();
    let resized = image::imageops::resize(&gray, DHASH_WIDTH, DHASH_HEIGHT, FilterType::Triangle);

    let mut hash: u64 = 0;
    let mut bit = 0u32;
    for y in 0..DHASH_HEIGHT {
        for x in 0..(DHASH_WIDTH - 1) {
            let left = resized.get_pixel(x, y)[0];
            let right = resized.get_pixel(x + 1, y)[0];
            if left >= right {
                hash |= 1u64 << (63 - bit);
            }
            bit += 1;
        }
    }

    PerceptualHash {
        value: format!("{hash:016x}"),
        algo: PERCEPTUAL_HASH_ALGO.to_string(),
        algo_version: PERCEPTUAL_HASH_ALGO_VERSION,
    }
}

/// 读取并解码图片后计算 dHash。
pub fn dhash_file(path: &Path) -> HpResult<PerceptualHash> {
    let img = image::open(path)
        .map_err(|e| HpError::Io(format!("解码图片失败 {}: {e}", path.display())))?;
    Ok(dhash_image(&img))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成一张水平灰度渐变图（宽度方向亮度递增）。
    fn gradient() -> DynamicImage {
        let img = image::GrayImage::from_fn(32, 32, |x, _| image::Luma([(x * 8) as u8]));
        DynamicImage::ImageLuma8(img)
    }

    #[test]
    fn same_image_stable_hash() {
        let a = dhash_image(&gradient());
        let b = dhash_image(&gradient());
        assert_eq!(a.value, b.value);
    }

    #[test]
    fn value_is_16_hex_chars() {
        let a = dhash_image(&gradient());
        assert_eq!(a.value.len(), 16);
        assert!(a.value.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn flipped_image_differs() {
        let a = dhash_image(&gradient());
        let flipped = gradient().fliph();
        let b = dhash_image(&flipped);
        assert_ne!(a.value, b.value);
    }

    #[test]
    fn algo_metadata_recorded() {
        let h = dhash_image(&gradient());
        assert_eq!(h.algo, "dHash");
        assert_eq!(h.algo_version, 1);
    }
}
