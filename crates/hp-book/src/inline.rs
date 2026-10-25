//! 行内内容的累积与 **HTML 片段**扫描（EPUB 与 Markdown 共用）。
//!
//! ## 为什么单独成模块
//!
//! `block.rs` 是**纯数据模型**（块与片段的形状），本模块是**解析工具**
//! （把一段标记文字变成 [`BookSpan`]）。两者被三种输入共用：
//! EPUB 的标题内文、EPUB 正文的行内标签、Markdown 里的**原始 HTML**。
//!
//! 放在一起的代价是"数据模型"会依赖 `xml` 的实体解码；分开之后
//! `block.rs` 保持零依赖，模型可以被任何解析器复用。
//!
//! ## 安全边界
//!
//! 本模块**只产出纯数据**：它把 HTML 过一遍受控白名单，丢弃标签、保留文字，
//! `<script>` / `<style>` / `<head>` 的内容整段丢弃。它**不产出 HTML 字符串**，
//! 因此调用方没有任何"把 HTML 塞给前端"的机会（见 `block.rs` 的模块文档）。
//!
//! ## "彩色文字"从哪来（koodo-reader 实测口径，2026-10-18）
//!
//! koodo-reader 读 EPUB 时**不改写正文标签**：它把章节 XHTML 的
//! `documentElement.innerHTML` 直接灌进 iframe（`EpubRender` /
//! `handleOneChapterDoc`，`src/assets/lib/kookit.min.js`），作者的 CSS 与内联
//! `style` 原样生效，`StyleHelper.getDefaultCss` 只再叠一层"用户字号/行高/字色 +
//! 标题 1.25em"的默认样式。
//!
//! 也就是说：**彩色文字、加粗、划线、高亮、注音在 koodo 里靠正文自身的内联
//! `style` 与标签生效**。本项目不能把 HTML 交给前端（见 `block` 模块的安全边界），
//! 所以这里把同一批内联声明**读出来**，落成 [`BookSpan`] 的结构化字段
//! （`color` / `bg` / `size_em`）与 [`SpanStyle`] 标记——信息量等价，
//! 但前端拿到的仍是纯数据。纯解析（颜色 / 字号 / 样式标记）在
//! [`crate::epub_rich`]，本模块只负责"扫描标签 + 折叠空白 + 维护状态"。

use crate::block::{BookSpan, SpanStyle, normalize_styles};
use crate::epub_rich::{InlineExtras, MARK_DEFAULT_BG, clamp_size_em, inline_styles_from_style};
use crate::xml::{attr_value, decode_entities};

// ==================== 行内累积（原始 run → 折叠后的片段）====================

/// **行内换行**的标记字符（`<br>` 与 Markdown 的硬换行）。
///
/// 用一个不可能出现在正文里的控制字符做标记：源码里的原始换行是**排版空白**，
/// 只有显式换行才是语义上的换行。两者必须在折叠时区分开，否则 XHTML 的缩进
/// 会被当成正文里的换行（实测：Re:Zero 的章节源码每个 `<p>` 之间都有换行与缩进）。
pub(crate) const LINE_BREAK_MARKER: char = '\u{1}';

/// 注音（`<rt>`）的字号倍率：koodo 用 `rt{user-select:none}` + 浏览器默认
/// `ruby-position` 让注音叠在汉字上方，默认渲染就是"小字"；这里显式给 0.6，
/// 免得上标样式在缺省字号下看起来跟正文一样大。
pub(crate) const RUBY_NOTE_SIZE_EM: f32 = 0.6;

/// 一个**已定稿的行片段**：文字 run（参与空白折叠与合并）或**原子片段**
/// （图片 / 注音：不参与合并，顺序即出现顺序）。
///
/// 它是 [`collapse_runs`] 的输入，因此必须是 `pub(crate)`（否则 `collapse_runs`
/// 的签名会暴露一个比它更私有的类型）。
pub(crate) enum Run {
    Text {
        text: String,
        styles: Vec<SpanStyle>,
        href: Option<String>,
        color: Option<String>,
        bg: Option<String>,
        size_em: Option<f32>,
    },
    Atomic(BookSpan),
}

/// 把字符追加到 `out` 的末尾片段；样式 / 链接 / 图片身份 / 行内属性不同则另起一段。
///
/// **图片片段不参与合并**：否则图片之后的文字会被并进图片片段里，
/// 渲染器会把那段文字当成图片的 alt 文本。
fn push_char(
    out: &mut Vec<BookSpan>,
    ch: char,
    styles: &[SpanStyle],
    href: Option<&str>,
    color: &Option<String>,
    bg: &Option<String>,
    size_em: Option<f32>,
) {
    if let Some(last) = out.last_mut()
        && last.image.is_none()
        && last.styles == styles
        && last.href.as_deref() == href
        && last.color == *color
        && last.bg == *bg
        && last.size_em.map(f32::to_bits) == size_em.map(f32::to_bits)
    {
        last.text.push(ch);
        return;
    }
    out.push(BookSpan {
        text: ch.to_string(),
        styles: styles.to_vec(),
        href: href.map(|s| s.to_string()),
        image: None,
        color: color.clone(),
        bg: bg.clone(),
        size_em,
    });
}

/// 末尾是否是"可被空白折叠丢掉"的片段（**图片不算**）。
///
/// 图片片段没有 `alt` 时 `text` 是空串，但它本身是内容。实测抓到的洞
/// （2026-10-18）：把图片与文字并进同一条输出链后，尾部裁剪会因为"alt 为空"
/// 把整张图删掉——链接里的图片尤其明显。
fn tail_is_droppable(out: &[BookSpan]) -> bool {
    out.last().is_some_and(|s| s.image.is_none())
}

/// 丢掉末尾的空片段（折叠后可能只剩空白）；图片片段一概保留。
fn trim_end_spans(out: &mut Vec<BookSpan>) {
    while tail_is_droppable(out) {
        let Some(last) = out.last_mut() else { break };
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
}

/// 把"文字 + 当前样式"攒成一段段原始 run，最后统一折叠成 [`BookSpan`]。
///
/// **为什么先攒再折叠**：空白折叠必须**跨 run** 进行——`a <b>b</b> c` 里
/// "a " 的尾随空格与 " c" 的前导空格都参与"折叠成单个空格"的判定，
/// 各自独立折叠会把词间空格吃掉（变成 `ab c`）。
#[derive(Default)]
pub(crate) struct RunBuilder {
    runs: Vec<Run>,
    /// 当前生效的颜色 / 底色（由 [`InlineState`] 维护，`None` = 无声明）。
    color: Option<String>,
    bg: Option<String>,
    /// 当前生效的**字号倍率**（各级 `font-size` 相乘并夹紧后的结果）。
    size_em: Option<f32>,
}

impl RunBuilder {
    pub(crate) fn new() -> Self {
        RunBuilder::default()
    }

    /// 更新**当前生效**的行内属性（不触碰已攒下的 run）。
    ///
    /// 解析器每次压栈 / 出栈后调用：属性变了之后的文字必须另起一段，
    /// 否则颜色 / 字号会蔓延到不该有的文字上。
    pub(crate) fn set_state(
        &mut self,
        color: Option<String>,
        bg: Option<String>,
        size_em: Option<f32>,
    ) {
        self.color = color;
        self.bg = bg;
        self.size_em = size_em;
    }

    /// 追加一段文字（沿用当前行内属性）；样式 / 链接 / 属性都相同的相邻文字并进同一 run。
    pub(crate) fn push(&mut self, text: &str, styles: &[SpanStyle], href: Option<&str>) {
        if text.is_empty() {
            return;
        }
        let href = href.map(|s| s.to_string());
        if let Some(Run::Text {
            text: last_text,
            styles: last_styles,
            href: last_href,
            color,
            bg,
            size_em,
        }) = self.runs.last_mut()
            && last_styles == styles
            && *last_href == href
            && *color == self.color
            && *bg == self.bg
            && size_em.map(f32::to_bits) == self.size_em.map(f32::to_bits)
        {
            last_text.push_str(text);
            return;
        }
        self.runs.push(Run::Text {
            text: text.to_string(),
            styles: styles.to_vec(),
            href,
            color: self.color.clone(),
            bg: self.bg.clone(),
            size_em: self.size_em,
        });
    }

    /// 追加一个**原子片段**（图片 / 注音）：不参与文字合并与空白折叠。
    pub(crate) fn push_atomic(&mut self, span: BookSpan) {
        self.runs.push(Run::Atomic(span));
    }

    /// 折叠空白并产出最终的行内片段。
    pub(crate) fn into_spans(self) -> Vec<BookSpan> {
        collapse_runs(&self.runs)
    }
}

/// 折叠空白：**原始空白（含换行）一律压成单个空格**，换行标记变成真正的换行。
///
/// 折叠**跨 run** 进行（见 [`RunBuilder`]），因此词间空格不会被样式边界吃掉。
pub(crate) fn collapse_runs(runs: &[Run]) -> Vec<BookSpan> {
    let mut out: Vec<BookSpan> = Vec::new();
    let mut last_space = false;
    for run in runs {
        let Run::Text {
            text,
            styles,
            href,
            color,
            bg,
            size_em,
        } = run
        else {
            // 原子片段（图片 / 注音）原样保留：它的 `text` 是 alt 或注音，
            // 不该被空白折叠改写，也必须保住自己的身份与顺序。
            if let Run::Atomic(span) = run {
                out.push(span.clone());
            }
            last_space = false;
            continue;
        };
        for ch in text.chars() {
            if ch == LINE_BREAK_MARKER {
                // 换行前把行尾空格去掉；连续标记不重复（图片片段不参与裁剪）。
                while tail_is_droppable(&out) {
                    let Some(last) = out.last_mut() else { break };
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
                    push_char(&mut out, '\n', styles, href.as_deref(), color, bg, *size_em);
                }
                last_space = false;
                continue;
            }
            if ch.is_whitespace() {
                let ends_nl = out.last().is_some_and(|s| s.text.ends_with('\n'));
                if !last_space && !out.is_empty() && !ends_nl {
                    push_char(&mut out, ' ', styles, href.as_deref(), color, bg, *size_em);
                }
                last_space = true;
                continue;
            }
            push_char(&mut out, ch, styles, href.as_deref(), color, bg, *size_em);
            last_space = false;
        }
    }
    trim_end_spans(&mut out);
    out
}

/// 解析一段纯文字（**无标记**）→ 行内片段（折叠空白）。
///
/// 保留给"纯文本解析器"复用（`text` / 将来的 `fb2`）；当前没有调用点，
/// 因此只在测试构建里存在。
#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn spans_from_plain_text(text: &str) -> Vec<BookSpan> {
    let mut builder = RunBuilder::new();
    builder.push(text, &[], None);
    builder.into_spans()
}

/// 标签名（小写、去命名空间前缀）：`dc:title` → `title`，`H1` → `h1`。
pub(crate) fn local_name(tag: &str) -> String {
    let raw = tag
        .trim_start_matches('<')
        .trim_start_matches('/')
        .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
        .next()
        .unwrap_or("");
    let tail = raw.rsplit_once(':').map(|(_, t)| t).unwrap_or(raw);
    tail.to_ascii_lowercase()
}

/// 行内标签 → 样式（EPUB 与 Markdown 共用同一套 [`SpanStyle`]）。
///
/// 清单据 EPUB3 的 HTML 语义与 koodo-reader 的默认 CSS 口径取：
/// `getDefaultCss` 给正文/标题补的是字号与颜色，**字形来自正文标签本身**
/// （`b/strong`、`i/em/cite/dfn/var`、`u/ins`、`s/del`、`code/kbd/samp`、
/// `sup/sub`、`mark`）。
/// `small` / `big` **不在这里**：它们是字号语义，由
/// [`parse_font_size`](crate::epub_rich::parse_font_size) 的关键字折算
/// （`small` → 0.8 倍），标成样式反而表达不了"多小"。
pub(crate) fn inline_style(name: &str) -> Option<SpanStyle> {
    match name {
        "b" | "strong" => Some(SpanStyle::Strong),
        "i" | "em" | "cite" | "dfn" | "var" => Some(SpanStyle::Emphasis),
        "code" | "tt" | "kbd" | "samp" => Some(SpanStyle::Code),
        "del" | "s" | "strike" => Some(SpanStyle::Strikethrough),
        "sub" => Some(SpanStyle::Subscript),
        "sup" => Some(SpanStyle::Superscript),
        "mark" => Some(SpanStyle::Highlight),
        "u" | "ins" => Some(SpanStyle::Underline),
        _ => None,
    }
}

/// 需要**整段丢弃内容**的标签（代码与样式不是正文）。
const SKIPPED_CONTENT: [&str; 3] = ["script", "style", "head"];

/// 行内属性层的**颜色**：取**最靠内**那条声明（CSS：最近的祖先赢）。
fn effective_color(layers: &[InlineExtras]) -> Option<String> {
    layers.iter().rev().find_map(|l| l.color.clone())
}

/// 行内属性层的**底色**：同 [`effective_color`]。
fn effective_bg(layers: &[InlineExtras]) -> Option<String> {
    layers.iter().rev().find_map(|l| l.bg.clone())
}

/// 行内属性层的**字号**：各层倍率**相乘**并夹紧。
///
/// 为什么是相乘：CSS 的 `em` / `%` 都相对父级，`2em` 套在 `2em` 里就是 4 倍。
/// 为什么夹紧：见 [`clamp_size_em`]（`font-size:0` 是真存在的写法）。
fn effective_size(layers: &[InlineExtras]) -> Option<f32> {
    let mut product = 1.0f32;
    let mut declared = false;
    for layer in layers {
        if let Some(size) = layer.size {
            product *= size;
            declared = true;
        }
    }
    declared.then(|| clamp_size_em(product)).flatten()
}

/// 行内标签的**状态机**（样式栈 + 链接 + 颜色/字号层 + 注音收集）。
///
/// 为什么做成一个共享结构：EPUB 的正文循环（`epub_text`）与 HTML 片段扫描
/// （[`spans_from_html`]）必须用**同一套**口径处理行内标签。两处各写一套
/// 必然漂移（"标题里有颜色、正文里没有"这类 bug 就是这么来的）。
///
/// 它**只维护状态**，不碰块级结构：块的分段 / 图片 / 换页仍由调用方决定。
#[derive(Default)]
pub(crate) struct InlineState {
    /// 生效中的样式标记（嵌套 → 后进先出）。
    styles: Vec<SpanStyle>,
    /// 当前链接目标。
    href: Option<String>,
    /// 生效中的行内属性层（每层一个 [`InlineExtras`]）。
    layers: Vec<InlineExtras>,
    /// 与 `layers` 一一对应：该层压入的**样式标记**（离开时按层精确弹出，
    /// 而不是"按名字找最近一个"——同种样式嵌套时那会弹错层）。
    layer_marks: Vec<Vec<SpanStyle>>,
    /// `<ruby>` / `<rt>` / `<rp>` 的嵌套深度。
    ruby_depth: usize,
    rt_depth: usize,
    rp_depth: usize,
    /// 当前 `<ruby>` 内**已定稿**的注音片段。
    notes: Vec<BookSpan>,
    /// 正在收集的 `<rt>` 文字。
    note: RunBuilder,
}

impl InlineState {
    pub(crate) fn new() -> Self {
        InlineState::default()
    }

    /// 当前生效的链接目标（图片片段也要带上它：`<a><img/></a>` 是真实写法）。
    pub(crate) fn current_href(&self) -> Option<String> {
        self.href.clone()
    }

    /// 把当前行内属性同步给 [`RunBuilder`]（由调用方在每次压 / 弹栈后触发）。
    fn sync(&self, builder: &mut RunBuilder) {
        builder.set_state(
            effective_color(&self.layers),
            effective_bg(&self.layers),
            effective_size(&self.layers),
        );
    }

    /// 追加一段**正文文字**（自动路由到注音收集器、自动同步行内属性）。
    pub(crate) fn push_text(&mut self, builder: &mut RunBuilder, text: &str) {
        if text.is_empty() {
            return;
        }
        // `<rp>` 是给不支持 ruby 的阅读器的回退括号（`(` / `)`）：丢弃。
        if self.rp_depth > 0 {
            return;
        }
        if self.rt_depth > 0 {
            // 注音单独收集：`0.6em` + 上标（见 [`RUBY_NOTE_SIZE_EM`] 的说明）。
            self.note.set_state(None, None, Some(RUBY_NOTE_SIZE_EM));
            self.note.push(text, &[SpanStyle::Superscript], None);
            return;
        }
        self.sync(builder);
        builder.push(text, &self.styles, self.href.as_deref());
    }

    /// 追加一个**段内换行**标记（`<br>`；见 [`LINE_BREAK_MARKER`]）。
    pub(crate) fn push_break(&mut self, builder: &mut RunBuilder) {
        if self.rt_depth > 0 {
            return;
        }
        self.sync(builder);
        builder.push(
            &LINE_BREAK_MARKER.to_string(),
            &self.styles,
            self.href.as_deref(),
        );
    }

    /// 处理一个**开标签**；返回 `true` 表示它是行内标签、已由本状态机消费。
    pub(crate) fn open(&mut self, name: &str, tag: &str) -> bool {
        match name {
            "a" => {
                self.href = attr_value(tag, "href").filter(|h| !h.is_empty());
                true
            }
            "ruby" => {
                if self.ruby_depth == 0 {
                    self.notes.clear();
                }
                self.ruby_depth += 1;
                true
            }
            "rt" => {
                self.rt_depth += 1;
                if self.rt_depth == 1 {
                    self.note = RunBuilder::new();
                }
                true
            }
            "rp" => {
                self.rp_depth += 1;
                true
            }
            // `div` **不在此列**：它是块级容器，由调用方走 [`InlineState::enter_block`]
            // （见 `close` 的说明）；`font` 是行内标签（`<font color>` 只改颜色）。
            "span" | "font" => {
                let mut declared = attr_value(tag, "style").unwrap_or_default();
                // `<font color="red">` 是上古写法，语料里真有：颜色属性也认。
                if name == "font"
                    && let Some(color) = attr_value(tag, "color").filter(|c| !c.is_empty())
                {
                    declared = format!("{declared}; color: {color}");
                }
                let (marks, extras) = inline_styles_from_style(&declared);
                self.styles.extend(marks.iter().copied());
                self.layer_marks.push(marks);
                self.layers.push(extras);
                true
            }
            "mark" => {
                self.styles.push(SpanStyle::Highlight);
                self.layer_marks.push(vec![SpanStyle::Highlight]);
                self.layers.push(InlineExtras {
                    color: None,
                    bg: Some(MARK_DEFAULT_BG.to_string()),
                    size: None,
                });
                true
            }
            "small" | "big" => {
                // `small` / `big` 是"相对当前字号微调"的标签，按浏览器默认比值
                // （`small` ≈ 0.8、`big` ≈ 1.2）折算，与关键字 `small`/`large` 一致。
                let size = if name == "small" { 0.8 } else { 1.2 };
                self.layer_marks.push(Vec::new());
                self.layers.push(InlineExtras {
                    color: None,
                    bg: None,
                    size: Some(size),
                });
                true
            }
            other => match inline_style(other) {
                Some(style) => {
                    self.styles.push(style);
                    true
                }
                None => false,
            },
        }
    }

    /// 处理一个**结束标签**；返回 `true` 表示已由本状态机消费。
    ///
    /// `builder` 只用于 `</ruby>`：注音片段要按出现顺序插进正文流。
    pub(crate) fn close(&mut self, name: &str, builder: &mut RunBuilder) -> bool {
        match name {
            "a" => {
                self.href = None;
                true
            }
            "ruby" => {
                self.ruby_depth = self.ruby_depth.saturating_sub(1);
                if self.ruby_depth == 0 {
                    // 注音接在汉字之后：`<ruby>漢<rt>kan</rt></ruby>` → 漢 + kan。
                    for note in std::mem::take(&mut self.notes) {
                        builder.push_atomic(note);
                    }
                }
                true
            }
            "rt" => {
                self.rt_depth = self.rt_depth.saturating_sub(1);
                if self.rt_depth == 0 {
                    let spans = std::mem::replace(&mut self.note, RunBuilder::new()).into_spans();
                    self.notes.extend(spans);
                }
                true
            }
            "rp" => {
                self.rp_depth = self.rp_depth.saturating_sub(1);
                true
            }
            // `font` 是**行内**标签（只改颜色）；`div` 是块级容器（见 `enter_block`）。
            "span" | "font" | "mark" | "small" | "big" => {
                let marks = self.layer_marks.pop().unwrap_or_default();
                self.layers.pop();
                for mark in marks {
                    if let Some(pos) = self.styles.iter().rposition(|s| *s == mark) {
                        self.styles.remove(pos);
                    }
                }
                true
            }
            other => match inline_style(other) {
                Some(style) => {
                    if let Some(pos) = self.styles.iter().rposition(|s| *s == style) {
                        self.styles.remove(pos);
                    }
                    true
                }
                None => false,
            },
        }
    }

    /// 进入一个**块级容器**（`<div style="color:red">`）：把它当成一个"远祖先"
    /// 行内属性层。
    ///
    /// 为什么需要：颜色 / 字号写在 `div` / `section` 上在 EPUB 语料里很常见，
    /// 而 `div` 又是块级切段标签——既不能把它丢了（颜色会丢），
    /// 也不能把它当行内层（块级语义会丢）。做法是把它的声明压进层栈、
    /// **不**产生样式标记（块级容器不该让文字变粗体），离开时按层弹出。
    pub(crate) fn enter_block(&mut self, tag: &str) {
        let declared = attr_value(tag, "style").unwrap_or_default();
        let (_, extras) = inline_styles_from_style(&declared);
        self.layer_marks.push(Vec::new());
        self.layers.push(extras);
    }

    /// 离开一个块级容器（与 [`InlineState::enter_block`] 成对；没有对应层则什么都不做）。
    pub(crate) fn leave_block(&mut self) {
        // 只在栈**非空**时弹：标签汤里 `</div>` 可能多于 `<div>`。
        if !self.layers.is_empty() {
            self.layer_marks.pop();
            self.layers.pop();
        }
    }

    /// 收尾：把**未闭合**的注音补进正文流（标签汤也尽量不丢内容）。
    pub(crate) fn finish(&mut self, builder: &mut RunBuilder) {
        if self.rt_depth > 0 {
            self.rt_depth = 0;
            let spans = std::mem::replace(&mut self.note, RunBuilder::new()).into_spans();
            self.notes.extend(spans);
        }
        for note in std::mem::take(&mut self.notes) {
            builder.push_atomic(note);
        }
    }
}

/// 解析一段 **HTML 片段** → 行内片段（受控白名单）。
///
/// 两种用途：
/// - EPUB 的标题内文（`keep_images = false`：图片在块级循环里处理）；
/// - Markdown 里的**原始 HTML**（`keep_images = true`：README 常用
///   `<img src="…">` 插图，丢掉它会让正文缺图）。
///
/// 口径与 EPUB 正文一致：`<script>` / `<style>` / `<head>` 的内容**整段丢弃**，
/// 其余白名单外的标签**丢标签留文字**（不丢正文）。
///
/// `keep_images = true` 时，图片片段的 `image` 字段是**原始 src**（相对路径未解析），
/// 由调用方按自己的上下文解析成可用路径。
pub fn spans_from_html(fragment: &str, keep_images: bool) -> Vec<BookSpan> {
    let mut builder = RunBuilder::new();
    let mut state = InlineState::new();
    let mut skip_depth = 0usize;

    let mut at = 0usize;
    while let Some(lt) = fragment[at..].find('<') {
        let start = at + lt;
        if skip_depth == 0 && start > at {
            state.push_text(&mut builder, &decode_entities(&fragment[at..start]));
        }
        let Some(gt) = fragment[start..].find('>') else {
            if skip_depth == 0 {
                state.push_text(&mut builder, &decode_entities(&fragment[start..]));
            }
            break;
        };
        let tag_end = start + gt + 1;
        let tag = &fragment[start..tag_end];
        at = tag_end;

        if tag.starts_with("<!--") || tag.starts_with("<!") || tag.starts_with("<?") {
            continue;
        }
        let closing = tag.starts_with("</");
        let self_closing = tag.trim_end().ends_with("/>");
        let name = local_name(tag);

        if SKIPPED_CONTENT.contains(&name.as_str()) {
            if closing {
                skip_depth = skip_depth.saturating_sub(1);
            } else if !self_closing {
                skip_depth += 1;
            }
            continue;
        }
        if skip_depth > 0 {
            continue;
        }

        if name == "img" {
            if keep_images
                && !closing
                && let Some(src) = attr_value(tag, "src").filter(|s| !s.is_empty())
            {
                let alt = attr_value(tag, "alt").unwrap_or_default();
                let mut img = BookSpan::plain(decode_entities(&alt));
                img.image = Some(src);
                // 链接里的图片要带上链接（`[![alt](a)](b)` 是真实写法）。
                img.href = state.current_href();
                builder.push_atomic(img);
            }
            continue;
        }
        if name == "br" {
            state.push_break(&mut builder);
            continue;
        }
        if closing {
            state.close(&name, &mut builder);
            continue;
        }
        state.open(&name, tag);
    }
    if skip_depth == 0 && at < fragment.len() {
        state.push_text(&mut builder, &decode_entities(&fragment[at..]));
    }
    state.finish(&mut builder);

    let mut spans = builder.into_spans();
    for span in &mut spans {
        normalize_styles(&mut span.styles);
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼接**文字**片段（跳过图片：图片片段的 `text` 是 alt，不是散文）。
    fn joined(spans: &[BookSpan]) -> String {
        spans
            .iter()
            .filter(|s| s.image.is_none())
            .map(|s| s.text.as_str())
            .collect()
    }

    #[test]
    fn script_and_style_content_is_dropped() {
        let spans = spans_from_html(
            "<p>正文</p><script>alert('xss')</script><style>.x{}</style>",
            false,
        );
        let text = joined(&spans);
        assert!(!text.contains("alert"), "script 内容不得进入正文：{text}");
        assert!(!text.contains(".x{}"), "style 内容不得进入正文：{text}");
        assert!(text.contains("正文"));
    }

    #[test]
    fn unknown_tags_keep_their_text() {
        // 白名单外的标签**丢标签留文字**（不丢正文）。
        let spans = spans_from_html("前<custom>中</custom>后", false);
        assert_eq!(joined(&spans), "前中后");
    }

    #[test]
    fn inline_styles_are_collected_and_normalized() {
        let spans = spans_from_html("<strong><em>粗斜</em></strong>", false);
        let styled = spans
            .iter()
            .find(|s| !s.styles.is_empty())
            .expect("应当有样式片段");
        assert_eq!(styled.text, "粗斜");
        assert_eq!(
            styled.styles,
            vec![SpanStyle::Strong, SpanStyle::Emphasis],
            "样式必须归一化成固定次序"
        );
    }

    #[test]
    fn images_are_kept_in_document_order() {
        let spans = spans_from_html("前<img src=\"a.png\" alt=\"图\"/>后", true);
        assert_eq!(joined(&spans), "前后");
        let img = spans
            .iter()
            .find(|s| s.image.is_some())
            .expect("应当有图片片段");
        assert_eq!(img.image.as_deref(), Some("a.png"));
        assert_eq!(img.text, "图", "图片片段的 text 是 alt 文本");
        // 顺序：文字 → 图片 → 文字。
        let img_at = spans.iter().position(|s| s.image.is_some()).unwrap();
        assert!(spans[..img_at].iter().all(|s| s.image.is_none()));
        assert!(spans[img_at + 1..].iter().all(|s| s.image.is_none()));
    }

    #[test]
    fn images_are_ignored_when_not_requested() {
        let spans = spans_from_html("前<img src=\"a.png\" alt=\"图\"/>后", false);
        assert!(spans.iter().all(|s| s.image.is_none()));
        // `keep_images = false` 时连 alt 文本也不留：`<img>` 的 alt 不是散文。
        assert_eq!(joined(&spans), "前后");
    }

    #[test]
    fn links_carry_href_and_images_inside_links_keep_it() {
        let spans = spans_from_html("<a href=\"https://e.com\"><img src=\"a.png\"/></a>", true);
        let img = spans
            .iter()
            .find(|s| s.image.is_some())
            .expect("应当有图片");
        assert_eq!(
            img.href.as_deref(),
            Some("https://e.com"),
            "链接里的图片应保留链接（`[![alt](a)](b)` 是真实写法）"
        );
    }

    #[test]
    fn image_without_alt_is_not_trimmed_away() {
        // `<img>` 没有 alt 时 `text` 是空串：尾部裁剪**不能**把它当空白删掉
        // （实测抓到的洞，2026-10-18：链接里的图片会整条消失）。
        let spans = spans_from_html("<a href=\"x\"><img src=\"a.png\"/></a>", true);
        assert_eq!(spans.len(), 1, "空 alt 的图片必须留下：{spans:?}");
        assert_eq!(spans[0].image.as_deref(), Some("a.png"));
    }

    #[test]
    fn br_becomes_a_line_break() {
        let spans = spans_from_html("甲<br/>乙", false);
        assert_eq!(joined(&spans), "甲\n乙");
    }

    #[test]
    fn entities_are_decoded() {
        let spans = spans_from_html("a &amp; b &lt;c&gt;", false);
        assert_eq!(joined(&spans), "a & b <c>");
    }

    // ---- 内联 `style` 落到片段上（颜色 / 底色 / 字号）----

    #[test]
    fn span_style_color_bg_and_size_land_on_spans() {
        let spans = spans_from_html(
            "<span style=\"color:#f00; background-color: yellow; font-size:1.5em\">红</span>",
            false,
        );
        let span = spans.first().expect("应当有片段");
        assert_eq!(span.text, "红");
        assert_eq!(span.color.as_deref(), Some("#ff0000"));
        assert_eq!(span.bg.as_deref(), Some("#ffff00"));
        assert_eq!(span.size_em, clamp_size_em(1.5));
    }

    #[test]
    fn style_flags_become_span_styles() {
        let spans = spans_from_html(
            "<span style=\"font-style:italic; font-weight:700; text-decoration:underline\">x</span>",
            false,
        );
        let styles = &spans.first().expect("应当有片段").styles;
        assert!(styles.contains(&SpanStyle::Emphasis), "{styles:?}");
        assert!(styles.contains(&SpanStyle::Strong), "{styles:?}");
        assert!(styles.contains(&SpanStyle::Underline), "{styles:?}");
    }

    #[test]
    fn new_tags_map_to_new_styles() {
        let spans = spans_from_html("<mark>高</mark><u>下</u>", false);
        assert!(
            spans
                .iter()
                .any(|s| s.styles.contains(&SpanStyle::Highlight))
        );
        assert!(
            spans
                .iter()
                .any(|s| s.styles.contains(&SpanStyle::Underline))
        );
        // `<mark>` 未声明底色时补浏览器默认黄。
        let marked = spans
            .iter()
            .find(|s| s.styles.contains(&SpanStyle::Highlight))
            .unwrap();
        assert_eq!(marked.bg.as_deref(), Some(MARK_DEFAULT_BG));
    }

    #[test]
    fn colored_text_does_not_bleed_into_neighbours() {
        // 颜色必须**另起片段**：并进前一段会让颜色蔓延到 `前` 上。
        let spans = spans_from_html("前<span style=\"color:red\">中</span>后", false);
        assert_eq!(joined(&spans), "前中后");
        assert!(spans[0].color.is_none());
        assert_eq!(spans[1].color.as_deref(), Some("#ff0000"));
        assert!(spans[2].color.is_none());
    }

    #[test]
    fn font_tag_color_attribute_is_honored() {
        // 上古写法 `<font color="red">`（koodo 的语料里也常见）。
        let spans = spans_from_html("<font color=\"red\">红</font>", false);
        assert_eq!(spans[0].color.as_deref(), Some("#ff0000"));
    }

    #[test]
    fn nested_font_sizes_multiply_and_clamp() {
        let spans = spans_from_html(
            "<span style=\"font-size:2em\"><span style=\"font-size:2em\">大</span></span>",
            false,
        );
        assert_eq!(
            spans[0].size_em,
            Some(crate::epub_rich::MAX_SIZE_EM),
            "2×2 应夹到上限"
        );
    }

    #[test]
    fn small_and_big_fold_into_sizes() {
        let spans = spans_from_html("<small>小</small><big>大</big>", false);
        assert_eq!(spans[0].size_em, clamp_size_em(0.8));
        assert_eq!(spans[1].size_em, clamp_size_em(1.2));
    }

    #[test]
    fn block_container_style_layers_are_inherited_within_the_scan() {
        // `<div style="color:#0f0">` 是**块级**容器：颜色要传给孩子文字，
        // 但不能把它当行内层（块级切段语义会丢）。
        //
        // 说明：`spans_from_html` 是**行内片段**扫描器，块级祖先的压 / 弹由
        // `epub_text` 的扫描循环负责（它才有块结构概念，见其 `enter_block` 调用）；
        // 本测试钉住的是 `InlineState::enter_block` / `leave_block` 这一对 API 的语义。
        let mut builder = RunBuilder::new();
        let mut state = InlineState::new();
        state.enter_block(r#"<div style="color:#0f0">"#);
        state.push_text(&mut builder, "文");
        state.leave_block();
        state.push_text(&mut builder, "后");
        let spans = builder.into_spans();
        assert_eq!(joined(&spans), "文后");
        assert_eq!(spans[0].color.as_deref(), Some("#00ff00"));
        assert!(spans[1].color.is_none(), "颜色不得漏到容器之外：{spans:?}");
    }

    #[test]
    fn ruby_keeps_the_base_text_and_separates_the_note() {
        let spans = spans_from_html("<ruby>漢<rt>kan</rt></ruby>", false);
        assert_eq!(joined(&spans), "漢kan", "注音要保留（否则读者看不到读音）");
        let note = spans
            .iter()
            .find(|s| s.text == "kan")
            .expect("注音应自成片段");
        assert!(
            note.styles.contains(&SpanStyle::Superscript),
            "注音按上标渲染：{:?}",
            note.styles
        );
        assert_eq!(note.size_em, Some(RUBY_NOTE_SIZE_EM), "注音是 0.6em 小字");
        let base = spans.iter().find(|s| s.text == "漢").expect("汉字应在");
        assert!(base.size_em.is_none(), "汉字不该被缩小");
    }

    #[test]
    fn ruby_fallback_parentheses_are_dropped() {
        let spans = spans_from_html("<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>", false);
        assert_eq!(joined(&spans), "漢kan", "回退括号不是正文");
    }
}
