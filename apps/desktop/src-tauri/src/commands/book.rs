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

use std::path::{Path, PathBuf};

use hp_core::{HpError, HpResult, MediaType};
use hp_dto::{
    BookBlockItem, BookContentResult, BookCoverItem, BookCoverResult, BookDefinitionItem,
    BookListItem, BookSpanItem, BookTableRowItem,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::shared::{
    api_async, api_from_hp, lock_repo, open_repo, open_repo_mut, resolve_file_path, ApiAsync,
};
use crate::AppState;

/// `book.meta` 返回体。
#[derive(Serialize)]
pub(crate) struct BookMetaResult {
    /// 作者（EPUB `<dc:creator>`）；无则 `null`。
    author: Option<String>,
    /// 简介（EPUB `<dc:description>`）；无则 `null`。
    description: Option<String>,
    /// **已落盘**的封面绝对路径（供前端 `convertFileSrc`）；无封面则 `null`。
    ///
    /// 无封面不是错误：`txt` / `md` 本来就没有封面，面板用文件名渲染文字封面；
    /// epub 里也确实存在不带封面的书。
    cover_path: Option<String>,
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
    fn into_result(self, cache: &hp_media::ThumbnailCache, hash: &str) -> BookMetaResult {
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

/// 读缓存；文件不存在或内容损坏都返回 `None`（损坏即当未缓存，重算一次）。
pub(crate) fn read_cache(path: &Path) -> Option<BookMetaCache> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// 解析一本书并把结果写进缓存（在**阻塞线程**里跑：整本 epub 读盘 + 解压）。
pub(crate) fn parse_and_cache(
    source_path: &Path,
    cache: &hp_media::ThumbnailCache,
    hash: &str,
) -> HpResult<BookMetaCache> {
    let meta = match hp_book::read_book_meta(source_path) {
        Ok(meta) => meta,
        // 解析失败 = 这本书没有元数据（不向上抛：面板要的是"能显示"）。
        Err(_) => hp_book::BookMeta::default(),
    };

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

        // 只有文本类可能带元数据；其余类型直接空结果（不是错误）。
        if media_type != MediaType::Text {
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
        if let Some(record) = read_cache(&cache.path_for_book_meta(&hash)) {
            if record.cover_ext.is_none() || record.cover_path(&cache, &hash).is_some() {
                return Ok(record.into_result(&cache, &hash));
            }
        }

        // 未命中：整本解析放到阻塞线程（大 epub 读盘 + 解压封面，不能占着 IPC 线程）。
        let hash_for_task = hash.clone();
        let cache_for_task = cache.clone();
        let src_for_task = src_path.clone();
        let record = tauri::async_runtime::spawn_blocking(move || {
            parse_and_cache(&src_for_task, &cache_for_task, &hash_for_task)
        })
        .await
        .map_err(|e| HpError::Io(format!("图书解析线程异常: {e}")))??;

        Ok(record.into_result(&cache, &hash))
    }
    .await;
    api_async(api_from_hp(outcome))
}

/// Markdown 一页取多少个**顶层块**。
///
/// 取 60 的理由：README / 文档站的顶层块通常是"几个标题 + 若干段 + 偶尔的表格"，
/// 60 个足以覆盖一屏多的内容，又不至于一次 IPC 传回一大坨嵌套结构。
/// 一页的**块数**与纯文本的**字符数**不是一个量纲，因此各自独立设上限。
pub(crate) const MARKDOWN_PAGE_BLOCKS: u32 = 60;

/// 一页正文的游标上限：纯文本按**字符偏移**、epub 按**章节序号**（见 `book.content`）。
///
/// 解析失败（游标写坏、越界）一律回落第一页而**不是**报错——"翻页游标"不该
/// 成为新的错误来源。
pub(crate) fn parse_cursor(cursor: Option<&str>) -> u32 {
    cursor.and_then(|c| c.parse::<u32>().ok()).unwrap_or(0)
}

/// 把一个**行内片段**转成 DTO。
///
/// Markdown 的图片 `image` 已是解析侧确认过的**绝对路径**，原样透传；
/// EPUB 的片段没有图片（章节插图是块级 `Image`），因此此处无需落盘。
fn span_to_item(span: hp_book::BookSpan) -> BookSpanItem {
    BookSpanItem {
        text: span.text,
        styles: span.styles.iter().map(|s| s.as_str().to_string()).collect(),
        href: span.href,
        image: span.image,
    }
}

/// 把正文块转成 DTO，并把 **EPUB 的章节插图**落盘成前端可用的绝对路径。
///
/// 两种格式共用这一个转换（EPUB 与 Markdown 产出的是同一套块，见 `hp_book::block`），
/// 因此前端只有一份渲染器。图片落盘命名 `<hash>.book-<章节>-<序号>.<ext>`（与封面/
/// 元数据同分片、同名不同后缀），同一本书第二次打开直接命中缓存。
pub(crate) fn blocks_to_items(
    blocks: Vec<hp_book::BookBlock>,
    cache: &hp_media::ThumbnailCache,
    hash: &str,
    section: u32,
) -> Vec<BookBlockItem> {
    let mut out = Vec::with_capacity(blocks.len());
    // EPUB 的章节插图按出现序号落盘，与 `hp-book` 的块顺序一致。
    let mut image_index = 0usize;
    for block in blocks {
        out.push(block_to_item(block, cache, hash, section, &mut image_index));
    }
    out
}

/// 单个块 → DTO（容器块递归转换）。
pub(crate) fn block_to_item(
    block: hp_book::BookBlock,
    cache: &hp_media::ThumbnailCache,
    hash: &str,
    section: u32,
    image_index: &mut usize,
) -> BookBlockItem {
    /// 只填 `kind` 的块（其余字段全 `None`）——避免每处重复写一长串 `None`。
    fn empty(kind: &str) -> BookBlockItem {
        BookBlockItem {
            kind: kind.into(),
            level: None,
            spans: None,
            path: None,
            lang: None,
            text: None,
            blocks: None,
            quote_kind: None,
            ordered: None,
            start: None,
            list_items: None,
            align: None,
            head: None,
            rows: None,
            label: None,
            definitions: None,
        }
    }

    match block {
        hp_book::BookBlock::Heading { level, spans } => BookBlockItem {
            level: Some(level),
            spans: Some(spans.into_iter().map(span_to_item).collect()),
            ..empty("heading")
        },
        hp_book::BookBlock::Paragraph { spans } => BookBlockItem {
            spans: Some(spans.into_iter().map(span_to_item).collect()),
            ..empty("paragraph")
        },
        hp_book::BookBlock::Image { ext, bytes, .. } => {
            // 认不出格式的图直接丢（渲染不了，留着只会是个坏图占位）。
            let Some(ext) = ext else {
                return empty("image");
            };
            let path = cache.path_for_book_content_image(hash, section, *image_index, ext);
            *image_index += 1;
            if !path.exists() {
                if cache.ensure_dir_for(hash).is_err() || write_atomic(&path, &bytes).is_err() {
                    // 单张图落盘失败不该让整页变成错误态：跳过它，正文照常显示。
                    return empty("image");
                }
            }
            BookBlockItem {
                path: Some(path.to_string_lossy().to_string()),
                ..empty("image")
            }
        }
        hp_book::BookBlock::CodeBlock { lang, text } => BookBlockItem {
            lang,
            text: Some(text),
            ..empty("code_block")
        },
        hp_book::BookBlock::BlockQuote { kind, blocks } => BookBlockItem {
            quote_kind: kind,
            blocks: Some(convert(blocks, cache, hash, section, image_index)),
            ..empty("blockquote")
        },
        hp_book::BookBlock::List {
            ordered,
            start,
            items,
        } => BookBlockItem {
            ordered: Some(ordered),
            start: start.and_then(|n| u32::try_from(n).ok()),
            list_items: Some(
                items
                    .into_iter()
                    .map(|item| BookListItem {
                        checked: item.checked,
                        blocks: convert(item.blocks, cache, hash, section, image_index),
                    })
                    .collect(),
            ),
            ..empty("list")
        },
        hp_book::BookBlock::Rule => empty("rule"),
        hp_book::BookBlock::Table { align, head, rows } => BookBlockItem {
            align: Some(align.iter().map(|a| a.as_str().to_string()).collect()),
            head: Some(
                head.into_iter()
                    .map(|cell| cell.into_iter().map(span_to_item).collect())
                    .collect(),
            ),
            rows: Some(
                rows.into_iter()
                    .map(|row| BookTableRowItem {
                        cells: row
                            .into_iter()
                            .map(|cell| cell.into_iter().map(span_to_item).collect())
                            .collect(),
                    })
                    .collect(),
            ),
            ..empty("table")
        },
        hp_book::BookBlock::Footnote { label, blocks } => BookBlockItem {
            label: Some(label),
            blocks: Some(convert(blocks, cache, hash, section, image_index)),
            ..empty("footnote")
        },
        hp_book::BookBlock::DefinitionList { items } => BookBlockItem {
            definitions: Some(
                items
                    .into_iter()
                    .map(|item| BookDefinitionItem {
                        term: item.term.into_iter().map(span_to_item).collect(),
                        definitions: item
                            .definitions
                            .into_iter()
                            .map(|def| convert(def, cache, hash, section, image_index))
                            .collect(),
                    })
                    .collect(),
            ),
            ..empty("definition_list")
        },
    }
}

/// 递归转换一组块（容器块内共用同一个插图序号）。
fn convert(
    blocks: Vec<hp_book::BookBlock>,
    cache: &hp_media::ThumbnailCache,
    hash: &str,
    section: u32,
    image_index: &mut usize,
) -> Vec<BookBlockItem> {
    blocks
        .into_iter()
        .map(|b| block_to_item(b, cache, hash, section, image_index))
        .collect()
}

/// `book.content`：读取查看器要显示的**一页正文**（`txt` / `md` / `epub`）。
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

        // 非文本类没有"正文"可看：空结果（不是错误）。
        if media_type != MediaType::Text {
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

        // 整本读盘 / 解压放在阻塞线程（大 epub 与 24 MB 的 txt 都不能占着 IPC 线程）。
        let read = tauri::async_runtime::spawn_blocking(move || {
            match ext.as_str() {
                "epub" => read_epub_page(&src_path, offset, &cache, &hash),
                // `md` / `markdown`：**渲染**成类型化块（与 epub 同一套块模型，
                // 因此前端只有一份渲染器）。
                "md" | "markdown" => read_markdown_page(&src_path, offset, &cache, &hash),
                _ => read_text_page(&src_path, offset),
            }
        })
        .await
        .map_err(|e| HpError::Io(format!("正文读取线程异常: {e}")))??;

        Ok(read)
    }
    .await;
    api_async(api_from_hp(outcome))
}

/// 空正文（非文本类 / 无内容哈希）：**不是错误**，前端显示占位。
fn empty_content() -> BookContentResult {
    BookContentResult {
        format: String::new(),
        encoding: None,
        text: None,
        blocks: None,
        next_cursor: None,
        section: 0,
        section_count: None,
        title: None,
        capped: false,
    }
}

/// 纯文本一页：判编码 → 解码开头 → 按字符偏移切页。
pub(crate) fn read_text_page(src_path: &Path, offset: u32) -> HpResult<BookContentResult> {
    // 解码到「偏移 + 一页 **+ 1**」为止：多要一个字符才判得出"本页之后还有内容"。
    // 只解码到 `offset + 一页` 的话，`page_at` 看到的正好是末尾，
    // `next_offset` 恒为 `None`——"还有下一页"这件事就永远发现不了。
    let want = offset as usize + hp_book::TEXT_PAGE_CHARS + 1;
    let decoded = hp_book::decode_file_head(src_path, want)?;
    let page = hp_book::page_at(&decoded.text, offset as usize, hp_book::TEXT_PAGE_CHARS);
    Ok(BookContentResult {
        format: "text".into(),
        encoding: Some(decoded.encoding.name().to_string()),
        text: Some(page.text),
        blocks: None,
        next_cursor: page.next_offset.map(|n| n.to_string()),
        section: 0,
        section_count: None,
        title: None,
        // 本页之后还有内容、或解码时就被上限截断，都算"仅显示开头"。
        capped: decoded.capped || page.next_offset.is_some(),
    })
}

/// Markdown 一页：解码 → 解析成类型化块 → 按**块**切页。
///
/// ### 为什么按块切页而不是按字符切页
///
/// Markdown 渲染后是**结构化的块**（标题 / 表格 / 代码块 / 列表…），没有"连续字符流"
/// 可切：把一页按字符数拦腰截断会切出半个表格、截断一个代码块，
/// 那正是"渲染"要消除的东西。因此游标是**块序号**（与 epub 的章节序号同一形态），
/// 一页取 `MARKDOWN_PAGE_BLOCKS` 个**顶层块**。
///
/// ### 为什么仍然要字符上限
///
/// 渲染一次要解析整篇，而 `.md` 可以很大（README 几十 KB 很常见、文档站单页更甚）。
/// 复用 `hp_book::decode_file_head` 的**字节上限**（2 MiB）先把读盘与解码量封住，
/// 再解析——与纯文本同一条"固定上限"口径（用户 2026-10-09 口径）。
pub(crate) fn read_markdown_page(
    src_path: &Path,
    offset: u32,
    cache: &hp_media::ThumbnailCache,
    hash: &str,
) -> HpResult<BookContentResult> {
    // 解码到字节上限为止（判编码与 txt 同一条路径：`.md` 同样可能是 GBK）。
    let decoded = hp_book::decode_file_head(src_path, usize::MAX)?;
    let doc_dir = src_path.parent();
    let read = hp_book::blocks_from_markdown(&decoded.text, doc_dir);
    let blocks = blocks_to_items(read.blocks, cache, hash, 0);

    let total = blocks.len() as u32;
    let start = offset.min(total);
    let end = start.saturating_add(MARKDOWN_PAGE_BLOCKS).min(total);
    let page: Vec<BookBlockItem> = blocks
        .get(start as usize..end as usize)
        .unwrap_or_default()
        .to_vec();

    Ok(BookContentResult {
        format: "markdown".into(),
        encoding: Some(decoded.encoding.name().to_string()),
        text: None,
        blocks: Some(page),
        next_cursor: (end < total).then(|| end.to_string()),
        section: 0,
        section_count: None,
        title: None,
        // 还有下一页、或解码时被上限截断，都算"仅显示开头"。
        capped: decoded.capped || end < total,
    })
}

/// epub 一章：读 spine 的第 `section` 章，转成类型化块（**不返回 HTML**）。
pub(crate) fn read_epub_page(
    src_path: &Path,
    section: u32,
    cache: &hp_media::ThumbnailCache,
    hash: &str,
) -> HpResult<BookContentResult> {
    let read = hp_book::read_epub_section(src_path, section)?;
    let blocks = blocks_to_items(read.blocks, cache, hash, read.section);
    Ok(BookContentResult {
        format: "epub".into(),
        encoding: None,
        text: None,
        blocks: Some(blocks),
        next_cursor: (read.section + 1 < read.section_count)
            .then(|| (read.section + 1).to_string()),
        section: read.section,
        section_count: Some(read.section_count),
        title: Some(read.title),
        // 还有下一章 = "仅显示开头"（用户口径：只显示开头的内容）。
        capped: read.section + 1 < read.section_count,
    })
}

// ==================== 封面覆盖（book.covers / book.cover / setCover / clearCover）====================
//
// 用户口径（2026-10-09）："txt 右键可以更换封面颜色或自定义图片"。
// 库里只存"是什么"（颜色值 / 裸文件名），绝对路径在返回时现拼——见文件头的说明。

/// 封面图片允许的扩展名（按 magic bytes 判定，不信任用户文件的后缀名）。
const COVER_IMAGE_EXTS: [&str; 6] = ["jpg", "png", "gif", "webp", "bmp", "svg"];

/// 把库里的封面记录转成命令返回体（图片拼成**当前**绝对路径，并确认文件在盘上）。
pub(crate) fn cover_to_result(cover: Option<hp_core::FileCover>) -> BookCoverResult {
    let Some(cover) = cover else {
        return BookCoverResult {
            kind: None,
            value: None,
        };
    };
    match cover.kind {
        hp_core::CoverKind::Color => BookCoverResult {
            kind: Some("color".into()),
            value: Some(cover.value),
        },
        hp_core::CoverKind::Image => {
            // 文件不在盘上（被手工删了 / 换了数据目录）→ 当作**没有覆盖**，
            // 让面板回落默认封面，而不是显示一个坏图。
            let path = crate::commands::shared::user_covers_dir()
                .map(|dir| dir.join(&cover.value))
                .ok()
                .filter(|p| p.exists());
            match path {
                Some(p) => BookCoverResult {
                    kind: Some("image".into()),
                    value: Some(p.to_string_lossy().to_string()),
                },
                None => BookCoverResult {
                    kind: None,
                    value: None,
                },
            }
        }
    }
}

/// `book.covers`：**批量**读一组文件的封面覆盖（只返回**真有覆盖**的那些）。
///
/// **为什么是批量**：图书预览面板一页可能列几百本，逐本发一次 `book.cover`
/// 就是几百次 IPC 往返（与"只为需要内嵌封面的书发 `book.meta`"是同一类浪费，
/// 但封面这里**每本书都可能有**，所以只能靠批量而不是靠跳过）。
/// 调用方按**一页**（≤ `FILE_QUERY_MAX_LIMIT`）传 id，`IN (...)` 的长度因此有界。
///
/// 没有覆盖的书**不出现在结果里**（面板按默认封面渲染），因此返回体大小与
/// "用户设过多少封面"成正比，而不是与"列了多少本书"成正比。
#[tauri::command]
pub(crate) async fn book_covers(
    repo_id: String,
    file_ids: Vec<String>,
    state: State<'_, AppState>,
) -> ApiAsync<Vec<BookCoverItem>> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<Vec<BookCoverItem>> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let covers = db.covers_for_files(&file_ids)?;
        let mut out: Vec<BookCoverItem> = covers
            .into_values()
            .filter_map(|cover| {
                let file_id = cover.file_id.clone();
                // 图片的绝对路径在这里拼（库里的 `value` 只是文件名）；
                // 图片文件不在盘上时 `cover_to_result` 给出 `None` → 整条不返回。
                let resolved = cover_to_result(Some(cover));
                Some(BookCoverItem {
                    file_id,
                    kind: resolved.kind?,
                    value: resolved.value?,
                })
            })
            .collect();
        // 顺序稳定（便于断言与 diff）：按 `file_id` 升序。
        out.sort_by(|a, b| a.file_id.cmp(&b.file_id));
        Ok(out)
    })();
    api_async(api_from_hp(outcome))
}

/// `book.cover`：读**单个**文件的封面覆盖（两个字段为 `null` = 没有覆盖）。
///
/// 批量接口（[`book_covers`]）覆盖面板的主路径；本命令服务"菜单打开时确认当前状态"
/// 这类单点查询（改完之后立刻回读一次，不必刷新整页）。
#[tauri::command]
pub(crate) async fn book_cover(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<BookCoverResult> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<BookCoverResult> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        Ok(cover_to_result(db.get_file_cover(&file_id)?))
    })();
    api_async(api_from_hp(outcome))
}

/// `book.setCover`：设置封面覆盖。
///
/// 两种取值（`kind`）：
/// - `color`：`value` 必须是 `#rrggbb`（`hp_core::normalize_cover_color` 规范化）；
/// - `image`：`value` 是**源图片的绝对路径**（用户在系统对话框里挑的那张）。
///   桥接层把它**拷贝**进 `data\user\covers\` 并改名成 `<file_id>.<ext>`——
///   为什么是拷贝而不是记住原路径：原图可能被移动/删除，而封面是"这本书的属性"，
///   不该因为用户整理文件就变成坏图。扩展名按 **magic bytes** 判定，不信任后缀名。
#[tauri::command]
pub(crate) async fn book_set_cover(
    repo_id: String,
    file_id: String,
    kind: String,
    value: String,
    state: State<'_, AppState>,
) -> ApiAsync<BookCoverResult> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<BookCoverResult> {
        let cover_kind = hp_core::CoverKind::from_str(&kind)
            .ok_or_else(|| HpError::InvalidArgument(format!("未知的封面种类: {kind}")))?;

        // 图片先落盘再落库：落盘失败就不该留下一行指向不存在文件的记录。
        let stored_value = match cover_kind {
            hp_core::CoverKind::Color => value,
            hp_core::CoverKind::Image => copy_cover_image(&file_id, &value)?,
        };

        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        // 文件必须存在（外键也要求）：给不存在的 file_id 设封面是调用方的错。
        if db.get_file(&file_id)?.is_none() {
            return Err(HpError::NotFound(format!("文件不存在: {file_id}")));
        }
        let cover = db.upsert_file_cover(&file_id, cover_kind, &stored_value)?;
        // 换过图片时把**同一本书的其他扩展名**文件删掉，避免 `covers\` 里越积越多孤儿。
        if matches!(cover_kind, hp_core::CoverKind::Image) {
            prune_other_cover_images(&file_id, &cover.value);
        }
        Ok(cover_to_result(Some(cover)))
    })();
    api_async(api_from_hp(outcome))
}

/// `book.clearCover`：清除封面覆盖，回到默认封面（内嵌封面或文字封面）。
///
/// 同时删掉落盘的图片文件（否则 `covers\` 里会留下再也没人引用的文件）。
#[tauri::command]
pub(crate) async fn book_clear_cover(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<BookCoverResult> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<BookCoverResult> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        // 先取旧值：删除之后才知道该删哪个文件。
        let previous = db.get_file_cover(&file_id)?;
        db.delete_file_cover(&file_id)?;
        if let Some(hp_core::FileCover {
            kind: hp_core::CoverKind::Image,
            value,
            ..
        }) = previous
        {
            if let Ok(dir) = crate::commands::shared::user_covers_dir() {
                let _ = std::fs::remove_file(dir.join(value));
            }
        }
        Ok(BookCoverResult {
            kind: None,
            value: None,
        })
    })();
    api_async(api_from_hp(outcome))
}

/// 把用户挑的图片拷进 `data\user\covers\`，返回**落库用的裸文件名**。
///
/// 文件名用 `<file_id>.<ext>`：按文件 id 命名，因此同一本书换图就是**覆盖同一个文件**
/// （除了扩展名变化，见 [`prune_other_cover_images`]），不会每次换图都堆一个新文件。
pub(crate) fn copy_cover_image(file_id: &str, src_path: &str) -> HpResult<String> {
    let src = Path::new(src_path);
    let bytes = std::fs::read(src)
        .map_err(|e| HpError::Io(format!("读取封面图片失败 {}: {e}", src.display())))?;
    // 扩展名按 **magic bytes** 判定：用户可能挑了一个后缀名与内容不符的文件
    // （更常见的是 `.jpeg` / `.JPG` 这类大小写差异），信任后缀名会让前端拿错格式。
    let ext = hp_book::detect_image_ext(&bytes).ok_or_else(|| {
        HpError::InvalidArgument(format!(
            "认不出的图片格式（支持 {}）：{}",
            COVER_IMAGE_EXTS.join(" / "),
            src.display()
        ))
    })?;
    // `file_id` 进文件名前必须确认它本身是安全的（不含分隔符）——它来自前端参数，
    // 直接拼进路径就是一次目录穿越（与 `is_safe_cover_file_name` 同一条边界）。
    let name = format!("{file_id}.{ext}");
    if !hp_core::is_safe_cover_file_name(&name) {
        return Err(HpError::InvalidArgument(format!(
            "文件 ID 不能用作文件名: {file_id}"
        )));
    }
    let dir = crate::commands::shared::user_covers_dir().map_err(HpError::Io)?;
    // 原子落盘：先写临时文件再改名，避免前端在"写了一半"时读到它。
    let target = dir.join(&name);
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, &bytes).map_err(|e| HpError::Io(format!("写入封面失败: {e}")))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        HpError::Io(format!("提交封面失败: {e}"))
    })?;
    Ok(name)
}

/// 删掉同一个 `file_id` 的**其他**封面图片（换扩展名时留下的旧文件）。
///
/// 只删 `<file_id>.<已知图片扩展名>` 这一组名字：不做"扫目录删所有前缀匹配"，
/// 那会误删别的书（`a` 与 `ab` 这类前缀重叠的 id）。
pub(crate) fn prune_other_cover_images(file_id: &str, keep: &str) {
    let Ok(dir) = crate::commands::shared::user_covers_dir() else {
        return;
    };
    for ext in COVER_IMAGE_EXTS {
        let name = format!("{file_id}.{ext}");
        if name != keep {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }
}
