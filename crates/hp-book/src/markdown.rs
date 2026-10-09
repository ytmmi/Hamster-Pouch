//! Markdown（`.md` / `.markdown`）**正文解析**：把 CommonMark + GFM 转成**类型化的块**。
//!
//! ## 安全边界（与 EPUB 同一条，见 `block.rs` 的模块文档）
//!
//! Markdown 的常见渲染路径是"转 HTML → `dangerouslySetInnerHTML`"——**本项目不接受**。
//! 因此本模块产出的是 [`BookBlock`] / [`BookSpan`] **纯数据**，由前端用 React 元素渲染。
//! 前端因此**没有**可以注入 HTML 的入口——不是"我们记得不要用
//! `dangerouslySetInnerHTML`"，而是**没有 HTML 可注入**。
//!
//! Markdown 里可以内嵌**原始 HTML**（README 的 `<img>` / `<br>` / `<details>` 很常见）。
//! 处置与 EPUB 一致：`<script>` / `<style>` / `<head>` 的内容**整段丢弃**，
//! 其余标签**丢标签留文字**；`<img src>` **保留**（README 常用它插图，丢掉会让正文缺图）。
//!
//! ## 为什么用 `pulldown-cmark` 而不是手写
//!
//! EPUB 的 XHTML 我们手写解析，是因为只需要"块级切段 + 行内取字 + 图片取 src"
//! 这一小片语义（见 `epub_text.rs`）。Markdown 不同：口径要**完整语法覆盖**
//! （标题 / 强调 / 链接 / 列表 / 引用 / 代码 / 表格 / 任务列表 / 脚注 / 定义列表…），
//! 而 CommonMark 的**行内强调**与**链接引用**规则出了名的绕（分隔符栈、惰性续行、
//! 引用式链接的解析顺序）。手写一个"差不多"的实现会在这两处长期出错，
//! 且每次修补都要重新证明没有回归。
//!
//! `pulldown-cmark` 是 CommonMark 参考实现之一、**纯 Rust、无 C 依赖**。它**只用来
//! 产出事件流**——我们**不用**它的 HTML 渲染器（`html` 特性刻意不开），
//! 因此"库能生成 HTML"这件事不会给本项目多出一条 HTML 注入路径。
//!
//! ## 图片路径解析
//!
//! 相对路径按**文档所在目录**解析（`docs/img/a.png` 相对 `README.md`）。
//! **只保留真的在盘上的图片**：指向网页的图片（`![x](https://…)`）与相对路径写错的
//! 图片都不落成 `<img>`——前端拿到的每个 `image` 都是可渲染的本地绝对路径，
//! "破图"在结构上不出现。跳过的图片进 `warnings`（可诊断，但不让整篇变成错误态）。

use std::path::{Path, PathBuf};

use pulldown_cmark::{Alignment, CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

use crate::block::{
    normalize_styles, BookBlock, BookDefinition, BookListItem, BookSpan, ColumnAlign, SpanStyle,
};
use crate::inline::{inline_style, local_name, LINE_BREAK_MARKER};
use crate::xml::{attr_value, decode_entities};

/// 解析选项：CommonMark 全量 + 口径要求的 GFM 扩展。
///
/// 逐项说明为什么开：
/// - `ENABLE_TABLES`：GFM 表格；
/// - `ENABLE_FOOTNOTES`：`[^1]` 脚注；
/// - `ENABLE_STRIKETHROUGH`：`~~x~~`；
/// - `ENABLE_TASKLISTS`：`- [x]` 任务列表（勾选态进 [`BookListItem::checked`]）；
/// - `ENABLE_GFM`：GFM 告示块（`> [!NOTE]`）与 GFM 的表格 / 脚注变体；
/// - `ENABLE_DEFINITION_LIST`：`术语` + 缩进释义；
/// - `ENABLE_SUPERSCRIPT` / `ENABLE_SUBSCRIPT`：`^x^` / `~x~`；
/// - `ENABLE_MATH`：`$x$` / `$$x$$`（按纯文本渲染，不引入公式排版）；
/// - `ENABLE_HEADING_ATTRIBUTES`：`# 标题 {#id}` 的属性语法要**吃掉**，
///   否则 `{#id}` 会当成标题文字显示出来；
/// - `ENABLE_YAML_STYLE_METADATA_BLOCKS`：文首 `---` 的 front matter 要**吃掉**，
///   否则 YAML 头会当成正文与分隔线显示（Markdown 语料里非常常见）。
///
/// **刻意不开**：`ENABLE_SMART_PUNCTUATION`（会把 `--` 变成破折号、`"` 变成弯引号，
/// 改动了用户原文）；`ENABLE_WIKILINKS`（Obsidian 私有语法，不是 Markdown 标准）。
fn options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_GFM
        | Options::ENABLE_DEFINITION_LIST
        | Options::ENABLE_SUPERSCRIPT
        | Options::ENABLE_SUBSCRIPT
        | Options::ENABLE_MATH
        | Options::ENABLE_HEADING_ATTRIBUTES
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
}

/// 一次 Markdown 读取的结果。
#[derive(Debug, Clone)]
pub struct MarkdownRead {
    /// 正文块。
    pub blocks: Vec<BookBlock>,
    /// 解析告警（目前是"引用了不存在的本地图片，已跳过"这类可诊断信息）。
    ///
    /// **不向上抛错**：一张图找不到不该让整篇文档变成错误态（与 EPUB 的
    /// "缺图只丢图，不丢正文"同一条口径）。
    pub warnings: Vec<String>,
}

/// 把 Markdown 文本解析成类型化的块。
///
/// `doc_dir` 是**文档所在目录**，用于把图片的相对路径解析成绝对路径；
/// 传 `None` 时图片一律丢弃（没有基准目录就没有"相对"可言）。
pub fn blocks_from_markdown(text: &str, doc_dir: Option<&Path>) -> MarkdownRead {
    let mut ctx = ParseCtx {
        doc_dir: doc_dir.map(|d| d.to_path_buf()),
        warnings: Vec::new(),
        html_skip_depth: 0,
    };
    let mut stack: Vec<Frame> = vec![Frame::root()];
    for event in Parser::new_ext(text, options()) {
        ctx.handle(event, &mut stack);
    }
    // 事件流是**成对**的，正常情况下栈里只剩根容器。
    // 真遇到未闭合的容器（解析器不该产生，但不必 panic），把剩余内容并进根：
    // "少一段结构"远好过"整篇文档打不开"。
    let mut pending: Vec<BookBlock> = Vec::new();
    while let Some(frame) = stack.pop() {
        let blocks = frame.into_blocks();
        if stack.is_empty() {
            pending = blocks;
            break;
        }
        stack.last_mut().expect("栈非空").push_blocks(blocks);
    }
    MarkdownRead {
        blocks: pending,
        warnings: ctx.warnings,
    }
}

/// 容器种类（决定"结束时产出哪个块"与"文字往哪写"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameKind {
    Root,
    Paragraph,
    Heading {
        level: u8,
    },
    BlockQuote,
    CodeBlock,
    List,
    Item,
    Table,
    TableHead,
    TableRow,
    TableCell,
    Footnote,
    DefinitionList,
    DefinitionTitle,
    DefinitionDefinition,
    HtmlBlock,
    /// front matter / 原始 HTML 块：内容**整段丢弃**。
    DropContent,
}

/// 一个容器（栈帧）。
///
/// 为什么用一个"宽"结构而不是给每种块写一个类型：Markdown 的块可以任意嵌套
/// （引用套列表套引用套代码），把"当前收集什么"统一成一种结构，
/// 嵌套就只是"压栈 / 出栈"，不必为每种组合各写一条路径。
struct Frame {
    kind: FrameKind,
    /// 已完成的子块。
    blocks: Vec<BookBlock>,
    /// 正在累积的行内内容（段落 / 标题 / 单元格 / 块级 HTML 文字都走它）。
    inline: InlineAcc,
    /// 代码块的**原文**（不折叠空白：缩进是代码语义）。
    raw: String,
    /// 列表项的勾选态（GFM 任务列表）。
    checked: Option<bool>,
    /// 列表项。
    items: Vec<BookListItem>,
    /// 定义列表：当前术语。
    term: Option<Vec<BookSpan>>,
    /// 定义列表：当前项的释义。
    definitions: Vec<Vec<BookBlock>>,
    /// 定义列表：已完成的项。
    def_items: Vec<BookDefinition>,
    /// 表格：列对齐。
    align: Vec<ColumnAlign>,
    /// 表格：表头单元格。
    head: Vec<Vec<BookSpan>>,
    /// 表格：表体行。
    rows: Vec<Vec<Vec<BookSpan>>>,
    /// 表格行 / 表头的单元格。
    cells: Vec<Vec<BookSpan>>,
    /// 代码块的围栏语言。
    lang: Option<String>,
    /// 脚注标签。
    label: Option<String>,
    /// 引用块的 GFM 告示种类。
    quote_kind: Option<String>,
    /// 有序列表的起始序号。
    start: Option<u64>,
    /// 图片开始时的"行内片段下标 + 目标地址"（alt 文本在两者之间产生）。
    image_mark: Option<(usize, String)>,
}

impl Frame {
    fn root() -> Self {
        Frame::new(FrameKind::Root)
    }

    fn new(kind: FrameKind) -> Self {
        Frame {
            kind,
            blocks: Vec::new(),
            inline: InlineAcc::default(),
            raw: String::new(),
            checked: None,
            items: Vec::new(),
            term: None,
            definitions: Vec::new(),
            def_items: Vec::new(),
            align: Vec::new(),
            head: Vec::new(),
            rows: Vec::new(),
            cells: Vec::new(),
            lang: None,
            label: None,
            quote_kind: None,
            start: None,
            image_mark: None,
        }
    }

    /// 追加一个**已完成的块**；先把挂起的行内内容收成段落（保证顺序）。
    fn push_block(&mut self, block: BookBlock) {
        self.flush_inline();
        self.blocks.push(block);
    }

    /// 追加若干块。
    fn push_blocks(&mut self, blocks: Vec<BookBlock>) {
        for block in blocks {
            self.push_block(block);
        }
    }

    /// 把挂起的行内内容收成一个段落（空则丢弃）。
    fn flush_inline(&mut self) {
        let spans = self.take_inline();
        // 只有**纯文字**才包成段落：图片片段自成一段（`close_image` 已落定），
        // 再包一层会让 `!spans.is_empty()` 之类判据误判，也会让 alt 文本被当正文。
        let has_image = spans.iter().any(|s| s.image.is_some());
        let text: String = spans
            .iter()
            .filter(|s| s.image.is_none())
            .map(|s| s.text.as_str())
            .collect();
        if text.trim().is_empty() && !has_image {
            return;
        }
        self.blocks.push(BookBlock::Paragraph { spans });
    }

    /// 取走挂起的行内片段（已折叠空白、已归一化样式）。
    fn take_inline(&mut self) -> Vec<BookSpan> {
        std::mem::take(&mut self.inline).finish()
    }

    /// 收尾：把挂起内容落定并交出子块。
    fn into_blocks(mut self) -> Vec<BookBlock> {
        self.flush_inline();
        std::mem::take(&mut self.blocks)
    }
}

/// 解析上下文（图片解析基准目录 + 告警 + HTML 丢弃深度）。
struct ParseCtx {
    doc_dir: Option<PathBuf>,
    warnings: Vec<String>,
    /// 原始 HTML 里"内容整段丢弃"标签的**嵌套深度**（`<script>` / `<style>` / `<head>`）。
    ///
    /// 它必须**跨事件**存活：`pulldown-cmark` 把 `<script>alert()</script>` 拆成
    /// `InlineHtml("<script>")` + `Text("alert()")` + `InlineHtml("</script>")`，
    /// 而 `Text` 那一件会走普通的文字通路。只看单个事件无法知道"这段文字在 script 里"。
    html_skip_depth: usize,
}

/// 内容**整段丢弃**的 HTML 标签（代码与样式不是正文）。
const DROPPED_HTML_TAGS: [&str; 3] = ["script", "style", "head"];

impl ParseCtx {
    /// 处理一个事件。
    fn handle(&mut self, event: Event<'_>, stack: &mut Vec<Frame>) {
        match event {
            Event::Start(tag) => self.start(tag, stack),
            Event::End(tag_end) => self.end(tag_end, stack),
            Event::Text(text) => {
                // **安全边界**：`<script>` 与 `</script>` 之间是**普通文字事件**
                // （pulldown 只把标签本身作为 `InlineHtml` 发出）。这段深度内的文字
                // 必须丢弃，否则 `<script>alert('xss')</script>` 的内容会进正文
                // ——这是实测抓到的洞，见 `push_html` 的文档。
                if self.html_skip_depth > 0 {
                    return;
                }
                let frame = stack.last_mut().expect("栈非空");
                if frame.kind == FrameKind::CodeBlock {
                    frame.raw.push_str(&text);
                } else if frame.kind != FrameKind::DropContent {
                    frame.inline.push_text(&text);
                }
            }
            Event::Code(code) => {
                let frame = stack.last_mut().expect("栈非空");
                frame.inline.push_style(SpanStyle::Code);
                frame.inline.push_text(&code);
                frame.inline.pop_style(SpanStyle::Code);
            }
            Event::InlineMath(math) | Event::DisplayMath(math) => {
                let frame = stack.last_mut().expect("栈非空");
                frame.inline.push_style(SpanStyle::Math);
                frame.inline.push_text(&math);
                frame.inline.pop_style(SpanStyle::Math);
            }
            Event::FootnoteReference(label) => {
                // 脚注引用：文字就是标签，样式标记为脚注（前端渲染成上标编号）。
                let frame = stack.last_mut().expect("栈非空");
                frame.inline.push_style(SpanStyle::Footnote);
                frame.inline.push_text(&label);
                frame.inline.pop_style(SpanStyle::Footnote);
            }
            Event::SoftBreak => {
                // 软换行按**空格**处理（CommonMark 语义：软换行等价于空格）。
                stack.last_mut().expect("栈非空").inline.push_text(" ");
            }
            Event::HardBreak => {
                stack
                    .last_mut()
                    .expect("栈非空")
                    .inline
                    .push_text(&LINE_BREAK_MARKER.to_string());
            }
            Event::Rule => {
                stack
                    .last_mut()
                    .expect("栈非空")
                    .push_block(BookBlock::Rule);
            }
            Event::TaskListMarker(checked) => {
                // 勾选态属于**列表项**，而 `TaskListMarker` 可能出现在项内更深的位置
                // （实测：它在 `Start(Item)` 之后、`Start(Paragraph)` 之前）。
                // 因此从栈顶向下找最近的一个项帧，而不是只看栈顶。
                for frame in stack.iter_mut().rev() {
                    if frame.kind == FrameKind::Item {
                        frame.checked = Some(checked);
                        break;
                    }
                }
            }
            Event::Html(html) | Event::InlineHtml(html) => self.push_html(&html, stack),
        }
    }

    /// 处理开始标签。
    fn start(&mut self, tag: Tag<'_>, stack: &mut Vec<Frame>) {
        match tag {
            Tag::Paragraph => stack.push(Frame::new(FrameKind::Paragraph)),
            Tag::Heading { level, .. } => {
                stack.push(Frame::new(FrameKind::Heading { level: level as u8 }))
            }
            Tag::BlockQuote(kind) => {
                let mut frame = Frame::new(FrameKind::BlockQuote);
                frame.quote_kind = kind.map(|k| format!("{k:?}").to_ascii_lowercase());
                stack.push(frame);
            }
            Tag::CodeBlock(kind) => {
                let mut frame = Frame::new(FrameKind::CodeBlock);
                frame.lang = match kind {
                    CodeBlockKind::Fenced(info) => fence_lang(&info),
                    CodeBlockKind::Indented => None,
                };
                stack.push(frame);
            }
            Tag::List(start) => {
                let mut frame = Frame::new(FrameKind::List);
                frame.start = start;
                stack.push(frame);
            }
            Tag::Item => stack.push(Frame::new(FrameKind::Item)),
            Tag::Table(align) => {
                let mut frame = Frame::new(FrameKind::Table);
                frame.align = align.into_iter().map(map_align).collect();
                stack.push(frame);
            }
            Tag::TableHead => stack.push(Frame::new(FrameKind::TableHead)),
            Tag::TableRow => stack.push(Frame::new(FrameKind::TableRow)),
            Tag::TableCell => stack.push(Frame::new(FrameKind::TableCell)),
            Tag::FootnoteDefinition(label) => {
                let mut frame = Frame::new(FrameKind::Footnote);
                frame.label = Some(label.to_string());
                stack.push(frame);
            }
            Tag::DefinitionList => stack.push(Frame::new(FrameKind::DefinitionList)),
            Tag::DefinitionListTitle => stack.push(Frame::new(FrameKind::DefinitionTitle)),
            Tag::DefinitionListDefinition => {
                stack.push(Frame::new(FrameKind::DefinitionDefinition))
            }
            Tag::HtmlBlock => stack.push(Frame::new(FrameKind::HtmlBlock)),
            Tag::MetadataBlock(_) => stack.push(Frame::new(FrameKind::DropContent)),
            Tag::Emphasis => push_style(stack, SpanStyle::Emphasis),
            Tag::Strong => push_style(stack, SpanStyle::Strong),
            Tag::Strikethrough => push_style(stack, SpanStyle::Strikethrough),
            Tag::Superscript => push_style(stack, SpanStyle::Superscript),
            Tag::Subscript => push_style(stack, SpanStyle::Subscript),
            Tag::Link { dest_url, .. } => {
                stack.last_mut().expect("栈非空").inline.href = Some(dest_url.to_string());
            }
            Tag::Image { dest_url, .. } => {
                // 图片的 alt 文本由随后的行内事件产生：先记下"从哪个片段开始"。
                let frame = stack.last_mut().expect("栈非空");
                frame.image_mark = Some((frame.inline.spans.len(), dest_url.to_string()));
            }
        }
    }

    /// 处理结束标签。
    fn end(&mut self, tag_end: TagEnd, stack: &mut Vec<Frame>) {
        match tag_end {
            TagEnd::Paragraph => {
                let frame = stack.pop().expect("栈非空");
                let blocks = frame.into_blocks();
                stack.last_mut().expect("栈非空").push_blocks(blocks);
            }
            TagEnd::Heading(_) => {
                let mut frame = stack.pop().expect("栈非空");
                let level = match frame.kind {
                    FrameKind::Heading { level } => level,
                    _ => 1,
                };
                // 标题的内容只有行内片段：直接取累积，不必先落成段落再改写。
                let spans = frame.take_inline();
                if !spans.is_empty() {
                    stack
                        .last_mut()
                        .expect("栈非空")
                        .push_block(BookBlock::Heading { level, spans });
                }
            }
            TagEnd::BlockQuote(_) => {
                let frame = stack.pop().expect("栈非空");
                let kind = frame.quote_kind.clone();
                let blocks = frame.into_blocks();
                stack
                    .last_mut()
                    .expect("栈非空")
                    .push_block(BookBlock::BlockQuote { kind, blocks });
            }
            TagEnd::CodeBlock => {
                let frame = stack.pop().expect("栈非空");
                let lang = frame.lang.clone();
                let text = frame.raw.clone();
                stack
                    .last_mut()
                    .expect("栈非空")
                    .push_block(BookBlock::CodeBlock { lang, text });
            }
            TagEnd::List(ordered) => {
                let frame = stack.pop().expect("栈非空");
                let start = frame.start;
                let items = frame.items;
                stack
                    .last_mut()
                    .expect("栈非空")
                    .push_block(BookBlock::List {
                        ordered,
                        start,
                        items,
                    });
            }
            TagEnd::Item => {
                let frame = stack.pop().expect("栈非空");
                let item = BookListItem {
                    checked: frame.checked,
                    blocks: frame.into_blocks(),
                };
                let parent = stack.last_mut().expect("栈非空");
                parent.items.push(item);
            }
            TagEnd::Table => {
                let frame = stack.pop().expect("栈非空");
                let align = frame.align.clone();
                let head = frame.head.clone();
                let rows = frame.rows.clone();
                stack
                    .last_mut()
                    .expect("栈非空")
                    .push_block(BookBlock::Table { align, head, rows });
            }
            TagEnd::TableHead => {
                let frame = stack.pop().expect("栈非空");
                let cells = frame.cells;
                stack.last_mut().expect("栈非空").head = cells;
            }
            TagEnd::TableRow => {
                let frame = stack.pop().expect("栈非空");
                let cells = frame.cells;
                stack.last_mut().expect("栈非空").rows.push(cells);
            }
            TagEnd::TableCell => {
                let mut frame = stack.pop().expect("栈非空");
                let spans = frame.take_inline();
                stack.last_mut().expect("栈非空").cells.push(spans);
            }
            TagEnd::FootnoteDefinition => {
                let frame = stack.pop().expect("栈非空");
                let label = frame.label.clone().unwrap_or_default();
                let blocks = frame.into_blocks();
                stack
                    .last_mut()
                    .expect("栈非空")
                    .push_block(BookBlock::Footnote { label, blocks });
            }
            TagEnd::DefinitionList => {
                let mut frame = stack.pop().expect("栈非空");
                frame.flush_definition();
                let items = std::mem::take(&mut frame.def_items);
                stack
                    .last_mut()
                    .expect("栈非空")
                    .push_block(BookBlock::DefinitionList { items });
            }
            TagEnd::DefinitionListTitle => {
                let mut frame = stack.pop().expect("栈非空");
                let spans = frame.take_inline();
                let parent = stack.last_mut().expect("栈非空");
                // 上一个术语（及其释义）已经收完，落成一项。
                parent.flush_definition();
                parent.term = Some(spans);
            }
            TagEnd::DefinitionListDefinition => {
                let frame = stack.pop().expect("栈非空");
                let blocks = frame.into_blocks();
                stack.last_mut().expect("栈非空").definitions.push(blocks);
            }
            TagEnd::HtmlBlock => {
                let frame = stack.pop().expect("栈非空");
                let blocks = frame.into_blocks();
                stack.last_mut().expect("栈非空").push_blocks(blocks);
            }
            TagEnd::MetadataBlock(_) => {
                // front matter：整段丢弃。
                stack.pop();
            }
            TagEnd::Emphasis => pop_style(stack, SpanStyle::Emphasis),
            TagEnd::Strong => pop_style(stack, SpanStyle::Strong),
            TagEnd::Strikethrough => pop_style(stack, SpanStyle::Strikethrough),
            TagEnd::Superscript => pop_style(stack, SpanStyle::Superscript),
            TagEnd::Subscript => pop_style(stack, SpanStyle::Subscript),
            TagEnd::Link => {
                stack.last_mut().expect("栈非空").inline.href = None;
            }
            TagEnd::Image => self.close_image(stack),
        }
    }

    /// 结束一张图片：把两者之间产生的文字当作 alt，落成一个图片片段。
    fn close_image(&mut self, stack: &mut Vec<Frame>) {
        let mark = stack.last_mut().expect("栈非空").image_mark.take();
        let Some((start, src)) = mark else {
            return;
        };
        let resolved = self.resolve_image(&src);
        let frame = stack.last_mut().expect("栈非空");
        let alt: String = frame
            .inline
            .spans
            .get(start..)
            .unwrap_or_default()
            .iter()
            .map(|s| s.text.as_str())
            .collect();
        frame.inline.spans.truncate(start);
        match resolved {
            Some(path) => frame.inline.push_image(alt.trim(), path),
            None => self
                .warnings
                .push(format!("图片不存在或无法解析，已跳过：{src}")),
        }
    }

    /// 把一段原始 HTML 追加到当前容器（**丢标签留文字**，保留 `<img>`）。
    ///
    /// ### 为什么这里自己扫描而不复用 `inline::spans_from_html`
    ///
    /// `pulldown-cmark` 对 `<script>…alert…</script>` 的产出是
    /// `InlineHtml("<script>")` + **`Text("alert('xss')")`** + `InlineHtml("</script>")`：
    /// 起止标签之间是**普通文字事件**，不是 HTML 事件。因此"过滤 HTML 事件"**漏掉
    /// 了正中间那段代码**——安全测试实测抓到的就是这个洞
    /// （`raw_html_is_never_passed_through`）。
    ///
    /// 复用的路径（`spans_from_html`）只看到孤立的标签字符串，同样拦不住它。
    /// 于是本函数**自己驱动一遍扫描**：遇到丢弃标签就记深度，深度内的文字一律不产出。
    /// 扫描逻辑与 `inline::spans_from_html` 同一条口径（白名单 + 丢标签留文字）。
    fn push_html(&mut self, html: &str, stack: &mut Vec<Frame>) {
        // front matter 里的 HTML 事件是 YAML 原文：整段丢弃。
        if stack
            .last()
            .is_some_and(|f| f.kind == FrameKind::DropContent)
        {
            return;
        }
        let Some(frame) = stack.last_mut() else {
            return;
        };
        let mut at = 0usize;
        while let Some(lt) = html[at..].find('<') {
            let start = at + lt;
            // 标签之前的文字（丢弃区段内被上一个事件的扫描已处理，这里按深度过滤）。
            if self.html_skip_depth == 0 && start > at {
                frame.inline.push_text(&decode_entities(&html[at..start]));
            }
            let Some(gt) = html[start..].find('>') else {
                if self.html_skip_depth == 0 {
                    frame.inline.push_text(&decode_entities(&html[start..]));
                }
                break;
            };
            let tag_end = start + gt + 1;
            let tag = &html[start..tag_end];
            at = tag_end;

            if tag.starts_with("<!--") || tag.starts_with("<!") || tag.starts_with("<?") {
                continue;
            }
            let closing = tag.starts_with("</");
            let self_closing = tag.trim_end().ends_with("/>");
            let name = local_name(tag);

            if DROPPED_HTML_TAGS.contains(&name.as_str()) {
                if closing {
                    self.html_skip_depth = self.html_skip_depth.saturating_sub(1);
                } else if !self_closing {
                    self.html_skip_depth += 1;
                }
                continue;
            }
            if self.html_skip_depth > 0 {
                continue;
            }

            if name == "img" && !closing {
                let src = attr_value(tag, "src").filter(|s| !s.is_empty());
                if let Some(src) = src {
                    let alt = decode_entities(&attr_value(tag, "alt").unwrap_or_default());
                    match self.resolve_image(&src) {
                        Some(path) => frame.inline.push_image(&alt, path),
                        None => self
                            .warnings
                            .push(format!("图片不存在或无法解析，已跳过：{src}")),
                    }
                }
                continue;
            }
            if name == "br" {
                frame.inline.push_text(&LINE_BREAK_MARKER.to_string());
                continue;
            }
            if name == "a" {
                if closing {
                    frame.inline.href = None;
                } else {
                    frame.inline.href = attr_value(tag, "href").filter(|h| !h.is_empty());
                }
                continue;
            }
            if let Some(style) = inline_style(&name) {
                if closing {
                    frame.inline.pop_style(style);
                } else {
                    frame.inline.push_style(style);
                }
            }
        }
        if self.html_skip_depth == 0 && at < html.len() {
            frame.inline.push_text(&decode_entities(&html[at..]));
        }
    }

    /// 把图片的 src 解析成**真的在盘上**的绝对路径。
    ///
    /// 解析失败（远程 URL / data URI / 相对路径写错 / 文件不存在）返回 `None`，
    /// 调用方据此**跳过这张图**——前端拿到的每个 `image` 都可渲染。
    fn resolve_image(&mut self, src: &str) -> Option<String> {
        // 远程图片与 data URI 不落到本地文件系统。
        let lower = src.to_ascii_lowercase();
        if lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("data:")
            || lower.starts_with("//")
        {
            return None;
        }
        let decoded = crate::xml::percent_decode(src);
        // 去掉锚点与查询串（`a.png#x` / `a.png?raw=1`）。
        let cleaned = decoded.split(['#', '?']).next().unwrap_or("").to_string();
        if cleaned.is_empty() {
            return None;
        }
        let raw = PathBuf::from(&cleaned);
        let candidate = if raw.is_absolute() {
            raw
        } else {
            self.doc_dir.as_ref()?.join(raw)
        };
        // 归一化 `..` / `.`（不解析符号链接：只求"路径字符串"可用）。
        let normalized = normalize_path(&candidate);
        normalized
            .is_file()
            .then(|| normalized.to_string_lossy().to_string())
    }
}

impl Frame {
    /// 把"当前术语 + 已收释义"落成一个定义列表项。
    fn flush_definition(&mut self) {
        let Some(term) = self.term.take() else {
            return;
        };
        let definitions = std::mem::take(&mut self.definitions);
        self.def_items.push(BookDefinition { term, definitions });
    }
}

/// 围栏信息串 → 语言标记（`rust,ignore` / `rust title="x"` 都只取第一个词）。
fn fence_lang(info: &str) -> Option<String> {
    let first = info
        .split(|c: char| c.is_whitespace() || c == ',' || c == '{')
        .next()
        .unwrap_or("")
        .trim();
    (!first.is_empty()).then(|| first.to_string())
}

/// 把 `Alignment` 映射成 [`ColumnAlign`]。
fn map_align(align: Alignment) -> ColumnAlign {
    match align {
        Alignment::None => ColumnAlign::None,
        Alignment::Left => ColumnAlign::Left,
        Alignment::Center => ColumnAlign::Center,
        Alignment::Right => ColumnAlign::Right,
    }
}

/// 往当前容器的行内累积里压入一个样式。
fn push_style(stack: &mut [Frame], style: SpanStyle) {
    stack.last_mut().expect("栈非空").inline.push_style(style);
}

/// 从当前容器的行内累积里弹出一个样式。
fn pop_style(stack: &mut [Frame], style: SpanStyle) {
    stack.last_mut().expect("栈非空").inline.pop_style(style);
}

/// 归一化路径里的 `.` 与 `..`（纯字符串处理，不触碰文件系统）。
fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                // 只有"前一段是普通目录名"时才回退（不能吃掉盘符或根）。
                let pop = matches!(
                    out.components().next_back(),
                    Some(std::path::Component::Normal(_))
                );
                if pop {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 正在累积的一段行内内容。
///
/// **为什么不直接折叠**：空白折叠必须**跨事件**进行——`a <b>b</b> c` 里
/// "a " 的尾随空格与 " c" 的前导空格都参与"折叠成单个空格"的判定，
/// 分开折叠会把词间空格吃掉（变成 `ab c`）。因此先按样式分段累积，
/// 段落结束（`finish`）时才统一折叠。
#[derive(Debug, Default)]
struct InlineAcc {
    /// 累积的片段（已按样式分段，但**尚未折叠空白**）。
    spans: Vec<BookSpan>,
    /// 当前生效的样式栈（嵌套标签依次压栈）。
    styles: Vec<SpanStyle>,
    /// 当前链接目标。
    href: Option<String>,
}

impl InlineAcc {
    /// 追加一段文字（沿用当前样式与链接）。
    fn push_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let href = self.href.clone();
        if let Some(last) = self.spans.last_mut() {
            if last.image.is_none() && last.styles == self.styles && last.href == href {
                last.text.push_str(text);
                return;
            }
        }
        self.spans.push(BookSpan {
            text: text.to_string(),
            styles: self.styles.clone(),
            href,
            image: None,
        });
    }

    /// 追加一张图片（图片片段不参与文字合并）。
    fn push_image(&mut self, alt: &str, path: String) {
        self.spans.push(BookSpan {
            text: alt.to_string(),
            styles: self.styles.clone(),
            href: self.href.clone(),
            image: Some(path),
        });
    }

    /// 压入一个样式。
    fn push_style(&mut self, style: SpanStyle) {
        self.styles.push(style);
    }

    /// 弹出一个样式（只移除**最近一次**同名样式：嵌套同种样式时不该一次全清）。
    fn pop_style(&mut self, style: SpanStyle) {
        if let Some(pos) = self.styles.iter().rposition(|s| *s == style) {
            self.styles.remove(pos);
        }
    }

    /// 结束累积，产出**折叠空白后**的片段。
    fn finish(self) -> Vec<BookSpan> {
        let mut spans = collapse_spans(&self.spans);
        for span in &mut spans {
            normalize_styles(&mut span.styles);
        }
        spans
    }
}

/// 跨片段折叠空白（保留 [`LINE_BREAK_MARKER`] 产生的换行）。
///
/// 与 `inline::collapse_runs` 同一条口径，但作用在**已分好样式**的片段上：
/// 折叠时不能跨样式合并文字（那会把粗体并进普通文字），
/// 但**空格的判定必须跨片段**。
fn collapse_spans(spans: &[BookSpan]) -> Vec<BookSpan> {
    let mut out: Vec<BookSpan> = Vec::new();
    let mut last_space = false;
    for span in spans {
        // 图片片段**不参与折叠**：它的 `text` 是 alt（不该被空白折叠改写），
        // 而且它必须在输出里保留自己的身份——逐字符重建会把它变成普通文字，
        // 前端就再也看不到这张图（实测抓到的洞）。
        if span.image.is_some() {
            let mut kept = span.clone();
            kept.styles = std::mem::take(&mut kept.styles);
            out.push(kept);
            last_space = false;
            continue;
        }
        for ch in span.text.chars() {
            if ch == LINE_BREAK_MARKER {
                // 换行前去掉行尾空格。
                while let Some(last) = out.last_mut() {
                    while last.text.ends_with(' ') {
                        last.text.pop();
                    }
                    if last.text.is_empty() {
                        out.pop();
                    } else {
                        break;
                    }
                }
                let ends_nl = out.last().is_some_and(|s| s.text.ends_with('\n'));
                if !out.is_empty() && !ends_nl {
                    push_styled(&mut out, '\n', span);
                }
                last_space = false;
                continue;
            }
            if ch.is_whitespace() {
                let ends_nl = out.last().is_some_and(|s| s.text.ends_with('\n'));
                if !last_space && !out.is_empty() && !ends_nl {
                    push_styled(&mut out, ' ', span);
                }
                last_space = true;
                continue;
            }
            push_styled(&mut out, ch, span);
            last_space = false;
        }
    }
    // 去掉末尾空白。
    while let Some(last) = out.last_mut() {
        let trimmed = last.text.trim_end();
        if trimmed.len() != last.text.len() {
            last.text = trimmed.to_string();
        }
        if last.text.is_empty() {
            out.pop();
        } else {
            break;
        }
    }
    out
}

/// 把字符追加到末尾片段（样式 / 链接 / 图片身份不同则另起）。
fn push_styled(out: &mut Vec<BookSpan>, ch: char, like: &BookSpan) {
    if let Some(last) = out.last_mut() {
        if last.image.is_none() && last.styles == like.styles && last.href == like.href {
            last.text.push(ch);
            return;
        }
    }
    out.push(BookSpan {
        text: ch.to_string(),
        styles: like.styles.clone(),
        href: like.href.clone(),
        image: None,
    });
}
