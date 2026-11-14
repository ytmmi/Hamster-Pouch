//! EPUB 正文的**受控白名单**块转换（`epub_text` 的一部分，D216 从单文件拆出）。
//!
//! 只做"XHTML 片段 → `BookBlock` 列表"这一件事：安全边界与白名单口径写在
//! 父模块的文档里（[`super`]）。拆出来的理由同 `thumbnail`：正文循环 + 图片 / 图注
//! 抽取 + 行内状态机一起长到了两百多行的单函数体，而它们与 spine 读取、章节标题
//! 完全不相干。

use crate::block::BookBlock;
use crate::epub_rich::{
    ANCESTOR_TAGS, BLOCK_TAGS, SKIPPED_CONTENT, caption_from_visible_text, comment_label,
    element_inner_balanced, figcaption_inner, first_image_tag, heading_level, image_ref,
    is_full_page_image, is_page_break_tag, strip_tags, trim_page_breaks,
};
use crate::inline::{InlineState, RunBuilder, local_name, spans_from_html};
use crate::xml::{decode_entities, resolve_zip_path};
use crate::zip::ZipArchive;

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
        if closing
            && ANCESTOR_TAGS.contains(&name.as_str())
            && let Some(pos) = ancestors.iter().rposition(|(pushed, _)| *pushed == name)
        {
            ancestors.truncate(pos);
            inline.leave_block();
        }

        // `<figure>`：图片 + 图注整体抽取（见 [`figure_from_inner`]）。
        if name == "figure" {
            flush(&mut pending, &mut blocks);
            if !closing
                && let Some((inner, next)) = element_inner_balanced(xhtml, tag_end, "figure")
            {
                if let Some(block) = figure_from_inner(&inner, tag, chapter_path, archive) {
                    blocks.push(block);
                }
                at = next;
            }
            // 标签汤（没有配对的 `</figure>`）：退回普通块处理，内容不丢。
            continue;
        }

        // 注释容器（`aside` / `epub:type=footnote` / `role=doc-footnote` / `.footnote`）：
        // 内文**递归**解析成块（嵌套注释因此天然正确）。
        if let Some(label) = comment_label(&name, tag) {
            flush(&mut pending, &mut blocks);
            if !closing && let Some((inner, next)) = element_inner_balanced(xhtml, tag_end, &name) {
                // 递归：`inner` 里可以再有注释 / figure / 表格，口径完全一致。
                let inner_blocks = blocks_from_xhtml(&inner, chapter_path, archive);
                blocks.push(BookBlock::Comment {
                    label,
                    blocks: inner_blocks,
                });
                at = next;
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
