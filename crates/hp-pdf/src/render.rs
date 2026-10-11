//! 把 PDF 的一页**栅格化**成位图（封面 = 第 0 页；查看器 = 逐页）。
//!
//! ## 为什么是"栅格化"而不是"抽文字"
//!
//! PDF 是**版式描述**，不是文本流：分栏、表格、五线谱、图片、公式的位置与字形
//! 都由内容流里的绘制指令给出，文字只是其中一类指令。抽文字会丢掉版式（表格散架、
//! 乐谱全丢），因此本 crate 的正文路径与封面路径**是同一件事**——把页面画成位图。
//! 用户口径（2026-10-11）："查看器里的 PDF 逐页栅格化为图片，滚动看后续页"。
//!
//! ## 缩放口径
//!
//! PDF 的页面尺寸是**点**（1 pt = 1/72 英寸，A4 ≈ 595×842 pt）。栅格化时按目标像素宽
//! 算缩放比，并**夹住上限**（[`PDF_MAX_SCALE`]）：
//!
//! - 目标宽度取 [`PDF_COVER_WIDTH`]（封面）或 [`PDF_PAGE_WIDTH`]（查看器）；
//! - **只放大到上限为止**：一个 3579 pt 宽的展板页面若按 1200px 目标算，
//!   缩放比是 0.33（缩小，正常）；但一个 72 pt 的小页面会算出 16.7 倍，
//!   那是把 10 pt 的字放大成 167 pt——既慢又没有任何信息增量。
//!   上限 4 倍与 `hayro` 示例的口径一致；
//! - **不放大到目标宽度以上**：目标宽度是"最多画多宽"，不是"必须画这么宽"。
//!   实际输出宽度 = 页面宽 × 缩放比，可能小于目标（此时前端按 CSS 放大显示即可，
//!   比在解码端放大更省内存）。
//!
//! ## 背景色
//!
//! **白色**而不是透明：PDF 页面默认没有底色（内容画在白纸上），若用透明背景，
//! 深色主题下页面会变成"黑底黑字"、整页读不了。`hayro` 的 `PixmapSettings::bg_color`
//! 就是干这个的——与图书预览封面容器的"字面白色纸边"是同一条口径。

use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::hayro_syntax::page::Page;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{PixmapSettings, RenderCache, RenderSettings, render};

use crate::encode::encode_jpeg;

/// 封面的目标像素宽度（图书预览的封面框最大 400px，两倍余量给高分屏）。
///
/// 取 800 的理由：`coverSize` 的上限是 400px（`BOOK_COVER_SIZE_MAX`），
/// 2× 是"高分屏下不糊"的常用口径；再大对 2/3 的封面框没有可见收益，
/// 而 PNG/JPEG 体积与像素数成正比（实测 800px 封面 138–357 KiB）。
pub const PDF_COVER_WIDTH: u32 = 800;

/// 查看器一页的目标像素宽度。
///
/// 取 1200 的理由：阅读区宽度受面板限制（实测双栏阈值 900px + 内边距），
/// 1200px 已覆盖"面板拉得很宽"的情况；再大在阅读距离下看不出差别，
/// 而每页的体积与栅格化时间都随像素数线性增长（实测 1200px 单页 25–156 ms）。
pub const PDF_PAGE_WIDTH: u32 = 1200;

/// 缩放比上限：**只放大到 4 倍**（见模块文档"缩放口径"）。
pub const PDF_MAX_SCALE: f32 = 4.0;

/// 一页的栅格化结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfPage {
    /// 像素宽（已按缩放比算出，可能小于请求的目标宽度）。
    pub width: u32,
    /// 像素高。
    pub height: u32,
    /// 非预乘的 RGBA8 像素（`width * height * 4` 字节，行优先）。
    ///
    /// **非预乘**：`hayro` 的 `Pixmap` 内部是预乘的（`PremulRgba8`），
    /// 本 crate 在 [`render_page_rgba`] 里统一解预乘，因此调用方拿到的就是
    /// 常规的 RGBA——直接喂给 `image` crate 即可，不必知道 vello 的表示。
    pub rgba: Vec<u8>,
}

impl PdfPage {
    /// 像素数（调用方据此判断"这页多大"，例如体积上限）。
    pub fn pixel_count(&self) -> u64 {
        u64::from(self.width) * u64::from(self.height)
    }
}

/// 按**目标像素宽**算缩放比（纯函数，门禁可直接断言）。
///
/// - 页面宽度非正或非有限（畸形页面 / 未渲染尺寸）→ 返回 `1.0`，让调用方按原尺寸画；
/// - 目标宽度为 0 → 返回 `1.0`（"不指定"的语义，不是"缩到 0"）；
/// - 否则 `min(目标 / 页宽, PDF_MAX_SCALE)`——**只夹上限，不夹下限**：
///   大页面照常缩小，这是这个函数存在的主要理由。
///
/// `is_finite()` 必须先判：`NaN` 参与比较恒为假，只写 `page_width <= 0.0` 会让
/// `NaN` 漏过去，算出的缩放比是 `NaN`，`render` 会造出一个尺寸为 0 的 pixmap。
pub fn scale_for_width(page_width: f32, target_width: u32) -> f32 {
    if !page_width.is_finite() || page_width <= 0.0 || target_width == 0 {
        return 1.0;
    }
    (target_width as f32 / page_width).min(PDF_MAX_SCALE)
}

/// 渲染第 `index` 页（0 起）；越界返回 `None`。
///
/// `target_width` 是**目标像素宽**（见 [`PDF_COVER_WIDTH`] / [`PDF_PAGE_WIDTH`]）。
pub fn render_page_rgba(pdf: &Pdf, index: usize, target_width: u32) -> Option<PdfPage> {
    let pages = pdf.pages();
    let page: &Page<'_> = pages.get(index)?;
    let (page_width, _page_height) = page.render_dimensions();
    let scale = scale_for_width(page_width, target_width);

    let cache = RenderCache::new();
    let settings = InterpreterSettings::default();
    let pixmap = render(
        page,
        &cache,
        &settings,
        &RenderSettings::default(),
        &PixmapSettings {
            x_scale: scale,
            y_scale: scale,
            // 白底（见模块文档）：深色主题下透明背景会变成"黑底黑字"。
            bg_color: WHITE,
        },
    );

    let width = u32::from(pixmap.width());
    let height = u32::from(pixmap.height());
    // 解预乘：`Pixmap` 的像素是预乘 RGBA（`PremulRgba8`），而 `image` crate 与
    // 浏览器的 `<img>` 都要**非预乘**。白底之上 alpha 恒为 255，但显式解一遍
    // 才是对的——把"刚好不透明"当成不变量，换一张带透明页面的 PDF 就会出错。
    let mut rgba = pixmap.data_as_u8_slice().to_vec();
    unpremultiply_rgba(&mut rgba);

    Some(PdfPage {
        width,
        height,
        rgba,
    })
}

/// 渲染第 `index` 页并编码成 JPEG 字节；越界或编码失败返回 `None`。
///
/// **封面与查看器正文共用这一个函数**（差别只有 `target_width`）：
/// 用户口径里"封面 = PDF 第一页"与"查看器逐页显示"本来就是同一件渲染，
/// 分成两条实现只会让两处的缩放口径慢慢漂移。
pub fn render_page_jpeg(pdf: &Pdf, index: usize, target_width: u32) -> Option<Vec<u8>> {
    let page = render_page_rgba(pdf, index, target_width)?;
    encode_jpeg(&page.rgba, page.width, page.height).ok()
}

/// 就地解预乘（`r,g,b` 从"乘过 alpha"还原成"独立分量"）。
///
/// 用整数算术而不是浮点：`c * 255 / a` 在 `a = 255` 时恒等于 `c`（本项目的白底
/// 场景全是这条路径），且**逐像素结果可复现**——浮点会因舍入在不同平台差 1，
/// 而缓存是按内容哈希落盘的，同内容必须同字节。
///
/// `a = 0` 的像素直接置 0（"完全透明"没有颜色可言；保留预乘值会让它变成一个
/// 不存在的深色，缩略图上表现为一圈黑边）。
pub(crate) fn unpremultiply_rgba(rgba: &mut [u8]) {
    for px in rgba.chunks_exact_mut(4) {
        let a = px[3];
        if a == 255 {
            // 绝大多数像素走这条（白底渲染）：一个乘法都不做。
            continue;
        }
        if a == 0 {
            px[0] = 0;
            px[1] = 0;
            px[2] = 0;
            continue;
        }
        let a16 = u16::from(a);
        px[0] = ((u16::from(px[0]) * 255 + a16 / 2) / a16).min(255) as u8;
        px[1] = ((u16::from(px[1]) * 255 + a16 / 2) / a16).min(255) as u8;
        px[2] = ((u16::from(px[2]) * 255 + a16 / 2) / a16).min(255) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_only_caps_the_upper_bound() {
        // 大页面缩小（这是主要用途）。
        assert!((scale_for_width(595.0, 800) - 800.0 / 595.0).abs() < 1e-6);
        // 小页面**不无限放大**：72pt 的页面按 1200 目标会算出 16.7 倍，夹到 4。
        assert_eq!(scale_for_width(72.0, 1200), PDF_MAX_SCALE);
        // 刚好在 4 倍以内：按实际比值，不夹。
        assert!((scale_for_width(400.0, 1200) - 3.0).abs() < 1e-6);
    }

    #[test]
    fn scale_is_one_for_degenerate_input() {
        // 畸形页面宽度 / 不指定目标宽度 → 恒等，绝不产生 0 或负数
        //（0 会让 `render` 造出 0×0 的 pixmap，上层拿到空图）。
        assert_eq!(scale_for_width(0.0, 800), 1.0);
        assert_eq!(scale_for_width(-5.0, 800), 1.0);
        assert_eq!(scale_for_width(595.0, 0), 1.0);
        assert_eq!(scale_for_width(f32::NAN, 800), 1.0);
    }

    #[test]
    fn unpremultiply_is_identity_for_opaque_pixels() {
        // 白底渲染出来的像素 alpha 恒为 255：解预乘**必须**逐字节不变，
        // 否则封面会整体变亮/变暗（这是最容易静默出错的一处）。
        let mut rgba = vec![10, 200, 30, 255, 0, 0, 0, 255, 255, 255, 255, 255];
        let before = rgba.clone();
        unpremultiply_rgba(&mut rgba);
        assert_eq!(rgba, before);
    }

    #[test]
    fn unpremultiply_restores_half_alpha() {
        // 半透明红：预乘值是 (128, 0, 0, 128)，解预乘应还原成接近 (255, 0, 0, 128)。
        let mut rgba = vec![128, 0, 0, 128];
        unpremultiply_rgba(&mut rgba);
        assert_eq!(rgba[3], 128, "alpha 本身不动");
        assert!(rgba[0] >= 254, "红色分量应还原到接近 255，实际 {}", rgba[0]);
        assert_eq!(rgba[1], 0);
        assert_eq!(rgba[2], 0);
    }

    #[test]
    fn unpremultiply_zeroes_fully_transparent() {
        // 全透明像素不该留下一个"不存在的深色"（缩略图上会变成黑边）。
        let mut rgba = vec![40, 40, 40, 0];
        unpremultiply_rgba(&mut rgba);
        assert_eq!(rgba, vec![0, 0, 0, 0]);
    }
}
