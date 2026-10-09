//! 封面图片：本模块只负责"这堆字节是什么图片格式"（按 magic bytes），
//! 以及"一本书解析出来的封面长什么样"。
//!
//! **不转码**：封面原样落盘（见 `hp_media::ThumbnailCache::path_for_book_cover`），
//! 前端 `<img>` 直接渲染。转码会为了一张 200 KB 的图引入一次完整解码 + 重编码，
//! 还平白损失质量——封面是书的门面，没有理由动它。
//!
//! 认不出的格式返回 `None`：调用方**回落文字封面**（不是错误态）。

/// 一本书解析出的封面。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookCover {
    /// 落盘扩展名（`jpg` / `png` / `gif` / `webp` / `bmp` / `svg`）。
    pub ext: &'static str,
    /// 图片原始字节。
    pub bytes: Vec<u8>,
}

/// 按 magic bytes 判定图片格式；认不出返回 `None`。
///
/// 只认 Chromium 与 WebView2 能直接渲染的格式——认出一个渲染不了的格式
/// （TIFF、AVIF 之外的怪格式）只会让前端出现一个坏图占位，不如回落文字封面。
pub fn detect_image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 4 {
        return None;
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("png");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("gif");
    }
    if bytes.starts_with(b"BM") {
        return Some("bmp");
    }
    // RIFF 容器：`RIFF....WEBP`
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    // SVG 是文本：允许 XML 声明/空白/BOM 在前，再找 `<svg`。
    let head = &bytes[..bytes.len().min(512)];
    let text = String::from_utf8_lossy(head);
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    if trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && text.contains("<svg")) {
        return Some("svg");
    }
    None
}

/// 由原始字节构造封面；格式认不出返回 `None`。
pub fn cover_from_bytes(bytes: Vec<u8>) -> Option<BookCover> {
    let ext = detect_image_ext(&bytes)?;
    Some(BookCover { ext, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_common_formats() {
        assert_eq!(detect_image_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(detect_image_ext(&[0x89, 0x50, 0x4E, 0x47, 1]), Some("png"));
        assert_eq!(detect_image_ext(b"GIF89a...."), Some("gif"));
        assert_eq!(detect_image_ext(b"BM......"), Some("bmp"));
        assert_eq!(detect_image_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
    }

    #[test]
    fn detects_svg_with_prolog() {
        assert_eq!(detect_image_ext(b"<svg xmlns=\"...\"></svg>"), Some("svg"));
        assert_eq!(
            detect_image_ext(b"<?xml version=\"1.0\"?>\n<svg></svg>"),
            Some("svg")
        );
    }

    #[test]
    fn unknown_format_is_none() {
        assert_eq!(detect_image_ext(b"II*\0 tiff bytes"), None);
        assert_eq!(detect_image_ext(b"ab"), None);
        assert!(cover_from_bytes(b"not an image".to_vec()).is_none());
    }
}
