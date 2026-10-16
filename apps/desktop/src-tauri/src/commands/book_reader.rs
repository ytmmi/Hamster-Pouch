//! 图书阅读器的**桥接侧取数**：`book.toc`（目录）+ **整本正文解码缓存**。
//!
//! ## 为什么与 `book.rs` 分开
//!
//! `book.rs` 已经承担三件事（元数据 / 正文分页 / 封面覆盖），再加"目录 + 整本缓存"
//! 就超过项目"单文件 ≤ 1200 行"的红线（实测 1229 行）。按**职责**切而不是按行数切：
//!
//! | 文件 | 职责 | 消费者 |
//! | --- | --- | --- |
//! | `book.rs` | 元数据 / 正文分页 / 封面覆盖 | 图书预览 + **查看器** + 阅读器 |
//! | 本文件 | **目录** + **整本正文缓存** | **图书阅读器** |
//!
//! 依赖方向单向：`book.rs → book_reader.rs`（`book_content` 复用这里的整本缓存），
//! 反向没有引用。
//!
//! ## 整本解码与缓存（2026-10-16）
//!
//! 查看器的口径是"只显示开头内容"（`hp_book::TEXT_VIEW_MAX_BYTES` = 2 MiB），
//! 而阅读器的**目录跳转**必须能读到全书：一本 24 MB 的 txt，第 800 章落在 2 MiB 之外，
//! 按 2 MiB 截断就永远读不到。因此这里：
//!
//! 1. 把字节上限放宽到 [`READER_MAX_BYTES`]（64 MiB，覆盖长篇连载的量级，
//!    同时给畸形巨文件留一道闸：超过即 `capped = true`，**不是错误**）；
//! 2. 加一份**单本缓存**（[`ReaderTextCache`]）——整本解码 24 MB 的 GBK 小说
//!    约几百毫秒，而"翻一页"与"列目录"都要读同一份正文，不缓存就没法用。
//!
//! 缓存只留一本，键是 `repo_id|file_id|content_hash`：换仓库 / 换文件 / **换内容**
//! （重新分析、文件被改）都会命中不同的键而重新解码。

use std::path::Path;
use std::sync::Mutex;

use hp_core::{HpError, HpResult, MediaType};
use hp_dto::{BookTocItem, BookTocResult};
use tauri::State;

use crate::commands::shared::{api_async, api_from_hp, lock_repo, open_repo, resolve_file_path, ApiAsync};
use crate::AppState;

/// 阅读器整本解码的**字节上限**：64 MiB。
///
/// 查看器（`panel.viewer`）沿用 `hp_book::TEXT_VIEW_MAX_BYTES`（2 MiB）；
/// **阅读器**要能跳到任意一章，而 2 MiB 只够一本小说前 ~20%（实测语料里最大的
/// txt 是 24 MB），因此这里放宽到 64 MiB——覆盖"长篇连载"的量级，
/// 同时仍然给"畸形巨文件"留一道闸：超过即按 `book.content` 的 `capped` 字段如实降级。
///
/// 代价由 [`ReaderTextCache`] 吸收：解码一次、缓存一本，翻页与目录都命中缓存。
pub(crate) const READER_MAX_BYTES: usize = 64 * 1024 * 1024;

/// 阅读器的**单本纯文本缓存**（解码后的正文 + 编码 + 是否被上限截断）。
///
/// 只留**一本**（`key` 不匹配即整份替换）：阅读器一次只读一本书，
/// 留多本只是白占内存（一本 24 MB 的 txt 解码后约 24 MB 字符串）。
pub(crate) struct ReaderTextCache {
    /// 缓存键：`repo_id|file_id|content_hash`（内容哈希变了 = 换了一本书的内容）。
    pub(crate) key: String,
    /// 解码后的正文。
    pub(crate) text: String,
    /// 判定出的编码名（`UTF-8` / `GBK` …），供面板提示。
    pub(crate) encoding: String,
    /// 是否因 [`READER_MAX_BYTES`] 被截断。
    pub(crate) capped: bool,
}

/// 在**整本纯文本**上执行 `use_text`（必要时先解码并写缓存）。
///
/// 用闭包而不是"返回 `&str`"：缓存在 `Mutex` 后面，把借用逃出锁是不可能的；
/// 而每页克隆一份 24 MB 的字符串是纯浪费。闭包在持锁期间执行，因此同一本书的
/// 并发请求是串行的——阅读器一次只读一本书，这正是想要的行为。
pub(crate) fn with_reader_text<T>(
    cache: &Mutex<Option<ReaderTextCache>>,
    key: &str,
    src_path: &Path,
    use_text: impl FnOnce(&str, &str, bool) -> T,
) -> HpResult<T> {
    // 中毒的锁不该让阅读器不可用：数据只是一份可重算的解码结果。
    let mut guard = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let hit = guard.as_ref().is_some_and(|entry| entry.key == key);
    if !hit {
        let decoded = hp_book::decode_file_limited(src_path, usize::MAX, READER_MAX_BYTES)?;
        *guard = Some(ReaderTextCache {
            key: key.to_string(),
            text: decoded.text,
            encoding: decoded.encoding.name().to_string(),
            capped: decoded.capped,
        });
    }
    let entry = guard.as_ref().expect("上面刚保证过缓存已填充");
    Ok(use_text(&entry.text, &entry.encoding, entry.capped))
}

/// 一本"书"在读正文 / 目录时的**全部外部依赖**（省得每个函数都拖六个参数）。
pub(crate) struct ReaderCtx<'a> {
    /// 插图 / 整页位图的落盘缓存。
    pub(crate) cache: &'a hp_media::ThumbnailCache,
    /// 纯文本的整本解码缓存。
    pub(crate) text_cache: &'a Mutex<Option<ReaderTextCache>>,
    /// 内容哈希（缓存路径的键）。
    pub(crate) hash: &'a str,
    /// 纯文本缓存键（`repo_id|file_id|content_hash`）。
    pub(crate) text_key: &'a str,
}

/// 纯文本缓存键：`repo_id|file_id|content_hash`。
///
/// 三个都要：换仓库（同一 `file_id` 在不同库里是两本书）、换文件、**换内容**
/// （重新分析 / 文件被改）都必须让缓存失效。
pub(crate) fn reader_text_key(repo_id: &str, file_id: &str, hash: Option<&str>) -> String {
    format!("{repo_id}|{file_id}|{}", hash.unwrap_or("-"))
}

/// 空目录（非"书" / 无内容哈希）：**不是错误**。
fn empty_toc() -> BookTocResult {
    BookTocResult {
        format: String::new(),
        entries: Vec::new(),
        total: None,
    }
}

/// 选目录读取器：与 `book.rs` 的 `read_page_by_media_type` 同一条分流口径
/// （**按媒体类型**，不按扩展名——扫描器对 PDF 做了 `%PDF-` 内容兜底，
/// 扩展名被改掉的 PDF 也会入库为 `media_type = pdf`）。
pub(crate) fn read_toc_by_media_type(
    media_type: MediaType,
    src_path: &Path,
    ext: &str,
    ctx: &ReaderCtx<'_>,
) -> HpResult<BookTocResult> {
    let (format, entries, total) = if media_type == MediaType::Pdf {
        // PDF 是版式描述，没有章节语义：空目录（阅读器此时只显示正文与页码）。
        // 进度也不由这里给（用 `book.content` 的 section / section_count）。
        ("pdf".to_string(), Vec::new(), None)
    } else {
        match ext {
            "epub" => (
                "epub".to_string(),
                // 读不出目录不是错误（坏包 / 缺 OPF）：空目录，正文照常能读。
                hp_book::read_epub_toc(src_path).unwrap_or_default(),
                None,
            ),
            "md" | "markdown" => {
                let decoded = hp_book::decode_file_head(src_path, usize::MAX)?;
                let read = hp_book::blocks_from_markdown(&decoded.text, src_path.parent());
                let total = u32::try_from(read.blocks.len()).ok();
                ("markdown".to_string(), hp_book::markdown_toc(&read.blocks), total)
            }
            _ => {
                // **整本**解码（阅读器的字节上限）：目录必须覆盖全书，
                // 否则第 800 章根本不会出现在目录里。总字符数顺带在这里算出
                // （与 `cursor` 同为字符口径，进度因此可以对上）。
                with_reader_text(ctx.text_cache, ctx.text_key, src_path, |text, _, _| {
                    let total = u32::try_from(text.chars().count()).ok();
                    ("text".to_string(), hp_book::text_toc(text), total)
                })?
            }
        }
    };

    Ok(BookTocResult {
        format,
        entries: entries
            .into_iter()
            .map(|entry| BookTocItem {
                title: entry.title,
                level: entry.level,
                cursor: entry.cursor,
            })
            .collect(),
        total,
    })
}

/// `book.toc`：读一本书的**目录**（图书阅读器的章节栏）。
///
/// 各格式的来源（见 `hp_book::toc` 的模块文档）：
/// - `epub`：nav（EPUB3）→ NCX（EPUB2）→ 各章 `<title>` 兜底；
/// - `txt` / 其它文本：**内置小说章节规则**识别标题行（用户 2026-10-16 口径）；
/// - `md` / `markdown`：顶层标题块；
/// - `pdf`：**没有目录结构**（版式描述里没有章节语义）→ 空目录。
///
/// 与 `book.content` **同一条游标口径**（epub = 章节序号、txt = 字符偏移、
/// md = 顶层块序号），因此"目录跳转"就是把目录给的 `cursor` 原样交给 `book.content`。
///
/// 打不开的书 / 非"书"类型 → **空目录而不是错误**（与 `book.meta` / `book.content`
/// 同一条降级口径：一本书读不出目录不该让阅读器变成错误态）。
#[tauri::command]
pub(crate) async fn book_toc(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<BookTocResult> {
    let outcome = async {
        let (src_path, media_type, content_hash, cache, text_cache, text_key) = {
            let guard = lock_repo(&state)?;
            let db = open_repo(&guard)?;
            let file = db
                .get_file(&file_id)?
                .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
            let src_path = resolve_file_path(db, &file)?;
            let text_key = reader_text_key(&repo_id, &file_id, file.content_hash.as_deref());
            (
                src_path,
                file.media_type,
                file.content_hash,
                (*state.thumb_cache).clone(),
                state.book_text.clone(),
                text_key,
            )
        };

        if !media_type.is_book() {
            return Ok(empty_toc());
        }
        let Some(hash) = content_hash else {
            return Ok(empty_toc());
        };

        let ext = src_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        // 与 `book.content` 一样放在阻塞线程：整本解码（阅读器的 64 MiB 上限）
        // 与 EPUB 解包都不能占着 IPC 线程。
        //
        // `ReaderCtx` **在闭包内**构造：闭包按 `'static` 要求把 `cache` / `text_cache` /
        // `hash` / `text_key` 移进去，借用因此落在闭包内部（在外面构造会借用局部变量，
        // 编译器正确地拒绝）。
        let read = tauri::async_runtime::spawn_blocking(move || {
            let ctx = ReaderCtx {
                cache: &cache,
                text_cache: &text_cache,
                hash: &hash,
                text_key: &text_key,
            };
            read_toc_by_media_type(media_type, &src_path, &ext, &ctx)
        })
        .await
        .map_err(|e| HpError::Io(format!("目录读取线程异常: {e}")))??;

        Ok(read)
    }
    .await;
    api_async(api_from_hp(outcome))
}
