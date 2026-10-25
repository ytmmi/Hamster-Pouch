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
    ApiAsync, api_async, api_from_hp, lock_repo, open_repo, open_repo_mut, resolve_file_path,
};
// 阅读器一侧的取数（目录 + 插图缓存上下文）拆在 `book_reader.rs`：`book.rs` 已经
// 承担元数据 / 正文分页 / 封面覆盖三件事，再加目录会越过"单文件 ≤ 1200 行"的红线。
//
// **2026-10-18（需求 2）**：这里的 `ReaderTextCache` / `with_reader_text` /
// `reader_text_key` 已随"整本解码"整体删除——纯文本改成按窗口读取
// （`hp_book::read_text_page_window`），没有"整本"可缓存。`ReaderCtx` 因此只剩
// `cache`（插图落盘）与 `hash`（缓存键）两个字段。
use crate::AppState;
use crate::commands::book_reader::ReaderCtx;

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

/// 读一份 JSON 磁盘缓存；文件不存在或内容损坏都返回 `None`
/// （**损坏即当未缓存**，重算一次，绝不把坏缓存变成用户可见的错误）。
///
/// 泛型化（2026-10-19）：目录缓存（`book_reader.rs` 的 `<hash>.booktoc.json`）
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
/// EPUB 的片段没有图片（章节插图是块级 `Figure`），因此此处无需落盘。
///
/// **书自带的颜色 / 底色 / 字号**（`color` / `bg` / `size_em`）原样透传：
/// 解析侧已把它们规范成 `#rrggbb`（认不出来就是 `None`）与 0.5–3.0 的倍率，
/// 桥接层**不重新解释**它们——两份口径必然漂移（见 `hp_book::inline` 的解析说明）。
fn span_to_item(span: hp_book::BookSpan) -> BookSpanItem {
    BookSpanItem {
        text: span.text,
        styles: span.styles.iter().map(|s| s.as_str().to_string()).collect(),
        href: span.href,
        image: span.image,
        color: span.color,
        bg: span.bg,
        size_em: span.size_em,
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
            figure: None,
            caption: None,
            full_page: None,
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
            if !path.exists()
                && (cache.ensure_dir_for(hash).is_err() || write_atomic(&path, &bytes).is_err())
            {
                // 单张图落盘失败不该让整页变成错误态：跳过它，正文照常显示。
                return empty("image");
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
        /*
         * **插画**（`<figure>`：图 + 图注）与**裸图**（不在 `figure` 里的 `<img>`）
         * 共用同一个 DTO 形状：
         * - `figure`：图片块（`kind = "image"` 或嵌套的其它块）+ `caption` + `full_page`；
         * - `full_page` 如实透传（"是否应当独占一页"由解析侧的判据给出，见
         *   `hp_book::epub_text` 的 `is_full_page_image`）；桥接层**不重新判定**
         *   ——判据有两份必然漂移。
         *
         * 图片落盘口径与 `kind = "image"` 完全一致（`<hash>.book-<章节>-<序号>.<ext>`），
         * 因此同一本书第二次打开直接命中缓存。
         */
        hp_book::BookBlock::Figure {
            image,
            caption,
            full_page,
        } => BookBlockItem {
            figure: Some(Box::new(block_to_item(
                *image,
                cache,
                hash,
                section,
                image_index,
            ))),
            caption: Some(caption.into_iter().map(span_to_item).collect()),
            full_page: Some(full_page),
            ..empty("figure")
        },
        /*
         * **注释 / 脚注 / 侧栏**（EPUB 的 `aside` / `epub:type="footnote"` /
         * `role="doc-footnote"` / `.footnote` 一类）。
         *
         * 与 `footnote`（GFM 的 `[^1]: …` 定义块）共用 `label` + `blocks` 两个字段，
         * 只靠 `kind` 区分：两者的语义不同（前者是原文里的注、后者是 Markdown 的
         * 脚注定义），前端因此可以给它们不同的样式落点。
         */
        hp_book::BookBlock::Comment { label, blocks } => BookBlockItem {
            label,
            blocks: Some(convert(blocks, cache, hash, section, image_index)),
            ..empty("comment")
        },
        /*
         * **显式换页**（章节内部的 `page-break-before`）。
         *
         * 无附加字段：它只是一个"从这里另起一页"的排版标记，前端渲染成
         * `aria-hidden` 的标记元素、由 CSS 决定表现（滚动模式画分隔、分页模式
         * `break-before: column`）。**章节之间**的换页不走这个块——那由
         * `BookContentResult.page_break_before` 在页容器上表达（见下面
         * `read_epub_page` 的说明）。
         */
        hp_book::BookBlock::PageBreak => empty("page_break"),
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

/// 选正文读取器：**按媒体类型分流，不按扩展名**。
///
/// ## 为什么不能按扩展名分流（2026-10-11 修的真实缺口）
///
/// `hp-scanner` 对 PDF **做了内容兜底**（`%PDF-` magic bytes），因此一个扩展名被改掉的
/// PDF（`a.dat`）会被正确入库为 `media_type = pdf`。此时若这里按扩展名分流，
/// `a.dat` 会掉进 `_ => read_text_page` 分支——**把一份 PDF 当 GBK 文本解码**，
/// 用户看到的是满屏乱码而不是页面。判据必须与"入库判据"同源：
/// 媒体类型是扫描期给出的**唯一**权威，扩展名只是它的一种来源。
///
/// `ext` 仍然需要：它区分 `md` / `markdown`（同一媒体类型下的两种写法）
/// 与 `txt`（**其余文本一律按纯文本读**，这是刻意的兜底——认不出的文本扩展名
/// 按纯文本显示，比报错更符合"显示开头内容"的预期）。
fn read_page_by_media_type(
    media_type: MediaType,
    src_path: &Path,
    ext: &str,
    offset: u32,
    ctx: &ReaderCtx<'_>,
) -> HpResult<BookContentResult> {
    // PDF 先判**媒体类型**：`%PDF-` 兜底认出来的 PDF 可能带任意扩展名。
    if media_type == MediaType::Pdf {
        return read_pdf_page(src_path, offset, ctx.cache, ctx.hash);
    }
    match ext {
        "epub" => read_epub_page(src_path, offset, ctx.cache, ctx.hash),
        // `md` / `markdown`：**渲染**成类型化块（与 epub 同一套块模型，
        // 因此前端只有一份渲染器）。
        "md" | "markdown" => read_markdown_page(src_path, offset, ctx.cache, ctx.hash),
        // 其余文本（`txt` 与认不出的文本扩展名）：**按窗口读取**的纯文本通路。
        //
        // 这里**不再**需要缓存键 / 整本缓存：`read_text_page` 每次只读一页所需的
        // 字节窗口（见它的文档），因此没有"整本"可缓存——需求 2 的内存问题正是
        // 从"整本进内存"来的。
        //
        // 传 `ctx.hash` 作为**内容身份**：纯文本的锚点表（`hp_book::text_stream`）
        // 用它做键，换内容必然换表，因此陈旧锚点不可能被复用（路径 + 长度 + mtime
        // 只是启发式，见那边的模块文档第 3 条）。
        _ => read_text_page(src_path, offset, ctx.hash),
    }
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
        // 空结果没有"章"，自然也没有"本章要另起一页"这回事。
        page_break_before: false,
    }
}

/// 纯文本一页：**按窗口读取**（渐进加载）→ 直接返回该页。
///
/// ## 为什么不再"整本解码 + 缓存"（2026-10-18，需求 2）
///
/// 旧实现先把整个文件读进内存、再一次性解码，然后缓存在 `Mutex` 里复用。
/// 用户实测：加载一本 txt 时**内存涨到 5 GB 以上并卡死**。成因不是"某一页太大"，
/// 而是"整本进内存"本身——一本几十 MB 的 GBK 小说解码成 `String` 后，
/// 加上读盘缓冲区与解码中转，实际占用是文件大小的若干倍。
///
/// 现在交给 `hp_book::read_text_page_window`：它按**字符偏移**定位、只读该页所需的
/// **字节窗口**再解码，返回本页与下一页游标。因此：
/// - 任何一次调用占用的内存都与**一页**成正比，与文件大小无关；
/// - 查看器与阅读器**共用**这条实现（两者差别只在"怎么请求"，不在"怎么切页"）；
/// - `capped` 的语义随之改变：从前是"解码时被字节上限截断"，现在是
///   "统计/扫描时超过了闸门"（畸形巨文件仍会被如实标记，见 `hp_book::text`）。
///
/// 上游的 `RUNNING_CONTEXT`（旧 `ReaderTextCache` / `with_reader_text`）已整体删除：
/// 没有"整本"可缓存，缓存自然也就不需要了。
pub(crate) fn read_text_page(
    src_path: &Path,
    offset: u32,
    content_key: &str,
) -> HpResult<BookContentResult> {
    let page = hp_book::read_text_page_window(
        src_path,
        offset,
        hp_book::TEXT_PAGE_CHARS,
        Some(content_key),
    )?;
    Ok(BookContentResult {
        format: "text".into(),
        encoding: Some(page.encoding.name().to_string()),
        text: Some(page.text),
        blocks: None,
        next_cursor: page.next_offset.map(|n| n.to_string()),
        section: 0,
        section_count: None,
        title: None,
        // 本页之后还有内容、或扫描时就被上限闸门截断，都算"仅显示开头"。
        capped: page.capped || page.next_offset.is_some(),
        // 纯文本没有"章"，因此没有"本章要另起一页"这回事。
        page_break_before: false,
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
        // Markdown 没有"章"的概念（游标是顶层块序号），因此不声明章节换页。
        page_break_before: false,
    })
}

/// PDF 一页：**栅格化**第 `page` 页并落盘，返回一个 `image` 块。
///
/// ## 为什么返回"一个图片块"而不是"一页文字"
///
/// PDF 是**版式描述**而不是文本流：分栏、表格、五线谱、图片、公式的位置与字形都由
/// 内容流里的绘制指令给出，文字只是其中一类。抽文字会丢掉版式（表格散架、乐谱全丢），
/// 因此用户口径（2026-10-11）是"**逐页栅格化为图片，滚动看后续页**"——
/// 所见即 PDF 原貌。
///
/// ## 复用既有的块模型与分页口径
///
/// 返回的是 `BookBlock::Image`，与 EPUB 的章节插图**同一个块种类**，
/// 因此前端渲染器（`BookBlocks.tsx`）一行都不用改就能显示它。
/// 游标同样是**页序号**（与 epub 的章节序号同形），前端沿用 `section` /
/// `section_count` 做进度提示——PDF 不需要另一套翻页口径。
///
/// ## 落盘命名
///
/// `<hash>.book-<页码>-0.jpg`（复用 `path_for_book_content_image`，`section` 传页码）。
/// 与 EPUB 的章节插图**同分片、同命名规则**，因此第二次翻到同一页直接命中缓存——
/// 这是必需的：一页栅格化实测 25–156 ms，不缓存的话往回翻一次就要重画。
/// 图片序号恒为 `0`（一页只有一个整页位图）。
pub(crate) fn read_pdf_page(
    src_path: &Path,
    page: u32,
    cache: &hp_media::ThumbnailCache,
    hash: &str,
) -> HpResult<BookContentResult> {
    // 打开失败（损坏 / 加密）= 没有正文（**不是错误**）：查看器显示占位。
    let Some(pdf) = hp_pdf::open_pdf_file(src_path)? else {
        return Ok(empty_content());
    };
    let total = hp_pdf::page_count(&pdf) as u32;
    if total == 0 {
        return Ok(empty_content());
    }
    // 游标越界（写坏 / 文件变小）→ 回落**最后一页**而不是报错：
    // 与 `parse_cursor` 的"翻页游标不该成为新的错误来源"同一条口径。
    let index = page.min(total - 1) as usize;

    let path = cache.path_for_book_content_image(hash, index as u32, 0, hp_pdf::PDF_COVER_EXT);
    if !path.exists() {
        let Some(jpeg) = hp_pdf::render_page_jpeg(&pdf, index, hp_pdf::PDF_PAGE_WIDTH) else {
            // 单页渲染失败不该让整个查看器变成错误态：这一页给一个空块。
            return Ok(BookContentResult {
                format: "pdf".into(),
                encoding: None,
                text: None,
                blocks: Some(Vec::new()),
                next_cursor: None,
                section: index as u32,
                section_count: Some(total),
                title: None,
                capped: false,
                page_break_before: false,
            });
        };
        cache.ensure_dir_for(hash)?;
        write_atomic(&path, &jpeg)?;
    }

    let block = BookBlockItem {
        kind: "image".into(),
        level: None,
        spans: None,
        path: Some(path.to_string_lossy().to_string()),
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
        figure: None,
        caption: None,
        full_page: None,
    };

    Ok(BookContentResult {
        format: "pdf".into(),
        encoding: None,
        text: None,
        blocks: Some(vec![block]),
        next_cursor: (index as u32 + 1 < total).then(|| (index as u32 + 1).to_string()),
        section: index as u32,
        section_count: Some(total),
        title: None,
        // 还有下一页 = "仅显示开头"（用户口径：只显示开头的内容）。
        capped: index as u32 + 1 < total,
        // PDF 的一"页"就是一张位图：翻到下一页天然换页，不需要额外的换页声明。
        page_break_before: false,
    })
}

/// epub 一章：读 spine 的第 `section` 章，转成类型化块（**不返回 HTML**）。
///
/// ## `page_break_before`：**每章都是全新的一页**（2026-10-18，需求 4）
///
/// 用户口径："每个章节应该是全新的一页，而不是接在上一章后面。"
///
/// 判据就是 `read.section > 0`——**章节序号**（`book.content` 的游标）本身已经
/// 表达"这是第几章"，`0` 是第一/前言，`> 0` 即"本章另起一页"。
///
/// **为什么不用一个 `page_break` 块表示**（三个可观测的理由）：
/// 1. 那个块会占掉**页容器的第一个子元素**，把 `:first-child` / `:last-child`
///    语义一起改掉（样式的落点会错位）；
/// 2. 它是"空块"，在章首就是**前导空白**：滚动模式下多一条分隔线，
///    分页（多栏）模式下会多出一整栏空白；
/// 3. 前端本来就要按页容器渲染每章，页容器上多一个属性是**零新增结构**。
///
/// 因此解析侧不合成任何块，只在这里如实声明"本章不是第一章"。
/// 前端在页容器上落到 `data-page-break-before`（见 `ReaderStage` 的渲染说明）。
///
/// ## 与 koodo-reader 的对应关系
///
/// koodo 的真实机制是"**整章重渲染**"：它不做连续排版，每次换章都先
/// `doc.body.innerHTML = ""` 再注入（其排版内核 `kookit` 的
/// `src/utils/navigationUtil.ts` 的 `handleRenderChapter()`），章首分页是这件事的
/// **副作用**。我们这里"已载入的多页拼在一条流里"，所以要把同一个语义**显式**写出来
/// ——`section > 0` 就是它的等价物。
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
        // 第 0 章（前言 / 第一章）不声明换页；其后每一章都另起一页（需求 4）。
        page_break_before: read.section > 0,
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
            && let Ok(dir) = crate::commands::shared::user_covers_dir()
        {
            let _ = std::fs::remove_file(dir.join(value));
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
