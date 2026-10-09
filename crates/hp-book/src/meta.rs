//! 一本书的元数据（与格式无关的入口）。
//!
//! 面板只关心三样东西：**作者、简介、封面**。作品名不在其中——面板显示的是
//! **文件名**（用户口径「文件名（作品名）」），不看内嵌标题。
//!
//! 各格式的支持程度（如实记录，不假装）：
//! | 格式 | 作者 / 简介 | 封面 |
//! | --- | --- | --- |
//! | `epub` | OPF 的 `<dc:creator>` / `<dc:description>` | 内嵌封面图片（见 `epub` 模块的查找顺序） |
//! | `txt` / `md` / 其它文本 | 无（返回 `None`） | 无 → 前端用文件名渲染**文字封面** |
//!
//! **解析失败不影响列表**：调用方（`book.meta` 命令）把错误降级为"这本书没有元数据"，
//! 因为一本书打不开不该让整个面板变成错误态。

use std::path::Path;

use hp_core::HpResult;

use crate::cover::BookCover;
use crate::epub::read_epub;

/// 一本书解析出的元数据；三项都可以缺失。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BookMeta {
    /// 作者（EPUB `<dc:creator>`；多作者时取第一个）。
    pub author: Option<String>,
    /// 简介（EPUB `<dc:description>`，可能含换行）。
    pub description: Option<String>,
    /// 封面（含格式与原始字节）。
    pub cover: Option<BookCover>,
}

/// 按扩展名读取一本书的元数据。
///
/// 非 EPUB 的文本（`txt` / `md` …）**不是错误**：它们本来就没有元数据，
/// 返回空结构体，面板按文件名出字。
pub fn read_book_meta(path: &Path) -> HpResult<BookMeta> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "epub" => read_epub(path),
        _ => Ok(BookMeta::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_has_no_metadata() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("novel.txt");
        std::fs::write(&path, "第一章\n正文").expect("写入失败");
        let meta = read_book_meta(&path).expect("纯文本不该报错");
        assert_eq!(meta, BookMeta::default());
    }

    #[test]
    fn missing_file_of_unknown_extension_is_still_fine() {
        // 未知扩展名走"无元数据"分支，不做 IO——因此不存在的文件也不报错。
        // 这是有意的：元数据是**增强**，不是列表可用性的前提。
        let meta = read_book_meta(Path::new("Z:/definitely/missing.md")).expect("不该报错");
        assert_eq!(meta, BookMeta::default());
    }
}
