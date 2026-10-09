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

mod cover;
mod epub;
mod epub_text;
mod meta;
mod text;
mod xml;
mod zip;

pub use cover::{cover_from_bytes, detect_image_ext, BookCover};
pub use epub::read_epub;
pub use epub_text::{blocks_from_xhtml, read_epub_section, BookBlock, EpubSectionRead};
pub use meta::{read_book_meta, BookMeta};
pub use text::{
    decode_file_head, decode_head, detect_encoding, is_strict_utf8, is_utf8_but_maybe_truncated,
    page_at, trim_to_char_boundary, DecodedText, TextEncoding, TextPage, TEXT_PAGE_CHARS,
    TEXT_VIEW_MAX_BYTES,
};
pub use xml::{decode_xml_bytes, percent_decode, resolve_zip_path};
pub use zip::{ZipArchive, ZipEntry};
