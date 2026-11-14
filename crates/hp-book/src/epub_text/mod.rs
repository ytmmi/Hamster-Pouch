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
//! [`crate::epub_rich`]：它们可以独立单测；本模块自己也于 D216 拆成目录，避免再顶到"单文件 ≤ 1200 行"的红线。

use std::path::Path;

use hp_core::{HpError, HpResult};

use crate::block::BookBlock;
use crate::zip::ZipArchive;

mod blocks;
mod spine;

#[cfg(test)]
mod tests;

pub use blocks::blocks_from_xhtml;
pub(crate) use blocks::element_inner_text;
pub(crate) use spine::{SpineRead, read_spine};

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
