//! 图书命令桥接：`book.meta`（作者 / 简介 / 内嵌封面）、`book.content`（查看器正文）
//! 与 `book.cover*`（封面覆盖：用户自设的颜色 / 图片）。
//!
//! **为什么不进索引**：封面是二进制、简介是长文本，把它们塞进 `files` 行会让
//! 每次文件查询都背上几十 KB 的负载，而列表只用得到"有没有封面"。
//! 因此走**按内容哈希的磁盘缓存**（与缩略图同一套失效口径）：
//! - `<hash>.cover.<ext>`：封面原格式字节（不转码）；
//! - `<hash>.bookmeta.json`：作者 / 简介 / 封面扩展名（免得每次重解一遍 epub）。
//!
//! **失败降级为"没有元数据"，不是错误**：一本书解析不了（损坏的 zip、缺 OPF）
//! 不该让整个图书预览面板变成错误态——面板回落成文件名文字封面即可。
//!
//! ## `book.content`（查看器正文，2026-10-09）
//!
//! 查看器要"显示书的开头内容"（用户口径），因此本文件另有 `book_content`：
//! - **txt / md**：判编码（实测语料 14 本里 7 本 GBK，见 `hp_book::text`）后按字符偏移分页；
//! - **epub**：按 **spine 章节**分页，章节的 XHTML 由 `hp-book` 转成**类型化块**
//!   （**不返回 HTML**——安全边界见 `hp_book::epub_text`）。
//!
//! epub 章节里的图片要落盘才能给前端 `convertFileSrc`：复用缩略图缓存目录的
//! `<hash>.book-<章节>-<序号>.<ext>`（按内容哈希失效，与封面/元数据同一套口径）。
//!
//! ## `book.cover*`（封面覆盖，2026-10-09）
//!
//! 用户口径："txt 右键可以更换封面颜色或自定义图片"。覆盖存在仓库库的
//! `file_covers` 表（迁移 0009），优先级高于"内嵌封面 / 文字封面"这两套默认。
//!
//! **库里只存"是什么"**（颜色值 / **裸文件名**），不存绝对路径：`data\user\covers\`
//! 的位置随安装目录变（开发包与发布包不同、整夹搬走也不同），存绝对路径会在换位置后
//! 全部失效——这正是全局库 `repos.repo_db_path` 需要在打包时被改写的那种麻烦。
//! 命令返回时再把文件名拼成**当前**的绝对路径给前端 `convertFileSrc`。
//!
//! 自定义图片会**拷贝**进 `data\user\covers\`（不是记住原路径）：原图可能被移动/删除，
//! 而封面是"这本书的属性"，不该因为用户整理文件就变成坏图。

/// 三个子模块共享的导入：集中在这里，子模块 `use super::prelude::*;` 即可取用
/// （glob 导入不会因"本模块没用到某一项"而报 unused）。
mod prelude {
    pub(super) use std::path::{Path, PathBuf};

    pub(super) use hp_core::{HpError, HpResult, MediaType};
    pub(super) use hp_dto::{
        BookBlockItem, BookContentResult, BookCoverItem, BookCoverResult, BookDefinitionItem,
        BookListItem, BookSpanItem, BookTableRowItem,
    };
    pub(super) use serde::{Deserialize, Serialize};
    pub(super) use tauri::State;

    pub(super) use crate::AppState;
    pub(super) use crate::commands::book_reader::ReaderCtx;
    pub(super) use crate::commands::shared::{
        ApiAsync, api_async, api_from_hp, lock_repo, open_repo, open_repo_mut, resolve_file_path,
    };
}

use prelude::*;

mod cache;
mod cover;
mod paging;

pub(crate) use cache::*;
pub(crate) use cover::*;
pub(crate) use paging::*;

/// `book.meta`：按 `file_id` 返回作者 / 简介 / 封面路径（带磁盘缓存）。
///
/// 非文本文件、无内容哈希、无元数据一律返回空结果而**不是**错误——
/// 调用方（图书预览面板）据此回落文字封面。
#[tauri::command]
pub(crate) async fn book_meta(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<BookMetaResult> {
    let _ = repo_id;

    let outcome = async {
        // 同步取出所需数据后立即释放锁，避免跨 await 持有 MutexGuard（与 `thumb.get` 同款）。
        let (src_path, media_type, content_hash, cache) = {
            let guard = lock_repo(&state)?;
            let db = open_repo(&guard)?;
            let file = db
                .get_file(&file_id)?
                .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
            let src_path = resolve_file_path(db, &file)?;
            (
                src_path,
                file.media_type,
                file.content_hash,
                (*state.thumb_cache).clone(),
            )
        };

        // 只有"书"（文本类 + PDF）可能带元数据；其余类型直接空结果（不是错误）。
        //
        // 判据用 `MediaType::is_book()` 而不是 `== Text`：PDF 是**独立类目**，
        // 但它与文本类在这一处的行为完全一致（都要作者 / 简介 / 封面）。
        // 分成两个条件写会让下次新增"书"类型时漏掉一个。
        if !media_type.is_book() {
            return Ok(BookMetaResult {
                author: None,
                description: None,
                cover_path: None,
            });
        }
        // 无内容哈希 = 索引里还没有可用的内容身份（例如不可读占位行）：
        // 没有稳定的缓存键，就不缓存、也不解析。
        let Some(hash) = content_hash else {
            return Ok(BookMetaResult {
                author: None,
                description: None,
                cover_path: None,
            });
        };

        // 缓存命中：封面文件也必须在盘上（否则退回重新解析）。
        if let Some(record) = read_cache(&cache.path_for_book_meta(&hash))
            && (record.cover_ext.is_none() || record.cover_path(&cache, &hash).is_some())
        {
            return Ok(record.into_result(&cache, &hash));
        }

        // 未命中：整本解析放到阻塞线程（大 epub 读盘 + 解压封面，不能占着 IPC 线程）。
        let hash_for_task = hash.clone();
        let cache_for_task = cache.clone();
        let src_for_task = src_path.clone();
        let record = tauri::async_runtime::spawn_blocking(move || match media_type {
            // PDF：封面 = 第一页栅格化（`hp-pdf`）。
            MediaType::Pdf => parse_pdf_and_cache(&src_for_task, &cache_for_task, &hash_for_task),
            // 文本类：EPUB 解 OPF 取内嵌封面；txt / md 本来就没有元数据。
            _ => parse_and_cache(&src_for_task, &cache_for_task, &hash_for_task),
        })
        .await
        .map_err(|e| HpError::Io(format!("图书解析线程异常: {e}")))??;

        Ok(record.into_result(&cache, &hash))
    }
    .await;
    api_async(api_from_hp(outcome))
}

/// `book.content`：读取查看器要显示的**一页正文**（`txt` / `md` / `epub` / `pdf`）。
///
/// 用户口径（2026-10-09）：查看器新增 txt 与 epub 两种查看，**显示开头内容**、
/// 范围为查看器面板大小；"固定上限 + 面板内滚动看更多，滚动时按需缓存"。
/// 因此本命令是**分页**的：每次只回一页，游标由前端带着走。
///
/// - `cursor` 缺省 = 第一页；纯文本是字符偏移、epub 是章节序号；
/// - 非文本类 / 无内容哈希 / 解析失败 → **空结果而不是错误**（与 `book.meta` 同口径：
///   一本书打不开不该让查看器变成错误态）。
#[tauri::command]
pub(crate) async fn book_content(
    repo_id: String,
    file_id: String,
    cursor: Option<String>,
    state: State<'_, AppState>,
) -> ApiAsync<BookContentResult> {
    let _ = repo_id;

    let outcome = async {
        let _ = repo_id;
        // 同步取出所需数据后立即释放锁，避免跨 await 持有 MutexGuard。
        let (src_path, media_type, content_hash, cache) = {
            let guard = lock_repo(&state)?;
            let db = open_repo(&guard)?;
            let file = db
                .get_file(&file_id)?
                .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
            let src_path = resolve_file_path(db, &file)?;
            (
                src_path,
                file.media_type,
                file.content_hash,
                (*state.thumb_cache).clone(),
            )
        };

        // 非"书"（文本类 + PDF）没有"正文"可看：空结果（不是错误）。
        if !media_type.is_book() {
            return Ok(empty_content());
        }
        let Some(hash) = content_hash else {
            return Ok(empty_content());
        };

        let offset = parse_cursor(cursor.as_deref());
        let ext = src_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        // 读盘 / 解压 / 栅格化放在阻塞线程（大 epub 与 24 MB 的 txt 都不能占着 IPC 线程；
        // PDF 还要真的把一页画出来，实测 25–156 ms，更不能占 IPC 线程）。
        //
        // **纯文本这一轮不再需要"整本缓存"**（需求 2）：`read_text_page` 每次只读
        // 一页所需的字节窗口，因此这里没有要跨请求保持的状态——`ReaderCtx` 只剩
        // "插图缓存 + 内容哈希"两个字段（见 `book_reader.rs`），构造它的理由与
        // `book_toc` 的同款注释一致（闭包按 `'static` 要求把借用移进去）。
        let read = tauri::async_runtime::spawn_blocking(move || {
            let ctx = ReaderCtx {
                cache: &cache,
                hash: &hash,
            };
            read_page_by_media_type(media_type, &src_path, &ext, offset, &ctx)
        })
        .await
        .map_err(|e| HpError::Io(format!("正文读取线程异常: {e}")))??;

        Ok(read)
    }
    .await;
    api_async(api_from_hp(outcome))
}
