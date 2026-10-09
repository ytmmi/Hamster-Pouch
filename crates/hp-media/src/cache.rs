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
}

impl ThumbFormat {
    /// 该格式的落盘扩展名。
    pub fn extension(self) -> &'static str {
        match self {
            ThumbFormat::Webp => "webp",
            ThumbFormat::Jpeg => "jpg",
        }
    }

    /// 某媒体类型的缩略图格式；音频与文本不生成缩略图，返回 `None`。
    ///
    /// 文本（`text`）的"封面"不是缩略图：`epub` 的内嵌封面由 `hp_book` 解析后
    /// 按原格式落到 [`ThumbnailCache::path_for_book_cover`]，`txt` 根本没有封面
    /// （前端用文件名渲染文字封面）。因此这里恒为 `None`，别把两件事混起来。
    pub fn for_media_type(media_type: MediaType) -> Option<Self> {
        match media_type {
            MediaType::Image => Some(ThumbFormat::Webp),
            MediaType::Video => Some(ThumbFormat::Jpeg),
            MediaType::Audio | MediaType::Text => None,
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
        assert_eq!(ThumbFormat::for_media_type(MediaType::Audio), None);
        // 文本没有"缩略图"：epub 封面走 `path_for_book_cover`，txt 走前端文字封面。
        assert_eq!(ThumbFormat::for_media_type(MediaType::Text), None);
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
