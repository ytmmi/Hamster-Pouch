//! 媒体类型判定：扩展名优先 + 内容兜底（D11）。

use std::io::Read;
use std::path::Path;

use hp_core::{default_book_mark_for_ext, FileMark, MediaType};

/// 扩展名 → 媒体类型映射（扩展名优先，D11）。
///
/// **文本类只认扩展名、不做内容兜底**：`txt` / `md` 没有 magic bytes，任何"看着像文本"
/// 的兜底都会把未知二进制文件吸进索引（D11 的"未知类型不索引"因此失守）。
///
/// **PDF 与文本类相反，它走内容兜底**（`sniff_media_type` 的 `%PDF-` 分支）：
/// PDF 有可靠的 magic bytes，因此改名的 PDF（`a.dat`）也能被正确识别——
/// 这正是 D11"扩展名优先 + 内容兜底"里"内容兜底"该发挥作用的地方。
fn ext_to_media_type(ext: &str) -> Option<MediaType> {
    match ext.to_ascii_lowercase().as_str() {
        // 图片
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "tiff" | "tif" | "avif" | "heic"
        | "heif" | "ico" | "svg" => Some(MediaType::Image),
        // 视频
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "mpg" | "mpeg" | "ts"
        | "3gp" => Some(MediaType::Video),
        // 音频
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" | "opus" | "ape" => {
            Some(MediaType::Audio)
        }
        // 文本（2026-10：新增 `text` 媒体类型；默认标记见 `default_file_marks`）
        "txt" | "md" | "markdown" | "epub" => Some(MediaType::Text),
        // PDF（2026-10-11）：**独立类目**，不是文本类的一种（见 `MediaType::Pdf`）。
        "pdf" => Some(MediaType::Pdf),
        _ => None,
    }
}

/// 文本类与 PDF 的**默认标记**（扫描只在"一个标记都没有"时补它，不覆盖用户已有标记）。
///
/// 与 `ext_to_media_type` 放在同一张表旁边：扩展名口径只有这一处，
/// 免得"哪些扩展名算文本"与"哪些默认带 book 标记"各写一遍、日后漂移。
///
/// **2026-10-10 口径（D102）**：标记是**可多值、与类目正交**的一维，因此返回**列表**：
/// - `epub` → `[book]`（自带封面与元数据的电子书，默认打 book 标记）；
/// - `txt` / `md` / `markdown` → **空**（默认不打标记；用户可自行打上 `book` / `manga`，
///   打上之后与子类**交叉**——这正是"标记可交叉"的落点）。
///
/// **2026-10-11（PDF）**：`pdf` → `[book]`。理由与 `epub` 逐条相同——PDF 同样是
/// "自带封面（第一页）与元数据、按书阅读"的容器。这一条决定**封面来源**：
/// 带 book 标记才去 `book.meta` 取渲染出来的封面（见 `bookPreviewView.usesEmbeddedCover`）。
///
/// **补默认值的条件**：只有当该文件**当前一个标记都没有**时才补（调用方判定），
/// 否则用户手动清空 `book` 后会被重扫补回来。
pub fn default_file_marks(media_type: MediaType, ext: &str) -> Vec<FileMark> {
    if !media_type.is_book() {
        return Vec::new();
    }
    default_book_mark_for_ext(ext).into_iter().collect()
}

/// 内容兜底：读取文件头 magic bytes 判定媒体类型（D11）。
fn sniff_media_type(path: &Path) -> Option<MediaType> {
    let mut buf = [0u8; 16];
    let mut f = std::fs::File::open(path).ok()?;
    let n = f.read(&mut buf).ok()?;
    let b = &buf[..n];
    if b.len() < 4 {
        return None;
    }

    // PDF（2026-10-11）：`%PDF-` 是可靠的 magic bytes，因此**走内容兜底**——
    // 扩展名被改掉的 PDF（`a.dat`）也能正确入库，这是 D11"内容兜底"该管的事。
    // 与文本类**刻意相反**：`txt` / `md` 没有 magic bytes，只能认扩展名。
    // 放在最前面：5 字节的固定前缀，判得最快，且与下面的格式互不重叠。
    if b.starts_with(b"%PDF-") {
        return Some(MediaType::Pdf);
    }

    // 图片
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(MediaType::Image); // JPEG
    }
    if b.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some(MediaType::Image); // PNG
    }
    if b.starts_with(b"GIF8") {
        return Some(MediaType::Image);
    }
    if b.starts_with(b"BM") {
        return Some(MediaType::Image); // BMP
    }

    // RIFF 容器（WebP 图片 / AVI 视频 / WAV 音频）
    if b.starts_with(b"RIFF") && b.len() >= 12 {
        match &b[8..12] {
            b"WEBP" => return Some(MediaType::Image),
            b"AVI " => return Some(MediaType::Video),
            b"WAVE" => return Some(MediaType::Audio),
            _ => {}
        }
    }

    // ISO BMFF（mp4/mov/3gp/webm/m4a）
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        if b.len() >= 16 && &b[8..16] == b"M4A " {
            return Some(MediaType::Audio);
        }
        return Some(MediaType::Video);
    }

    // EBML（mkv/webm）
    if b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some(MediaType::Video);
    }

    // 音频
    if b.starts_with(b"ID3") {
        return Some(MediaType::Audio); // MP3 (ID3 tag)
    }
    if b.starts_with(&[0xFF, 0xFB])
        || b.starts_with(&[0xFF, 0xF3])
        || b.starts_with(&[0xFF, 0xF2])
    {
        return Some(MediaType::Audio); // MP3 帧同步
    }
    if b.starts_with(b"fLaC") {
        return Some(MediaType::Audio); // FLAC
    }
    if b.starts_with(b"OggS") {
        return Some(MediaType::Audio); // OGG (vorbis/opus)
    }

    None
}

/// 判定文件媒体类型；未知类型返回 `None`（跳过不索引，D11）。
pub fn detect_media_type(path: &Path) -> Option<MediaType> {
    // 扩展名优先
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if let Some(mt) = ext_to_media_type(ext) {
            return Some(mt);
        }
    }
    // 内容兜底
    sniff_media_type(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = tempfile::tempdir().expect("创建临时目录失败").keep();
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).expect("创建文件失败");
        f.write_all(bytes).expect("写入失败");
        path
    }

    #[test]
    fn extension_first() {
        let png = write_tmp("photo.png", b"not really a png");
        assert_eq!(detect_media_type(&png), Some(MediaType::Image));
    }

    #[test]
    fn content_fallback_without_extension() {
        let jpeg = write_tmp("noext", &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(detect_media_type(&jpeg), Some(MediaType::Image));
    }

    #[test]
    fn unknown_type_returns_none() {
        // 未知扩展名 + 无 magic bytes → 跳过不索引（D11）。
        let bin = write_tmp("data.bin", b"hello world plain text");
        assert_eq!(detect_media_type(&bin), None);
    }

    #[test]
    fn text_is_extension_only() {
        // 文本类**只认扩展名**：`txt` 命中，而同样内容的无扩展名文件仍是未知类型
        // （否则"看着像文本"的兜底会把未知二进制吸进索引）。
        let txt = write_tmp("notes.txt", b"hello world plain text");
        assert_eq!(detect_media_type(&txt), Some(MediaType::Text));
        let noext = write_tmp("noext-text", b"hello world plain text");
        assert_eq!(detect_media_type(&noext), None);
    }

    #[test]
    fn text_default_marks() {
        // 唯一的默认标记表：只有 `epub` 默认打 book 标记；
        // `txt` / `md` 默认**不打**（用户可自行打上任意标记，与子类交叉）；
        // 非"书"的类型一律没有标记（标记只在文本类与 PDF 上有意义）。
        for (name, ext, want) in [
            ("a.epub", "epub", vec!["book"]),
            ("a.txt", "txt", vec![]),
            ("a.md", "md", vec![]),
            ("a.markdown", "markdown", vec![]),
        ] {
            let got: Vec<String> = default_file_marks(MediaType::Text, ext)
                .iter()
                .map(|m| m.as_str().to_string())
                .collect();
            assert_eq!(got, want, "{name} 的默认标记不符");
        }
        for media_type in [MediaType::Image, MediaType::Video, MediaType::Audio] {
            assert!(default_file_marks(media_type, "epub").is_empty());
        }
    }

    #[test]
    fn pdf_is_its_own_category_and_gets_the_book_mark() {
        // 用户口径（2026-10-11）：PDF 是**独立类目**（不是文本类的一种），
        // 且默认带 book 标记——理由与 `epub` 逐条相同：它自带封面（第一页）与元数据、
        // 按书阅读。这一条决定封面来源（带 book 标记才去 `book.meta` 取封面）。
        let pdf = write_tmp("book.pdf", b"%PDF-1.7 fake pdf");
        assert_eq!(detect_media_type(&pdf), Some(MediaType::Pdf));
        assert_ne!(
            detect_media_type(&pdf),
            Some(MediaType::Text),
            "PDF 不得被并进文本类目（它是二进制容器，编码判定 / 字符分页都不适用）"
        );
        assert_eq!(
            default_file_marks(MediaType::Pdf, "pdf"),
            vec![FileMark::from_raw("book")]
        );
        // 大写扩展名同样归一化。
        let upper = write_tmp("BOOK.PDF", b"%PDF-1.4 fake pdf");
        assert_eq!(detect_media_type(&upper), Some(MediaType::Pdf));
    }

    #[test]
    fn pdf_uses_content_fallback_unlike_text() {
        // 这是 PDF 与文本类**刻意相反**的一条：`%PDF-` 是可靠的 magic bytes，
        // 因此扩展名被改掉的 PDF（`a.dat`）也能正确入库；
        // 而文本类没有 magic bytes，只能认扩展名（否则未知二进制会被吸进索引）。
        let renamed = write_tmp("renamed.dat", b"%PDF-1.7 this is really a pdf");
        assert_eq!(detect_media_type(&renamed), Some(MediaType::Pdf));
        // 反向对照：同样"没有扩展名"的文本仍是未知类型。
        let text_noext = write_tmp("plain-noext", b"hello world plain text");
        assert_eq!(detect_media_type(&text_noext), None);
    }

    #[test]
    fn marks_are_multi_valued_and_orthogonal_to_the_category() {
        // 用户口径（D102）："book 为标记，标记可以交叉，例子：漫画.zip 的类目为压缩包，
        // 可以标记为 manga（漫画）"。因此：
        // 1. 标记是**集合**——同一个文件可以同时带 book 与 manga；
        // 2. 默认值只给 epub 一个 book，txt / md 默认**不打**任何标记（可后补）。
        let book = FileMark::from_raw("book");
        let manga = FileMark::from_raw("manga");
        assert!(book.is_book());
        assert!(!manga.is_book(), "manga 不是 book 标记");

        // 一个文件的两个标记可以并存（这就是"可交叉"）。
        let both = vec![book.clone(), manga.clone()];
        assert_eq!(both.len(), 2);
        assert!(both.iter().any(|m| m.is_book()));
        assert!(both.iter().any(|m| m.as_str() == "manga"));

        // 默认标记：epub → [book]；txt / md → 空（可被用户打上任意标记）。
        assert_eq!(default_file_marks(MediaType::Text, "epub"), vec![book.clone()]);
        assert!(default_file_marks(MediaType::Text, "txt").is_empty());
        assert!(default_file_marks(MediaType::Text, "md").is_empty());

        // PDF 同样默认带 book 标记（2026-10-11），因此"标记可交叉"对 PDF 也成立：
        // 一本 pdf 可以同时是 book 与 manga。
        assert_eq!(default_file_marks(MediaType::Pdf, "pdf"), vec![book]);
        assert!(default_file_marks(MediaType::Pdf, "pdf")
            .iter()
            .all(|m| m.is_book()));
    }

    #[test]
    fn uppercase_text_extension_normalized() {
        let epub = write_tmp("BOOK.EPUB", b"PK\x03\x04 fake epub");
        assert_eq!(detect_media_type(&epub), Some(MediaType::Text));
        assert_eq!(
            default_file_marks(MediaType::Text, "EPUB"),
            vec![FileMark::from_raw("book")]
        );
    }

    #[test]
    fn audio_detected() {
        let mp3 = write_tmp("song.mp3", b"ID3 fake audio");
        assert_eq!(detect_media_type(&mp3), Some(MediaType::Audio));
    }

    #[test]
    fn uppercase_extension_normalized() {
        let jpg = write_tmp("PHOTO.JPG", &[0xFF, 0xD8, 0xFF, 0xE0]);
        assert_eq!(detect_media_type(&jpg), Some(MediaType::Image));
    }
}
