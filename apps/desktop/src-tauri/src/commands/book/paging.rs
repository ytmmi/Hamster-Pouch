//! `book` 的分页层：游标 / 块转换 / 各格式的正文取页（txt / md / epub / pdf）。

use super::cache::write_atomic;
use super::prelude::*;

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
pub(crate) fn span_to_item(span: hp_book::BookSpan) -> BookSpanItem {
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
pub(crate) fn convert(
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
pub(crate) fn read_page_by_media_type(
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

/// 空正文（非文本类 / 无内容哈希）：**不是错误**，前端显示占位。
pub(crate) fn empty_content() -> BookContentResult {
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
