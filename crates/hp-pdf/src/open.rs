//! 打开 PDF：把 `hayro` 的解析入口收敛成**一处**，并统一错误降级口径。
//!
//! `hayro` 的 `Pdf` 是**自持有**的（内部把文件字节装进 `Arc<PdfData>`，
//! 对象按需惰性解析），因此"打开"不需要调用方操心生命周期：拿到 [`Pdf`] 就能
//! 取页数、取页尺寸、渲染任意一页。
//!
//! **解析失败一律降级**（见 [`open_pdf`] 的文档）：坏文件、加密文件、截断文件都不该
//! 让上层变成错误态——图书预览回落文字封面、查看器显示"没有可显示的正文"。

use std::path::Path;

use hp_core::{HpError, HpResult};
use hayro::hayro_syntax::Pdf;

/// 从字节打开一个 PDF；打不开返回 `None`。
///
/// **失败降级为 `None` 而不是 `Err`**（本 crate 最外层的口径）：
/// - 加密 / 带密码的 PDF：`hayro` 报 `Decryption`，本项目没有"输入密码"的入口；
/// - 结构损坏 / 根本不是 PDF：报 `Invalid`；
/// - 目录里一页都没有：`CachedPages` 构造失败。
///
/// 这三种都归入"这份 PDF 打不开"，由调用方决定怎么回落（图书预览回落文字封面、
/// 查看器显示占位），**不是错误态**——与 `hp-book` 的"坏书降级为没有元数据"同口径。
///
/// **注意区分**：`None` 是"内容层面的打不开"，`Err` 只留给**读盘失败**
/// （见 [`open_pdf_file`]）——文件不在、没权限要报给用户，坏文件不该报。
pub fn open_pdf(data: Vec<u8>) -> Option<Pdf> {
    Pdf::new(data).ok()
}

/// 读取文件并打开；**读盘失败是 `Err`，解析失败是 `Ok(None)`**。
pub fn open_pdf_file(path: &Path) -> HpResult<Option<Pdf>> {
    let bytes = std::fs::read(path)
        .map_err(|e| HpError::Io(format!("读取 PDF 失败 {}: {e}", path.display())))?;
    Ok(open_pdf(bytes))
}

/// 页数；打不开返回 `None`。
///
/// 单列一个函数是为了让"只要页数"的调用方（查看器的 `section_count`）
/// 不必自己拼 `open_pdf(...).map(|p| p.pages().len())`。
pub fn page_count(pdf: &Pdf) -> usize {
    pdf.pages().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn garbage_is_none_not_error() {
        // 不是 PDF 的字节 → 内容层面打不开（`None`），**不是**读盘错误。
        assert!(open_pdf(b"not a pdf at all".to_vec()).is_none());
        assert!(open_pdf(Vec::new()).is_none());
    }

    #[test]
    fn missing_file_is_io_error() {
        // 文件不存在 → 读盘错误（`Err`），与"打不开"区分开：
        // 前者要报给用户，后者回落默认封面。
        assert!(open_pdf_file(Path::new("Z:/definitely/missing.pdf")).is_err());
    }
}
