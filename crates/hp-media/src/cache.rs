//! 缩略图缓存：按内容哈希分目录存放缩略图文件（缓存位置属于实现期开放点）。
//!
//! **落盘格式按媒体类型分流**（用户 2026-10-08 口径：同像素、同质量下取体积更小的格式）：
//! 图片缩略图用 **WebP**，视频首帧缩略图仍用 **JPEG**。实测依据与取舍理由见
//! `docs/issues/0029` 与 `thumbnail` 模块文档。因此文件名后缀随媒体类型不同，
//! 但**分片目录相同**（都以内容哈希前 2 位分片），预览文件也共用该目录。

use std::path::{Path, PathBuf};

use hp_core::{HpError, HpResult, MediaType};

/// 缩略图落盘格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbFormat {
    /// 图片缩略图：WebP（有损，经 ffmpeg 的 libwebp）。
    Webp,
    /// 视频首帧缩略图：JPEG。
    Jpeg,
    /// 音频**波形图**：PNG（`ffmpeg` 的 `showwavespic`，**背景透明**）。
    ///
    /// PNG 而不是 WebP/JPEG：波形图靠**透明背景**与主题配色共存
    /// （见 `waveform` 模块文档），两种有损格式都没有 alpha 通道可用。
    /// 体积也很小（实测 30 分钟音频 → 2.2 KB），无损 PNG 无需让位于有损压缩。
    WaveformPng,
}

impl ThumbFormat {
    /// 该格式的落盘扩展名。
    pub fn extension(self) -> &'static str {
        match self {
            ThumbFormat::Webp => "webp",
            ThumbFormat::Jpeg => "jpg",
            ThumbFormat::WaveformPng => "png",
        }
    }

    /// 某媒体类型在该缓存目录里的**缩略图**格式；文本与 PDF 不生成缩略图，返回 `None`。
    ///
    /// **音频返回 [`ThumbFormat::WaveformPng`]**（2026-10-17 / D115）：音频从 D11 占位行
    /// 升级为完整索引后，网格单元里显示的就是这张**波形图**——它占据图片缩略图同一个
    /// 位置（`thumb.get` → `.mp-thumb`），因此属于"缩略图"这一格的格式。
    /// **但它不是内容的视觉缩略**：波形图由**音频内容**生成，与图片缩略图"缩小的原图"
    /// 是两种东西（详见 `waveform` 模块文档）。
    ///
    /// 文本（`text`）与 PDF（`pdf`）的"封面"都**不是**缩略图：
    /// - `epub` 的内嵌封面由 `hp_book` 解析后按原格式落到
    ///   [`ThumbnailCache::path_for_book_cover`]；`txt` 根本没有封面
    ///   （前端用文件名渲染文字封面）；
    /// - PDF 的封面是**第一页栅格化**出来的，由 `hp_pdf` 编码成 JPEG 后落到**同一个**
    ///   `path_for_book_cover`（`ext = "jpg"`）——它同样是"书的封面"，
    ///   不该另立一个缓存路径。
    ///
    /// 因此这里对两者恒为 `None`，别把两件事混起来。
    pub fn for_media_type(media_type: MediaType) -> Option<Self> {
        match media_type {
            MediaType::Image => Some(ThumbFormat::Webp),
            MediaType::Video => Some(ThumbFormat::Jpeg),
            MediaType::Audio => Some(ThumbFormat::WaveformPng),
            MediaType::Text | MediaType::Pdf => None,
        }
    }
}

/// 缩略图缓存：`root/<前2位>/<content_hash>.<ext>`。
#[derive(Debug, Clone)]
pub struct ThumbnailCache {
    root: PathBuf,
}

impl ThumbnailCache {
    /// 以 `root` 为缓存根目录创建缓存管理器。
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// 缓存根目录。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 某内容哈希的分片目录（前 2 位；哈希过短时归入 `xx`）。
    ///
    /// 所有格式共用同一分片目录——格式只影响文件名后缀。
    pub fn shard_dir(&self, content_hash: &str) -> PathBuf {
        let prefix = if content_hash.len() >= 2 {
            &content_hash[..2]
        } else {
            "xx"
        };
        self.root.join(prefix)
    }

    /// 某内容哈希、某格式的缩略图路径。
    pub fn path_for_format(&self, content_hash: &str, format: ThumbFormat) -> PathBuf {
        self.shard_dir(content_hash)
            .join(format!("{content_hash}.{}", format.extension()))
    }

    /// 图片缩略图路径（WebP）。
    pub fn path_for_image(&self, content_hash: &str) -> PathBuf {
        self.path_for_format(content_hash, ThumbFormat::Webp)
    }

    /// 视频首帧缩略图路径（JPEG）。
    pub fn path_for_video(&self, content_hash: &str) -> PathBuf {
        self.path_for_format(content_hash, ThumbFormat::Jpeg)
    }

    /// 音频**波形图**路径（PNG；2026-10-17 / D115）。
    ///
    /// 与缩略图同分片、同名不同后缀，互不冲突。
    pub fn path_for_audio(&self, content_hash: &str) -> PathBuf {
        self.path_for_format(content_hash, ThumbFormat::WaveformPng)
    }

    /// 某内容哈希对应的**全分辨率预览**路径（与缩略图同分片、同名不同后缀，
    /// 互不冲突；见 `preview.get` 命令与 `docs/issues/0019`）。
    ///
    /// 预览保持 JPEG：它是查看器 100% 检视用的原始尺寸图，与"缩略图格式"是两件事。
    pub fn path_for_preview(&self, content_hash: &str) -> PathBuf {
        self.shard_dir(content_hash)
            .join(format!("{content_hash}.preview.jpg"))
    }

    /// 电子书**内嵌封面**的缓存路径（`<hash>.cover.<ext>`）。
    ///
    /// 与缩略图同分片、同名不同后缀，互不冲突。`ext` 由 `hp_book` 按封面图片的
    /// magic bytes 给出（`jpg` / `png` / `gif` / `webp` / `bmp` / `svg`）——
    /// 这里**不转码**：封面是书的门面，原样保留原格式与原质量。
    pub fn path_for_book_cover(&self, content_hash: &str, ext: &str) -> PathBuf {
        self.shard_dir(content_hash)
            .join(format!("{content_hash}.cover.{ext}"))
    }

    /// 电子书**元数据缓存**路径（`<hash>.bookmeta.json`）。
    ///
    /// 缓存的是"解析一次 EPUB 才知道的东西"（作者 / 简介 / 封面扩展名）。
    /// 没有它，面板每次装载都要把整本 epub 读一遍并解压封面——一本书几十兆，
    /// 那点延迟在卡片网格里是看得见的。**内容以内容哈希为键**：文件一变，
    /// 哈希就变，旧缓存自然失效（与缩略图同一套失效口径）。
    pub fn path_for_book_meta(&self, content_hash: &str) -> PathBuf {
        self.shard_dir(content_hash)
            .join(format!("{content_hash}.bookmeta.json"))
    }

    /// 电子书**目录缓存**路径（`<hash>.booktoc.json`）。
    ///
    /// 目录是"扫一遍全书才知道"的东西：纯文本要逐块读盘、逐行套小说章节规则
    /// （实测 24 MB 的书 release 下 60–130 ms，dev 构建下 0.4–1.1 s），
    /// EPUB 要解 nav / NCX。**同一本书第二次打开目录是逐字不变的**，
    /// 所以按内容哈希落盘复用——与元数据同一套失效口径（文件一变哈希就变）。
    ///
    /// 记录里另带一个**规则版本号**：`TOC_MAX_ENTRIES` 或标题识别规则演进时，
    /// 旧缓存不会因为文件没变就永远命中，版本号对不上即重扫。
    pub fn path_for_book_toc(&self, content_hash: &str) -> PathBuf {
        self.shard_dir(content_hash)
            .join(format!("{content_hash}.booktoc.json"))
    }

    /// 电子书**正文插图**的缓存路径（`<hash>.book-<章节>-<序号>.<ext>`）。
    ///
    /// EPUB 的章节正文里可能有插图（实测语料 22/22 本都有，共 420 个 `<img>`），
    /// 它们要落盘才能交给前端 `convertFileSrc` 渲染。与封面/元数据**同分片、
    /// 同名不同后缀**，因此互不冲突，且同一本书第二次打开直接命中缓存。
    ///
    /// 序号是**章内**的图片序号（同一章里第几张），章节号是 spine 序号——
    /// 两者一起保证同一本书内不重名。
    pub fn path_for_book_content_image(
        &self,
        content_hash: &str,
        section: u32,
        index: usize,
        ext: &str,
    ) -> PathBuf {
        self.shard_dir(content_hash)
            .join(format!("{content_hash}.book-{section}-{index}.{ext}"))
    }

    /// 确保缓存根目录存在。
    pub fn ensure_dir(&self) -> HpResult<()> {
        std::fs::create_dir_all(&self.root)
            .map_err(|e| HpError::Io(format!("创建缩略图缓存目录失败: {e}")))
    }

    /// 确保某内容哈希对应的缩略图父目录存在。
    pub fn ensure_dir_for(&self, content_hash: &str) -> HpResult<()> {
        std::fs::create_dir_all(self.shard_dir(content_hash))
            .map_err(|e| HpError::Io(format!("创建缩略图子目录失败: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_thumbnail_is_webp() {
        let cache = ThumbnailCache::new("C:/tmp/thumbs");
        let p = cache.path_for_image("abcdef0123456789");
        assert_eq!(p, PathBuf::from("C:/tmp/thumbs/ab/abcdef0123456789.webp"));
    }

    #[test]
    fn video_thumbnail_is_jpeg() {
        let cache = ThumbnailCache::new("C:/tmp/thumbs");
        let p = cache.path_for_video("abcdef0123456789");
        assert_eq!(p, PathBuf::from("C:/tmp/thumbs/ab/abcdef0123456789.jpg"));
    }

    #[test]
    fn format_follows_media_type() {
        assert_eq!(
            ThumbFormat::for_media_type(MediaType::Image),
            Some(ThumbFormat::Webp)
        );
        assert_eq!(
            ThumbFormat::for_media_type(MediaType::Video),
            Some(ThumbFormat::Jpeg)
        );
        // 音频（2026-10-17 / D115）：占位行升级后，它在这一格显示的是**波形图**
        // （PNG，背景透明）。**是 PNG 不是 WebP/JPEG**：两种有损格式都没有 alpha，
        // 而透明背景正是"一张图配三套主题"的前提（见 `waveform` 模块文档）。
        assert_eq!(
            ThumbFormat::for_media_type(MediaType::Audio),
            Some(ThumbFormat::WaveformPng)
        );
        assert_eq!(ThumbFormat::WaveformPng.extension(), "png");
        // 文本没有"缩略图"：epub 封面走 `path_for_book_cover`，txt 走前端文字封面。
        assert_eq!(ThumbFormat::for_media_type(MediaType::Text), None);
        assert_eq!(ThumbFormat::for_media_type(MediaType::Pdf), None);
    }

    #[test]
    fn audio_waveform_shares_shard_but_not_file() {
        // 波形图与图片/视频缩略图**同分片、不同文件**：内容哈希相同的图片与音频
        // （理论上可能，比如同一个哈希前缀）不会互相覆盖。
        let cache = ThumbnailCache::new("C:/tmp/thumbs");
        let audio = cache.path_for_audio("abcdef0123456789");
        assert_eq!(
            audio,
            PathBuf::from("C:/tmp/thumbs/ab/abcdef0123456789.png")
        );
        let img = cache.path_for_image("abcdef0123456789");
        let vid = cache.path_for_video("abcdef0123456789");
        assert_eq!(audio.parent(), img.parent(), "三种格式共用分片目录");
        assert_ne!(audio, img, "波形图与图片缩略图不得共用同一缓存文件");
        assert_ne!(audio, vid, "波形图与视频缩略图不得共用同一缓存文件");
    }

    #[test]
    fn book_cover_shares_shard_but_not_file() {
        let cache = ThumbnailCache::new("C:/tmp/thumbs");
        let cover = cache.path_for_book_cover("abcdef0123456789", "png");
        let thumb = cache.path_for_image("abcdef0123456789");
        assert_eq!(
            cover,
            PathBuf::from("C:/tmp/thumbs/ab/abcdef0123456789.cover.png")
        );
        assert_eq!(cover.parent(), thumb.parent(), "封面与缩略图共用分片目录");
        assert_ne!(cover, thumb, "封面与缩略图不得共用同一缓存文件");
    }

    #[test]
    fn book_toc_shares_shard_but_not_file() {
        // 目录缓存与封面 / 元数据 / 插图**同分片、不同文件**：同一本书的四种缓存
        // 各自独立，不会互相覆盖。
        let cache = ThumbnailCache::new("C:/tmp/thumbs");
        let toc = cache.path_for_book_toc("abcdef0123456789");
        assert_eq!(
            toc,
            PathBuf::from("C:/tmp/thumbs/ab/abcdef0123456789.booktoc.json")
        );
        assert_eq!(
            toc.parent(),
            cache.path_for_book_meta("abcdef0123456789").parent(),
            "目录与元数据共用分片目录"
        );
        assert_ne!(toc, cache.path_for_book_meta("abcdef0123456789"));
        assert_ne!(toc, cache.path_for_book_cover("abcdef0123456789", "png"));
        assert_ne!(toc, cache.path_for_image("abcdef0123456789"));
    }

    #[test]
    fn formats_share_shard_but_not_file() {
        let cache = ThumbnailCache::new("C:/tmp/thumbs");
        let img = cache.path_for_image("abcdef0123456789");
        let vid = cache.path_for_video("abcdef0123456789");
        assert_eq!(img.parent(), vid.parent(), "两种格式共用分片目录");
        assert_ne!(img, vid, "两种格式不得共用同一缓存文件");
    }

    #[test]
    fn preview_path_shares_shard_but_has_own_name() {
        let cache = ThumbnailCache::new("C:/tmp/thumbs");
        let thumb = cache.path_for_image("abcdef0123456789");
        let preview = cache.path_for_preview("abcdef0123456789");
        assert_eq!(
            preview,
            PathBuf::from("C:/tmp/thumbs/ab/abcdef0123456789.preview.jpg")
        );
        assert_ne!(thumb, preview, "预览与缩略图不得共用同一缓存文件");
    }

    #[test]
    fn short_hash_uses_fallback() {
        let cache = ThumbnailCache::new("C:/tmp/thumbs");
        let p = cache.path_for_image("a");
        assert_eq!(p, PathBuf::from("C:/tmp/thumbs/xx/a.webp"));
    }
}
