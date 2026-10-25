//! 目录（TOC）：EPUB 的 **nav / NCX** 目录树、**纯文本小说的内置章节规则**、Markdown 标题。
//!
//! ## 为什么需要这一层
//!
//! 查看器（`panel.viewer`）的口径是"**显示开头内容**"——它只按序一页页往下取，
//! 不知道"这本书有哪些章"。图书阅读器（`panel.bookreader`）要的是**目录跳转**：
//! 先拿到章节清单，再按某一章的位置取正文。本模块产出那份清单。
//!
//! ## 游标口径：**与 `book.content` 的 `cursor` 同语义**
//!
//! [`TocEntry::cursor`] 就是调用方随后要传给 `book.content` 的游标，**不另立一套坐标**：
//!
//! | 格式 | 游标语义 | 来源 |
//! | --- | --- | --- |
//! | EPUB | spine 的**章节序号** | nav / NCX 的 `href` 映射到 spine |
//! | 纯文本 | **字符偏移**（与 `text::page_at` 同口径） | 章节标题行首的字符位置 |
//! | Markdown | **顶层块序号**（与 `read_markdown_page` 同口径） | 标题块的下标 |
//!
//! 三套游标各自与读取路径一一对应，"目录跳转"因此不需要在桥接层做任何换算。
//!
//! ## 纯文本小说规则（用户 2026-10-16 口径）
//!
//! > "txt 文件使用内置规则识别创建目录（针对小说的优化）"
//!
//! txt **没有**任何结构信息——目录只能靠正文里的标题行认出来。规则是
//! [`novel_heading`]，覆盖中文小说的三类写法（章节 / 卷 / 特殊章）+ 英文章节：
//!
//! - `第<数字><章回节話话篇卷集部幕折>`（数字支持阿拉伯数字、全角数字与汉字数字）；
//! - `Chapter 12` / `Part 2` / `Prologue` 这类英文章节；
//! - `楔子` / `序章` / `番外` / `后记` 这类无序号章节。
//!
//! **防误判**是这套规则的主要成本，因此另有三条约束（每条都由单元测试钉住）：
//! 标题行**不超过 [`NOVEL_TITLE_MAX_CHARS`] 个字**、**不以句读收尾**、
//! 且"第 + 数字"后面必须紧跟**章节量词**（`第二天早上…` 里的"天"不是量词 → 不认）。
//!
//! **边界如实说明**：这是启发式，不是解析。标题行混在正文里、以句读结尾的怪写法、
//! 或既没有空行也没有量词的"第 X 节"变体都可能漏认或误认。规则**只增不改**地演进
//! （新增写法加一条分支 + 一条测试），不做"按书调参"。

use std::path::Path;

use hp_core::{HpError, HpResult};

use crate::block::BookBlock;
use crate::epub_text::{SpineRead, element_inner_text, read_spine};
use crate::inline::local_name;
use crate::xml::{attr_value, decode_entities, element_text, open_tags, resolve_zip_path};
use crate::zip::ZipArchive;

/// 目录项上限：目录是**一次 IPC 传回**的，畸形书（几千个 navPoint）不该撑爆返回体。
///
/// 2000 条对应"一部长篇连载"的量级（真机语料里最长的一本 53 章）；
/// 超过即截断——**截断不是错误**，阅读器仍能按章往下读。
pub const TOC_MAX_ENTRIES: usize = 2000;

/// 目录项标题的字符上限（EPUB 的 `<a>` 里偶尔会塞进整段文字）。
const TITLE_MAX_CHARS: usize = 80;

/// 纯文本候选标题行的字符上限：小说的章节标题远短于此，长行一律是正文。
const NOVEL_TITLE_MAX_CHARS: usize = 60;

/// 目录的一项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TocEntry {
    /// 章节标题。
    ///
    /// **可能是空串**：EPUB 的 `<title>` 缺失或不是章节名时如实留空，
    /// 由前端按 i18n 显示序号（后端不内联用户可见文案）。
    pub title: String,
    /// 层级（1 = 顶层）。
    ///
    /// EPUB 取自 nav / NCX 的嵌套深度；纯文本按"卷"分组；Markdown 用标题层级。
    pub level: u32,
    /// 跳转游标（语义见模块文档的表）。
    pub cursor: String,
}

/// 折叠空白并裁到上限（XML 内文里的换行与缩进不是标题的一部分）。
fn clean_title(raw: &str) -> String {
    let decoded = decode_entities(raw);
    let mut out = String::with_capacity(decoded.len());
    let mut prev_space = false;
    for ch in decoded.chars() {
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out.trim().chars().take(TITLE_MAX_CHARS).collect()
}

/// 把目录里的 `href` / `src` 映射成 **spine 序号**。
///
/// 片段（`#toc`）与空目标不算章节；**大小写不敏感**比对是刻意的容错——实测包里
/// 存在 nav 写 `Text/a.xhtml`、manifest 写 `text/a.xhtml` 的书，而 `resolve_zip_path`
/// 按规格不做大小写猜测。猜错的代价只是"这一条目录项被丢掉"（宁缺勿错）。
fn section_of(spine_paths: &[String], base_path: &str, href: &str) -> Option<usize> {
    let target = href.split('#').next().unwrap_or("");
    if target.trim().is_empty() {
        return None;
    }
    let resolved = resolve_zip_path(base_path, target).to_ascii_lowercase();
    spine_paths
        .iter()
        .position(|p| p.to_ascii_lowercase() == resolved)
}

/// EPUB3：`<nav epub:type="toc">` 里的嵌套 `<ol>` → 目录项。
///
/// 层级取 `<ol>` 的嵌套深度（nav 的根 `<ol>` 即第 1 层）。
fn nav_entries(nav: &str, nav_path: &str, spine_paths: &[String]) -> Vec<TocEntry> {
    let mut out: Vec<TocEntry> = Vec::new();
    let mut depth: u32 = 0;
    let mut at = 0usize;
    while let Some(rel) = nav[at..].find('<') {
        let start = at + rel;
        let Some(gt) = nav[start..].find('>') else {
            break;
        };
        let end = start + gt + 1;
        let tag = &nav[start..end];
        at = end;
        if tag.starts_with("<!--") || tag.starts_with("<!") || tag.starts_with("<?") {
            continue;
        }
        let name = local_name(tag);
        let closing = tag.starts_with("</");
        let self_closing = tag.trim_end().ends_with("/>");

        if name == "ol" || name == "ul" {
            if closing {
                depth = depth.saturating_sub(1);
            } else if !self_closing {
                depth += 1;
            }
            continue;
        }
        if name != "a" || closing {
            continue;
        }
        let Some(href) = attr_value(tag, "href") else {
            continue;
        };
        let Some((raw_title, next)) = element_inner_text(nav, at, "a") else {
            continue;
        };
        at = next;
        let title = clean_title(&raw_title);
        let Some(section) = section_of(spine_paths, nav_path, &href) else {
            continue;
        };
        out.push(TocEntry {
            title,
            level: depth.max(1),
            cursor: section.to_string(),
        });
        if out.len() >= TOC_MAX_ENTRIES {
            break;
        }
    }
    out
}

/// EPUB2：NCX 的 `<navPoint>` 树 → 目录项（嵌套 `navPoint` 即层级）。
fn ncx_entries(ncx: &str, ncx_path: &str, spine_paths: &[String]) -> Vec<TocEntry> {
    let mut out: Vec<TocEntry> = Vec::new();
    let mut depth: u32 = 0;
    let mut pending_title: Option<String> = None;
    let mut at = 0usize;
    while let Some(rel) = ncx[at..].find('<') {
        let start = at + rel;
        let Some(gt) = ncx[start..].find('>') else {
            break;
        };
        let end = start + gt + 1;
        let tag = &ncx[start..end];
        at = end;
        if tag.starts_with("<!--") || tag.starts_with("<!") || tag.starts_with("<?") {
            continue;
        }
        let name = local_name(tag);
        let closing = tag.starts_with("</");
        let self_closing = tag.trim_end().ends_with("/>");

        if name == "navpoint" {
            if closing {
                depth = depth.saturating_sub(1);
            } else if !self_closing {
                depth += 1;
            }
            continue;
        }
        if name == "text" && !closing {
            if let Some((raw, next)) = element_inner_text(ncx, at, "text") {
                at = next;
                pending_title = Some(clean_title(&raw));
            }
            continue;
        }
        if name == "content" && !closing {
            let Some(src) = attr_value(tag, "src") else {
                continue;
            };
            let title = pending_title.take().unwrap_or_default();
            let Some(section) = section_of(spine_paths, ncx_path, &src) else {
                continue;
            };
            out.push(TocEntry {
                title,
                level: depth.max(1),
                cursor: section.to_string(),
            });
            if out.len() >= TOC_MAX_ENTRIES {
                break;
            }
        }
    }
    out
}

/// 找出 OPF 里声明为目录的条目路径。
///
/// 顺序：`<item properties="nav">`（EPUB3）→ `application/x-dtbncx+xml`（EPUB2）
/// → `<spine toc="<id>">` 指向的条目（封面之外最常见的 NCX 写法）。
fn toc_href(spine: &SpineRead) -> Option<String> {
    let items = open_tags(&spine.opf, "item");
    let nav = items.iter().find(|tag| {
        attr_value(tag, "properties")
            .is_some_and(|p| p.split_whitespace().any(|v| v.eq_ignore_ascii_case("nav")))
    });
    if let Some(href) = nav.and_then(|tag| attr_value(tag, "href")) {
        return Some(href);
    }
    let ncx = items.iter().find(|tag| {
        attr_value(tag, "media-type")
            .is_some_and(|m| m.eq_ignore_ascii_case("application/x-dtbncx+xml"))
    });
    if let Some(href) = ncx.and_then(|tag| attr_value(tag, "href")) {
        return Some(href);
    }
    let id = open_tags(&spine.opf, "spine")
        .first()
        .and_then(|tag| attr_value(tag, "toc"))?;
    items
        .iter()
        .find(|tag| attr_value(tag, "id").as_deref() == Some(id.as_str()))
        .and_then(|tag| attr_value(tag, "href"))
}

/// 兜底：逐章取该章 XHTML 的 `<title>`（与查看器的章节标题同源）。
///
/// 实测语料里有两本书既没有 nav 也没有 NCX；此时"章节清单"仍然存在（spine），
/// 只是没有作者写的标题——标题留空，由前端显示序号。
fn spine_titles(archive: &ZipArchive, spine: &SpineRead) -> Vec<TocEntry> {
    spine
        .paths
        .iter()
        .enumerate()
        .take(TOC_MAX_ENTRIES)
        .map(|(index, path)| TocEntry {
            title: archive
                .read(path)
                .ok()
                .flatten()
                .map(|bytes| crate::xml::decode_xml_bytes(&bytes))
                .and_then(|xhtml| element_text(&xhtml, "title"))
                .map(|title| clean_title(&title))
                .unwrap_or_default(),
            level: 1,
            cursor: index.to_string(),
        })
        .collect()
}

/// 读一本 EPUB 的目录（nav → NCX → 各章 `<title>` 兜底）。
pub fn read_epub_toc(path: &Path) -> HpResult<Vec<TocEntry>> {
    let archive = ZipArchive::open(path)?;
    let Some(spine) = read_spine(&archive)? else {
        return Err(HpError::Io(format!(
            "EPUB 缺少 OPF 清单：{}",
            path.display()
        )));
    };
    if spine.paths.is_empty() {
        return Ok(Vec::new());
    }

    if let Some(href) = toc_href(&spine) {
        let toc_path = resolve_zip_path(&spine.opf_path, &href);
        if let Some(bytes) = archive.read(&toc_path)? {
            let xml = crate::xml::decode_xml_bytes(&bytes);
            // NCX 与 nav 都能被同一个扫描器安全处理（互不认识的标签被忽略），
            // 因此按文件名后缀分流只是为了让两条路径各留一份可测的入口。
            let entries = if toc_path.to_ascii_lowercase().ends_with(".ncx") {
                ncx_entries(&xml, &toc_path, &spine.paths)
            } else {
                nav_entries(&xml, &toc_path, &spine.paths)
            };
            if !entries.is_empty() {
                return Ok(entries);
            }
        }
    }

    Ok(spine_titles(&archive, &spine))
}

/// 中文数字与全角数字（章节序号里出现的全部字符）。
const CN_NUMERALS: &str =
    "0123456789０１２３４５６７８９〇零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟廿卅";

/// 章节量词（`第一章` 里的"章"）。
const CHAPTER_UNITS: &str = "章回节話话篇卷集部幕折";

/// "卷"型量词：目录里作为分组层（其下章节缩进一级）。
const VOLUME_UNITS: &str = "卷部集";

/// 无序号章节的固定写法（简繁并列；**不用单字"序"**——它在正文里太常见）。
const SPECIAL_HEADINGS: [&str; 20] = [
    "楔子",
    "序章",
    "序言",
    "序幕",
    "引子",
    "前言",
    "尾声",
    "终章",
    "终曲",
    "后记",
    "後記",
    "后序",
    "番外",
    "外传",
    "外傳",
    "附录",
    "附錄",
    "完本感言",
    "作者的话",
    "作者的話",
];

/// 标题行的种类（决定层级）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HeadingKind {
    /// 卷 / 部 / 集（其下章节缩进一级）。
    Volume,
    /// 章 / 回 / 节 / 特殊章 / 英文章节。
    Chapter,
}

/// 中文写法：`第<数字><量词>`（数字 1–12 个字符，量词取自 [`CHAPTER_UNITS`]）。
fn chinese_heading_kind(line: &str) -> Option<HeadingKind> {
    let mut chars = line.chars();
    if chars.next()? != '第' {
        return None;
    }
    let mut numerals = 0usize;
    let mut unit: Option<char> = None;
    for ch in chars.by_ref() {
        if CN_NUMERALS.contains(ch) && numerals < 12 {
            numerals += 1;
            continue;
        }
        unit = Some(ch);
        break;
    }
    if numerals == 0 {
        return None;
    }
    let unit = unit?;
    if !CHAPTER_UNITS.contains(unit) {
        return None;
    }
    Some(if VOLUME_UNITS.contains(unit) {
        HeadingKind::Volume
    } else {
        HeadingKind::Chapter
    })
}

/// `hay` 是否以 `needle` 开头（只折叠 ASCII 大小写）。
///
/// 用它替代"整行 `to_ascii_lowercase()` 再 `strip_prefix`"：旧写法每判一行都要
/// 分配一个与行等长的 `String`，而目录扫描要对全书的每一行都判一次。
fn starts_with_ignore_ascii_case(hay: &str, needle: &str) -> bool {
    hay.len() >= needle.len()
        && hay.as_bytes()[..needle.len()].eq_ignore_ascii_case(needle.as_bytes())
}

/// 英文写法：`Chapter 12` / `Part 2` / `Prologue`（大小写不敏感）。
///
/// 数字位只认阿拉伯数字与罗马数字：`Chapter one` 这类拼写**不认**——
/// 把 `Part of me…` 这种正文行误认成标题的代价，大于漏掉少量拼写数字的章节。
fn english_heading_kind(line: &str) -> Option<HeadingKind> {
    for (word, kind) in [
        ("chapter", HeadingKind::Chapter),
        ("part", HeadingKind::Volume),
    ] {
        if !starts_with_ignore_ascii_case(line, word) {
            continue;
        }
        let rest = &line[word.len()..];
        let rest = rest.trim_start_matches([' ', '.', ':', '-', '—', '、', '　']);
        let next = rest.chars().next()?;
        if next.is_ascii_digit() || "ivxlcdm".contains(next) {
            return Some(kind);
        }
    }
    for word in ["prologue", "epilogue", "interlude"] {
        if !starts_with_ignore_ascii_case(line, word) {
            continue;
        }
        let rest = &line[word.len()..];
        if rest.is_empty() || rest.starts_with(' ') {
            return Some(HeadingKind::Chapter);
        }
    }
    None
}

/// 固定写法：`楔子`、`番外 一`、`后记：…`。
fn special_heading_kind(line: &str) -> Option<HeadingKind> {
    for word in SPECIAL_HEADINGS {
        let Some(rest) = line.strip_prefix(word) else {
            continue;
        };
        if rest.is_empty() {
            return Some(HeadingKind::Chapter);
        }
        let next = rest.chars().next()?;
        let separator = next.is_whitespace()
            || next.is_ascii_digit()
            || CN_NUMERALS.contains(next)
            || "：:、.-—（(【「".contains(next);
        if separator {
            return Some(HeadingKind::Chapter);
        }
    }
    None
}

/// 折叠空白（标题行内部的连续空白归一为一个空格）。
fn clean_heading(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut prev_space = false;
    for ch in line.chars() {
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out.trim().chars().take(NOVEL_TITLE_MAX_CHARS).collect()
}

/// 首字符是否**有可能**出现在标题里（便宜的预筛）。
///
/// 目录扫描要为全书每一行判一次 [`novel_heading`]，而小说正文里绝大多数行
/// 连"像标题"都谈不上（首字符是"他""我""这"……）。三条判据的首字符集合是有限的：
/// 中文 `第`、英文 `c`/`p`/`e`/`i`（chapter/part/prologue/epilogue/interlude）、
/// 固定写法那 20 条的首字。先用一次 `chars().next()` 把其余行挡掉，
/// 长度计数、控制字符扫描、逐条 `strip_prefix` 就都不用做了。
fn plausible_heading_start(ch: char) -> bool {
    if ch == '第' || matches!(ch.to_ascii_lowercase(), 'c' | 'p' | 'e' | 'i') {
        return true;
    }
    SPECIAL_HEADINGS.iter().any(|word| word.starts_with(ch))
}

/// 判断一行是否是**小说章节标题**，返回（种类，展示标题）。
///
/// 防误判的三条约束见模块文档；命中后返回的标题已折叠空白。
///
/// `pub(crate)`：这是本模块的内部判据，对外只暴露 [`text_toc`]——
/// 调用方要的是"整本书的目录"，不是"这一行算不算标题"。
pub(crate) fn novel_heading(line: &str) -> Option<(HeadingKind, String)> {
    // 三条约束全是"不满足就 None"的过滤，彼此独立，因此可以先跑最便宜的那条。
    let first = line.chars().next()?;
    if !plausible_heading_start(first) {
        return None;
    }
    // 字节数 ≤ 上限 ⇒ 字符数必然 ≤ 上限，省掉一次 `chars().count()`。
    if line.len() > NOVEL_TITLE_MAX_CHARS && line.chars().count() > NOVEL_TITLE_MAX_CHARS {
        return None;
    }
    if line.chars().any(|c| c.is_control()) {
        return None;
    }
    // 以句读收尾的几乎都是正文（"他翻到第一章，看了很久。"）。
    if line.ends_with(['。', '，', '、', '；', '：', '…']) {
        return None;
    }
    let kind = chinese_heading_kind(line)
        .or_else(|| english_heading_kind(line))
        .or_else(|| special_heading_kind(line))?;
    Some((kind, clean_heading(line)))
}

/// 纯文本目录：按内置规则扫出章节标题行，游标 = 该行行首的**字符偏移**。
///
/// 偏移与 [`crate::text::page_at`] 同口径（按 `char` 计，不是字节）——同一本书换个
/// 编码（GBK / UTF-8）游标语义不变。行首的缩进不计入（跳过去正好从标题开始读）。
pub fn text_toc(text: &str) -> Vec<TocEntry> {
    let mut out: Vec<TocEntry> = Vec::new();
    let mut offset = 0usize;
    let mut seen_volume = false;
    for raw in text.split_inclusive('\n') {
        let line = raw.trim_end_matches(|c| c == '\n' || c == '\r');
        let trimmed = line.trim_start();
        let start_offset = offset + (line.chars().count() - trimmed.chars().count());
        offset += raw.chars().count();
        if trimmed.is_empty() {
            continue;
        }
        let Some((kind, title)) = novel_heading(trimmed) else {
            continue;
        };
        if kind == HeadingKind::Volume {
            seen_volume = true;
        }
        let level = match kind {
            HeadingKind::Volume => 1,
            // 有"卷"时章节缩进一级；只有章节的书保持平铺（层级不凭空造出来）。
            HeadingKind::Chapter => {
                if seen_volume {
                    2
                } else {
                    1
                }
            }
        };
        out.push(TocEntry {
            title,
            level,
            cursor: start_offset.to_string(),
        });
        if out.len() >= TOC_MAX_ENTRIES {
            break;
        }
    }
    out
}

/// Markdown 目录：取**顶层标题块**，游标 = 该块的序号（`book.content` 的 md 游标）。
///
/// 只取顶层：`read_markdown_page` 的分页单位就是顶层块，用嵌套块的下标跳转会落错位置。
pub fn markdown_toc(blocks: &[BookBlock]) -> Vec<TocEntry> {
    let mut out: Vec<TocEntry> = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        let BookBlock::Heading { level, spans } = block else {
            continue;
        };
        let raw: String = spans.iter().map(|span| span.text.as_str()).collect();
        let title = clean_title(&raw);
        if title.is_empty() {
            continue;
        }
        out.push(TocEntry {
            title,
            level: u32::from(*level).max(1),
            cursor: index.to_string(),
        });
        if out.len() >= TOC_MAX_ENTRIES {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::BookSpan;
    use crate::zip::build_test_zip;

    fn container(rootfile: &str) -> String {
        format!(
            r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="{rootfile}" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#
        )
    }

    /// 造一本 EPUB（OPF + container + 额外条目），返回临时目录与路径。
    fn write_epub(
        name: &str,
        opf: &str,
        extra: &[(&str, &[u8])],
    ) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join(name);
        let mut files: Vec<(String, Vec<u8>, bool)> = vec![
            ("mimetype".into(), b"application/epub+zip".to_vec(), false),
            ("OEBPS/content.opf".into(), opf.as_bytes().to_vec(), true),
            (
                "META-INF/container.xml".into(),
                container("OEBPS/content.opf").into_bytes(),
                true,
            ),
        ];
        for (entry, body) in extra {
            files.push(((*entry).to_string(), body.to_vec(), true));
        }
        let refs: Vec<(&str, &[u8], bool)> = files
            .iter()
            .map(|(n, b, c)| (n.as_str(), b.as_slice(), *c))
            .collect();
        std::fs::write(&path, build_test_zip(&refs)).expect("写入 EPUB 失败");
        (dir, path)
    }

    fn chapter(title: &str, body: &str) -> String {
        format!("<html><head><title>{title}</title></head><body><p>{body}</p></body></html>")
    }

    // ==================== EPUB3 nav ====================

    #[test]
    fn epub3_nav_gives_nested_titles_and_section_cursors() {
        let opf = r#"<package><metadata/><manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml"/>
          <item id="c2" href="Text/c2.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
        <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>"#;
        let nav = r#"<html><body><nav epub:type="toc"><ol>
          <li><a href="Text/c1.xhtml">序章 『愚者的坚持』</a>
            <ol><li><a href="Text/c1.xhtml#s1">第一节</a></li></ol>
          </li>
          <li><a href="Text/c2.xhtml">第一章 &amp; 之后</a></li>
        </ol></nav></body></html>"#;
        let (_dir, path) = write_epub(
            "nav.epub",
            opf,
            &[
                ("OEBPS/nav.xhtml", nav.as_bytes()),
                ("OEBPS/Text/c1.xhtml", chapter("一", "正文一").as_bytes()),
                ("OEBPS/Text/c2.xhtml", chapter("二", "正文二").as_bytes()),
            ],
        );
        let entries = read_epub_toc(&path).expect("解析目录失败");
        assert_eq!(
            entries,
            vec![
                TocEntry {
                    title: "序章 『愚者的坚持』".into(),
                    level: 1,
                    cursor: "0".into()
                },
                // 片段 href 映射到**同一章**（`#s1` 被忽略），层级取自 `<ol>` 嵌套。
                TocEntry {
                    title: "第一节".into(),
                    level: 2,
                    cursor: "0".into()
                },
                TocEntry {
                    title: "第一章 & 之后".into(),
                    level: 1,
                    cursor: "1".into()
                },
            ]
        );
    }

    // ==================== EPUB2 NCX ====================

    #[test]
    fn epub2_ncx_is_parsed_with_levels() {
        let opf = r#"<package><metadata/><manifest>
          <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
          <item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml"/>
          <item id="c2" href="Text/c2.xhtml" media-type="application/xhtml+xml"/>
        </manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>"#;
        let ncx = r#"<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
  <navPoint id="n1"><navLabel><text>楔子</text></navLabel><content src="Text/c1.xhtml"/>
    <navPoint id="n1a"><navLabel><text>上</text></navLabel><content src="Text/c1.xhtml"/></navPoint>
  </navPoint>
  <navPoint id="n2"><navLabel><text>第一章</text></navLabel><content src="Text/c2.xhtml"/></navPoint>
</navMap></ncx>"#;
        let (_dir, path) = write_epub(
            "ncx.epub",
            opf,
            &[
                ("OEBPS/toc.ncx", ncx.as_bytes()),
                ("OEBPS/Text/c1.xhtml", chapter("一", "正文一").as_bytes()),
                ("OEBPS/Text/c2.xhtml", chapter("二", "正文二").as_bytes()),
            ],
        );
        let entries = read_epub_toc(&path).expect("解析目录失败");
        let got: Vec<(String, u32, String)> = entries
            .into_iter()
            .map(|e| (e.title, e.level, e.cursor))
            .collect();
        assert_eq!(
            got,
            vec![
                ("楔子".into(), 1, "0".into()),
                ("上".into(), 2, "0".into()),
                ("第一章".into(), 1, "1".into()),
            ]
        );
    }

    // ==================== 兜底 ====================

    #[test]
    fn falls_back_to_chapter_titles_when_no_toc_document_exists() {
        let opf = r#"<package><metadata/><manifest>
          <item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml"/>
          <item id="c2" href="Text/c2.xhtml" media-type="application/xhtml+xml"/>
        </manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>"#;
        let (_dir, path) = write_epub(
            "plain.epub",
            opf,
            &[
                ("OEBPS/Text/c1.xhtml", chapter("序章", "正文一").as_bytes()),
                // 没有 `<title>` 的章节：标题留空（由前端显示序号）。
                (
                    "OEBPS/Text/c2.xhtml",
                    b"<html><body><p>\xe6\xad\xa3\xe6\x96\x87</p></body></html>",
                ),
            ],
        );
        let entries = read_epub_toc(&path).expect("解析目录失败");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].title, "序章");
        assert_eq!(entries[0].cursor, "0");
        assert_eq!(entries[1].title, "", "缺 <title> 时如实留空");
        assert_eq!(entries[1].cursor, "1");
    }

    #[test]
    fn nav_entries_pointing_outside_the_spine_are_dropped_not_guessed() {
        let opf = r#"<package><metadata/><manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml"/>
        </manifest><spine><itemref idref="c1"/></spine></package>"#;
        let nav = r#"<nav><ol>
          <li><a href="cover.xhtml">封面</a></li>
          <li><a href="Text/c1.xhtml">第一章</a></li>
        </ol></nav>"#;
        let (_dir, path) = write_epub(
            "drop.epub",
            opf,
            &[
                ("OEBPS/nav.xhtml", nav.as_bytes()),
                ("OEBPS/Text/c1.xhtml", chapter("一", "正文").as_bytes()),
            ],
        );
        let entries = read_epub_toc(&path).expect("解析目录失败");
        assert_eq!(entries.len(), 1, "spine 之外的条目应被丢掉：{entries:?}");
        assert_eq!(entries[0].title, "第一章");
    }

    // ==================== 纯文本小说规则 ====================

    #[test]
    fn txt_chapters_are_found_with_character_offsets() {
        let text = "\u{3000}\u{3000}第一章 山边小村\n\n他抬起头。\n第二章 青牛镇\n第二天早上，他醒了。\n第三章 七玄门\n";
        let entries = text_toc(text);
        let got: Vec<(String, u32, String)> = entries
            .into_iter()
            .map(|e| (e.title, e.level, e.cursor))
            .collect();
        // 行首缩进（两个全角空格）不计入游标：跳过去正好从"第"字开始读。
        // 偏移逐个手算：第 2 章在 18（"第二章"前面共 18 个字符：2 缩进 + 8 标题 +
        // 2 换行 + 5 正文 + 1 换行 = 18），第 3 章在 37。
        assert_eq!(
            got,
            vec![
                ("第一章 山边小村".into(), 1, "2".into()),
                ("第二章 青牛镇".into(), 1, "18".into()),
                ("第三章 七玄门".into(), 1, "37".into()),
            ]
        );
    }

    #[test]
    fn txt_prose_that_merely_mentions_chapters_is_not_a_heading() {
        let text = "第二天早上，他醒了过来，发现自己躺在一张陌生的床上。\n\
                    他翻到第一章，看了很久。\n\
                    第一章\n";
        let entries = text_toc(text);
        assert_eq!(entries.len(), 1, "只有独占一行的标题算目录项：{entries:?}");
        assert_eq!(entries[0].title, "第一章");
    }

    #[test]
    fn txt_volumes_group_chapters_one_level_deeper() {
        let text = "第一卷 风起\n第一章 出发\n第二章 路上\n第二卷 云涌\n第一章 归来\n";
        let entries = text_toc(text);
        let got: Vec<(String, u32)> = entries.into_iter().map(|e| (e.title, e.level)).collect();
        assert_eq!(
            got,
            vec![
                ("第一卷 风起".into(), 1),
                ("第一章 出发".into(), 2),
                ("第二章 路上".into(), 2),
                ("第二卷 云涌".into(), 1),
                // 第二卷之下的"第一章"仍是第 2 层（分组状态是"这本书有卷"）。
                ("第一章 归来".into(), 2),
            ]
        );
    }

    #[test]
    fn txt_special_and_english_headings_are_recognized() {
        let text = "楔子\n序章 雪\n番外 一\nChapter 1\nPrologue\nPart of me wanted to leave.\n";
        let entries = text_toc(text);
        let titles: Vec<String> = entries.into_iter().map(|e| e.title).collect();
        assert_eq!(
            titles,
            vec!["楔子", "序章 雪", "番外 一", "Chapter 1", "Prologue"],
            "正文行 `Part of me…` 不得被认成标题"
        );
    }

    #[test]
    fn txt_headings_longer_than_the_limit_are_ignored() {
        let long = format!("第一章 {}", "字".repeat(NOVEL_TITLE_MAX_CHARS));
        assert!(text_toc(&long).is_empty(), "超长行一律按正文处理");
    }

    // ==================== Markdown ====================

    #[test]
    fn markdown_toc_uses_top_level_block_indices() {
        let blocks = vec![
            BookBlock::Paragraph {
                spans: vec![BookSpan::plain("前言")],
            },
            BookBlock::Heading {
                level: 2,
                spans: vec![BookSpan::plain("第一章 出发")],
            },
            BookBlock::Paragraph {
                spans: vec![BookSpan::plain("正文")],
            },
            BookBlock::Heading {
                level: 3,
                spans: vec![BookSpan::plain("小节")],
            },
        ];
        let entries = markdown_toc(&blocks);
        let got: Vec<(String, u32, String)> = entries
            .into_iter()
            .map(|e| (e.title, e.level, e.cursor))
            .collect();
        assert_eq!(
            got,
            vec![
                ("第一章 出发".into(), 2, "1".into()),
                ("小节".into(), 3, "3".into()),
            ]
        );
    }
}
