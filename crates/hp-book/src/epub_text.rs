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
//! 两种格式的观感不会各自漂移。
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
//!
//! ## 富排版的来源（koodo-reader 实测，2026-10-18 dev 分支）
//!
//! 用户口径是"排版参考 koodo-reader（含注释、彩色文字、图片装饰）"。实测它的实现：
//!
//! - **彩色文字 / 划线 / 高亮**：正文**原样灌进 iframe**（`EpubRender.renderTo` →
//!   `handleOneChapterDoc` → `doc.body.innerHTML = chapterText`，
//!   `src/assets/lib/kookit.min.js`），作者的内联 `style` 与标签直接生效；
//!   `StyleHelper.getDefaultCss` 只补"用户字号 / 行高 / 字色 / 标题 1.25em"。
//!   本项目不能注入 HTML，因此把同一批内联声明**读成结构字段**
//!   （见 [`crate::epub_rich`] 与 [`crate::inline`] 的模块文档）。
//! - **注释**：它的默认 CSS 有
//!   `aside[epub\:type="footnote"],aside[epub\:type="note"],aside[epub\:type="endnote"],
//!   aside[epub\:type="rearnote"],.hide{font-size:0px !important;}`——即**注释默认折叠**；
//!   另有 `aside[type="sidebar"],aside[epub\:type="sidebar"]{background-color:#c7eafc;
//!   break-inside:avoid}`（旁注给淡蓝底）。
//!   本项目把它落成 [`BookBlock::Comment`]（带标签），由前端决定折叠样式。
//! - **图片装饰 / 图片页**：漫画（图片书）走 `ComicRender`：**每一张图 = 一页**，
//!   页面 HTML 是
//!   `<div style="width:100%;height:100%;display:flex;align-items:center;
//!   justify-content:center;overflow:hidden;"><img src="…"
//!   style="max-width:100%;max-height:100%;object-fit:contain;"></div>`
//!   （同一 bundle 的 `makeComicBook`），书级 layout 标成
//!   `book.rendition={layout:"pre-paginated"}`。
//!   也就是说**在 koodo 里"图片独占一页"是整页容器 + `object-fit:contain`**，
//!   不是一个空块、也不是 `page-break`。本模块据此产出
//!   [`BookBlock::Figure { full_page }`]：`full_page = true` 交给前端放进整页容器，
//!   **解析侧不换页**。
//! - **章节换页**：koodo 一次只渲染**一个**章节文档
//!   （`chapterDocList[chapterDocIndex]`，每章 `doc.body.innerHTML` 清空重建），
//!   滚动与分栏都在那一章的 iframe 内做（`handleLayout` 给 `documentElement` 设
//!   `column-width` / `column-gap` / `column-fill:auto`）。
//!   即"每章另起一页"在它那里是**渲染单位**的自然结果。
//!   本项目的对应物是 `BookContentResult.section > 0`（前端按章节序号换页），
//!   **不**在块列表里合成空块（见 `block.rs` 里 [`BookBlock::PageBreak`] 的边界说明）。
//!
//! 判据（颜色 / 字号 / 注释分类 / 整页图 / 显式换页）都是**纯函数**，放在
//! [`crate::epub_rich`]：它们可以独立单测，也让本文件守住"单文件 ≤ 1200 行"的红线。

use std::path::Path;

use hp_core::{HpError, HpResult};

use crate::block::BookBlock;
use crate::epub_rich::{
    caption_from_visible_text, comment_label, element_inner_balanced, figcaption_inner,
    first_image_tag, heading_level, image_ref, is_full_page_image, is_page_break_tag, strip_tags,
    trim_page_breaks, ANCESTOR_TAGS, BLOCK_TAGS, SKIPPED_CONTENT,
};
use crate::inline::{local_name, spans_from_html, InlineState, RunBuilder};
use crate::xml::{attr_value, decode_entities, resolve_zip_path};
use crate::zip::ZipArchive;

/// 一次章节读取的结果。
#[derive(Debug, Clone)]
pub struct EpubSectionRead {
    /// 章节总数（spine 长度）。
    pub section_count: u32,
    /// 本次读取的章节序号。
    pub section: u32,
    /// 本章标题。
    pub title: String,
    /// 本章正文块。
    pub blocks: Vec<BookBlock>,
}

/// 取**包内图片块**：`<img>` / SVG 的 `<image>`，字节从包里读出来。
///
/// 读不到（条目不存在 / 不是图片字节）返回 `None`——**缺图不该让整章失败**。
/// `extra_full_page_attrs` 是外层（`<figure>` / 祖先块）的属性：整页判定两者取并
/// （`<div class="cover"><img/></div>` 的提示必须能传到图片上）。
fn image_block(
    tag: &str,
    chapter_path: &str,
    archive: &ZipArchive,
    extra_full_page_attrs: &[String],
) -> Option<BookBlock> {
    let src = image_ref(tag)?;
    let entry = resolve_zip_path(chapter_path, &src);
    let bytes = archive.read(&entry).ok().flatten()?;
    let ext = crate::cover::detect_image_ext(&bytes);
    let full_page = is_full_page_image(tag)
        || extra_full_page_attrs
            .iter()
            .any(|attrs| is_full_page_image(attrs));
    Some(BookBlock::Figure {
        image: Box::new(BookBlock::Image {
            name: entry,
            ext,
            bytes,
        }),
        caption: Vec::new(),
        full_page,
    })
}

/// 从 `<figure>` 的**内文**取出"图片 + 图注"这一个整体块。
///
/// 为什么整体抽取而不是让主循环流式处理：`<figure>` 的语义就是"图与它的注是一个
/// 排版单元"（同页、同栏宽），拆成兄弟段落前端就没法再绑回去。
///
/// 图注优先取 `<figcaption>` 的内文；没有 `figcaption` 时退回 `<figure>` 里
/// 除图片之外的可见文字。
///
/// **找不到图片时的如实边界**：`figure` 里有文字但图片条目读不出来（`src` 为远程
/// URL / 条目缺失）时，**只保留图注文字**（退化成段落）——内容不能凭空消失；
/// 真正空的 `figure` 才什么都不产出（空容器不该变成空块）。
fn figure_from_inner(
    inner: &str,
    figure_tag: &str,
    chapter_path: &str,
    archive: &ZipArchive,
) -> Option<BookBlock> {
    let image_tag = first_image_tag(inner);
    let mut caption = match figcaption_inner(inner) {
        Some(caption) => spans_from_html(&caption, false),
        None => caption_from_visible_text(inner),
    };
    if caption.is_empty() {
        // 兜底：把 `<figure>` 里所有可见文字（含嵌套标签的）当图注。
        caption = spans_from_html(&strip_tags(inner), false);
    }
    match image_tag {
        Some(tag) => {
            let full_page_hint = [figure_tag.to_string()];
            match image_block(tag, chapter_path, archive, &full_page_hint) {
                Some(mut block) => {
                    if let BookBlock::Figure { caption: slot, .. } = &mut block {
                        *slot = caption;
                    }
                    Some(block)
                }
                // 图片读不出来（条目缺失 / 远程 URL）：**保住图注**，别让内容消失。
                None => (!caption.is_empty()).then_some(BookBlock::Paragraph { spans: caption }),
            }
        }
        // 没有图片：只在有文字时退化成段落（不产出空 `Figure`——`image` 必须非空）。
        None => (!caption.is_empty()).then_some(BookBlock::Paragraph { spans: caption }),
    }
}

/// 取某元素的开标签之后、配对结束标签之前的**原始内文**，返回 `(内文, 结束标签之后的下标)`。
///
/// 只做一层配对（不递归）：标题里不会再套标题。找不到配对结束标签时返回 `None`
/// （调用方保持原游标，按普通文字继续处理）。
pub(crate) fn element_inner_text(xhtml: &str, from: usize, name: &str) -> Option<(String, usize)> {
    let closing = format!("</{name}");
    let lower = xhtml[from..].to_ascii_lowercase();
    let rel = lower.find(&closing)?;
    let end_start = from + rel;
    let end_gt = xhtml[end_start..].find('>')? + end_start + 1;
    Some((xhtml[from..end_start].to_string(), end_gt))
}

/// XHTML → 正文块的**受控白名单**转换（见模块文档的安全边界）。
///
/// `chapter_path` 是本章在包内的路径，用于把相对 `src` 解析成包内条目名。
///
/// 收尾的 `PageBreak` 裁剪在 [`trim_page_breaks`]（`epub_rich`）：只在"后面还有块"
/// 时保留。
pub fn blocks_from_xhtml(xhtml: &str, chapter_path: &str, archive: &ZipArchive) -> Vec<BookBlock> {
    let mut blocks: Vec<BookBlock> = Vec::new();
    let mut pending = RunBuilder::new();
    let mut inline = InlineState::new();
    // 丢弃内容的标签嵌套深度（`script` / `style` / `head`）。
    let mut skip_depth = 0usize;
    // 块级祖先栈：`is_full_page_image` 要看**包裹**图片的那个元素的属性
    // （`<div class="cover"><img/></div>`）。只压 / 弹，不参与分段。
    let mut ancestors: Vec<(String, String)> = Vec::new();

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
            inline.push_text(&mut pending, &decode_entities(&xhtml[at..start]));
        }
        let Some(gt) = xhtml[start..].find('>') else {
            // 没有闭合的 `<`：把剩下的当文字收尾。
            if skip_depth == 0 {
                inline.push_text(&mut pending, &decode_entities(&xhtml[start..]));
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

        // 祖先栈的出栈：**按名字回溯匹配**，只对确实被压栈的标签出栈。
        // 为什么不用 `pop()`：`figure` / `aside` 的内文是原子抽取（`at` 直接跳到配对的
        // 结束标签之后），它们的结束标签根本走不到这里；用 `pop()` 会把别的祖先弹掉，
        // 于是 `cover` 提示再也传不到内部的图片上（实测抓到的 bug，2026-10-18）。
        if closing && ANCESTOR_TAGS.contains(&name.as_str()) {
            if let Some(pos) = ancestors.iter().rposition(|(pushed, _)| *pushed == name) {
                ancestors.truncate(pos);
                inline.leave_block();
            }
        }

        // `<figure>`：图片 + 图注整体抽取（见 [`figure_from_inner`]）。
        if name == "figure" {
            flush(&mut pending, &mut blocks);
            if !closing {
                if let Some((inner, next)) = element_inner_balanced(xhtml, tag_end, "figure") {
                    if let Some(block) = figure_from_inner(&inner, tag, chapter_path, archive) {
                        blocks.push(block);
                    }
                    at = next;
                }
                // 标签汤（没有配对的 `</figure>`）：退回普通块处理，内容不丢。
            }
            continue;
        }

        // 注释容器（`aside` / `epub:type=footnote` / `role=doc-footnote` / `.footnote`）：
        // 内文**递归**解析成块（嵌套注释因此天然正确）。
        if let Some(label) = comment_label(&name, tag) {
            flush(&mut pending, &mut blocks);
            if !closing {
                if let Some((inner, next)) = element_inner_balanced(xhtml, tag_end, &name) {
                    // 递归：`inner` 里可以再有注释 / figure / 表格，口径完全一致。
                    let inner_blocks = blocks_from_xhtml(&inner, chapter_path, archive);
                    blocks.push(BookBlock::Comment {
                        label,
                        blocks: inner_blocks,
                    });
                    at = next;
                }
            }
            continue;
        }

        // 图片：块级处理（先收段，再插图）。不在 `figure` 里的 `<img>` 也包成 `Figure`
        // （caption 空）——前端因此只有一条图片渲染路径。
        if (name == "img" || name == "image") && !closing {
            flush(&mut pending, &mut blocks);
            let ancestor_attrs: Vec<String> =
                ancestors.iter().map(|(_, attrs)| attrs.clone()).collect();
            if let Some(block) = image_block(tag, chapter_path, archive, &ancestor_attrs) {
                blocks.push(block);
            }
            // 缺图只丢图，不丢正文（`image_block` 返回 `None` 时什么都不做）。
            continue;
        }

        // 换行：段内换行（不切段，避免诗句被切成一堆碎段）。
        // 写的是**标记**而不是 `\n`：源码里的原始换行是排版空白。
        if name == "br" {
            inline.push_break(&mut pending);
            continue;
        }
        // 分隔线：独立成块；`<hr class="pagebreak">` 是另一种常见换页写法。
        if name == "hr" {
            flush(&mut pending, &mut blocks);
            if is_page_break_tag(tag) {
                blocks.push(BookBlock::PageBreak);
            } else {
                blocks.push(BookBlock::Rule);
            }
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

        // **显式换页**（章节内部作者声明的"从这里另起一页"）。
        // 是否保留由 [`trim_page_breaks`] 决定（首块 / 末尾 / 连续都要丢掉）。
        // 图片**不**产生换页：koodo 对整页图用整页容器 + `object-fit:contain`，
        // 没有任何分页符机制（2026-10-18 需求 5 的核查结论）。
        if !closing && is_page_break_tag(tag) {
            flush(&mut pending, &mut blocks);
            blocks.push(BookBlock::PageBreak);
            continue;
        }

        // 行内元素：由 `InlineState` 统一处理（样式 / 链接 / 颜色 / 字号 / 注音）。
        if closing {
            if inline.close(&name, &mut pending) {
                continue;
            }
        } else if inline.open(&name, tag) {
            continue;
        }

        // 其余块级元素：先收段（其文字由后续的字符累积进新段）。
        if BLOCK_TAGS.contains(&name.as_str()) {
            flush(&mut pending, &mut blocks);
        }
        // 祖先记账：当前块级标签（含属性）压栈，供其中的图片做整页判定；
        // 同时把它的 `style` 声明压成"远祖先"行内属性层（`<div style="color:red">`）。
        if !closing && !self_closing && ANCESTOR_TAGS.contains(&name.as_str()) {
            inline.enter_block(tag);
            ancestors.push((name.clone(), tag.to_string()));
        }
    }

    if skip_depth == 0 {
        inline.finish(&mut pending);
        flush(&mut pending, &mut blocks);
    }
    trim_page_breaks(&mut blocks);
    blocks
}

/// 读出章节清单（spine 顺序）、各章路径，以及 OPF 的路径与文本。
///
/// OPF 文本一并返回：**目录解析**（`toc.rs` 的 nav / NCX 查找）要用同一份 manifest，
/// 各读一遍包会让"两处 OPF 口径"迟早漂移。
pub(crate) struct SpineRead {
    /// OPF 在包内的路径（相对 href 的解析基准）。
    pub(crate) opf_path: String,
    /// OPF 文本。
    pub(crate) opf: String,
    /// spine 顺序的章节路径。
    pub(crate) paths: Vec<String>,
}

/// 读出章节清单（spine 顺序）与各章路径。
pub(crate) fn read_spine(archive: &ZipArchive) -> HpResult<Option<SpineRead>> {
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
    Ok(Some(SpineRead {
        opf_path,
        opf,
        paths,
    }))
}

/// 读一章正文（含章节清单与标题）。
///
/// `section` 越界时按**最后一章**处理（前端滚到底再请求一次不该变成错误态）。
///
/// **不在此处合成 `PageBreak`**：章节之间的换页由前端按
/// `BookContentResult.section > 0` 在**页容器**上完成（2026-10-18 Lead 的集成决策，
/// 见 `block.rs` 里 [`BookBlock::PageBreak`] 的边界说明）。
/// 本章块列表里的 `PageBreak` 只可能来自**章节内部的**显式换页声明。
pub fn read_epub_section(path: &Path, section: u32) -> HpResult<EpubSectionRead> {
    let archive = ZipArchive::open(path)?;
    let Some(spine) = read_spine(&archive)? else {
        return Err(HpError::Io(format!(
            "EPUB 缺少 OPF 清单：{}",
            path.display()
        )));
    };
    let paths = spine.paths;
    if paths.is_empty() {
        return Err(HpError::Io(format!(
            "EPUB 的 spine 为空（没有可读章节）：{}",
            path.display()
        )));
    }

    let count = paths.len() as u32;
    let index = section.min(count.saturating_sub(1));
    let chapter_path = &paths[index as usize];
    let xhtml = archive
        .read(chapter_path)?
        .map(|bytes| crate::xml::decode_xml_bytes(&bytes))
        .unwrap_or_default();

    Ok(EpubSectionRead {
        section_count: count,
        // 标题只取**本章**的 `<title>`：旧实现在这里顺带解压 spine 里**全部**章节
        // 只为攒一份 `titles`，而这份字段没有任何消费方（前端标题走
        // `book.toc`，章节名走本字段），于是打开一本 50 MiB 的 EPUB 会把整本书
        // 解压一遍又丢掉。2026-10-19 起只读目标章。
        title: crate::xml::element_text(&xhtml, "title").unwrap_or_default(),
        section: index,
        blocks: blocks_from_xhtml(&xhtml, chapter_path, &archive),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::block_char_count;
    use crate::block::{BookSpan, SpanStyle};
    use crate::epub_rich::clamp_size_em;
    use crate::inline::RUBY_NOTE_SIZE_EM;
    use crate::zip::build_test_zip;

    fn archive_with(files: &[(&str, &[u8], bool)]) -> ZipArchive {
        ZipArchive::from_bytes(build_test_zip(files)).expect("解析测试 ZIP 失败")
    }

    const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];

    /// 测试夹具：把纯文字包成一个无样式片段（大多数断言只关心文字）。
    fn text(s: &str) -> BookSpan {
        BookSpan::plain(s)
    }

    /// 取出块列表里的图片（`Figure` 包着 `Image`）：`(图片块, full_page, 图注)`。
    fn images(blocks: &[BookBlock]) -> Vec<(&BookBlock, bool, &[BookSpan])> {
        blocks
            .iter()
            .filter_map(|b| match b {
                BookBlock::Figure {
                    image,
                    caption,
                    full_page,
                } => Some((image.as_ref(), *full_page, caption.as_slice())),
                _ => None,
            })
            .collect()
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
                        color: None,
                        bg: None,
                        size_em: None,
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
        let found = images(&blocks);
        assert_eq!(found.len(), 1, "应当取出 1 张图：{blocks:?}");
        match found[0].0 {
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
            !images(&blocks).is_empty(),
            "SVG 的 xlink:href 图片应当被取出：{blocks:?}"
        );
    }

    #[test]
    fn unknown_image_format_is_reported_without_ext() {
        let xhtml = r#"<img src="i.bin"/>"#;
        let archive = archive_with(&[("i.bin", b"not an image", false)]);
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
        match images(&blocks)[0].0 {
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

    // ---- 彩色文字 / 字号（koodo 的"内联 style 生效"口径）----

    #[test]
    fn span_color_and_size_survive_into_blocks() {
        let xhtml = r#"<p><span style="color:#abc; font-size:150%">彩</span>字</p>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        match &blocks[0] {
            BookBlock::Paragraph { spans } => {
                let colored = spans
                    .iter()
                    .find(|s| s.color.is_some())
                    .expect("应有彩色片段");
                assert_eq!(colored.text, "彩");
                assert_eq!(colored.color.as_deref(), Some("#aabbcc"));
                assert_eq!(colored.size_em, clamp_size_em(1.5));
                // 颜色不得蔓延到后面的"字"上。
                let plain = spans.iter().find(|s| s.text == "字").expect("应有普通片段");
                assert!(plain.color.is_none());
            }
            other => panic!("不是段落：{other:?}"),
        }
    }

    #[test]
    fn block_container_color_is_inherited_by_child_text() {
        // 颜色写在**块级**容器上（`<div style="color:red">`）也要生效；
        // 且离开容器后不得漏到后面的文字上。
        let xhtml = r#"<div style="color:#0f0"><p>甲</p></div><p>乙</p>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        match &&blocks[0] {
            BookBlock::Paragraph { spans } => {
                assert_eq!(spans[0].color.as_deref(), Some("#00ff00"), "{blocks:?}");
            }
            other => panic!("不是段落：{other:?}"),
        }
        match &blocks[1] {
            BookBlock::Paragraph { spans } => {
                assert!(spans[0].color.is_none(), "颜色不得漏出容器：{blocks:?}");
            }
            other => panic!("不是段落：{other:?}"),
        }
    }

    #[test]
    fn mark_and_underline_produce_styles() {
        let xhtml = r#"<p><mark>高亮</mark><u>下划</u></p>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        match &blocks[0] {
            BookBlock::Paragraph { spans } => {
                assert!(spans
                    .iter()
                    .any(|s| s.styles.contains(&SpanStyle::Highlight)));
                assert!(spans
                    .iter()
                    .any(|s| s.styles.contains(&SpanStyle::Underline)));
            }
            other => panic!("不是段落：{other:?}"),
        }
    }

    #[test]
    fn ruby_note_is_kept_as_a_small_superscript() {
        let xhtml = r#"<p><ruby>漢<rt>kan</rt></ruby>字</p>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        match &blocks[0] {
            BookBlock::Paragraph { spans } => {
                let note = spans.iter().find(|s| s.text == "kan").expect("应有注音片段");
                assert!(note.styles.contains(&SpanStyle::Superscript));
                assert_eq!(note.size_em, Some(RUBY_NOTE_SIZE_EM));
            }
            other => panic!("不是段落：{other:?}"),
        }
    }

    // ---- Figure / full_page ----

    #[test]
    fn figure_with_figcaption_becomes_one_block() {
        let xhtml = r#"<body><p>前</p><figure><img src="../Images/p.png"/><figcaption>图注</figcaption></figure></body>"#;
        let archive = archive_with(&[("Images/p.png", PNG, false)]);
        let blocks = blocks_from_xhtml(xhtml, "Text/a.xhtml", &archive);
        assert_eq!(blocks.len(), 2, "figure 应整体成一个块：{blocks:?}");
        match &blocks[1] {
            BookBlock::Figure {
                image,
                caption,
                full_page,
            } => {
                assert!(matches!(image.as_ref(), BookBlock::Image { .. }));
                assert_eq!(
                    caption.iter().map(|s| s.text.as_str()).collect::<String>(),
                    "图注"
                );
                assert!(!full_page, "普通插图不是整页");
            }
            other => panic!("应当是 Figure：{other:?}"),
        }
    }

    #[test]
    fn figure_caption_carries_inline_styles() {
        // `<figcaption>` 里的行内样式走同一套解析（与 koodo 的"原样生效"等价）。
        let xhtml = r#"<figure><img src="i.png"/><figcaption><b>粗</b>注</figcaption></figure>"#;
        let archive = archive_with(&[("i.png", PNG, false)]);
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
        match &blocks[0] {
            BookBlock::Figure { caption, .. } => {
                assert!(caption
                    .iter()
                    .any(|s| s.styles.contains(&SpanStyle::Strong)));
            }
            other => panic!("应当是 Figure：{other:?}"),
        }
    }

    #[test]
    fn bare_img_becomes_a_figure_without_caption() {
        let xhtml = r#"<body><img src="Images/p.png"/></body>"#;
        let archive = archive_with(&[("Images/p.png", PNG, false)]);
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
        match &blocks[0] {
            BookBlock::Figure { caption, .. } => assert!(caption.is_empty(), "无图注"),
            other => panic!("应当是 Figure：{other:?}"),
        }
    }

    #[test]
    fn figure_without_figcaption_keeps_visible_text_as_caption() {
        // `<figure><img/><p>注</p></figure>`：没有 figcaption 也不能把注丢掉。
        let xhtml = r#"<figure><img src="i.png"/><p>说明文字</p></figure>"#;
        let archive = archive_with(&[("i.png", PNG, false)]);
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
        match &blocks[0] {
            BookBlock::Figure { caption, .. } => {
                let text: String = caption.iter().map(|s| s.text.as_str()).collect();
                assert_eq!(text, "说明文字", "图注不得凭空消失");
            }
            other => panic!("应当是 Figure：{other:?}"),
        }
    }

    #[test]
    fn empty_figure_produces_no_block() {
        let xhtml = r#"<body><p>a</p><figure></figure></body>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(
            blocks,
            vec![BookBlock::Paragraph {
                spans: vec![text("a")]
            }],
            "空 figure 不该产出空块：{blocks:?}"
        );
    }

    #[test]
    fn full_page_cover_figure_is_marked_on_the_block() {
        let xhtml = r#"<body><figure epub:type="cover"><img src="Images/c.png"/></figure></body>"#;
        let archive = archive_with(&[("Images/c.png", PNG, false)]);
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
        let found = images(&blocks);
        assert_eq!(found.len(), 1);
        assert!(found[0].1, "封面图应标 full_page：{blocks:?}");
    }

    #[test]
    fn full_page_hint_from_an_ancestor_div_is_honored() {
        // `<div class="cover"><img/></div>`：图不是 `figure`，但外层 div 声明了整页。
        let xhtml = r#"<body><div class="cover"><img src="Images/c.png"/></div></body>"#;
        let archive = archive_with(&[("Images/c.png", PNG, false)]);
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
        let found = images(&blocks);
        assert_eq!(found.len(), 1);
        assert!(found[0].1, "祖先 div 的 cover 应传到图片上：{blocks:?}");
    }

    #[test]
    fn figure_image_style_height_is_honored() {
        let xhtml = r#"<body><figure><img src="i.png" style="height:100%"/></figure></body>"#;
        let archive = archive_with(&[("i.png", PNG, false)]);
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
        assert!(images(&blocks)[0].1, "img 自己的 style 高度也算：{blocks:?}");
    }

    // ---- Comment（注释 / 脚注 / 侧栏）----

    #[test]
    fn aside_becomes_a_comment_block() {
        let xhtml = r#"<body><p>正文</p><aside><p>旁注</p></aside></body>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(
            blocks,
            vec![
                BookBlock::Paragraph {
                    spans: vec![text("正文")]
                },
                BookBlock::Comment {
                    label: None,
                    blocks: vec![BookBlock::Paragraph {
                        spans: vec![text("旁注")]
                    }],
                },
            ]
        );
    }

    #[test]
    fn epub_type_footnote_is_a_comment_with_a_label() {
        let xhtml = r#"<body><p>正文</p><aside epub:type="footnote"><p>注 1</p></aside></body>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(blocks.len(), 2);
        match &blocks[1] {
            BookBlock::Comment { label, blocks } => {
                assert_eq!(label.as_deref(), Some("footnote"), "label 取 epub:type 的值");
                assert_eq!(blocks.len(), 1);
            }
            other => panic!("应当是 Comment：{other:?}"),
        }
    }

    #[test]
    fn role_doc_footnote_and_class_note_are_comments() {
        for (xhtml, expect_label) in [
            (
                r#"<div role="doc-footnote"><p>注</p></div>"#,
                Some("doc-footnote"),
            ),
            (r#"<div class="note"><p>注</p></div>"#, Some("note")),
            (r#"<div class="annotation"><p>注</p></div>"#, Some("annotation")),
            (
                r#"<div class="sidebar" epub:type="sidebar"><p>侧栏</p></div>"#,
                Some("sidebar"),
            ),
            (r#"<div class="footnote"><p>注</p></div>"#, Some("footnote")),
        ] {
            let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
            match &blocks[0] {
                BookBlock::Comment { label, .. } => {
                    assert_eq!(label.as_deref(), expect_label, "{xhtml}");
                }
                other => panic!("「{xhtml}」应当是 Comment：{other:?}"),
            }
        }
    }

    #[test]
    fn comment_body_keeps_its_structure() {
        // 注释里可以有多段、列表、彩色文字——递归解析必须保住它们。
        let xhtml = r#"<aside epub:type="footnote"><p>第一段</p><p><span style="color:red">第二段</span></p></aside>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        match &blocks[0] {
            BookBlock::Comment { blocks, .. } => {
                assert_eq!(blocks.len(), 2, "注释里的两段都要在：{blocks:?}");
                match &blocks[1] {
                    BookBlock::Paragraph { spans } => {
                        assert_eq!(spans[0].color.as_deref(), Some("#ff0000"));
                    }
                    other => panic!("第二段应是段落：{other:?}"),
                }
            }
            other => panic!("应当是 Comment：{other:?}"),
        }
    }

    #[test]
    fn comment_with_nested_divs_is_not_truncated() {
        // 平衡配对：`<aside><div>…</div></aside>` 不能在第一个 `</div>` 处截断。
        let xhtml = r#"<aside class="note"><div><p>甲</p></div><p>乙</p></aside>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        match &blocks[0] {
            BookBlock::Comment { blocks, .. } => {
                assert!(
                    blocks.iter().any(|b| matches!(
                        b,
                        BookBlock::Paragraph { spans } if spans[0].text == "乙"
                    )),
                    "尾部内容不得被截断：{blocks:?}"
                );
            }
            other => panic!("应当是 Comment：{other:?}"),
        }
    }

    #[test]
    fn ordinary_div_is_not_a_comment() {
        let xhtml = r#"<div class="chapter"><p>正文</p></div>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert!(
            blocks
                .iter()
                .all(|b| !matches!(b, BookBlock::Comment { .. })),
            "普通 div 不该变成注释：{blocks:?}"
        );
    }

    // ---- PageBreak（章节**内部**的显式换页）----

    #[test]
    fn inline_page_break_between_paragraphs_is_kept() {
        let xhtml =
            r#"<body><p>a</p><div style="page-break-before:always"></div><p>b</p></body>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(
            blocks,
            vec![
                BookBlock::Paragraph {
                    spans: vec![text("a")]
                },
                BookBlock::PageBreak,
                BookBlock::Paragraph {
                    spans: vec![text("b")]
                },
            ],
            "章内显式换页应产出 PageBreak"
        );
    }

    #[test]
    fn page_break_on_a_container_with_content_is_kept() {
        let xhtml = r#"<body><p>a</p><div style="page-break-before:always"><p>b</p></div></body>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(
            blocks,
            vec![
                BookBlock::Paragraph {
                    spans: vec![text("a")]
                },
                BookBlock::PageBreak,
                BookBlock::Paragraph {
                    spans: vec![text("b")]
                },
            ],
            "{blocks:?}"
        );
    }

    #[test]
    fn leading_page_break_is_dropped() {
        // 首块换页 = 前导空白页，必须丢掉（Lead 的集成决策）。
        let xhtml = r#"<body><div style="page-break-before:always"></div><p>a</p></body>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(
            blocks,
            vec![BookBlock::Paragraph {
                spans: vec![text("a")]
            }],
            "首块换页不得产出：{blocks:?}"
        );
    }

    #[test]
    fn leading_page_break_on_a_container_with_content_is_dropped() {
        // `<div style="page-break-before:always"><p>a</p></div>` 作为首块应**不**产出。
        let xhtml = r#"<div style="page-break-before:always"><p>a</p></div>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(
            blocks,
            vec![BookBlock::Paragraph {
                spans: vec![text("a")]
            }],
            "{blocks:?}"
        );
    }

    #[test]
    fn trailing_page_break_is_dropped() {
        // 末尾换页 = 尾随空白，必须丢掉。
        let xhtml = r#"<body><p>a</p><div style="page-break-before:always"></div></body>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(
            blocks,
            vec![BookBlock::Paragraph {
                spans: vec![text("a")]
            }],
            "末尾换页不得产出：{blocks:?}"
        );
    }

    #[test]
    fn consecutive_page_breaks_collapse_to_one() {
        let xhtml = r#"<body><p>a</p><div style="page-break-before:always"></div><div style="page-break-before:always"></div><p>b</p></body>"#;
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        assert_eq!(
            blocks,
            vec![
                BookBlock::Paragraph {
                    spans: vec![text("a")]
                },
                BookBlock::PageBreak,
                BookBlock::Paragraph {
                    spans: vec![text("b")]
                },
            ],
            "连续换页只留一个：{blocks:?}"
        );
    }

    #[test]
    fn images_do_not_produce_page_breaks() {
        // 需求 5 的核查结论：koodo 对整页图用整页容器 + `object-fit:contain`，
        // **没有**任何分页符机制——图片不得合成 `PageBreak`。
        let xhtml = r#"<body><p>a</p><figure class="fullpage"><img src="Images/c.png"/></figure><p>b</p></body>"#;
        let archive = archive_with(&[("Images/c.png", PNG, false)]);
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
        assert!(
            blocks.iter().all(|b| !matches!(b, BookBlock::PageBreak)),
            "图片不得产出换页块：{blocks:?}"
        );
    }

    // ---- 章节换页：**不**在块里合成 PageBreak（由前端按 section 处理）----

    #[test]
    fn read_epub_section_does_not_synthesize_page_breaks() {
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
            }],
            "非首章也不得合成 PageBreak（前端按 section>0 换页）：{second:?}"
        );

        // 越界按最后一章处理（滚到底再请求一次不该变成错误态）。
        let past = read_epub_section(&path, 99).expect("越界不该报错");
        assert_eq!(past.section, 1);
    }

    // ---- 字符数覆盖新变体 ----

    #[test]
    fn char_counts_cover_figure_comment_and_page_break() {
        let figure = BookBlock::Figure {
            image: Box::new(BookBlock::Image {
                name: "i.png".into(),
                ext: Some("png"),
                bytes: PNG.to_vec(),
            }),
            caption: vec![text("图注")],
            full_page: false,
        };
        // 图注计入、图片本身不计。
        assert_eq!(block_char_count(&figure), 2);
        let comment = BookBlock::Comment {
            label: Some("footnote".into()),
            blocks: vec![BookBlock::Paragraph {
                spans: vec![text("注文")]
            }],
        };
        assert_eq!(block_char_count(&comment), 2, "注释正文要递归计入");
        assert_eq!(block_char_count(&BookBlock::PageBreak), 0);
        assert_eq!(
            crate::block::blocks_char_count(&[figure, comment, BookBlock::PageBreak]),
            4
        );
    }
}
