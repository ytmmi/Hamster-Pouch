//! 图书命令族的**取数前置**：一个 `file_id` → 一份可直接交给下游的 [`BookSource`]。
//!
//! ## 为什么单独成文件（D203）
//!
//! `book.meta` / `book.content` / `book.toc` 三个命令此前各抄一遍同样的五行：
//!
//! 1. `with_repo` 里取 `(src_path, media_type, content_hash, cache)` 四元组；
//! 2. 不是「书」（文本类 + PDF 之外）→ **空结果而不是错误**；
//! 3. 没有内容哈希 → **不解析**（没有稳定缓存键，解析结果无处可存）；
//! 4. 扩展名小写化（三处都写 `extension().and_then(to_str).unwrap_or("").to_ascii_lowercase()`）；
//! 5. `spawn_blocking` + `map_err(|e| HpError::Io("…线程异常: {e}"))`。
//!
//! 这五条都是**口径**而不是样板：新增一种「书」（例如将来支持 mobi）要同时改三处，
//! 而漏改不会编译失败——只会让某一个命令的行为悄悄和另外两个不一致。
//! 现在只有这一份，三个命令各自只剩「空结果长什么样」与「在阻塞线程里做什么」。

use super::prelude::*;
use crate::commands::shared::with_repo;

/// 一本「书」的读取前置：三个图书命令共用，构造后即与 `AppState` 的锁无关。
pub(crate) struct BookSource {
    /// 源文件绝对路径（`resolve_file_path` 的产物）。
    pub(crate) src_path: PathBuf,
    /// 媒体类型（分流依据；**不按扩展名猜**，扫描器对 PDF 做过内容兜底）。
    pub(crate) media_type: MediaType,
    /// 内容哈希（缓存键，也是纯文本锚点表的 `content_key`）。
    pub(crate) hash: String,
    /// 小写化后的扩展名（`""` = 没有扩展名）。
    pub(crate) ext: String,
    /// 插图 / 封面 / 整页位图的落盘缓存。
    pub(crate) cache: hp_media::ThumbnailCache,
}

/// 解析一本书的读取前置。
///
/// - 文件行不存在 → `not_found`（这是调用方的错，**不降级**）；
/// - 不是「书」→ `Ok(None)`（调用方回自己的空结果）；
/// - 没有内容哈希 → `Ok(None)`（没有稳定缓存键就不解析，与 `book.meta` 同一条口径）。
///
/// **锁只在这里持有**：取完四元组就放锁，闭包外的 `await` 不再跨 `MutexGuard`。
pub(crate) fn resolve_book_source(
    state: &AppState,
    repo_id: &str,
    file_id: &str,
) -> HpResult<Option<BookSource>> {
    let (src_path, media_type, content_hash, cache) = with_repo(state, repo_id, |db| {
        let file = db
            .get_file(file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        let src_path = resolve_file_path(db, &file)?;
        Ok((
            src_path,
            file.media_type,
            file.content_hash,
            (*state.thumb_cache).clone(),
        ))
    })?;

    if !media_type.is_book() {
        return Ok(None);
    }
    let Some(hash) = content_hash else {
        return Ok(None);
    };
    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    Ok(Some(BookSource {
        src_path,
        media_type,
        hash,
        ext,
        cache,
    }))
}

/// 把一次取数放到阻塞线程，并统一「线程异常」的错误形状。
///
/// `label` 只进错误文案（`<label>线程异常: …`），既有三条文案逐字保留：
/// `图书解析` / `正文读取` / `目录读取`。
pub(crate) async fn run_book_io<T, F>(label: &'static str, body: F) -> HpResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> HpResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(body)
        .await
        .map_err(|e| HpError::Io(format!("{label}线程异常: {e}")))?
}
