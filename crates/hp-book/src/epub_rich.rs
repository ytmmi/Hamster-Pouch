//! EPUB **富排版辅助判据**：行内颜色 / 字号解析，注释分类，整页图片判定，
//! 显式换页识别。
//!
//! ## 为什么单独成模块
//!
//! 这些函数全是**纯函数**（输入属性串 / 声明串 → 判定结果），没有 DOM、没有文件系统，
//! 也不产出块。它们被两个地方共用：
//! - `inline`：把 `<span style="…">` / `<font color>` 的内联声明转成
//!   [`BookSpan`](crate::block::BookSpan) 的颜色 / 底色 / 字号与样式标记；
//! - `epub_text`：块级判定（`figure` 是否整页、`aside` 是否注释、哪里显式换页）。
//!
//! 放在一起还让 [`epub_text`](crate::epub_text) 守住"单文件 ≤ 1200 行"的红线
//! （`pnpm check:line-count`）：判据是可以独立单测的纯逻辑，不该和 XHTML 扫描循环
//! 挤在一个文件里。
//!
//! ## 与 koodo-reader 的对应（实测，2026-10-18 dev 分支）
//!
//! koodo 读 EPUB 时把章节 XHTML **原样灌进 iframe**
//! （`EpubRender.renderTo` → `handleOneChapterDoc` → `doc.body.innerHTML = chapterText`，
//! `src/assets/lib/kookit.min.js`），因此**彩色文字 / 划线 / 高亮靠作者的内联
//! `style` 与标签生效**；`StyleHelper.getDefaultCss` 只补"用户字号 / 行高 / 字色 /
//! 标题 1.25em"，另有
//! `aside[epub\:type="footnote"]{font-size:0}`（注释折叠）与
//! `aside[epub\:type="sidebar"]{background-color:#c7eafc}`（旁注淡蓝底）。
//! 本模块把同一批声明**读成结构字段**（本项目不能把 HTML 交给前端）。
//!
//! 分页方面 koodo 在加载作者 CSS 时把 `page-break-(before|after|inside)` 改写成
//! `-webkit-column-break-*`（它的分页是 CSS 多栏：`handleLayout` 给
//! `documentElement` 设 `column-width` / `column-gap` / `column-fill:auto`）——
//! 本模块的 [`is_page_break_tag`] 因此只认 `before` 语义。
//!
//! 整页图方面 koodo 的做法是"整页 flex 容器 + `object-fit:contain`"
//! （同一 bundle 的 `makeComicBook`，书级 `book.rendition={layout:"pre-paginated"}`）——
//! 也就是**由容器负责占满**；[`is_full_page_image`] 负责认出"这张图该走那条路径"。

use crate::block::{BookBlock, SpanStyle};
use crate::xml::{attr_value, decode_entities};

// ==================== 块级 / 丢弃标签清单（解析政策）====================

/// 需要**整段丢弃内容**的标签（代码与样式不是正文）。
pub(crate) const SKIPPED_CONTENT: [&str; 3] = ["script", "style", "head"];

/// 块级标签：遇到它们就**先结束当前段落**。
///
/// `figure` / `figcaption` 也在这里：它们的**内文**由 `epub_text` 单独抽取，
/// 但出现在"块级标签"的位置上仍然必须切段（否则图片前后的文字会粘成一段）。
pub(crate) const BLOCK_TAGS: [&str; 16] = [
    "p",
    "div",
    "section",
    "article",
    "blockquote",
    "li",
    "tr",
    "td",
    "th",
    "figure",
    "figcaption",
    "body",
    "html",
    "nav",
    "aside",
    "hr",
];

/// 会被当作**块级容器**记账的标签（用于整页图片的祖先判定 + 颜色继承）。
///
/// 与 [`BLOCK_TAGS`] 重叠，但**不含** `hr`（自闭合）与 `figcaption`（它的内文属于
/// 图注）。这些标签只压栈 / 出栈，不参与分段。
pub(crate) const ANCESTOR_TAGS: [&str; 14] = [
    "p",
    "div",
    "section",
    "article",
    "blockquote",
    "li",
    "tr",
    "td",
    "th",
    "body",
    "html",
    "nav",
    "aside",
    "figure",
];

// ==================== 行内属性（样式之外的三样）====================

/// 一行内**额外属性**（除样式标记之外的三样：颜色 / 底色 / 字号）。
///
/// 它必须参与"相邻文字能否合并成一段"的判定：`a <span style="color:red">b</span> c`
/// 里的 `a` / `b` / `c` 必须是**三段**——合并会让红色蔓延到前后文字上
/// （颜色是整段生效的，不像样式标记那样可以事后叠加）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct InlineExtras {
    pub(crate) color: Option<String>,
    pub(crate) bg: Option<String>,
    /// 本层的**相对**字号倍率（`None` = 本层没改字号）；多层相乘见 `inline` 的
    /// `effective_size`。
    pub(crate) size: Option<f32>,
}

impl InlineExtras {
    pub(crate) const NONE: InlineExtras = InlineExtras {
        color: None,
        bg: None,
        size: None,
    };
}

// ==================== 颜色解析（CSS 色彩 → `#rrggbb`）====================

/// CSS 具名色 → `#rrggbb`（**只收语料与 koodo 出现过的名字**，不是全表）。
///
/// 为什么不做全表：具名色有 148 个，其中大半（`rebeccapurple` /
/// `lightgoldenrodyellow` …）在中文 EPUB 语料里从未出现；而"认不出来 → `None`"
/// 这条口径比多认几个怪色重要（宁可少显示一个颜色，也不能猜错颜色）。
fn named_color(name: &str) -> Option<&'static str> {
    let hex = match name {
        "black" => "#000000",
        "silver" => "#c0c0c0",
        "gray" | "grey" => "#808080",
        "white" => "#ffffff",
        "maroon" => "#800000",
        "red" => "#ff0000",
        "purple" => "#800080",
        "fuchsia" | "magenta" => "#ff00ff",
        "green" => "#008000",
        "lime" => "#00ff00",
        "olive" => "#808000",
        "yellow" => "#ffff00",
        "navy" => "#000080",
        "blue" => "#0000ff",
        "teal" => "#008080",
        "aqua" | "cyan" => "#00ffff",
        "orange" => "#ffa500",
        "pink" => "#ffc0cb",
        "brown" => "#a52a2a",
        // `transparent` 是**没有颜色**：退回"未声明"，不能让 `bg` 变成透明黑。
        "transparent" => return None,
        _ => return None,
    };
    Some(hex)
}

/// 一个十六进制分量字符 → 值。
fn hex_digit(ch: char) -> Option<u8> {
    ch.to_digit(16).map(|v| v as u8)
}

/// `#rgb` / `#rrggbb` / `#rgba` / `#rrggbbaa` → `#rrggbb`（**小写**）。
///
/// **alpha 一律忽略**并在此说明：前端拿到的是纯数据渲染，不做透明合成；
/// 保留 alpha 会让"高亮底色"变成半透明（比不写更糟），也会让契约里的
/// `#rrggbb` 多出 `#rrggbbaa` 一种形状。
fn parse_hex_color(body: &str) -> Option<String> {
    let chars: Vec<char> = body.chars().collect();
    let (r, g, b) = match chars.len() {
        // `#rgb` / `#rgba`：每个分量重复一次（CSS 缩写规则）。
        3 | 4 => {
            let r = hex_digit(chars[0])?;
            let g = hex_digit(chars[1])?;
            let b = hex_digit(chars[2])?;
            (r * 16 + r, g * 16 + g, b * 16 + b)
        }
        // `#rrggbb` / `#rrggbbaa`。
        6 | 8 => {
            let r = hex_digit(chars[0])? * 16 + hex_digit(chars[1])?;
            let g = hex_digit(chars[2])? * 16 + hex_digit(chars[3])?;
            let b = hex_digit(chars[4])? * 16 + hex_digit(chars[5])?;
            (r, g, b)
        }
        _ => return None,
    };
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

/// `rgb()` / `rgba()` 的单个分量：`0..=255` 的数字或 `0%..=100%` 的百分比。
///
/// 越界（`rgb(300,0,0)` / `120%`）返回 `None` 而**不夹紧**：越界值说明这不是
/// 一个正常颜色，按"认不出来"处理比悄悄改成一个相近颜色诚实。
fn rgb_component(token: &str) -> Option<u8> {
    let token = token.trim();
    if let Some(percent) = token.strip_suffix('%') {
        let value: f32 = percent.trim().parse().ok()?;
        if !value.is_finite() {
            return None;
        }
        let scaled = (value / 100.0 * 255.0).round();
        return (0.0..=255.0).contains(&scaled).then_some(scaled as u8);
    }
    let value: f32 = token.parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    let rounded = value.round();
    (0.0..=255.0).contains(&rounded).then_some(rounded as u8)
}

/// `rgb(…)` / `rgba(…)` 的**内部**（已去掉函数名与括号）：只取前三个分量。
fn parse_rgb_body(body: &str) -> Option<String> {
    // 兼容 `rgb(1,2,3)` / `rgba(1,2,3,0.5)` / `rgb(1 2 3 / 50%)` 三种写法。
    let normalized = body.replace('/', " ");
    let parts: Vec<String> = if normalized.contains(',') {
        normalized
            .split(',')
            .map(|s| s.trim().to_string())
            .collect()
    } else {
        normalized
            .split_whitespace()
            .map(|s| s.to_string())
            .collect()
    };
    if parts.len() < 3 {
        return None;
    }
    let r = rgb_component(&parts[0])?;
    let g = rgb_component(&parts[1])?;
    let b = rgb_component(&parts[2])?;
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

/// CSS 颜色声明 → `#rrggbb`（**小写**）；认不出来返回 `None`（**绝不产出垃圾值**）。
///
/// 支持：`#rgb` / `#rrggbb` / `#rgba` / `#rrggbbaa`、`rgb()` / `rgba()`、
/// 常见具名色。`currentColor` / `inherit` / `var(--x)` 这类"要有级联才知道"的
/// 值一律 `None`——本项目不维护 CSS 级联，猜一个颜色比不显示颜色更糟。
pub fn parse_css_color(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    if let Some(body) = lower.strip_prefix('#') {
        return parse_hex_color(body);
    }
    if let Some(inner) = lower
        .strip_prefix("rgb(")
        .or_else(|| lower.strip_prefix("rgba("))
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return parse_rgb_body(inner);
    }
    named_color(&lower).map(|s| s.to_string())
}

// ==================== 字号解析（CSS font-size → 倍率）====================

/// 字号倍率的**下限**：`font-size:0` 在语料里是"隐藏文字"的写法，
/// 真给 0 会让文字消失、给 `None` 会把"这段该小"的信息全丢，夹到 0.5 是取舍。
pub const MIN_SIZE_EM: f32 = 0.5;
/// 字号倍率的**上限**：装饰性大字的极端值（`10em`）会把排版撑爆。
pub const MAX_SIZE_EM: f32 = 3.0;
/// 基准字号（`1em` 按 16px 计，CSS 的默认 `font-size: medium`）。
const PX_PER_EM: f32 = 16.0;

/// 把倍率夹紧到 [`MIN_SIZE_EM`, `MAX_SIZE_EM`]；非正数或非有限值返回 `None`。
///
/// 与 `block.rs` 的 `BookSpan::size_em` 契约**同区间**（0.5–3.0 = 书自身的意图上限）。
/// 前端渲染时会**再**夹紧到 0.5–4（= 一栏放得下的上限，见前端注释）：
/// 两个区间不同是有意的，解析侧只负责书的意图。
pub fn clamp_size_em(value: f32) -> Option<f32> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    Some(value.clamp(MIN_SIZE_EM, MAX_SIZE_EM))
}

/// CSS 关键字字号 → 倍率（以浏览器实际渲染的 px 比值折算：`medium`=16px，
/// `small`≈13px→0.8、`x-small`≈10px→0.6、`large`≈19px→1.2、
/// `x-large`≈24px→1.5、`xx-large`≈32px→2.0）。
pub(crate) fn named_font_size(name: &str) -> Option<f32> {
    let factor = match name.to_ascii_lowercase().as_str() {
        "xx-small" => 0.5,
        "x-small" => 0.6,
        "small" => 0.8,
        "medium" => 1.0,
        "large" => 1.2,
        "x-large" => 1.5,
        "xx-large" => 2.0,
        "xxx-large" => 3.0,
        // `smaller` / `larger` 是**相对父级**的缩放（CSS 定义为 0.8 / 1.2 倍）。
        "smaller" => 0.8,
        "larger" => 1.2,
        _ => return None,
    };
    clamp_size_em(factor)
}

/// `font-size` 声明 → 倍率（相对正文基准）；认不出来 `None`。
///
/// 支持 `em` / `rem` / `%`（相对父级）与 `pt` / `px` / `pc`（绝对，按 `16px = 1em`
/// 折算：`96px = 1in = 72pt`），以及关键字（`small` / `x-small` / `large` …）。
/// `ex` / `ch` / `vw` / `vh` 这类依赖字体度量或视口的单位**不猜**（返回 `None`）。
pub fn parse_font_size(value: &str) -> Option<f32> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Some(number) = value.strip_suffix('%') {
        return number
            .trim()
            .parse::<f32>()
            .ok()
            .and_then(|v| clamp_size_em(v / 100.0));
    }
    let lower = value.to_ascii_lowercase();
    // 长后缀先匹配（`rem` 必须排在 `em` 前面，否则 `1rem` 会被当成 `1r` + `em`）。
    for (suffix, scale) in [
        ("rem", 1.0f32),
        ("em", 1.0),
        ("pt", 96.0 / 72.0 / PX_PER_EM),
        ("px", 1.0 / PX_PER_EM),
        // `1pc = 12pt = 16px`。
        ("pc", 16.0 / PX_PER_EM),
    ] {
        if let Some(number) = lower.strip_suffix(suffix) {
            let parsed = number.trim().parse::<f32>().ok()?;
            return clamp_size_em(parsed * scale);
        }
    }
    named_font_size(&lower)
}

// ==================== `style` 属性 → 行内属性 ====================

/// 一条 CSS 声明（属性名小写、值去掉 `!important` 与首尾空白）。
///
/// 只做"分号切分 + 第一个冒号切分"——**不实现 CSS 级联**。`var()` / `url(data:…;…)`
/// 里的分号在 `style` 属性里不会出现；真遇到也只会让那一条解析失败（`None`），
/// 不会污染别的声明。
fn declarations(style: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for declaration in style.split(';') {
        let Some((name, value)) = declaration.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim().trim_end_matches("!important").trim();
        if name.is_empty() || value.is_empty() {
            continue;
        }
        out.push((name, value.to_string()));
    }
    out
}

/// `<mark>` 未声明底色时的**浏览器默认黄**。
///
/// HTML 的 `mark` 默认就是黄底黑字；koodo 的默认 CSS 只改了**选中**高亮
/// （`::selection{background:#f3a6a68c}`），正文 `mark` 走浏览器默认。
/// 这里显式给出，免得上游（前端）各自猜一种黄。
pub(crate) const MARK_DEFAULT_BG: &str = "#ffff00";

/// 从 `style` 属性提取**样式标记**（`font-style` / `font-weight` /
/// `text-decoration` / `font-variant`）与**行内属性**（颜色 / 底色 / 字号）。
///
/// 取舍：
/// - `font-weight` 只在 `bold` / `bolder` / `>=600` 时出 [`SpanStyle::Strong`]；
///   `normal` / `400` 是默认值，标出来只会让"加粗"到处都是；
/// - `text-decoration` 里出现 `underline` 就出 [`SpanStyle::Underline`]、
///   `line-through` 就出 [`SpanStyle::Strikethrough`]（一条声明可以两个都有）；
/// - `text-transform`（`uppercase` / `lowercase` / `capitalize`）**不做文本改写**：
///   那是文案变换，会改变可搜索 / 可复制的原文。这里有意不产出任何字段，
///   交给前端的排版层去决定要不要显示成大写；
/// - `font-size` 是**相对本条**的倍率，调用方再与父级相乘。
pub(crate) fn inline_styles_from_style(style: &str) -> (Vec<SpanStyle>, InlineExtras) {
    let mut styles = Vec::new();
    let mut extras = InlineExtras::NONE;
    for (name, value) in declarations(style) {
        let lower = value.to_ascii_lowercase();
        match name.as_str() {
            "font-style" => {
                if lower == "italic" || lower == "oblique" {
                    styles.push(SpanStyle::Emphasis);
                }
            }
            "font-weight" => {
                let numeric = lower.parse::<u16>().ok();
                if lower == "bold" || lower == "bolder" || numeric.is_some_and(|w| w >= 600) {
                    styles.push(SpanStyle::Strong);
                }
            }
            "font-variant" | "font-variant-caps" => {
                if lower.contains("small-caps") {
                    styles.push(SpanStyle::SmallCaps);
                }
            }
            "text-decoration" | "text-decoration-line" => {
                if lower.contains("underline") {
                    styles.push(SpanStyle::Underline);
                }
                if lower.contains("line-through") {
                    styles.push(SpanStyle::Strikethrough);
                }
            }
            "font-size" => extras.size = parse_font_size(&value),
            "color" => extras.color = parse_css_color(&value),
            "background-color" | "background" => extras.bg = parse_css_color(&value),
            // 其余（margin / text-align / line-height …）**不进块模型**：
            // 版面属性由前端的阅读设置统一决定，正文只携带内容自身的属性。
            _ => {}
        }
    }
    (styles, extras)
}

// ==================== 注释分类 ====================

/// 注释容器的 class 名判据，见 [`comment_label`]。
///
/// 据 koodo-reader 的默认 CSS：`aside[epub\:type=footnote|note|endnote|rearnote]` 被
/// `font-size:0` 折叠、`aside[type=sidebar]` / `aside[epub\:type=sidebar]` 给淡蓝底——
/// 两类都是"正文之外的注解内容"。
const COMMENT_CLASS_HINTS: [&str; 5] = ["footnote", "note", "annotation", "endnote", "sidebar"];
/// `epub:type` 里属于"注释"的值（EPUB3 的结构语义词汇表）。
const COMMENT_EPUB_TYPES: [&str; 5] = ["footnote", "endnote", "rearnote", "note", "sidebar"];
/// `role` 里属于"注释"的值（DPUB-ARIA）。
const COMMENT_ROLES: [&str; 3] = ["doc-footnote", "doc-endnote", "doc-noteref"];

/// 一个标签的 `class` / `epub:type` / `role` 属性值（都小写、空格分隔的多值）。
fn attr_list(tag: &str, name: &str) -> Vec<String> {
    attr_value(tag, name)
        .unwrap_or_default()
        .split_whitespace()
        .map(|s| s.to_ascii_lowercase())
        .collect()
}

/// 判断一个标签是否是**注释容器**，并给出可识别的标签名。
///
/// 判据（与 koodo 的默认 CSS 对齐，见模块文档）：
/// - `epub:type` ∈ {footnote, endnote, rearnote, note, sidebar}（EPUB3 语义），或
/// - `role` ∈ {doc-footnote, doc-endnote, doc-noteref}（DPUB-ARIA），或
/// - `class` 含 `footnote` / `note` / `annotation` / `endnote` / `sidebar`，或
/// - 标签就是 `aside`（HTML5 的旁注元素）。
///
/// 返回 `Some(label)` 表示"是注释容器"，其中 `label` 优先取 `epub:type` 的值，
/// 其次 `role`、再次命中的 class；裸 `<aside>` 没有可识别的名字 → `Some(None)`。
/// 返回 `None` 表示**不是**注释容器。
pub(crate) fn comment_label(name: &str, tag: &str) -> Option<Option<String>> {
    for candidate in attr_list(tag, "epub:type") {
        if COMMENT_EPUB_TYPES.contains(&candidate.as_str()) {
            return Some(Some(candidate));
        }
    }
    for candidate in attr_list(tag, "role") {
        if COMMENT_ROLES.contains(&candidate.as_str()) {
            return Some(Some(candidate));
        }
    }
    for candidate in attr_list(tag, "class") {
        if COMMENT_CLASS_HINTS.contains(&candidate.as_str()) {
            return Some(Some(candidate));
        }
    }
    (name == "aside").then_some(None)
}

// ==================== 整页图片判定 ====================

/// 判断一个标签是否声明了"这张图应当**独占一页**"（`full_page`）。
///
/// 判据（任一条命中即为 `true`）：
/// 1. `class` / `id` / `epub:type` 里出现 `fullpage` / `full-page` / `imagepage` /
///    `image-page` / `fullsize` / `full-size` / `coverpage` / `cover-page`；
/// 2. 上述属性里有独立的 `cover` 记号（`class="cover"` / `epub:type="cover"`）；
/// 3. 内联 `style` 的高度 ≥ 90%（`height:100%` / `height:95vh`）。
///
/// 为什么 90% 而不是 100%：封面图常写 `height:95%`，留 10% 宽容度才不会把
/// "作者本意就是整页"的图漏成普通插图。`px` / `em` 等**不折算**——那要看窗口大小，
/// `height:600px` 是不是整页无法从标签判断（返回 `false` 而不是猜）。
pub(crate) fn is_full_page_image(attrs: &str) -> bool {
    let haystack = [
        attr_value(attrs, "class").unwrap_or_default(),
        attr_value(attrs, "id").unwrap_or_default(),
        attr_value(attrs, "epub:type").unwrap_or_default(),
    ]
    .join(" ")
    .to_ascii_lowercase();
    for hint in [
        "fullpage",
        "full-page",
        "imagepage",
        "image-page",
        "fullsize",
        "full-size",
        "coverpage",
        "cover-page",
    ] {
        if haystack.contains(hint) {
            return true;
        }
    }
    if haystack
        .split(|c: char| c.is_whitespace() || c == '-' || c == '_')
        .any(|token| token == "cover")
    {
        return true;
    }
    style_height_percent(&attr_value(attrs, "style").unwrap_or_default())
        .is_some_and(|percent| percent >= 90.0)
}

/// 从 `style` 取**高度**的占比（`height:100%` / `height: 95vh`）；折算不了返回 `None`。
///
/// 只认 `%` 与 `vh`（`1vh` 就是视口高度的 1%，等价于"占比"）：
/// `em` / `px` / `pt` / 无单位都取决于上下文，不猜。
fn style_height_percent(style: &str) -> Option<f32> {
    for declaration in style.split(';') {
        let Some((name, value)) = declaration.split_once(':') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("height") {
            continue;
        }
        let value = value
            .trim()
            .trim_end_matches("!important")
            .trim()
            .to_ascii_lowercase();
        if let Some(number) = value.strip_suffix("vh") {
            return number.trim().parse::<f32>().ok();
        }
        if let Some(number) = value.strip_suffix('%') {
            return number.trim().parse::<f32>().ok();
        }
    }
    None
}

// ==================== 显式换页识别 ====================

/// **显式换页**的判据：一个标签是否声明了"从这里另起一页"。
///
/// 据 koodo-reader 的实测口径（`src/assets/lib/kookit.min.js`，dev，2026-10-18）：
/// 它在加载 EPUB 自带 CSS 时把 `page-break-(before|after|inside)` **改写成
/// `-webkit-column-break-*`**
/// （`replace(/-epub-/gi,"")` + `replace(/page-break-(after|before|inside)/gi,(_,x)=>`-webkit-column-break-${x}`)`），
/// 因为它的分页就是 **CSS 多栏**（`handleLayout` 给 `documentElement` 设
/// `column-width` / `column-gap` / `column-fill:auto`）。
/// 作者写的 `page-break-before` 想表达的正是"新起一栏 / 一页"。
///
/// 本判据只认 **before**（`always` / `page` / `left` / `right`）与
/// `epub:type="pagebreak"` / `class="pagebreak"`：
/// `page-break-after` 是"本元素之后断"，在语料里几乎都是版面微调，只认 before
/// 更不容易误伤（宁可少断，也不要把正文切成两半）。
///
/// **图片不在此列**（2026-10-18 需求 5 核查结论）：koodo 对整页图用的是整页容器 +
/// `object-fit:contain`，**没有任何分页符机制**，因此"图片另起一页"由前端按
/// `Figure.full_page` 排版，解析侧不合成换页块。
pub(crate) fn is_page_break_tag(tag: &str) -> bool {
    let epub_type = attr_value(tag, "epub:type")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if epub_type
        .split_whitespace()
        .any(|token| token == "pagebreak" || token == "page-break")
    {
        return true;
    }
    let class = attr_value(tag, "class")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if class
        .split_whitespace()
        .any(|token| token == "pagebreak" || token == "page-break")
    {
        return true;
    }
    let style = attr_value(tag, "style")
        .unwrap_or_default()
        .to_ascii_lowercase();
    for declaration in style.split(';') {
        let Some((name, value)) = declaration.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name != "page-break-before" && name != "break-before" {
            continue;
        }
        let value = value.trim();
        if matches!(value, "always" | "page" | "left" | "right") {
            return true;
        }
    }
    false
}

/// 去掉一段 XHTML 里的**全部标签**、只留可见文字。
///
/// 用于"没有 `<figcaption>` 时从 `<figure>` 内文里捡图注"。
/// `script` / `style` / `head` 的内容一并丢弃（它们不是正文）。
pub(crate) fn strip_tags(inner: &str) -> String {
    let mut out = String::new();
    let mut skip_depth = 0usize;
    let mut at = 0usize;
    while let Some(lt) = inner[at..].find('<') {
        let start = at + lt;
        if skip_depth == 0 {
            out.push_str(&inner[at..start]);
        }
        let Some(gt) = inner[start..].find('>') else {
            break;
        };
        let tag_end = start + gt + 1;
        let tag = &inner[start..tag_end];
        at = tag_end;
        if tag.starts_with("<!--") || tag.starts_with("<!") || tag.starts_with("<?") {
            continue;
        }
        let name = crate::inline::local_name(tag);
        if ["script", "style", "head"].contains(&name.as_str()) {
            if tag.starts_with("</") {
                skip_depth = skip_depth.saturating_sub(1);
            } else if !tag.trim_end().ends_with("/>") {
                skip_depth += 1;
            }
        }
    }
    if skip_depth == 0 && at < inner.len() {
        out.push_str(&inner[at..]);
    }
    out
}

// ==================== `<figure>` 内文的纯解析助手 ====================

/// 取 `h1`–`h6` 的层级；不是标题标签返回 `None`。
pub(crate) fn heading_level(name: &str) -> Option<u8> {
    let rest = name.strip_prefix('h')?;
    let digit = rest.parse::<u8>().ok()?;
    (1..=6).contains(&digit).then_some(digit)
}

/// 取图片地址：`<img src>` 与 SVG 的 `<image xlink:href>` / `href` 都要认。
pub(crate) fn image_ref(tag: &str) -> Option<String> {
    for attr in ["src", "href", "xlink:href"] {
        if let Some(v) = attr_value(tag, attr)
            && !v.is_empty()
        {
            return Some(v);
        }
    }
    // 兜底：任何以 `:href` 结尾的属性（不同前缀写法）。
    let mut rest = tag;
    while let Some(at) = rest.find('=') {
        let name = rest[..at]
            .rsplit(|c: char| c.is_whitespace() || c == '<' || c == '/')
            .next()
            .unwrap_or("");
        if name.to_ascii_lowercase().ends_with(":href") {
            let after = rest[at + 1..].trim_start();
            let quote = after.chars().next()?;
            if quote == '"' || quote == '\'' {
                let body = &after[1..];
                if let Some(end) = body.find(quote) {
                    let v = decode_entities(&body[..end]);
                    if !v.is_empty() {
                        return Some(v);
                    }
                }
            }
        }
        rest = &rest[at + 1..];
    }
    None
}

/// 收尾裁剪：`PageBreak` 只在**后面还有正文块**时留下。
///
/// 三条规则（2026-10-18 Lead 的集成决策）：
/// 1. **开头的** `PageBreak` 不产出——首块换页没有意义，只会变成页首空白；
/// 2. **末尾的** `PageBreak` 不产出——那必然变成页尾空白；
/// 3. 同一位置**连续**的多个 `PageBreak` 只留一个。
///
/// 章节之间的换页**不**走这条路：那由前端按 `BookContentResult.section > 0` 完成。
pub(crate) fn trim_page_breaks(blocks: &mut Vec<BookBlock>) {
    let mut cleaned: Vec<BookBlock> = Vec::with_capacity(blocks.len());
    for block in blocks.drain(..) {
        if !matches!(block, BookBlock::PageBreak) {
            cleaned.push(block);
            continue;
        }
        if cleaned.is_empty() || matches!(cleaned.last(), Some(BookBlock::PageBreak)) {
            continue;
        }
        cleaned.push(block);
    }
    if matches!(cleaned.last(), Some(BookBlock::PageBreak)) {
        cleaned.pop();
    }
    *blocks = cleaned;
}

/// `inner` 里第一个 `<img>` / `<image>` 的**开标签**原文。
pub(crate) fn first_image_tag(inner: &str) -> Option<&str> {
    let mut at = 0usize;
    while let Some(lt) = inner[at..].find('<') {
        let start = at + lt;
        let gt = inner[start..].find('>')?;
        let tag_end = start + gt + 1;
        let tag = &inner[start..tag_end];
        at = tag_end;
        if tag.starts_with("<!--") || tag.starts_with("<!") || tag.starts_with("<?") {
            continue;
        }
        let name = crate::inline::local_name(tag);
        if (name == "img" || name == "image") && !tag.starts_with("</") {
            return Some(tag);
        }
    }
    None
}

/// `<figure>` 内文里 `<figcaption>` 的**内文**（取第一个；没有则 `None`）。
pub(crate) fn figcaption_inner(inner: &str) -> Option<String> {
    let mut at = 0usize;
    while let Some(lt) = inner[at..].find('<') {
        let start = at + lt;
        let gt = inner[start..].find('>')?;
        let tag_end = start + gt + 1;
        let tag = &inner[start..tag_end];
        at = tag_end;
        if crate::inline::local_name(tag) != "figcaption" || tag.starts_with("</") {
            continue;
        }
        return element_inner_balanced(inner, tag_end, "figcaption").map(|(text, _)| text);
    }
    None
}

/// 从 `<figure>` 内文里取"除图片之外"的可见文字片段（无 `figcaption` 的书用）。
///
/// 有些书直接写 `<figure><img/><p>注</p></figure>`：图注藏在 `figure` 的普通文字里。
pub(crate) fn caption_from_visible_text(inner: &str) -> Vec<crate::block::BookSpan> {
    let mut spans: Vec<crate::block::BookSpan> = Vec::new();
    let mut text_chunk = String::new();
    let mut at = 0usize;
    while let Some(lt) = inner[at..].find('<') {
        let start = at + lt;
        text_chunk.push_str(&inner[at..start]);
        let Some(gt) = inner[start..].find('>') else {
            break;
        };
        let tag_end = start + gt + 1;
        let tag = &inner[start..tag_end];
        at = tag_end;
        if tag.starts_with("<!--") || tag.starts_with("<!") || tag.starts_with("<?") {
            continue;
        }
        let name = crate::inline::local_name(tag);
        if (name == "img" || name == "image") && !tag.starts_with("</") {
            // 图片本身不是文字：先把已攒的文字落定，再跳过图片。
            spans.extend(crate::inline::spans_from_html(&text_chunk, false));
            text_chunk.clear();
        }
    }
    text_chunk.push_str(&inner[at..]);
    spans.extend(crate::inline::spans_from_html(&text_chunk, false));
    spans
}

/// 取某元素的开标签之后、**配对的**结束标签之前的原始内文，
/// 返回 `(内文, 结束标签之后的下标)`。
///
/// 与 `epub_text::element_inner_text` 的区别：本函数**记账同名标签的嵌套深度**，
/// 因此 `<aside><div><p>x</p></div></aside>` 不会在第一个 `</div>` 处被截断。
/// 注释 / `figure` 这类容器必须用它（它们内部常见嵌套的 `div` / `p`）。
pub(crate) fn element_inner_balanced(
    xhtml: &str,
    from: usize,
    name: &str,
) -> Option<(String, usize)> {
    let mut depth = 1usize;
    let mut at = from;
    while let Some(lt) = xhtml[at..].find('<') {
        let start = at + lt;
        let gt = xhtml[start..].find('>')?;
        let tag_end = start + gt + 1;
        let tag = &xhtml[start..tag_end];
        at = tag_end;
        if tag.starts_with("<!--") || tag.starts_with("<!") || tag.starts_with("<?") {
            continue;
        }
        if crate::inline::local_name(tag) != name {
            continue;
        }
        if tag.starts_with("</") {
            depth -= 1;
            if depth == 0 {
                return Some((xhtml[from..start].to_string(), tag_end));
            }
        } else if !tag.trim_end().ends_with("/>") {
            depth += 1;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 颜色 ----

    #[test]
    fn css_colors_are_normalized() {
        assert_eq!(parse_css_color("#abc").as_deref(), Some("#aabbcc"));
        assert_eq!(parse_css_color("#AABBCC").as_deref(), Some("#aabbcc"));
        assert_eq!(parse_css_color("#11223344").as_deref(), Some("#112233"));
        assert_eq!(
            parse_css_color("rgb(255, 0, 128)").as_deref(),
            Some("#ff0080")
        );
        assert_eq!(
            parse_css_color("rgba(1,2,3,0.5)").as_deref(),
            Some("#010203")
        );
        assert_eq!(parse_css_color("red").as_deref(), Some("#ff0000"));
        assert_eq!(parse_css_color("  WHITE  ").as_deref(), Some("#ffffff"));
        assert_eq!(
            parse_css_color("rgb(100% 0% 50%)").as_deref(),
            Some("#ff0080")
        );
    }

    #[test]
    fn unparsable_colors_are_none_not_garbage() {
        // 认不出来必须是 `None`：绝不产出 `#12`、`#xyz` 这类前端无法渲染的值。
        for bad in [
            "",
            "#12",
            "#12345",
            "#gggggg",
            "rgb(1,2)",
            "rgb(a,b,c)",
            "currentColor",
            "inherit",
            "var(--x)",
            "not-a-color",
            "transparent",
        ] {
            assert_eq!(parse_css_color(bad), None, "「{bad}」不该被解析成颜色");
        }
        assert_eq!(parse_css_color("rgb(300,0,0)"), None, "越界分量不得夹紧");
    }

    // ---- 字号 ----

    #[test]
    fn font_sizes_are_folded_to_ratios() {
        assert_eq!(parse_font_size("1.5em"), clamp_size_em(1.5));
        assert_eq!(parse_font_size("150%"), clamp_size_em(1.5));
        assert_eq!(parse_font_size("24px"), clamp_size_em(1.5));
        assert_eq!(
            parse_font_size("9pt"),
            clamp_size_em(0.75),
            "9pt = 12px = 0.75em"
        );
        assert_eq!(parse_font_size("large"), clamp_size_em(1.2));
        assert_eq!(parse_font_size("small"), clamp_size_em(0.8));
        assert_eq!(parse_font_size("x-small"), clamp_size_em(0.6));
        assert_eq!(parse_font_size("1rem"), clamp_size_em(1.0));
        // 夹紧：0 与非有限值都不产出垃圾值。
        assert_eq!(parse_font_size("0"), None);
        assert_eq!(parse_font_size("0em"), None);
        assert_eq!(parse_font_size("10em"), Some(MAX_SIZE_EM), "上限夹紧");
        assert_eq!(parse_font_size("0.1em"), Some(MIN_SIZE_EM), "下限夹紧");
        assert_eq!(parse_font_size("2vw"), None, "依赖视口的单位不猜");
        assert_eq!(parse_font_size("bogus"), None);
    }

    #[test]
    fn style_flags_and_extras_are_extracted() {
        let (styles, extras) = inline_styles_from_style(
            "color:#f00; background-color: yellow; font-size:1.5em; \
             font-style:italic; font-weight:700; text-decoration:underline; \
             font-variant:small-caps",
        );
        assert!(styles.contains(&SpanStyle::Emphasis), "{styles:?}");
        assert!(styles.contains(&SpanStyle::Strong), "{styles:?}");
        assert!(styles.contains(&SpanStyle::Underline), "{styles:?}");
        assert!(styles.contains(&SpanStyle::SmallCaps), "{styles:?}");
        assert_eq!(extras.color.as_deref(), Some("#ff0000"));
        assert_eq!(extras.bg.as_deref(), Some("#ffff00"));
        assert_eq!(extras.size, clamp_size_em(1.5));
    }

    #[test]
    fn normal_weight_is_not_strong() {
        let (styles, _) = inline_styles_from_style("font-weight:400");
        assert!(styles.is_empty(), "默认粗细不该标成加粗：{styles:?}");
    }

    // ---- 注释分类 ----

    #[test]
    fn comment_kinds_are_recognized_with_their_labels() {
        for (name, tag, expect) in [
            ("aside", r#"<aside>"#, Some(None)),
            (
                "aside",
                r#"<aside epub:type="footnote">"#,
                Some(Some("footnote")),
            ),
            (
                "div",
                r#"<div role="doc-footnote">"#,
                Some(Some("doc-footnote")),
            ),
            ("div", r#"<div class="note">"#, Some(Some("note"))),
            (
                "div",
                r#"<div class="annotation">"#,
                Some(Some("annotation")),
            ),
            ("div", r#"<div class="sidebar">"#, Some(Some("sidebar"))),
            ("div", r#"<div class="chapter">"#, None),
            ("p", r#"<p>"#, None),
        ] {
            let got = comment_label(name, tag);
            match (got, expect) {
                (None, None) => {}
                (Some(label), Some(expected)) => {
                    assert_eq!(label.as_deref(), expected, "{tag}");
                }
                (got, expect) => panic!("「{tag}」分类不符：{got:?} vs {expect:?}"),
            }
        }
    }

    // ---- 整页图片 ----

    #[test]
    fn full_page_detection_covers_the_declared_shapes() {
        for hit in [
            r#"<img src="i.png" class="fullpage"/>"#,
            r#"<img src="i.png" class="full-page"/>"#,
            r#"<img src="i.png" class="imagepage"/>"#,
            r#"<img src="i.png" class="fullsize"/>"#,
            r#"<img src="i.png" epub:type="cover"/>"#,
            r#"<div class="cover"><img src="i.png"/></div>"#,
            r#"<img src="i.png" style="height:100%"/>"#,
            r#"<img src="i.png" style="height: 95vh"/>"#,
            r#"<figure class="coverpage"><img src="i.png"/></figure>"#,
        ] {
            assert!(is_full_page_image(hit), "「{hit}」应判为整页图");
        }
        for miss in [
            r#"<img src="i.png"/>"#,
            r#"<img src="i.png" class="illustration"/>"#,
            r#"<img src="i.png" style="height:50%"/>"#,
            r#"<img src="i.png" style="width:100%"/>"#,
            r#"<img src="i.png" style="height:600px"/>"#,
        ] {
            assert!(!is_full_page_image(miss), "「{miss}」不该判为整页图");
        }
    }

    // ---- 换页 ----

    #[test]
    fn page_break_variants_are_recognized() {
        for tag in [
            r#"<div style="page-break-before:always"></div>"#,
            r#"<div style="page-break-before: page"></div>"#,
            r#"<div style="break-before: page"></div>"#,
            r#"<div epub:type="pagebreak"></div>"#,
            r#"<hr class="pagebreak"/>"#,
        ] {
            assert!(is_page_break_tag(tag), "「{tag}」应识别为换页");
        }
        for tag in [
            r#"<div style="page-break-before:auto"></div>"#,
            r#"<div style="page-break-after:always"></div>"#,
            r#"<div class="break"></div>"#,
            // 图片**不**是换页声明（需求 5 的核查结论：koodo 无分页符机制）。
            r#"<img src="i.png" class="fullpage"/>"#,
            r#"<figure class="cover"><img src="i.png"/></figure>"#,
        ] {
            assert!(!is_page_break_tag(tag), "「{tag}」不该识别为换页");
        }
    }

    #[test]
    fn strip_tags_keeps_only_visible_text() {
        assert_eq!(strip_tags("<p>甲</p><script>坏</script><p>乙</p>"), "甲乙");
        assert_eq!(strip_tags("<b>粗</b>体"), "粗体");
    }
}
