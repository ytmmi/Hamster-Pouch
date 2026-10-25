//! hp-book：电子书的**元数据 / 封面**与**正文读取**（EPUB = ZIP + OPF；txt/md 需判编码）。
//!
//! **职责边界**：本 crate 只做"从一个文件读出作者 / 简介 / 封面字节 / 正文开头"这几件事。
//! 它不碰数据库、不认识 `file_id`、不决定封面存到哪——那些属于桥接层
//! （`apps/desktop/src-tauri/src/commands/book.rs`）与 `hp_media::ThumbnailCache`。
//!
//! 依赖方向：`hp-book -> hp-core`（只用 `HpError` / `HpResult`），
//! 与 `docs/architecture/file-structure.md` 的允许方向一致。
//!
//! **为什么单独成 crate**：电子书解析与"媒体子进程/ffprobe/抽帧"（`hp-media`）不是
//! 同一个域——前者是纯文件格式解析，没有外部进程、没有解码、没有缓存。按领域拆 crate
//! 是本项目的既定口径（`docs/architecture/file-structure.md` 的"按功能分文件夹"）。
//!
//! ## 正文的三条读取路径（2026-10-09 / 2026-10-10 / 2026-10-18）
//!
//! - **纯文本**（`txt`）：`text` 判编码（实测语料一半 GBK）+ **按窗口渐进读取**
//!   （2026-10-18：不再是"整本解码"，见该模块文档与需求 2）；
//! - **EPUB**：`epub_text` 把 spine 章节的 XHTML 过白名单转成类型化块
//!   （富行内样式 / 图组 / 注释 / 换页的判据在 `epub_rich`，见需求 5）；
//! - **Markdown**（`md` / `markdown`）：`markdown` 把 CommonMark + GFM 转成**同一套**
//!   类型化块（`block` 模块），因此前端**只有一份渲染器**。
//!
//! 后两者共用 `block` 的块模型与 `inline` 的行内扫描：**正文永远不是 HTML**，
//! 前端没有可以注入 HTML 的入口（安全边界见 `block` 的模块文档）。

mod block;
mod cover;
mod epub;
mod epub_rich;
mod epub_text;
mod inline;
mod markdown;
mod markdown_tests;
mod meta;
mod text;
mod text_stream;
mod toc;
mod xml;
mod zip;

pub use block::{
    BookBlock, BookDefinition, BookListItem, BookSpan, ColumnAlign, SpanStyle, block_char_count,
    blocks_char_count, normalize_styles, spans_char_count,
};
pub use cover::{BookCover, cover_from_bytes, detect_image_ext};
pub use epub::read_epub;
pub use epub_text::{EpubSectionRead, blocks_from_xhtml, read_epub_section};
pub use inline::spans_from_html;
pub use markdown::{MarkdownRead, blocks_from_markdown};
pub use meta::{BookMeta, read_book_meta};
pub use text::{
    DecodedText, TEXT_PAGE_CHARS, TEXT_VIEW_MAX_BYTES, TextEncoding, TextPage, decode_file_head,
    decode_file_limited, decode_head, decode_head_limited, detect_encoding, is_strict_utf8,
    is_utf8_but_maybe_truncated, page_at, trim_to_char_boundary,
};
pub use text_stream::{
    TEXT_SCAN_MAX_BYTES, TextPageOwned, TextScan, last_page_read_bytes, read_text_page_window,
    scan_text, text_toc_stream,
};
pub use toc::{TOC_MAX_ENTRIES, TocEntry, markdown_toc, read_epub_toc, text_toc};
pub use xml::{decode_xml_bytes, percent_decode, resolve_zip_path};
pub use zip::{ZipArchive, ZipEntry};
