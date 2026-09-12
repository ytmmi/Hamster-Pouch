//! 缩略图缓存：按内容哈希分目录存放缩略图文件（缓存位置属于实现期开放点）。

use std::path::{Path, PathBuf};

use hp_core::{HpError, HpResult};

/// 缩略图缓存：`root/<前2位>/<content_hash>.jpg`。
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

    /// 某内容哈希对应的缩略图路径。
    pub fn path_for(&self, content_hash: &str) -> PathBuf {
        let prefix = if content_hash.len() >= 2 {
            &content_hash[..2]
        } else {
            "xx"
        };
        self.root
            .join(prefix)
            .join(format!("{content_hash}.jpg"))
    }

    /// 确保缓存根目录存在。
    pub fn ensure_dir(&self) -> HpResult<()> {
        std::fs::create_dir_all(&self.root)
            .map_err(|e| HpError::Io(format!("创建缩略图缓存目录失败: {e}")))
    }

    /// 确保某内容哈希对应的缩略图父目录存在。
    pub fn ensure_dir_for(&self, content_hash: &str) -> HpResult<()> {
        let path = self.path_for(content_hash);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| HpError::Io(format!("创建缩略图子目录失败: {e}")))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_shards_by_first_two_chars() {
        let cache = ThumbnailCache::new("C:/tmp/thumbs");
        let p = cache.path_for("abcdef0123456789");
        assert_eq!(p, PathBuf::from("C:/tmp/thumbs/ab/abcdef0123456789.jpg"));
    }

    #[test]
    fn short_hash_uses_fallback() {
        let cache = ThumbnailCache::new("C:/tmp/thumbs");
        let p = cache.path_for("a");
        assert_eq!(p, PathBuf::from("C:/tmp/thumbs/xx/a.jpg"));
    }
}
