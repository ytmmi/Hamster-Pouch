//! EPUB **正文**读取：把 spine 里的 XHTML 章节转成**类型化的块**。
//!
//! ## 安全边界（这是本模块存在的首要理由）
//!
//! EPUB 的正文是 XHTML。渲染它的常见做法是 `dangerouslySetInnerHTML`——**本项目不接受**
//! （与"插件不得创建自由 React 组件"同一条安全思路）。因此本模块**不返回 HTML**：
//! 它把 XHTML 过一遍**受控白名单**，产出 [`BookBlock`] 这样的**纯数据**，
//! 由前端用 React 元素渲染。前端因此**没有**可以注入 HTML 的入口——不是"我们记得不要用
//! `dangerouslySetInnerHTML`"，而是**没有 HTML 可注入**。
//!
//! 白名单之外的标签一律**丢掉标签、保留其文字**（不丢正文）；`<script>` / `<style>` /
//! `<head>` 的内容**整段丢弃**（那是代码与样式，不是正文）。
//!
//! ## 与 Markdown 共用同一套块模型
//!
//! 本模块产出的 [`BookBlock`] 定义在 `crate::block`，与 Markdown 解析器
//! （`crate::markdown`）**完全同形**——前端因此只有**一份渲染器**，
//! 两种格式的观感不会各自漂移。EPUB 只用到其中的一部分变体
//! （不产表格 / 任务列表 / 分隔线），这与"XHTML 里没有这些块级语义"一致。
//!
//! ## 为什么手写而不是上 HTML 解析库（D20）
//!
//! 与 `xml.rs` 同一条口径：我们只需要"块级元素切段 + 行内元素取文字 + 图片取 src"
//! 这一小片语义。实测语料（22 本 Re:Zero，2026-10-09）里出现的标签只有
//! `p` / `br` / `div` / `h1`–`h4` / `span` / `b` / `a` / `img` / `table` / `tr` / `td` /
//! `li` / `ol` / `ruby` / `rt` / `sup` / `hr` / `nav` / `aside` / `svg`+`image`
//! 这一小撮，**没有混合内容与命名空间语义**。为此引入完整 HTML 解析器（及其
//! 容错规则与实体表）不划算。
//!
//! **边界如实说明**：本模块**不是**通用 HTML 解析器。它不实现 HTML5 的隐式闭合
//! 规则（`<p>` 未闭合就开下一个 `<p>` 这类"标签汤"），遇到不平衡的标签只会把
//! 剩余文字继续收集。取不到就是取不到——**不会**退回"把原文塞给前端"。

use std::path::Path;

use hp_core::{HpError, HpResult};

use crate::block::{BookBlock, SpanStyle};
use crate::inline::{inline_style, local_name, spans_from_html, RunBuilder, LINE_BREAK_MARKER};
use crate::xml::{attr_value, decode_entities, resolve_zip_path};
use crate::zip::ZipArchive;

/// 一次章节读取的结果（一次打开包即可拿到目录 + 指定章节，避免重复解包）。
#[derive(Debug, Clone)]
pub struct EpubSectionRead {
    /// 章节总数（spine 长度）。
    pub section_count: u32,
    /// 全部章节标题（取自各章 `<title>`；缺失处为空串）。
    pub titles: Vec<String>,
    /// 本次读取的章节序号。
    pub section: u32,
    /// 本章标题。
    pub title: String,
    /// 本章正文块。
    pub blocks: Vec<BookBlock>,
}

/// 需要**整段丢弃内容**的标签（代码与样式不是正文）。
const SKIPPED_CONTENT: [&str; 3] = ["script", "style", "head"];

/// 块级标签：遇到它们就**先结束当前段落**。
const BLOCK_TAGS: [&str; 14] = [
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
];

/// 取 `h1`–`h6` 的层级；不是标题标签返回 `None`。
fn heading_level(name: &str) -> Option<u8> {
    let rest = name.strip_prefix('h')?;
    let digit = rest.parse::<u8>().ok()?;
    (1..=6).contains(&digit).then_some(digit)
}

/// 取图片地址：`<img src>` 与 SVG 的 `<image xlink:href>` / `href` 都要认。
fn image_ref(tag: &str) -> Option<String> {
    for attr in ["src", "href", "xlink:href"] {
        if let Some(v) = attr_value(tag, attr) {
            if !v.is_empty() {
                return Some(v);
            }
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

/// XHTML → 正文块的**受控白名单**转换（见模块文档的安全边界）。
///
/// `chapter_path` 是本章在包内的路径，用于把相对 `src` 解析成包内条目名。
pub fn blocks_from_xhtml(xhtml: &str, chapter_path: &str, archive: &ZipArchive) -> Vec<BookBlock> {
    let mut blocks: Vec<BookBlock> = Vec::new();
    let mut pending = RunBuilder::new();
    // 当前生效的行内样式与链接（标签嵌套 → 栈式生效）。
    let mut styles: Vec<SpanStyle> = Vec::new();
    let mut href: Option<String> = None;
    // 丢弃内容的标签嵌套深度（`script` / `style` / `head`）。
    let mut skip_depth = 0usize;

    /// 把已积累的文字收成一个段落（折叠后为空则丢弃）。
    fn flush(pending: &mut RunBuilder, blocks: &mut Vec<BookBlock>) {
        let spans = std::mem::replace(pending, RunBuilder::new()).into_spans();
        if !spans.is_empty() {
            blocks.push(BookBlock::Paragraph { spans });
        }
    }

    let mut at = 0usize;
    while let Some(lt) = xhtml[at..].find('<') {
        let start = at + lt;
        // 标签之前的文字（丢弃区段内直接忽略）。
        if skip_depth == 0 && start > at {
            pending.push(
                &decode_entities(&xhtml[at..start]),
                &styles,
                href.as_deref(),
            );
        }
        let Some(gt) = xhtml[start..].find('>') else {
            // 没有闭合的 `<`：把剩下的当文字收尾。
            if skip_depth == 0 {
                pending.push(&decode_entities(&xhtml[start..]), &styles, href.as_deref());
            }
            break;
        };
        let tag_end = start + gt + 1;
        let tag = &xhtml[start..tag_end];
        at = tag_end;

        // 注释 / 声明 / CDATA：整段丢掉。
        if tag.starts_with("<!--") || tag.starts_with("<!") || tag.starts_with("<?") {
            continue;
        }

        let closing = tag.starts_with("</");
        let self_closing = tag.trim_end().ends_with("/>");
        let name = local_name(tag);

        // 丢弃区段的进入 / 离开。
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

        if closing {
            // 行内标签的离开：撤销它带来的样式 / 链接。
            if name == "a" {
                href = None;
            } else if let Some(style) = inline_style(&name) {
                if let Some(pos) = styles.iter().rposition(|s| *s == style) {
                    styles.remove(pos);
                }
            }
            // 块级元素结束 → 收段。
            if BLOCK_TAGS.contains(&name.as_str()) || heading_level(&name).is_some() {
                flush(&mut pending, &mut blocks);
            }
            continue;
        }

        // 图片：块级处理（先收段，再插图）。
        if name == "img" || name == "image" {
            if let Some(src) = image_ref(tag) {
                flush(&mut pending, &mut blocks);
                let entry = resolve_zip_path(chapter_path, &src);
                if let Ok(Some(bytes)) = archive.read(&entry) {
                    let ext = crate::cover::detect_image_ext(&bytes);
                    blocks.push(BookBlock::Image {
                        name: entry,
                        ext,
                        bytes,
                    });
                }
            }
            continue;
        }

        // 换行：段内换行（不切段，避免诗句被切成一堆碎段）。
        // 写的是**标记**而不是 `\n`：源码里的原始换行是排版空白，两者见 `collapse_runs`。
        if name == "br" || name == "hr" {
            pending.push(&LINE_BREAK_MARKER.to_string(), &styles, href.as_deref());
            continue;
        }

        // 标题：先收段，并把标题文字单独成块（内文按行内规则解析）。
        if let Some(level) = heading_level(&name) {
            flush(&mut pending, &mut blocks);
            if let Some((text, next)) = element_inner_text(xhtml, tag_end, &name) {
                // `keep_images = false`：章节插图在块级循环里处理，标题里不插图。
                let spans = spans_from_html(&text, false);
                if !spans.is_empty() {
                    blocks.push(BookBlock::Heading { level, spans });
                }
                at = next;
            }
            continue;
        }

        // 行内元素：链接记 href，样式标签压栈（文字由后续的字符累积进新段）。
        if name == "a" {
            href = attr_value(tag, "href").filter(|h| !h.is_empty());
            continue;
        }
        if let Some(style) = inline_style(&name) {
            styles.push(style);
            continue;
        }

        // 其余块级元素：先收段（其文字由后续的字符累积进新段）。
        if BLOCK_TAGS.contains(&name.as_str()) {
            flush(&mut pending, &mut blocks);
        }
        // 其余行内元素（span / ruby / rt / sup 之外…）：什么都不做，文字自然累积。
    }

    if skip_depth == 0 {
        flush(&mut pending, &mut blocks);
    }
    blocks
}

/// 取某元素的开标签之后、配对结束标签之前的**原始内文**，返回 `(内文, 结束标签之后的下标)`。
///
/// 只做一层配对（不递归）：标题里不会再套标题。找不到配对结束标签时返回 `None`
/// （调用方保持原游标，按普通文字继续处理）。
fn element_inner_text(xhtml: &str, from: usize, name: &str) -> Option<(String, usize)> {
    let closing = format!("</{name}");
    let lower = xhtml[from..].to_ascii_lowercase();
    let rel = lower.find(&closing)?;
    let end_start = from + rel;
    let end_gt = xhtml[end_start..].find('>')? + end_start + 1;
    Some((xhtml[from..end_start].to_string(), end_gt))
}

/// 读出章节清单（spine 顺序）与各章路径。
fn read_spine(archive: &ZipArchive) -> HpResult<Option<(String, Vec<String>)>> {
    let Some((opf_path, opf)) = crate::epub::read_opf(archive)? else {
        return Ok(None);
    };
    let by_id: Vec<(String, String)> = crate::xml::open_tags(&opf, "item")
        .into_iter()
        .filter_map(|tag| {
            let id = attr_value(tag, "id")?;
            let href = attr_value(tag, "href")?;
            Some((id, href))
        })
        .collect();

    let mut paths = Vec::new();
    for tag in crate::xml::open_tags(&opf, "itemref") {
        let Some(idref) = attr_value(tag, "idref") else {
            continue;
        };
        if let Some((_, href)) = by_id.iter().find(|(id, _)| *id == idref) {
            paths.push(resolve_zip_path(&opf_path, href));
        }
    }
    Ok(Some((opf_path, paths)))
}

/// 读一章正文（含章节清单与标题）。
///
/// `section` 越界时按**最后一章**处理（前端滚到底再请求一次不该变成错误态）。
pub fn read_epub_section(path: &Path, section: u32) -> HpResult<EpubSectionRead> {
    let archive = ZipArchive::open(path)?;
    let Some((_opf_path, paths)) = read_spine(&archive)? else {
        return Err(HpError::Io(format!(
            "EPUB 缺少 OPF 清单：{}",
            path.display()
        )));
    };
    if paths.is_empty() {
        return Err(HpError::Io(format!(
            "EPUB 的 spine 为空（没有可读章节）：{}",
            path.display()
        )));
    }

    // 各章标题（取自 `<title>`）——顺带把目录给前端，用于进度提示。
    let titles: Vec<String> = paths
        .iter()
        .map(|p| {
            archive
                .read(p)
                .ok()
                .flatten()
                .map(|bytes| crate::xml::decode_xml_bytes(&bytes))
                .and_then(|xhtml| crate::xml::element_text(&xhtml, "title"))
                .unwrap_or_default()
        })
        .collect();

    let count = paths.len() as u32;
    let index = section.min(count.saturating_sub(1));
    let chapter_path = &paths[index as usize];
    let xhtml = archive
        .read(chapter_path)?
        .map(|bytes| crate::xml::decode_xml_bytes(&bytes))
        .unwrap_or_default();

    Ok(EpubSectionRead {
        section_count: count,
        title: titles.get(index as usize).cloned().unwrap_or_default(),
        titles,
        section: index,
        blocks: blocks_from_xhtml(&xhtml, chapter_path, &archive),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::BookSpan;
    use crate::zip::build_test_zip;

    fn archive_with(files: &[(&str, &[u8], bool)]) -> ZipArchive {
        ZipArchive::from_bytes(build_test_zip(files)).expect("解析测试 ZIP 失败")
    }

    const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];

    /// 测试夹具：把纯文字包成一个无样式片段（大多数断言只关心文字）。
    fn text(s: &str) -> BookSpan {
        BookSpan::plain(s)
    }

    #[test]
    fn paragraphs_and_headings_become_blocks() {
        let xhtml = r#"<html><head><title>序章</title><style>p{color:red}</style></head>
          <body><div><h1>序章 『愚者的坚持』</h1><p>第一段。</p><p>第二段。</p></div></body></html>"#;
        let archive = archive_with(&[]);
        let blocks = blocks_from_xhtml(xhtml, "Text/a.xhtml", &archive);
        assert_eq!(
            blocks,
            vec![
                BookBlock::Heading {
                    level: 1,
                    spans: vec![text("序章 『愚者的坚持』")]
                },
                BookBlock::Paragraph {
                    spans: vec![text("第一段。")]
                },
                BookBlock::Paragraph {
                    spans: vec![text("第二段。")]
                },
            ]
        );
    }

    /// **安全边界**：`script` 的内容绝不能出现在任何块里。
    #[test]
    fn script_and_style_content_is_dropped() {
        let xhtml = r#"<body><p>正文</p><script>alert('xss')</script>
          <style>.x{}</style><p>之后</p></body>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        let joined = format!("{blocks:?}");
        assert!(
            !joined.contains("alert"),
            "script 内容不得进入正文：{joined}"
        );
        assert!(!joined.contains("xss"));
        assert!(!joined.contains(".x{}"), "style 内容不得进入正文");
        assert_eq!(blocks.len(), 2, "两个段落仍应在：{blocks:?}");
    }

    #[test]
    fn inline_tags_keep_their_text_and_br_keeps_the_line_break() {
        let xhtml = r#"<p>他<b>大声</b>说：<br/>「你好」</p>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(
            blocks,
            vec![BookBlock::Paragraph {
                spans: vec![
                    text("他"),
                    BookSpan {
                        text: "大声".into(),
                        styles: vec![SpanStyle::Strong],
                        href: None,
                        image: None,
                    },
                    text("说：\n「你好」"),
                ],
            }]
        );
    }

    /// 词间空格必须**跨样式边界**存活（`a <b>b</b> c` → `a b c`，不是 `ab c`）。
    #[test]
    fn whitespace_survives_across_style_boundaries() {
        let xhtml = r#"<p>a <b>b</b> c</p>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        let joined: String = match &blocks[0] {
            BookBlock::Paragraph { spans } => spans.iter().map(|s| s.text.as_str()).collect(),
            other => panic!("不是段落：{other:?}"),
        };
        assert_eq!(joined, "a b c", "样式边界不得吃掉词间空格");
    }

    #[test]
    fn entities_are_decoded() {
        let xhtml = "<p>a &amp; b &lt;c&gt; &#x56fd;</p>";
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(
            blocks,
            vec![BookBlock::Paragraph {
                spans: vec![text("a & b <c> 国")]
            }]
        );
    }

    #[test]
    fn img_src_resolves_relative_to_the_chapter() {
        let xhtml = r#"<body><p>前</p><img src="../Images/i.png" alt="x"/><p>后</p></body>"#;
        let archive = archive_with(&[("Images/i.png", PNG, false)]);
        let blocks = blocks_from_xhtml(xhtml, "Text/a.xhtml", &archive);
        let images: Vec<&BookBlock> = blocks
            .iter()
            .filter(|b| matches!(b, BookBlock::Image { .. }))
            .collect();
        assert_eq!(images.len(), 1, "应当取出 1 张图：{blocks:?}");
        match images[0] {
            BookBlock::Image { name, ext, bytes } => {
                assert_eq!(name, "Images/i.png", "相对路径应相对**章节**解析");
                assert_eq!(*ext, Some("png"));
                assert_eq!(bytes, PNG);
            }
            other => panic!("不是图片块：{other:?}"),
        }
    }

    #[test]
    fn svg_image_href_is_recognized() {
        // 实测语料里有 1 本用 `<svg><image xlink:href=...>`（2026-10-09 实测）。
        let xhtml =
            r#"<body><svg viewBox="0 0 1 1"><image xlink:href="Images/c.png"/></svg></body>"#;
        let archive = archive_with(&[("Images/c.png", PNG, false)]);
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
        assert!(
            blocks.iter().any(|b| matches!(b, BookBlock::Image { .. })),
            "SVG 的 xlink:href 图片应当被取出：{blocks:?}"
        );
    }

    #[test]
    fn unknown_image_format_is_reported_without_ext() {
        let xhtml = r#"<img src="i.bin"/>"#;
        let archive = archive_with(&[("i.bin", b"not an image", false)]);
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
        match &blocks[0] {
            BookBlock::Image { ext, .. } => assert!(ext.is_none(), "认不出的格式 ext 应为 None"),
            other => panic!("不是图片块：{other:?}"),
        }
    }

    #[test]
    fn missing_image_is_skipped_not_fatal() {
        let xhtml = r#"<p>前</p><img src="missing.png"/><p>后</p>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(blocks.len(), 2, "缺图只丢图，不该丢正文：{blocks:?}");
    }

    #[test]
    fn table_cells_do_not_merge_into_one_paragraph() {
        let xhtml = r#"<table><tr><td>甲</td><td>乙</td></tr></table>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(
            blocks,
            vec![
                BookBlock::Paragraph {
                    spans: vec![text("甲")]
                },
                BookBlock::Paragraph {
                    spans: vec![text("乙")]
                },
            ],
            "单元格应各自成段，不该粘成「甲乙」"
        );
    }

    #[test]
    fn whitespace_is_collapsed_but_line_breaks_survive() {
        // 源码里的换行/缩进是排版空白 → 折叠成空格；`<br>` 才是真正的换行。
        let xhtml = "<p>  前\n\n  中  \n后  </p><p>甲<br/>乙</p>";
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(
            blocks,
            vec![
                BookBlock::Paragraph {
                    spans: vec![text("前 中 后")]
                },
                BookBlock::Paragraph {
                    spans: vec![text("甲\n乙")]
                },
            ],
            "原始换行折叠为空格，br 保留为换行"
        );
    }

    #[test]
    fn links_carry_their_href() {
        let xhtml = r#"<p>见 <a href="https://example.com">这里</a>。</p>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        match &blocks[0] {
            BookBlock::Paragraph { spans } => {
                let link = spans
                    .iter()
                    .find(|s| s.href.is_some())
                    .expect("应当有链接片段");
                assert_eq!(link.text, "这里");
                assert_eq!(link.href.as_deref(), Some("https://example.com"));
            }
            other => panic!("不是段落：{other:?}"),
        }
    }

    #[test]
    fn read_epub_section_walks_the_spine() {
        let container = r#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#;
        let opf = r#"<package><metadata/><manifest>
            <item id="a" href="Text/a.xhtml" media-type="application/xhtml+xml"/>
            <item id="b" href="Text/b.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine><itemref idref="a"/><itemref idref="b"/></spine></package>"#;
        let a = r#"<html><head><title>第一章</title></head><body><p>甲</p></body></html>"#;
        let b = r#"<html><head><title>第二章</title></head><body><p>乙</p></body></html>"#;
        let archive = build_test_zip(&[
            ("META-INF/container.xml", container.as_bytes(), true),
            ("OEBPS/content.opf", opf.as_bytes(), true),
            ("OEBPS/Text/a.xhtml", a.as_bytes(), true),
            ("OEBPS/Text/b.xhtml", b.as_bytes(), true),
        ]);
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("s.epub");
        std::fs::write(&path, archive).expect("写入失败");

        let first = read_epub_section(&path, 0).expect("读取失败");
        assert_eq!(first.section_count, 2);
        assert_eq!(first.titles, vec!["第一章".to_string(), "第二章".into()]);
        assert_eq!(first.section, 0);
        assert_eq!(first.title, "第一章");
        assert_eq!(
            first.blocks,
            vec![BookBlock::Paragraph {
                spans: vec![text("甲")]
            }]
        );

        let second = read_epub_section(&path, 1).expect("读取失败");
        assert_eq!(second.title, "第二章");
        assert_eq!(
            second.blocks,
            vec![BookBlock::Paragraph {
                spans: vec![text("乙")]
            }]
        );

        // 越界按最后一章处理（滚到底再请求一次不该变成错误态）。
        let past = read_epub_section(&path, 99).expect("越界不该报错");
        assert_eq!(past.section, 1);
    }
}
