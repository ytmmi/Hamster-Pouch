//! 图书阅读器的**桥接侧取数**：`book.toc`（目录）。
//!
//! ## 为什么与 `book.rs` 分开
//!
//! `book.rs` 已经承担三件事（元数据 / 正文分页 / 封面覆盖），再加目录就超过项目
//! "单文件 ≤ 1200 行"的红线。按**职责**切而不是按行数切：
//!
//! | 文件 | 职责 | 消费者 |
//! | --- | --- | --- |
//! | `book.rs` | 元数据 / 正文分页 / 封面覆盖 | 图书预览 + **查看器** + 阅读器 |
//! | 本文件 | **目录** | **图书阅读器** |
//!
//! 依赖方向单向：`book.rs → book_reader.rs`（`book_content` 复用这里的
//! [`ReaderCtx`]），反向没有引用。
//!
//! ## 整本解码与缓存**已删除**（2026-10-18，用户需求 2）
//!
//! 旧口径（2026-10-16）：为了让"目录跳转"能到任意一章，把字节上限放宽到 64 MiB
//! （旧 `READER_MAX_BYTES`），并把**整本解码后的 `String` 缓存**在
//! `Mutex<Option<ReaderTextCache>>` 里复用——翻页与列目录都命中同一份缓存。
//!
//! **用户实测：打开一本 txt 内存涨到 5 GB 以上并卡死。**
//!
//! 成因不是某一页太大，而是"整本进内存"这条路径的倍数叠乘（详见
//! `hp_book::text_stream` 的模块文档）：原始字节 + 解码 `String` + `into_owned`
//! 拷贝 + 每页克隆 + 跨请求缓存不释放。
//!
//! 现在的口径：
//! - **正文**（`book.rs` 的 `read_text_page`）→ `hp_book::read_text_page_window`：
//!   按字符偏移定位、只读该页所需的**字节窗口**再解码。**没有任何跨请求状态**。
//! - **目录**（本文件）→ `hp_book::text_toc_stream`：按块流式扫描标题行，
//!   只在命中时回调；峰值内存 = 一个 256 KiB 块 + 一行，**不保留全文**。
//! - **统计闸门**不再是"读多少进内存"的上限，而是"数到哪儿为止"
//!   （`hp_book::TEXT_SCAN_MAX_BYTES` = 512 MiB）；畸形巨文件仍按 `capped` 如实降级。
//!
//! 于是 `AppState` 里那个 `book_text` 缓存字段（以及它的 `Mutex`）整个删掉了：
//! 没有"整本"可缓存，缓存也就没有存在的理由。这也顺带解决了旧实现的一个隐患——
//! 缓存在持锁期间解码，同一本书的并发请求被串行化；现在每个请求各开自己的 `File`，
//! 并发只受锚点表的短暂锁影响（见 `text_stream` 的"并发"一节）。

use std::path::Path;

use hp_core::{HpError, HpResult, MediaType};
use hp_dto::{BookTocItem, BookTocResult};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;
use crate::commands::book::{read_json_cache, write_atomic};
use crate::commands::shared::{
    ApiAsync, api_async, api_from_hp, lock_repo, open_repo, resolve_file_path,
};

/// 一本"书"在读目录时的**全部外部依赖**。
///
/// **只有两个字段**（2026-10-18）：纯文本的整本缓存（`text_cache`）与它的键
/// （`text_key`）随"渐进加载"一起删除——现在没有任何跨请求状态需要传进来。
/// 留下的 `cache` 是插图 / 整页位图的落盘缓存，`hash` 是缓存路径与
/// **锚点表内容身份**共用的键。
pub(crate) struct ReaderCtx<'a> {
    /// 插图 / 整页位图的落盘缓存。
    pub(crate) cache: &'a hp_media::ThumbnailCache,
    /// 内容哈希（缓存路径的键，也是纯文本锚点表的 `content_key`）。
    pub(crate) hash: &'a str,
}

/// 空目录（非"书" / 无内容哈希）：**不是错误**。
fn empty_toc() -> BookTocResult {
    BookTocResult {
        format: String::new(),
        entries: Vec::new(),
        total: None,
    }
}

/// 目录缓存的**规则版本**（`<hash>.booktoc.json` 的 `rule` 字段）。
///
/// 目录是按"扫一遍全书 + 一套标题识别规则"算出来的：文件没变，但**规则变了**
/// 时旧缓存会安静地给出过期结果。内容哈希管不到这种情况，所以另立一个手写版本号：
/// **只要动了标题识别口径（`novel_heading` 的判据、`TOC_MAX_ENTRIES`、
/// `markdown_toc` / EPUB nav 的取法），就把这个数 +1**，旧缓存随之全部作废。
///
/// 版本 1 = 2026-10-19 引入目录缓存时的规则（D116-R4）。
pub(crate) const TOC_CACHE_RULE: u32 = 1;

/// 磁盘上的目录缓存记录。
///
/// 与 [`BookTocResult`] 同形，但**不直接复用**那个 DTO：DTO 只承载 IPC 契约
/// （`hp-dto` 里刻意不 derive `Deserialize`），而缓存格式是本层自己的落盘细节，
/// 需要独立演进（`rule` 字段就是 DTO 里没有的）。
#[derive(Serialize, Deserialize)]
struct BookTocCache {
    /// 写这份缓存时的 [`TOC_CACHE_RULE`]；对不上即视为未命中。
    rule: u32,
    format: String,
    entries: Vec<BookTocCacheEntry>,
    total: Option<u32>,
}

#[derive(Serialize, Deserialize)]
struct BookTocCacheEntry {
    title: String,
    level: u32,
    cursor: String,
}

impl BookTocCache {
    fn into_result(self) -> BookTocResult {
        BookTocResult {
            format: self.format,
            entries: self
                .entries
                .into_iter()
                .map(|entry| BookTocItem {
                    title: entry.title,
                    level: entry.level,
                    cursor: entry.cursor,
                })
                .collect(),
            total: self.total,
        }
    }
}

/// 读目录缓存；**未命中 / 损坏 / 规则版本不符**一律返回 `None`。
pub(crate) fn read_toc_cache(
    cache: &hp_media::ThumbnailCache,
    hash: &str,
) -> Option<BookTocResult> {
    let record: BookTocCache = read_json_cache(&cache.path_for_book_toc(hash))?;
    (record.rule == TOC_CACHE_RULE).then(|| record.into_result())
}

/// 写目录缓存（**失败不影响本次返回**：缓存是加速手段，不是正确性前提）。
fn write_toc_cache(
    cache: &hp_media::ThumbnailCache,
    hash: &str,
    result: &BookTocResult,
) -> Option<()> {
    cache.ensure_dir_for(hash).ok()?;
    let record = BookTocCache {
        rule: TOC_CACHE_RULE,
        format: result.format.clone(),
        entries: result
            .entries
            .iter()
            .map(|entry| BookTocCacheEntry {
                title: entry.title.clone(),
                level: entry.level,
                cursor: entry.cursor.clone(),
            })
            .collect(),
        total: result.total,
    };
    let json = serde_json::to_vec(&record).ok()?;
    write_atomic(&cache.path_for_book_toc(hash), &json).ok()
}

/// 带缓存的目录读取：**先查盘，未命中才真扫**，扫完落盘。
///
/// ## 为什么值得缓存
///
/// 目录是"扫一遍全书才知道"的东西，而**同一本书第二次打开时目录逐字不变**。
/// 实测（release，14 本 txt / 22 本 epub）：
/// - 纯文本流式扫描 19–86 ms（dev 构建 0.4–1.1 s）——每次打开阅读器都付一遍；
/// - EPUB 读 nav / NCX 0.3–1.7 ms。
///
/// 命中缓存后这两种格式的目录都是**一次小 JSON 读盘**（几 KB），与书的大小无关。
///
/// ## 失效口径
///
/// - **文件内容变了** → `content_hash` 变 → 换键，旧缓存自然不再命中
///   （与 `book.meta` / 缩略图同一套口径）；
/// - **标题识别规则变了** → [`TOC_CACHE_RULE`] 版本号对不上 → 重扫；
/// - **缓存文件损坏** → 当作未命中（`read_json_cache` 吞掉解析错误）。
///
/// ## 不缓存的情形
///
/// - PDF：目录恒为空，读它本来就是 O(1)，缓存只会多一次 IO；
/// - 读出来"既没有条目、也没有总字数"的结果：这更像**读取失败**而不是
///   "这本书没有目录"，落盘会把一次偶发失败固化成长期结论。
pub(crate) fn read_toc_with_cache(
    media_type: MediaType,
    src_path: &Path,
    ext: &str,
    cache: &hp_media::ThumbnailCache,
    hash: &str,
) -> HpResult<BookTocResult> {
    if media_type == MediaType::Pdf {
        return read_toc_by_media_type(media_type, src_path, ext);
    }
    if let Some(hit) = read_toc_cache(cache, hash) {
        return Ok(hit);
    }

    let result = read_toc_by_media_type(media_type, src_path, ext)?;
    // 见上："空且无总字数"不落盘（可能是读取失败）。
    if !result.entries.is_empty() || result.total.is_some() {
        write_toc_cache(cache, hash, &result);
    }
    Ok(result)
}

/// 选目录读取器：与 `book.rs` 的 `read_page_by_media_type` 同一条分流口径
/// （**按媒体类型**，不按扩展名——扫描器对 PDF 做了 `%PDF-` 内容兜底，
/// 扩展名被改掉的 PDF 也会入库为 `media_type = pdf`）。
///
/// **不需要任何外部上下文**（2026-10-18）：三种格式的目录都直接来自文件本身——
/// epub 读 `nav` / NCX、markdown 解码后取顶层标题、纯文本流式扫标题行。
/// 以前要传 [`ReaderCtx`] 是因为纯文本走"整本缓存"；随渐进加载一起删掉后，
/// 目录读取成了纯函数（`src_path` + `ext` 决定一切）。
pub(crate) fn read_toc_by_media_type(
    media_type: MediaType,
    src_path: &Path,
    ext: &str,
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
                (
                    "markdown".to_string(),
                    hp_book::markdown_toc(&read.blocks),
                    total,
                )
            }
            _ => {
                /*
                 * **流式目录**（需求 2）：目录必须覆盖全书（一本 24 MB 的 txt，
                 * 第 800 章落在开头 2 MiB 之外），但**不再**为此把整本读进内存。
                 *
                 * `text_toc_stream` 逐块读盘、逐行喂给既有的小说章节标题规则，
                 * 命中即回调；峰值内存 = 一个 256 KiB 块 + 一行。它的返回值带着
                 * **全书字符数**（扫完才知道的量），正好是 `book.toc` 的 `total`
                 * ——与 `cursor` 同为字符口径，进度因此可以对得上。
                 *
                 * 游标与 `book.content` 的 `cursor` **完全同口径**（字符偏移、
                 * BOM 不计），所以"目录跳转 = 把这一项原样交给 `book.content`"
                 * 这条契约不变（见 `readerView.ts` 的说明）。
                 *
                 * 坏文件 = **空目录而不是错误**（与 `book.meta` / `book.content`
                 * 同一条降级口径）：`unwrap_or_default()` 吞掉读取失败。
                 */
                let mut entries: Vec<hp_book::TocEntry> = Vec::new();
                let scan = hp_book::text_toc_stream(src_path, |entry| entries.push(entry))
                    .unwrap_or_default();
                let total = u32::try_from(scan.chars).ok();
                ("text".to_string(), entries, total)
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
/// - `txt` / 其它文本：**内置小说章节规则**识别标题行，**流式**扫描全书；
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
    let _ = repo_id;

    let outcome = async {
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

        if !media_type.is_book() {
            return Ok(empty_toc());
        }
        // 无内容哈希 = 索引里还没有可用的内容身份（例如不可读占位行）：
        // 目录不值得为一个身份不稳定的文件去扫（与 `book.meta` / `book.content`
        // 同一条"没有稳定缓存键就不解析"的口径）。
        //
        // 注意：这也意味着**目录缓存只对有内容哈希的书生效**——缓存键就是它。
        let Some(hash) = content_hash else {
            return Ok(empty_toc());
        };

        let ext = src_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        // 与 `book.content` 一样放在阻塞线程：纯文本的流式扫描（每 256 KiB 一块）、
        // EPUB 解包、以及目录缓存的读写都不能占着 IPC 线程。
        let read = tauri::async_runtime::spawn_blocking(move || {
            read_toc_with_cache(media_type, &src_path, &ext, &cache, &hash)
        })
        .await
        .map_err(|e| HpError::Io(format!("目录读取线程异常: {e}")))??;

        Ok(read)
    }
    .await;
    api_async(api_from_hp(outcome))
}
