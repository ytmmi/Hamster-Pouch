//! 图片「显示尺寸」：读头取存储尺寸，再按 EXIF `Orientation` 换算成**所见**宽高。
//!
//! 唯一用途是给索引写 `files.width` / `files.height`（缺陷 0043，
//! `docs/issues/0043-image-dimensions-not-indexed.md`）。口径是 2026-11-11
//! 第 37 轮裁决 1：**只存显示尺寸**，不存存储尺寸——消费方（虚拟化布局、胶片栏、
//! `-lowres` 分流）问的永远是"这张图看起来多宽多高"，而查看器与缩略图都已经按
//! 显示尺寸处理（`thumbnail.rs` 的 `apply_orientation`、`lowres.rs` 记录 ffmpeg
//! 自动应用 displaymatrix 旋转）。存两份必然漂移，0042 已经付过这笔学费。
//!
//! **为什么读头而不是复用解码结果**：扫描期虽然解码了整张图，但对 AVIF/HEIC
//! 家族走的是**有界解码**（`SCAN_DECODE_BOUND = 256`，见 `scan_compute.rs`），
//! 解码出来的宽高是中间尺寸、不是真实尺寸；而 JPEG 的解码器**不应用 EXIF 方向**。
//! 读头（`ImageReader::into_dimensions`）两条都不占：它拿真实存储尺寸、成本只有
//! 几十 KiB，与 `image_pixel_cost` 同一条路（后者本来就在读同一份头算并发配额）。
//!
//! 读不到就返回 `None`（不报错）：索引里这一列可空，消费方按"未知"降级——
//! 与"读头失败"相比，"把未知写成 0 或 1:1"才是真正的错误。

use std::path::Path;

/// 读图片头得到**存储尺寸**（未应用 EXIF 方向）；读不到返回 `None`。
///
/// 与 [`display_dimensions`] 拆开，是为了让并发配额（`image_pixel_cost`）能复用
/// 同一次读头：配额要的是"解码后有多少像素"，与方向无关；而索引要的是显示尺寸。
pub fn header_dimensions(path: &Path) -> Option<(u32, u32)> {
    crate::ensure_libheif_hooks();
    let reader = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?;
    reader.into_dimensions().ok()
}

/// 读图片头得到**显示尺寸**（EXIF 方向已应用）；读不到返回 `None`。
pub fn display_dimensions(path: &Path) -> Option<(u32, u32)> {
    let (width, height) = header_dimensions(path)?;
    // 方向只在**有 EXIF 的容器**里；PNG/GIF 等没有 EXIF，这里直接拿到 None。
    // `orientation_of` 走的是"只读容器、只取一个 tag"的轻量路径，不解析完整摘要。
    let orientation = crate::exif::orientation_of(path);
    Some(apply_orientation(width, height, orientation))
}

/// 把 EXIF 方向换算成显示尺寸。
///
/// 只有 5/6/7/8 这四种"转 90°"的方向需要交换长短边：
/// 5 = 转置、6 = 顺时针 90°、7 = 反转置、8 = 逆时针 90°；1/2/3/4 只是镜像或
/// 不转，宽高不变（镜像不改变尺寸）。方向值超出 1–8 时按"不转"处理——畸形
/// EXIF 不该让整张图被判成未知。
pub fn apply_orientation(width: u32, height: u32, orientation: Option<u32>) -> (u32, u32) {
    match orientation {
        Some(5..=8) => (height, width),
        _ => (width, height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hp-dims-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        dir
    }

    fn write_png(path: &Path, width: u32, height: u32) {
        let img = image::RgbImage::from_pixel(width, height, image::Rgb([9, 9, 9]));
        img.save(path).expect("写入测试图片失败");
    }

    #[test]
    fn reads_real_dimensions_from_header() {
        let dir = temp_dir("png");
        let path = dir.join("a.png");
        write_png(&path, 321, 123);
        assert_eq!(display_dimensions(&path), Some((321, 123)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_is_none_not_panic() {
        let path = std::env::temp_dir().join("hp-dims-does-not-exist.png");
        assert_eq!(display_dimensions(&path), None);
    }

    /// 90° 族交换长短边，其余不动——这条规则错了，全库竖拍照片的宽高都会反着存。
    #[test]
    fn orientation_swaps_only_for_90_degree_family() {
        for o in [Some(1), Some(2), Some(3), Some(4), None, Some(0), Some(9)] {
            assert_eq!(
                apply_orientation(4000, 3000, o),
                (4000, 3000),
                "方向 {o:?} 不该交换"
            );
        }
        for o in [Some(5), Some(6), Some(7), Some(8)] {
            assert_eq!(
                apply_orientation(4000, 3000, o),
                (3000, 4000),
                "方向 {o:?} 必须交换"
            );
        }
    }
}
