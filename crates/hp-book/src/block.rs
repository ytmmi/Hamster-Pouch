//! 正文的**类型化块模型**（EPUB 与 Markdown 共用的中间表示）。
//!
//! ## 为什么要有这一层（安全边界）
//!
//! 两种格式的正文都不是"纯文本"：EPUB 是 XHTML、Markdown 是标记语法。渲染它们
//! 的常见做法是转成 HTML 再 `dangerouslySetInnerHTML`——**本项目不接受**
//! （与"插件不得创建自由 React 组件"同一条安全思路）。
//!
//! 因此解析侧把两种格式都收敛成**同一套纯数据**：块（[`BookBlock`]）与行内片段
//! （[`BookSpan`]）。前端拿到的只有这些数据，用 React 元素渲染，
//! **没有可以注入 HTML 的入口**——不是"我们记得不要用 `dangerouslySetInnerHTML`"，
//! 而是**没有 HTML 可注入**。
//!
//! ## 为什么两种格式共用一套模型
//!
//! EPUB 与 Markdown 的**块级语义高度重合**（标题 / 段落 / 引用 / 列表 / 代码 /
//! 表格 / 分隔线），差异只在"怎么解析出来"。共用一套模型意味着：
//! - 前端**只有一份渲染器**（`BookBlocks.tsx`）——两种格式的观感不会各自漂移；
//! - 新增一种格式（如日后的 `mobi`）只需在解析侧产出同一套块，前端零改动。
//!
//! 反面做法是"每种格式各自一套块类型 + 各自一个渲染器"，那会让"改一处样式"
//! 变成"改 N 处"，并且迟早出现两种格式观感不一致。
//!
//! ## 边界如实说明
//!
//! - 行内样式是**可叠加的标记列表**（[`SpanStyle`]）而不是嵌套树：`***粗斜体***`
//!   解析为"一段文字 + `[Strong, Emphasis]`"。这样前端渲染只需按固定顺序套元素，
//!   不必递归遍历一棵可能任意深的内联树；表达力对 Markdown/EPUB 的实际语料足够。
//! - **原始 HTML 一律不进入模型**：Markdown 里的 HTML 块 / 行内 HTML 由解析侧
//!   丢弃标签、保留其文字（与 EPUB 的"白名单外标签丢标签留文字"同一条口径）。

/// 行内样式（**可叠加**：`***粗斜体***` = `[Strong, Emphasis]`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpanStyle {
    /// 斜体（Markdown `*x*` / EPUB `<i>` / `<em>`）。
    Emphasis,
    /// 粗体（Markdown `**x**` / EPUB `<b>` / `<strong>`）。
    Strong,
    /// 删除线（GFM `~~x~~`）。
    Strikethrough,
    /// 行内代码（Markdown `` `x` ``）。
    Code,
    /// 上标（`^x^`）。
    Superscript,
    /// 下标（`~x~`）。
    Subscript,
    /// 数学（`$x$` / `$$x$$`）。
    Math,
    /// 脚注引用（GFM `[^1]`）；`text` 是脚注标签。
    Footnote,
}

impl SpanStyle {
    /// 线上取值（DTO / 前端 `styles` 数组里的字符串）。
    pub fn as_str(self) -> &'static str {
        match self {
            SpanStyle::Emphasis => "emphasis",
            SpanStyle::Strong => "strong",
            SpanStyle::Strikethrough => "strikethrough",
            SpanStyle::Code => "code",
            SpanStyle::Superscript => "superscript",
            SpanStyle::Subscript => "subscript",
            SpanStyle::Math => "math",
            SpanStyle::Footnote => "footnote",
        }
    }

    /// 规范化排序用的固定次序（**唯一权威**，见 [`normalize_styles`]）。
    fn rank(self) -> u8 {
        match self {
            SpanStyle::Strong => 0,
            SpanStyle::Emphasis => 1,
            SpanStyle::Strikethrough => 2,
            SpanStyle::Code => 3,
            SpanStyle::Superscript => 4,
            SpanStyle::Subscript => 5,
            SpanStyle::Math => 6,
            SpanStyle::Footnote => 7,
        }
    }
}

/// 把样式列表排成**固定次序**并去重。
///
/// 为什么必须归一化：嵌套行内标签的"离开"顺序决定了样式入列的先后，
/// 而 `***x***` 这种写法在解析器里既可能先给 Strong 也可能先给 Emphasis。
/// 不归一化的话，**同一段文字**会因嵌套顺序不同而产生不相等的 [`BookSpan`]——
/// 测试与去重都会变成"看运气"。排序键是 [`SpanStyle::rank`]，只有一处定义。
pub fn normalize_styles(styles: &mut Vec<SpanStyle>) {
    styles.sort_by_key(|s| s.rank());
    styles.dedup();
}

/// 一段行内内容（**纯数据**）。
///
/// `image` 与 `href` 都可能为空；两者都有值时（`[![alt](a)](b)`）渲染器按
/// "图片包在链接里"处理——这是 Markdown 里真实存在的写法。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookSpan {
    /// 文字内容（图片片段里是 **alt 文本**）。
    pub text: String,
    /// 叠加的行内样式（顺序即声明顺序，渲染器按固定顺序套元素）。
    pub styles: Vec<SpanStyle>,
    /// 链接目标（`href`）；`None` = 不是链接。
    pub href: Option<String>,
    /// 图片的**已解析本地绝对路径**；`None` = 不是图片。
    ///
    /// 解析侧负责把 Markdown 里的相对路径按文档所在目录解析成绝对路径，
    /// 并**确认文件真的在盘上**——认不出的图片不会变成破图（见 `markdown` 模块）。
    pub image: Option<String>,
}

impl BookSpan {
    /// 纯文字片段（无样式、无链接、非图片）。
    pub fn plain(text: impl Into<String>) -> Self {
        BookSpan {
            text: text.into(),
            styles: Vec::new(),
            href: None,
            image: None,
        }
    }

    /// 是否没有任何样式与链接（渲染器可据此走纯文本快路径）。
    pub fn is_plain(&self) -> bool {
        self.styles.is_empty() && self.href.is_none() && self.image.is_none()
    }
}

/// 列表项：可选的**勾选态**（GFM 任务列表）+ 项内的块。
///
/// 项内是**块**而不是一行文字：Markdown 的列表项可以包含多个段落、嵌套列表、
/// 代码块、引用——把它压成一行会丢掉这些结构。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookListItem {
    /// `Some(true)` = 已勾选、`Some(false)` = 未勾选、`None` = 不是任务项。
    pub checked: Option<bool>,
    /// 项内正文（至少一个块；空项在解析侧已被丢弃）。
    pub blocks: Vec<BookBlock>,
}

/// 定义列表的一项：一个术语 + 若干条释义（每条释义是一组块）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookDefinition {
    /// 术语（行内内容）。
    pub term: Vec<BookSpan>,
    /// 释义（每条是一组块：释义可以有多段）。
    pub definitions: Vec<Vec<BookBlock>>,
}

/// 表格对齐（与 Markdown 的 `:---` / `:---:` / `---:` 一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnAlign {
    /// 未声明（渲染器用默认对齐）。
    None,
    Left,
    Center,
    Right,
}

impl ColumnAlign {
    /// 线上取值（DTO / 前端 `align` 数组里的字符串）。
    pub fn as_str(self) -> &'static str {
        match self {
            ColumnAlign::None => "none",
            ColumnAlign::Left => "left",
            ColumnAlign::Center => "center",
            ColumnAlign::Right => "right",
        }
    }
}

/// 正文块（**纯数据**，前端据此渲染 React 元素；见模块文档的安全边界）。
///
/// 变体刻意与"两种格式的块级语义并集"对齐：EPUB 只会产出其中一部分
/// （例如不产表格与任务列表），Markdown 产出得更全。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BookBlock {
    /// 标题（`h1`–`h6`）。
    Heading {
        /// 层级 1–6。
        level: u8,
        /// 标题的行内内容。
        spans: Vec<BookSpan>,
    },
    /// 一个段落。
    Paragraph {
        /// 段落的行内内容。
        spans: Vec<BookSpan>,
    },
    /// **包内**图片（EPUB 章节插图）：字节要由调用方落盘再换成前端可用路径。
    Image {
        /// 图片在包内的条目名（调用方据此落盘）。
        name: String,
        /// 落盘扩展名（按 magic bytes 判定；认不出为 `None`，调用方跳过该图）。
        ext: Option<&'static str>,
        /// 图片原始字节。
        bytes: Vec<u8>,
    },
    /// 代码块（围栏代码块的 `lang` 取自围栏信息串；缩进代码块为 `None`）。
    CodeBlock {
        /// 语言标记（如 `rust`）；无则 `None`。
        lang: Option<String>,
        /// 代码原文（**不折叠空白**：缩进是代码语义的一部分）。
        text: String,
    },
    /// 引用块；`kind` 是 GFM 告示（`note` / `tip` / `important` / `warning` / `caution`）。
    BlockQuote {
        /// GFM 告示种类；普通引用为 `None`。
        kind: Option<String>,
        /// 引用内的块（引用可以套引用、套列表、套代码）。
        blocks: Vec<BookBlock>,
    },
    /// 列表（有序 / 无序）。
    List {
        /// 是否有序列表。
        ordered: bool,
        /// 有序列表的起始序号（`Some(3)` = 从 3 开始）；无序列表为 `None`。
        start: Option<u64>,
        /// 列表项。
        items: Vec<BookListItem>,
    },
    /// 分隔线（`---`）。
    Rule,
    /// 表格（GFM）。
    Table {
        /// 每列对齐（长度 = 列数）。
        align: Vec<ColumnAlign>,
        /// 表头行（单元格 → 行内内容）。
        head: Vec<Vec<BookSpan>>,
        /// 表体行。
        rows: Vec<Vec<Vec<BookSpan>>>,
    },
    /// 脚注定义（GFM `[^1]: …`）。
    Footnote {
        /// 脚注标签（`[^1]` 里的 `1`）。
        label: String,
        /// 脚注正文。
        blocks: Vec<BookBlock>,
    },
    /// 定义列表（`术语` + 缩进释义）。
    DefinitionList {
        /// 各项。
        items: Vec<BookDefinition>,
    },
}

impl BookBlock {
    /// 本块**自身**的文字字符数（不含子块的递归；子块由 [`blocks_char_count`] 计）。
    fn own_char_count(&self) -> usize {
        match self {
            BookBlock::Heading { spans, .. } | BookBlock::Paragraph { spans } => {
                spans_char_count(spans)
            }
            // 图片本身没有文字（alt 文本不计入"阅读量"）。
            BookBlock::Image { .. } => 0,
            // 代码块的字符数就是代码长度（它是实打实要渲染出来的内容）。
            BookBlock::CodeBlock { text, .. } => text.chars().count(),
            BookBlock::Rule => 0,
            // 容器块的自身文字为 0，内容由子块计。
            BookBlock::BlockQuote { .. }
            | BookBlock::List { .. }
            | BookBlock::Table { .. }
            | BookBlock::Footnote { .. }
            | BookBlock::DefinitionList { .. } => 0,
        }
    }
}

/// 一组行内片段的字符数。
pub fn spans_char_count(spans: &[BookSpan]) -> usize {
    spans.iter().map(|s| s.text.chars().count()).sum()
}

/// 一组块的**递归**字符数（含容器块内的子块）。
///
/// 用于"一页最多多少字符"的上限判定：Markdown 的引用 / 列表 / 表格都能嵌套，
/// 只看顶层块会让一个巨大的引用块绕过上限。
pub fn blocks_char_count(blocks: &[BookBlock]) -> usize {
    blocks.iter().map(block_char_count).sum()
}

/// 单个块的递归字符数。
pub fn block_char_count(block: &BookBlock) -> usize {
    let own = block.own_char_count();
    let nested = match block {
        BookBlock::BlockQuote { blocks, .. } | BookBlock::Footnote { blocks, .. } => {
            blocks_char_count(blocks)
        }
        BookBlock::List { items, .. } => items
            .iter()
            .map(|item| blocks_char_count(&item.blocks))
            .sum(),
        BookBlock::Table { head, rows, .. } => {
            // 表头是一**行单元格**（每个单元格一组片段），不是一组片段。
            head.iter()
                .map(|cell| spans_char_count(cell))
                .sum::<usize>()
                + rows
                    .iter()
                    .map(|row| row.iter().map(|c| spans_char_count(c)).sum::<usize>())
                    .sum::<usize>()
        }
        BookBlock::DefinitionList { items } => items
            .iter()
            .map(|item| {
                spans_char_count(&item.term)
                    + item
                        .definitions
                        .iter()
                        .map(|def| blocks_char_count(def))
                        .sum::<usize>()
            })
            .sum(),
        _ => 0,
    };
    own + nested
}
