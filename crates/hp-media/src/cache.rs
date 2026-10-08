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

    /// 某媒体类型的缩略图格式；音频不生成缩略图，返回 `None`。
    pub fn for_media_type(media_type: MediaType) -> Option<Self> {
        match media_type {
            MediaType::Image => Some(ThumbFormat::Webp),
            MediaType::Video => Some(ThumbFormat::Jpeg),
            MediaType::Audio => None,
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
