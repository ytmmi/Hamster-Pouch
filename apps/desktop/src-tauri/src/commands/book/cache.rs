//! `book` 的磁盘缓存层：元数据缓存结构 + 原子写 / 读 JSON 等落盘工具。
//!
//! 口径与缩略图缓存一致（按内容哈希失效），详见父模块的模块文档。

use super::prelude::*;

/// `book.meta` 返回体。
#[derive(Serialize)]
pub(crate) struct BookMetaResult {
    /// 作者（EPUB `<dc:creator>`）；无则 `null`。
    pub(crate) author: Option<String>,
    /// 简介（EPUB `<dc:description>`）；无则 `null`。
    pub(crate) description: Option<String>,
    /// **已落盘**的封面绝对路径（供前端 `convertFileSrc`）；无封面则 `null`。
    ///
    /// 无封面不是错误：`txt` / `md` 本来就没有封面，面板用文件名渲染文字封面；
    /// epub 里也确实存在不带封面的书。
    pub(crate) cover_path: Option<String>,
}

/// 磁盘上的元数据缓存（字段与 [`BookMetaResult`] 同形，外加封面扩展名）。
#[derive(Serialize, Deserialize)]
pub(crate) struct BookMetaCache {
    pub(crate) author: Option<String>,
    pub(crate) description: Option<String>,
    /// 封面扩展名（`jpg` / `png` / …）；`None` = 这本书没有封面。
    pub(crate) cover_ext: Option<String>,
}

impl BookMetaCache {
    /// 缓存记录的封面文件路径（`cover_ext` 为空则没有封面）。
    pub(crate) fn cover_path(
        &self,
        cache: &hp_media::ThumbnailCache,
        hash: &str,
    ) -> Option<PathBuf> {
        let ext = self.cover_ext.as_deref()?;
        let path = cache.path_for_book_cover(hash, ext);
        path.exists().then_some(path)
    }

    /// 转成命令返回体（**封面文件必须真的在盘上**，否则当作没有封面）。
    pub(crate) fn into_result(
        self,
        cache: &hp_media::ThumbnailCache,
        hash: &str,
    ) -> BookMetaResult {
        let cover_path = self
            .cover_path(cache, hash)
            .map(|p| p.to_string_lossy().to_string());
        BookMetaResult {
            author: self.author,
            description: self.description,
            cover_path,
        }
    }
}

/// 原子落盘：先写同目录临时文件再改名。
///
/// 直接写目标文件的话，前端可能在"写了一半"时读到它（缓存是跨进程共享的，
/// 面板刷新与后台解析可以并发）。改名在同一卷上是原子的。
pub(crate) fn write_atomic(target: &Path, bytes: &[u8]) -> HpResult<()> {
    let tmp = target.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| HpError::Io(format!("写入缓存失败: {e}")))?;
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        HpError::Io(format!("提交缓存失败: {e}"))
    })
}

/// 读一份 JSON 磁盘缓存；文件不存在或内容损坏都返回 `None`
/// （**损坏即当未缓存**，重算一次，绝不把坏缓存变成用户可见的错误）。
///
/// 泛型化（2026-10-19）：目录缓存（`book/toc.rs` 的 `<hash>.booktoc.json`）
/// 与元数据缓存走同一条"读文件 + 反序列化 + 失败即未命中"的口径，只是记录类型不同。
pub(crate) fn read_json_cache<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// 读元数据缓存；文件不存在或内容损坏都返回 `None`（损坏即当未缓存，重算一次）。
pub(crate) fn read_cache(path: &Path) -> Option<BookMetaCache> {
    read_json_cache(path)
}

/// 解析一本书并把结果写进缓存（在**阻塞线程**里跑：整本 epub 读盘 + 解压）。
pub(crate) fn parse_and_cache(
    source_path: &Path,
    cache: &hp_media::ThumbnailCache,
    hash: &str,
) -> HpResult<BookMetaCache> {
    // 解析失败 = 这本书没有元数据（不向上抛：面板要的是"能显示"）。
    let meta = hp_book::read_book_meta(source_path).unwrap_or_default();

    cache.ensure_dir_for(hash)?;

    let cover_ext = match &meta.cover {
        Some(cover) => {
            let path = cache.path_for_book_cover(hash, cover.ext);
            write_atomic(&path, &cover.bytes)?;
            Some(cover.ext.to_string())
        }
        None => None,
    };

    let record = BookMetaCache {
        author: meta.author,
        description: meta.description,
        cover_ext,
    };
    // 缓存写失败不影响本次返回：内存里已经有结果了。
    if let Ok(json) = serde_json::to_vec(&record) {
        let _ = write_atomic(&cache.path_for_book_meta(hash), &json);
    }
    Ok(record)
}

/// 解析一个 **PDF** 并把结果写进缓存（与 [`parse_and_cache`] 同形，只是解析器不同）。
///
/// **封面 = 第一页**（用户口径 2026-10-11）：由 `hp_pdf` 栅格化后编成 JPEG，
/// 落到与 EPUB 封面**同一个** `path_for_book_cover`（`ext = "jpg"`）——
/// 两者都是"书的封面"，共用一个缓存路径才能让前端只有一条渲染路径。
///
/// 成本比 EPUB 高（实测 20–122 ms @800px，要真的把一页画出来），因此这条缓存
/// 不是可选项：没有它，卡片网格里每滚动一次就要重画一遍。
pub(crate) fn parse_pdf_and_cache(
    source_path: &Path,
    cache: &hp_media::ThumbnailCache,
    hash: &str,
) -> HpResult<BookMetaCache> {
    // 打不开（损坏 / 加密）= 没有元数据（不向上抛：面板回落文字封面即可）。
    let meta = hp_pdf::read_pdf_meta(source_path).unwrap_or_default();

    cache.ensure_dir_for(hash)?;

    let cover_ext = match &meta.cover {
        Some(cover) => {
            let path = cache.path_for_book_cover(hash, cover.ext);
            write_atomic(&path, &cover.bytes)?;
            Some(cover.ext.to_string())
        }
        None => None,
    };

    let record = BookMetaCache {
        author: meta.author,
        description: meta.description,
        cover_ext,
    };
    if let Ok(json) = serde_json::to_vec(&record) {
        let _ = write_atomic(&cache.path_for_book_meta(hash), &json);
    }
    Ok(record)
}
