//! 媒体类型判定：扩展名优先 + 内容兜底（D11）。

use std::io::Read;
use std::path::Path;

use hp_core::{FileMark, MediaType, default_book_mark_for_ext};

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
        // 图片。
        //
        // **2026-10-11 扩容**（用户要求"将 ffmpeg 支持的进行实现"）：此前只收 13 个格式，
        // 而捆绑 ffmpeg 实测还能解一批常见与长尾格式——它们**既不入库也没有解码路径**，
        // 于是"能解却看不到"。扩容依据是 `docs/rfc/0005` 的「图片格式支持边界」，
        // 逐个格式**端到端实测**（`ffmpeg -decoders` 有解码器 **且** 走本项目**完全相同**的
        // `-frames:v 1 -vf scale=… -f image2pipe -vcodec png -` 管线能出图）。
        //
        // 两条**判据分层**（不是"ffmpeg 能解就加"，那样会把坏文件报错变成抢救成功）：
        // - **进程内能解**（`image` crate 自带解码器）→ 只进本表，走进程内路径：
        //   `tga` / `dds` / `exr` / `hdr` / `qoi` / `ff` / `pnm` 家族；
        // - **进程内无解码器** → 进本表 **且** 进 `hp-media` 的
        //   `FFMPEG_ONLY_IMAGE_EXTS`（两处必须同时命中，否则"入库了但解不开"）。
        "jpg" | "jpeg" | "jfif" | "png" | "apng" | "gif" | "bmp" | "webp" | "tiff"
        | "tif" | "avif" | "heic" | "heif" | "ico"
        // SVG / SVGZ（D112）：**矢量**，进程内 `resvg` 栅格化（`hp-media::svg`）。
        // 捆绑 ffmpeg 对 SVG 只有解复用器 `svg_pipe`、**没有解码器**（实测
        // `no decoder found for: svg`），因此**不**进 `FFMPEG_ONLY_IMAGE_EXTS`——
        // 那张表的语义是"只能靠 ffmpeg"，而 SVG 恰恰是"ffmpeg 解不了、只能进程内解"。
        | "svg" | "svgz"
        // 进程内可解、2026-10-11 新收
        | "tga" | "dds" | "exr" | "hdr" | "qoi" | "ff" | "pnm" | "pam" | "ppm" | "pgm"
        | "pbm"
        // 进程内无解码器、必须走 ffmpeg 兜底（2026-10-11 新收）
        // 注意 `dib` 属本组：`image` crate **不认** `.dib`（实测报
        // "extension not recognized"），它是 DIB 裸数据、无 BMP 文件头。
        | "jp2" | "j2k" | "jpf" | "jpx" | "jxl" | "psd" | "pcx" | "sgi" | "ras" | "dpx"
        | "fits" | "wbmp" | "xbm" | "xpm" | "jls" | "pfm" | "dib" => Some(MediaType::Image),
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
        return Some(MediaType::Image); // JPEG（也覆盖 JPEG-LS：`FF D8 FF F7`）
    }
    if b.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some(MediaType::Image); // PNG（也覆盖 APNG：同一容器）
    }
    if b.starts_with(b"GIF8") {
        return Some(MediaType::Image);
    }
    if b.starts_with(b"BM") {
        return Some(MediaType::Image); // BMP
    }

    // 2026-10-11 扩容的图片格式中**magic bytes 足够可靠**的那批（D11 的内容兜底）。
    //
    // **只收"长且互不重叠"的签名**，刻意**不收**签名过弱的格式——`wbmp`（`00 00`
    // 两字节）、`dib`（4 字节的头部长度，`28 00 00 00` 之类在任意二进制里都常见）、
    // `tga`（签名在**文件尾** `TRUEVISION-XFILE`，本函数只读头部 16 字节）、
    // `pcx`（`0A` + 版本 + 编码，前两字节与普通二进制无法区分）。
    // 给它们做兜底会把**未知二进制吸进索引**，正是 D11「未知类型不索引」要防的事；
    // 这些格式仍可靠**扩展名**正常入库，只是改名的文件认不出。
    if b.starts_with(b"8BPS") {
        return Some(MediaType::Image); // Photoshop PSD
    }
    if b.starts_with(b"DDS ") {
        return Some(MediaType::Image); // DirectDraw Surface
    }
    if b.starts_with(&[0x76, 0x2F, 0x31, 0x01]) {
        return Some(MediaType::Image); // OpenEXR
    }
    if b.starts_with(b"qoif") {
        return Some(MediaType::Image); // QOI
    }
    if b.starts_with(b"farbfeld") {
        return Some(MediaType::Image); // farbfeld
    }
    if b.starts_with(b"#?RADIANCE") || b.starts_with(b"#?RGBE") {
        return Some(MediaType::Image); // Radiance HDR
    }
    if b.starts_with(&[0x59, 0xA6, 0x6A, 0x95]) {
        return Some(MediaType::Image); // Sun Raster
    }
    // SGI RGB：magic `01 DA` + storage(0/1) + BPC(1/2)。只判前两字节太弱（1/65536），
    // 因此**连第 4 字节一起判**（BPC 只能是 1 或 2），把约束收到 3 字节。
    if b.starts_with(&[0x01, 0xDA]) && (b[3] == 1 || b[3] == 2) {
        return Some(MediaType::Image); // SGI RGB
    }
    if b.starts_with(b"SDPX") || b.starts_with(b"XPDS") {
        return Some(MediaType::Image); // DPX
    }
    if b.starts_with(b"SIMPLE  = ") {
        return Some(MediaType::Image); // FITS
    }
    if b.starts_with(b"/* XPM */") {
        return Some(MediaType::Image); // XPM（文本签名，够长且唯一）
    }
    // JPEG 2000 家族：签名盒 `00 00 00 0C 6A 50 20 20 0D 0A 87 0A`（12 字节，全在头部）。
    // **必须排在下面的 ISO BMFF `ftyp` 判定之前**：两者都是"盒子"结构，
    // 但 JP2 的第 4–8 字节是 `jP  ` 而不是 `ftyp`，判据互不重叠。
    if b.starts_with(&[
        0x00, 0x00, 0x00, 0x0C, 0x6A, 0x50, 0x20, 0x20, 0x0D, 0x0A, 0x87, 0x0A,
    ]) {
        return Some(MediaType::Image); // JPEG 2000（jp2 / jpx）
    }
    // JPEG XL：裸码流签名 `FF 0A`，或容器盒 `00 00 00 0C 4A 58 4C 20`（`JXL `）。
    if b.starts_with(&[0xFF, 0x0A]) {
        return Some(MediaType::Image);
    }
    if b.starts_with(&[0x00, 0x00, 0x00, 0x0C, 0x4A, 0x58, 0x4C, 0x20]) {
        return Some(MediaType::Image);
    }
    // Netpbm 家族（`P1`–`P7`）。**必须再要求第 3 字节是空白**：真实的 Netpbm 头是
    // "magic + 空白 + 宽 高 …"，只判 `P` + 数字会让任意以 `P1` 开头的未知文件被吸进索引。
    if b.len() >= 3
        && b[0] == b'P'
        && (b'1'..=b'7').contains(&b[1])
        && (b[2] == b' ' || b[2] == b'\t' || b[2] == b'\n' || b[2] == b'\r')
    {
        return Some(MediaType::Image); // pnm / pam / ppm / pgm / pbm
    }
    // Portable FloatMap（`PF` / `Pf` + 换行）。
    if b.starts_with(b"PF\n") || b.starts_with(b"Pf\n") {
        return Some(MediaType::Image);
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
    if b.starts_with(&[0xFF, 0xFB]) || b.starts_with(&[0xFF, 0xF3]) || b.starts_with(&[0xFF, 0xF2])
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
    if let Some(ext) = path.extension().and_then(|e| e.to_str())
        && let Some(mt) = ext_to_media_type(ext)
    {
        return Some(mt);
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
        let jpeg = write_tmp(
            "noext",
            &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        );
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
        let both = [book.clone(), manga.clone()];
        assert_eq!(both.len(), 2);
        assert!(both.iter().any(|m| m.is_book()));
        assert!(both.iter().any(|m| m.as_str() == "manga"));

        // 默认标记：epub → [book]；txt / md → 空（可被用户打上任意标记）。
        assert_eq!(
            default_file_marks(MediaType::Text, "epub"),
            vec![book.clone()]
        );
        assert!(default_file_marks(MediaType::Text, "txt").is_empty());
        assert!(default_file_marks(MediaType::Text, "md").is_empty());

        // PDF 同样默认带 book 标记（2026-10-11），因此"标记可交叉"对 PDF 也成立：
        // 一本 pdf 可以同时是 book 与 manga。
        assert_eq!(default_file_marks(MediaType::Pdf, "pdf"), vec![book]);
        assert!(
            default_file_marks(MediaType::Pdf, "pdf")
                .iter()
                .all(|m| m.is_book())
        );
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

    /// 2026-10-11 扩容：新收的图片扩展名都必须判为 `image`（用户要求
    /// "将 ffmpeg 支持的进行实现"）。**逐项列出**而不是抽几个代表——
    /// 漏一项的表现就是"这个格式怎么扫都看不到"，而它不会让任何别的断言变红。
    #[test]
    fn expanded_image_extensions_are_all_indexed() {
        // 进程内可解的那批（只需进扩展名表）。
        for ext in [
            "tga", "dds", "exr", "hdr", "qoi", "ff", "pnm", "pam", "ppm", "pgm", "pbm", "apng",
            "jfif", "svg", "svgz",
        ] {
            let p = write_tmp(&format!("a.{ext}"), b"not really an image");
            assert_eq!(
                detect_media_type(&p),
                Some(MediaType::Image),
                "{ext} 应判为图片（扩展名优先）"
            );
        }
        // 进程内无解码器、必须走 ffmpeg 兜底的那批。
        for ext in [
            "jp2", "j2k", "jpf", "jpx", "jxl", "psd", "pcx", "sgi", "ras", "dpx", "fits", "wbmp",
            "xbm", "xpm", "jls", "pfm", "dib",
        ] {
            let p = write_tmp(&format!("a.{ext}"), b"not really an image");
            assert_eq!(
                detect_media_type(&p),
                Some(MediaType::Image),
                "{ext} 应判为图片（扩展名优先）"
            );
        }
        // 大写同样归一化。
        let upper = write_tmp("A.JP2", b"x");
        assert_eq!(detect_media_type(&upper), Some(MediaType::Image));
    }

    /// 扩容格式的**内容兜底**：签名可靠的能在改名后仍被认出；
    /// 签名过弱的（tga / pcx / wbmp / dib）**刻意不做兜底**——见 `sniff_media_type` 的说明。
    #[test]
    fn expanded_image_magic_bytes_sniffed_only_when_reliable() {
        // 可靠签名 → 无扩展名也认得出。
        for (name, bytes) in [
            ("psd", b"8BPS\x00\x01\x00\x00\x00\x00\x00\x00".to_vec()),
            ("dds", b"DDS \x7c\x00\x00\x00\x10\x00\x00\x00".to_vec()),
            ("exr", vec![0x76, 0x2F, 0x31, 0x01, 0x02, 0x00, 0x00, 0x00]),
            ("qoi", b"qoif\x00\x00\x00\x40\x00\x00\x00\x30".to_vec()),
            (
                "farbfeld",
                b"farbfeld\x00\x00\x00\x40\x00\x00\x00\x30".to_vec(),
            ),
            ("hdr", b"#?RADIANCE\nSOFTWARE=x\n".to_vec()),
            ("ras", vec![0x59, 0xA6, 0x6A, 0x95, 0, 0, 0, 64]),
            ("sgi", vec![0x01, 0xDA, 0x01, 0x01, 0x00, 0x03, 0x00, 0x40]),
            ("dpx", b"SDPX\x80\x06\x00\x00V1.0".to_vec()),
            ("fits", b"SIMPLE  =                    T".to_vec()),
            ("xpm", b"/* XPM */\nstatic char *x[] = {".to_vec()),
            (
                "jp2",
                vec![
                    0x00, 0x00, 0x00, 0x0C, 0x6A, 0x50, 0x20, 0x20, 0x0D, 0x0A, 0x87, 0x0A,
                ],
            ),
            ("jxl", vec![0xFF, 0x0A, 0xCB, 0x06, 0x00, 0x13, 0x88, 0x02]),
            ("ppm", b"P6\n64 48\n255\n".to_vec()),
            ("pam", b"P7\nWIDTH 64\n".to_vec()),
            ("pfm", b"PF\n64 48\n1.0\n".to_vec()),
        ] {
            let p = write_tmp("renamed-noext", &bytes);
            assert_eq!(
                detect_media_type(&p),
                Some(MediaType::Image),
                "{name} 的 magic bytes 应能在无扩展名时认出"
            );
        }

        // 签名过弱 → **不得**兜底（否则未知二进制会被吸进索引，D11 失守）。
        // 这些都是"看着像图片头、但不足以判定"的字节串。
        for (name, bytes) in [
            (
                "wbmp（00 00 两字节太弱）",
                vec![0x00, 0x00, 0x40, 0x30, 0x22, 0x22],
            ),
            (
                "pcx（0A 05 太弱）",
                vec![0x0A, 0x05, 0x01, 0x08, 0x00, 0x00],
            ),
            (
                "dib（28 00 00 00 是通用长度前缀）",
                vec![0x28, 0x00, 0x00, 0x00, 0x40, 0x00],
            ),
            (
                "tga 头部（无签名）",
                vec![0x00, 0x00, 0x0A, 0x00, 0x00, 0x00],
            ),
            ("随机二进制", vec![0x9E, 0x37, 0x11, 0xCD, 0x44, 0x02]),
        ] {
            let p = write_tmp("unknown-noext", &bytes);
            assert_eq!(
                detect_media_type(&p),
                None,
                "{name} 不该被内容兜底吸进索引（未知类型不索引）"
            );
        }
    }

    /// 内容兜底：SVG **没有** magic bytes 判据——`<svg` 会被未知二进制吸进索引。
    /// 因此 SVG / SVGZ **只认扩展名**（与 `txt` / `md` 同一档口径），改名后认不出是**已知边界**。
    #[test]
    fn svg_is_extension_only_no_content_fallback() {
        let svg = write_tmp(
            "icon.svg",
            b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        );
        assert_eq!(detect_media_type(&svg), Some(MediaType::Image));
        // 反向：同样内容但**没有扩展名** → 未知类型，不索引。
        let noext = write_tmp(
            "renamed-svg",
            b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        );
        assert_eq!(
            detect_media_type(&noext),
            None,
            "SVG 无扩展名时不该被吸进索引"
        );
        // 反向：SVGZ 是 gzip，但同样只认扩展名（gzip 不是 SVG 专属魔数）。
        let svgz = write_tmp("icon.svgz", &[0x1F, 0x8B, 0x08, 0x00]);
        assert_eq!(detect_media_type(&svgz), Some(MediaType::Image));
    }

    /// Netpbm 兜底必须要求第 3 字节是**空白**：否则任意 `P` + 数字开头的未知文件都会被吸进索引。
    #[test]
    fn pnm_sniff_requires_whitespace_after_magic() {
        let real = write_tmp("noext", b"P6\n64 48\n255\n");
        assert_eq!(detect_media_type(&real), Some(MediaType::Image));
        // 反向：`P1` 后紧跟非空白 → 不是 Netpbm 头，不得兜底。
        let fake = write_tmp("noext2", b"P1X-not-a-pnm-header");
        assert_eq!(detect_media_type(&fake), None);
    }
}
