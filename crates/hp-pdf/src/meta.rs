//! 一个 PDF 的元数据（作者 / 主题）与**首页封面**。
//!
//! 与 `hp_book::BookMeta` 同形（作者 / 简介 / 封面），因为**面板只关心这三样**：
//! 作品名不在其中——图书预览显示的是**文件名**（用户口径「文件名（作品名）」），
//! 不看文档内嵌的标题。
//!
//! ## 字段来源（如实记录）
//!
//! | 本 crate 的字段 | PDF 来源 |
//! | --- | --- |
//! | `author` | 文档信息字典的 `/Author` |
//! | `description` | 文档信息字典的 `/Subject` |
//! | `cover` | **第 0 页的栅格化结果**（用户口径："封面为 pdf 第一页"） |
//!
//! **`/Title` 刻意不读**：与 EPUB 侧同一条口径——内嵌标题与文件名经常不一致，
//! 取它会让"显示的是哪本书"变得对不上号（`bookPreviewView.bookDisplayName`）。
//!
//! ## 实测（本项目真机语料，2026-10-11）
//!
//! 11 份真实 PDF 里只有 **1 份**带 `/Author`（WPS 导出的简历）、**0 份**带
//! `/Subject`。也就是说 PDF 这一侧的"作者 / 简介"基本恒为 `None`，面板会渲染 `—`。
//! 这是**如实反映数据**，不是解析失败：PDF 不是电子书，多数生成器（Photoshop、
//! 打印驱动、iTextSharp）根本不写这两个字段。封面则**每份都有**（第一页总能画出来），
//! 这正是用户要的那一条。
//!
//! ## 文本编码
//!
//! PDF 的文本字符串有两种形态：**PDFDocEncoding**（近似 Latin-1）与
//! **UTF-16BE/LE**（带 BOM）。这里按 BOM 判定 UTF-16，其余先试 UTF-8、
//! 再回落 Latin-1。**已知边界**：PDFDocEncoding 在 `0x80–0x9F` 区间与 Latin-1
//! 并不完全相同（那里是若干符号），本实现不区分——实测语料里没有命中该区间的
//! 作者名，且这个区间的差异远小于"整段变问号"。属未排期的精度问题。

use std::path::Path;

use hayro::hayro_syntax::Pdf;
use hp_core::HpResult;

use crate::open::open_pdf_file;
use crate::render::{PDF_COVER_WIDTH, render_page_jpeg};

/// 封面落盘的扩展名（与 `hp_media::ThumbnailCache::path_for_book_cover` 的 `ext` 对齐）。
///
/// **恒为 `jpg`**：PDF 的封面是本 crate **画出来**的，不是从文件里取出的原始字节
/// （EPUB 那一侧才是"原格式不转码"）——画出来的是 RGBA，编码格式由我们决定。
pub const PDF_COVER_EXT: &str = "jpg";

/// 一个 PDF 解析出的元数据；三项都可以缺失。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PdfMeta {
    /// 作者（`/Author`）。
    pub author: Option<String>,
    /// 简介（`/Subject`）。
    pub description: Option<String>,
    /// 首页封面（已编码的 JPEG 字节）。
    pub cover: Option<PdfCover>,
}

/// 一个 PDF 的首页封面。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfCover {
    /// 落盘扩展名（恒为 [`PDF_COVER_EXT`]）。
    pub ext: &'static str,
    /// JPEG 字节。
    pub bytes: Vec<u8>,
    /// 封面像素宽 / 高（供上层做体积与观感判断，不参与落盘）。
    pub width: u32,
    pub height: u32,
}

/// 读取一个 PDF 的元数据与首页封面。
///
/// **解析失败降级为"没有元数据"而不是错误**（与 `hp_book::read_book_meta` 同口径）：
/// 一份 PDF 打不开（损坏 / 加密）不该让整个图书预览面板变成错误态——
/// 面板回落成文件名文字封面即可。
///
/// **只有读盘失败是 `Err`**：文件不在 / 没权限要报给用户，坏文件不该报。
///
/// 封面渲染是这里最贵的一步（实测 20–122 ms @800px），因此桥接层**按内容哈希
/// 缓存**结果，同一份文件只画一次（见 `commands/book.rs`）。
pub fn read_pdf_meta(path: &Path) -> HpResult<PdfMeta> {
    let Some(pdf) = open_pdf_file(path)? else {
        // 打不开：没有元数据，也没有封面（面板回落文字封面）。**不是错误**。
        return Ok(PdfMeta::default());
    };
    Ok(read_meta_from_pdf(&pdf))
}

/// 从**已打开**的 PDF 取元数据与首页封面。
///
/// 与 [`read_pdf_meta`] 分开，是为了让调用方在**同一次打开**里既取元数据又渲染
/// 别的页（查看器就属于这种：它要页数与第 N 页），避免把整份文件读两遍。
pub fn read_meta_from_pdf(pdf: &Pdf) -> PdfMeta {
    let info = pdf.metadata();
    PdfMeta {
        author: decode_pdf_text(info.author.as_deref()),
        description: decode_pdf_text(info.subject.as_deref()),
        // 封面 = **第 0 页**（用户口径："封面为 pdf 第一页"）。
        // 渲染失败（畸形页面 / 编码失败）→ `None`，回落文字封面。
        cover: render_cover(pdf),
    }
}

/// 渲染第 0 页作为封面。
fn render_cover(pdf: &Pdf) -> Option<PdfCover> {
    let bytes = render_page_jpeg(pdf, 0, PDF_COVER_WIDTH)?;
    // 尺寸在这里只作信息（落盘的是 JPEG 字节，尺寸由文件本身描述）。
    // 再渲染一次拿尺寸是浪费，因此从页尺寸与缩放比反推。
    let (width, height) = cover_pixel_size(pdf)?;
    Some(PdfCover {
        ext: PDF_COVER_EXT,
        bytes,
        width,
        height,
    })
}

/// 封面渲染出来的像素尺寸（页尺寸 × 缩放比）。
fn cover_pixel_size(pdf: &Pdf) -> Option<(u32, u32)> {
    let page = pdf.pages().first()?;
    let (w, h) = page.render_dimensions();
    let scale = crate::render::scale_for_width(w, PDF_COVER_WIDTH);
    Some((
        (w * scale).round().max(1.0) as u32,
        (h * scale).round().max(1.0) as u32,
    ))
}

/// PDF 文本字符串 → Rust `String`；空串与纯空白都当作"没有"（返回 `None`）。
///
/// 为什么把"空串"也归入 `None`：实测有 PDF 写了 `/Author ()`（空的作者字段），
/// 若原样返回 `Some("")`，面板会渲染出一个**空的作者行**（"作者："后面什么都没有），
/// 而按"缺值渲染 `—`"的既定口径应当显示 `—`。空值就是缺值。
pub fn decode_pdf_text(raw: Option<&[u8]>) -> Option<String> {
    let bytes = raw?;
    if bytes.is_empty() {
        return None;
    }
    let decoded = if bytes.starts_with(&[0xFE, 0xFF]) {
        // UTF-16**BE**（PDF 规范要求的形态）。
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        // UTF-16**LE**（不规范但真实存在）。
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        // 无 BOM：先试 UTF-8（现代生成器常直接写 UTF-8），失败再按 Latin-1
        // 逐字节映射（PDFDocEncoding 的近似，见模块文档的"文本编码"）。
        match std::str::from_utf8(bytes) {
            Ok(s) => s.to_string(),
            Err(_) => bytes.iter().map(|&b| b as char).collect(),
        }
    };
    let trimmed = decoded.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一份**最小但真实可解析**的 PDF（200×100 pt，一页，含 `/Author` 与 `/Subject`）。
    ///
    /// 刻意不写精确的 xref 偏移：`hayro` 在 xref 不可用时会走 fallback 扫描
    /// （`pdf.rs` 的 `fallback`），而手写字节偏移的夹具一旦算错就会变成一个
    /// "看起来像 PDF 但打不开"的文件——那会让测试**静默地**退化成只测降级路径。
    /// 这个夹具已实测能解析（`pages=1`、`dims=(200, 100)`、两个字段都读得到）。
    const MINIMAL_PDF: &str = "%PDF-1.4\n\
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n\
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n\
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n\
4 0 obj << /Length 42 >> stream\n\
BT /F1 24 Tf 20 40 Td (Hello PDF) Tj ET\n\
endstream\nendobj\n\
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n\
6 0 obj << /Author (wxlxt) /Subject (probe) >> endobj\n\
trailer << /Root 1 0 R /Size 7 /Info 6 0 R >>\n\
%%EOF\n";

    /// 把夹具写进临时文件，返回 (临时目录, 路径)。目录必须被持有到测试结束。
    fn write_fixture(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join(name);
        std::fs::write(&path, MINIMAL_PDF).expect("写入夹具失败");
        (dir, path)
    }

    #[test]
    fn reads_author_subject_and_renders_first_page_cover() {
        let (_dir, path) = write_fixture("book.pdf");
        let meta = read_pdf_meta(&path).expect("读盘应当成功");

        assert_eq!(meta.author.as_deref(), Some("wxlxt"), "作者来自 /Author");
        assert_eq!(
            meta.description.as_deref(),
            Some("probe"),
            "简介来自 /Subject"
        );

        // **封面 = 第一页**（用户口径）：必须真的画出来了，且是一张合法 JPEG。
        let cover = meta.cover.expect("首页封面必须渲染出来");
        assert_eq!(cover.ext, PDF_COVER_EXT);
        assert_eq!(
            &cover.bytes[..3],
            &[0xFF, 0xD8, 0xFF],
            "封面必须是 JPEG 魔数"
        );
        // 200pt 宽的页面按 800px 目标 → 缩放比 4（正好等于上限），得到 800×400。
        assert_eq!((cover.width, cover.height), (800, 400));
    }

    #[test]
    fn renders_every_page_and_reports_the_count() {
        // 查看器路径：页数 + 逐页渲染（第 0 页有内容，越界页返回 `None`）。
        let (_dir, path) = write_fixture("book.pdf");
        let pdf = crate::open::open_pdf_file(&path)
            .expect("读盘应当成功")
            .expect("应当能解析");
        assert_eq!(crate::open::page_count(&pdf), 1);
        assert!(crate::render::render_page_rgba(&pdf, 0, 400).is_some());
        assert!(
            crate::render::render_page_rgba(&pdf, 1, 400).is_none(),
            "越界页必须是 None"
        );
    }

    #[test]
    fn cover_scales_down_a_large_page() {
        // 大页面（展板 3579pt）按 800px 目标是**缩小**，不是被 4 倍上限拦住。
        let scale = crate::render::scale_for_width(3579.0, PDF_COVER_WIDTH);
        assert!(scale < 1.0, "大页面必须缩小，实际 {scale}");
        assert!((scale - 800.0 / 3579.0).abs() < 1e-6);
    }

    #[test]
    fn missing_file_is_io_error() {
        assert!(read_pdf_meta(Path::new("Z:/definitely/missing.pdf")).is_err());
    }

    #[test]
    fn broken_file_degrades_to_no_metadata() {
        // 坏文件 → **没有元数据**（不是错误）：面板回落文字封面。
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("broken.pdf");
        std::fs::write(&path, b"%PDF-1.4\nnot really a pdf").expect("写入失败");
        let meta = read_pdf_meta(&path).expect("坏文件不该报错");
        assert_eq!(meta, PdfMeta::default());
    }

    #[test]
    fn utf16be_is_decoded() {
        // PDF 规范的形态：UTF-16BE + BOM。中文作者名必须解出来。
        let mut raw = vec![0xFE, 0xFF];
        for unit in "长月达平".encode_utf16() {
            raw.extend_from_slice(&unit.to_be_bytes());
        }
        assert_eq!(decode_pdf_text(Some(&raw)).as_deref(), Some("长月达平"));
    }

    #[test]
    fn utf16le_is_decoded() {
        let mut raw = vec![0xFF, 0xFE];
        for unit in "wxlxt".encode_utf16() {
            raw.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_pdf_text(Some(&raw)).as_deref(), Some("wxlxt"));
    }

    #[test]
    fn plain_utf8_and_latin1_fallbacks() {
        assert_eq!(decode_pdf_text(Some(b"wxlxt")).as_deref(), Some("wxlxt"));
        // 非 UTF-8 的字节按 Latin-1 逐字节映射（不产生替换字符）。
        assert_eq!(decode_pdf_text(Some(&[0xE9])).as_deref(), Some("é"));
    }

    #[test]
    fn empty_and_blank_are_missing_not_empty_string() {
        // 空字段是**缺值**：面板据此渲染 `—`，而不是一个空的作者行。
        assert_eq!(decode_pdf_text(Some(b"")), None);
        assert_eq!(decode_pdf_text(Some(b"   ")), None);
        assert_eq!(decode_pdf_text(None), None);
        // 前后空白要裁掉（生成器常写 " wxlxt "）。
        assert_eq!(decode_pdf_text(Some(b"  wxlxt ")).as_deref(), Some("wxlxt"));
    }
}
