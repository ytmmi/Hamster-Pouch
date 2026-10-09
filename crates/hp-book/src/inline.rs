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

use crate::block::{normalize_styles, BookSpan, SpanStyle};
use crate::xml::{attr_value, decode_entities};

// ==================== 行内累积（原始 run → 折叠后的片段）====================

/// **行内换行**的标记字符（`<br>` 与 Markdown 的硬换行）。
///
/// 用一个不可能出现在正文里的控制字符做标记：源码里的原始换行是**排版空白**，
/// 只有显式换行才是语义上的换行。两者必须在折叠时区分开，否则 XHTML 的缩进
/// 会被当成正文里的换行（实测：Re:Zero 的章节源码每个 `<p>` 之间都有换行与缩进）。
pub(crate) const LINE_BREAK_MARKER: char = '\u{1}';

/// 把字符追加到 `out` 的末尾片段；样式 / 链接 / 图片身份不同则另起一段。
///
/// **图片片段不参与合并**：否则图片之后的文字会被并进图片片段里，
/// 渲染器会把那段文字当成图片的 alt 文本。
fn push_char(out: &mut Vec<BookSpan>, ch: char, styles: &[SpanStyle], href: Option<&str>) {
    if let Some(last) = out.last_mut() {
        if last.image.is_none() && last.styles == styles && last.href.as_deref() == href {
            last.text.push(ch);
            return;
        }
    }
    out.push(BookSpan {
        text: ch.to_string(),
        styles: styles.to_vec(),
        href: href.map(|s| s.to_string()),
        image: None,
    });
}

/// 丢掉末尾的空片段（折叠后可能只剩空白）。
fn trim_end_spans(out: &mut Vec<BookSpan>) {
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
}

/// 一段尚未折叠的原始文字 + 它所属的行内样式。
pub(crate) struct Run {
    text: String,
    styles: Vec<SpanStyle>,
    href: Option<String>,
}

/// 把"文字 + 当前样式"攒成一段段原始 run，最后统一折叠成 [`BookSpan`]。
///
/// **为什么先攒再折叠**：空白折叠必须**跨 run** 进行——`a <b>b</b> c` 里
/// "a " 的尾随空格与 " c" 的前导空格都参与"折叠成单个空格"的判定，
/// 各自独立折叠会把词间空格吃掉（变成 `ab c`）。
pub(crate) struct RunBuilder {
    runs: Vec<Run>,
}

impl RunBuilder {
    pub(crate) fn new() -> Self {
        RunBuilder { runs: Vec::new() }
    }

    /// 追加一段文字；样式与链接都相同的相邻文字自动并进同一 run。
    pub(crate) fn push(&mut self, text: &str, styles: &[SpanStyle], href: Option<&str>) {
        if text.is_empty() {
            return;
        }
        let href = href.map(|s| s.to_string());
        if let Some(last) = self.runs.last_mut() {
            if last.styles == styles && last.href == href {
                last.text.push_str(text);
                return;
            }
        }
        self.runs.push(Run {
            text: text.to_string(),
            styles: styles.to_vec(),
            href,
        });
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
        for ch in run.text.chars() {
            if ch == LINE_BREAK_MARKER {
                // 换行前把行尾空格去掉；连续标记不重复。
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
                    push_char(&mut out, '\n', &run.styles, run.href.as_deref());
                }
                last_space = false;
                continue;
            }
            if ch.is_whitespace() {
                let ends_nl = out.last().is_some_and(|s| s.text.ends_with('\n'));
                if !last_space && !out.is_empty() && !ends_nl {
                    push_char(&mut out, ' ', &run.styles, run.href.as_deref());
                }
                last_space = true;
                continue;
            }
            push_char(&mut out, ch, &run.styles, run.href.as_deref());
            last_space = false;
        }
    }
    trim_end_spans(&mut out);
    out
}

/// 解析一段纯文字（**无标记**）→ 行内片段（折叠空白）。
#[cfg(test)]
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
pub(crate) fn inline_style(name: &str) -> Option<SpanStyle> {
    match name {
        "b" | "strong" => Some(SpanStyle::Strong),
        "i" | "em" => Some(SpanStyle::Emphasis),
        "code" | "tt" | "kbd" | "samp" => Some(SpanStyle::Code),
        "del" | "s" | "strike" => Some(SpanStyle::Strikethrough),
        "sub" => Some(SpanStyle::Subscript),
        "sup" => Some(SpanStyle::Superscript),
        _ => None,
    }
}

/// 需要**整段丢弃内容**的标签（代码与样式不是正文）。
const SKIPPED_CONTENT: [&str; 3] = ["script", "style", "head"];

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
    let mut styles: Vec<SpanStyle> = Vec::new();
    let mut href: Option<String> = None;
    // 图片片段不参与文字合并：按出现顺序记下"图片之前的文字段"与图片本身。
    let mut images: Vec<BookSpan> = Vec::new();
    let mut texts: Vec<Vec<BookSpan>> = Vec::new();
    let mut skip_depth = 0usize;

    let mut at = 0usize;
    while let Some(lt) = fragment[at..].find('<') {
        let start = at + lt;
        if skip_depth == 0 && start > at {
            builder.push(
                &decode_entities(&fragment[at..start]),
                &styles,
                href.as_deref(),
            );
        }
        let Some(gt) = fragment[start..].find('>') else {
            if skip_depth == 0 {
                builder.push(
                    &decode_entities(&fragment[start..]),
                    &styles,
                    href.as_deref(),
                );
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
            if keep_images && !closing {
                if let Some(src) = attr_value(tag, "src").filter(|s| !s.is_empty()) {
                    // 先把已积累的文字落定，再插图片（顺序即正文顺序）。
                    texts.push(std::mem::replace(&mut builder, RunBuilder::new()).into_spans());
                    let alt = attr_value(tag, "alt").unwrap_or_default();
                    let mut img = BookSpan::plain(decode_entities(&alt));
                    img.image = Some(src);
                    img.href = href.clone();
                    images.push(img);
                }
            }
            continue;
        }
        if name == "br" {
            builder.push(&LINE_BREAK_MARKER.to_string(), &styles, href.as_deref());
            continue;
        }
        if name == "a" {
            if closing {
                href = None;
            } else {
                href = attr_value(tag, "href").filter(|h| !h.is_empty());
            }
            continue;
        }
        if let Some(style) = inline_style(&name) {
            if closing {
                if let Some(pos) = styles.iter().rposition(|s| *s == style) {
                    styles.remove(pos);
                }
            } else {
                styles.push(style);
            }
        }
    }
    if skip_depth == 0 && at < fragment.len() {
        builder.push(&decode_entities(&fragment[at..]), &styles, href.as_deref());
    }

    // 图片与文字按出现顺序交错拼接：texts[i] 是第 i 张图之前的文字。
    let tail = builder.into_spans();
    let mut spans: Vec<BookSpan> = Vec::new();
    for (index, text) in texts.into_iter().enumerate() {
        spans.extend(text);
        if let Some(img) = images.get(index) {
            spans.push(img.clone());
        }
    }
    spans.extend(tail);

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
    fn br_becomes_a_line_break() {
        let spans = spans_from_html("甲<br/>乙", false);
        assert_eq!(joined(&spans), "甲\n乙");
    }

    #[test]
    fn entities_are_decoded() {
        let spans = spans_from_html("a &amp; b &lt;c&gt;", false);
        assert_eq!(joined(&spans), "a & b <c>");
    }
}
