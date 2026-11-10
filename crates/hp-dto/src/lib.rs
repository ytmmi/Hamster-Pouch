//! hp-dto：跨层 DTO 的单一事实来源（docs/spec/shared-types.md）。
//!
//! 本 crate 只承载命令请求/响应与事件载荷的纯数据 DTO，不依赖 Tauri/SQLite；
//! 前端 `packages/shared-types` 由这些类型生成（`pnpm generate:types`）。
//!
//! 命名约定：返回值/事件负载字段使用 snake_case（serde 默认）；命令参数键使用
//! camelCase（Tauri v2 自动映射），因此参数类型不在本 crate 生成。

use serde::Serialize;
use ts_rs::TS;

/// repo.create / repo.open 返回。
#[derive(Serialize, TS)]
pub struct RepoSummary {
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub schema_version: i64,
}

/// repo.list 返回元素。
#[derive(Serialize, TS)]
pub struct RepoListItem {
    pub id: String,
    pub name: String,
    pub repo_db_path: String,
    pub created_at: String,
    pub last_opened_at: Option<String>,
}

/// source.* 返回元素。
#[derive(Serialize, TS)]
pub struct SourceItem {
    pub id: String,
    pub repo_id: String,
    pub local_path: String,
    pub alias: Option<String>,
    pub parent_source_id: Option<String>,
    pub mounted: bool,
    pub mounted_at: String,
}

/// album.members / file.query 返回元素。
#[derive(Serialize, TS)]
pub struct AlbumFileItem {
    pub id: String,
    pub source_id: String,
    pub relative_path: String,
    pub media_type: String,
    /// 文件的**标记集合**（D102：可多值、与类目正交；`book` / `manga` / …）。
    ///
    /// 恒为数组（可能为空）；不再是单值"子类型"——用户口径是"标记可以交叉"，
    /// 一个文件可以同时带多个标记。
    pub marks: Vec<String>,
    #[ts(type = "number")]
    pub size: i64,
    pub mtime: String,
    /// 图片**显示宽高**（EXIF 方向已应用，缺陷 0043）。非图片或回填未覆盖时为 `null`。
    ///
    /// 是"宽度/高度"而不是宽高比：消费方自己算比例，避免再存一份必然漂移的派生值。
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// file.metadata 返回。
#[derive(Serialize, TS)]
pub struct FileMetadataResult {
    pub id: String,
    pub source_id: String,
    pub relative_path: String,
    pub media_type: String,
    /// 文件的**标记集合**（见 [`AlbumFileItem::marks`]）。
    pub marks: Vec<String>,
    pub content_hash: Option<String>,
    #[ts(type = "number")]
    pub size: i64,
    pub mtime: String,
    pub verify_status: String,
    pub media_info_json: Option<String>,
    pub exif_json: Option<String>,
    /// 图片**显示宽高**（与 [`AlbumFileItem::width`] 同一口径）。
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// plugin.list 返回元素。
#[derive(Serialize, TS)]
pub struct PluginItem {
    pub id: String,
    pub name: String,
    pub version: String,
    pub trust_level: String,
    pub source_kind: String,
    pub source_ref: Option<String>,
    pub runtime_kind: String,
    pub installed_at: String,
    /// 插件**声明**的能力（`plugin.manifest` 的 `capabilities`）。
    ///
    /// 前端启用时只能请求这里的子集。纯数据扩展包（`static-data`）为空，
    /// 启用时不应请求任何能力。
    pub capabilities: Vec<String>,
}

/// plugin.discover 返回元素。
#[derive(Serialize, TS)]
pub struct DiscoveredPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
}

/// plugin.state 返回。
#[derive(Serialize, TS)]
pub struct PluginStateItem {
    pub plugin_id: String,
    pub repo_id: String,
    pub enabled: bool,
    pub grants: Vec<String>,
}

/// plugin.load 返回。
#[derive(Serialize, TS)]
pub struct PluginLoadItem {
    pub plugin_id: String,
    pub repo_id: String,
    pub runtime_kind: String,
    pub api_version: u32,
    pub grants: Vec<String>,
}

/// ai.config.* 返回。
#[derive(Serialize, TS)]
pub struct AiConfigItem {
    pub id: String,
    pub provider: String,
    pub model: Option<String>,
    pub config_json: String,
    pub created_at: String,
}

/// ai.tagging.status 返回。
#[derive(Serialize, TS)]
pub struct AiTaskItem {
    pub task_id: String,
    pub status: String,
}

/// ai.tagging.run 返回。
#[derive(Serialize, TS)]
pub struct AiRunSummary {
    #[ts(type = "number")]
    pub processed: usize,
    #[ts(type = "number")]
    pub written: usize,
    #[ts(type = "number")]
    pub overwritten: usize,
    pub undo_ids: Vec<String>,
}

/// fsops.copy / fsops.move 返回。
#[derive(Serialize, TS)]
pub struct FsOpsResult {
    pub op_record_id: String,
    pub affected: Vec<String>,
}

/// tag.list 返回元素。
#[derive(Serialize, TS)]
pub struct TagItem {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub color: Option<String>,
}

/// tag.forFile 返回元素（人工组 / 自动组共用；自动组含置信度）。
#[derive(Serialize, TS)]
pub struct FileTagItem {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub color: Option<String>,
    /// 自动组置信度；人工组为 `null`。
    pub confidence: Option<f64>,
}

/// tag.forFile 返回：人工组（在上）与自动组（在下）分开（D21）。
#[derive(Serialize, TS)]
pub struct FileTagsResult {
    pub manual: Vec<FileTagItem>,
    pub auto: Vec<FileTagItem>,
}

/// tag.relation.* 返回元素（D22：层级 + 关联，关系图谱数据源）。
#[derive(Serialize, TS)]
pub struct TagRelationItem {
    pub id: String,
    pub repo_id: String,
    pub from_tag_id: String,
    pub to_tag_id: String,
    /// `hierarchy`（层级）或 `related`（关联）。
    pub relation_kind: String,
    pub created_at: String,
}

/// blueprint.list 返回元素（RFC 0007 / D30）。
#[derive(Serialize, TS)]
pub struct BlueprintItem {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    #[ts(type = "number")]
    pub schema_version: i64,
    pub updated_at: String,
}

/// blueprint.validate 返回（RFC 0007 决策 6；errors 为空 = 有效）。
///
/// `errors` = 硬错误（拒绝保存）；`warnings` = **未接通软告警**（不阻塞保存，
/// 供编辑器灰显与提示：缺引用、无根层 D55、跳转失效 D55、浮层未连接到界面 D50）。
#[derive(Serialize, TS)]
pub struct BlueprintValidateResult {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// blueprint.template.list 返回元素（RFC 0007 / D30）。
#[derive(Serialize, TS)]
pub struct BlueprintTemplateItem {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[ts(type = "number")]
    pub schema_version: i64,
}

/// 一段**行内内容**（`book.content` 返回）。
///
/// **不是 HTML**：EPUB 的正文是 XHTML、Markdown 可以内嵌 HTML，渲染它们要么走
/// `dangerouslySetInnerHTML`（本项目不接受），要么做一遍受控白名单。后端把白名单
/// **做在解析侧**，前端只拿到这样的纯数据并渲染 React 元素——前端因此没有可注入
/// HTML 的入口（见 `hp-book` 的 `block` / `markdown` 模块文档）。
#[derive(Serialize, TS, Debug, Clone)]
pub struct BookSpanItem {
    /// 文字内容（图片片段里是 **alt 文本**）。
    pub text: String,
    /// 叠加的行内样式（`emphasis` / `strong` / `strikethrough` / `code` /
    /// `superscript` / `subscript` / `math` / `footnote` / **`highlight`** /
    /// **`underline`** / **`small_caps`**；**已归一化成固定次序**）。
    ///
    /// 后三种是 EPUB 富文本的装饰（`<mark>` / `<u>` / `small-caps`），
    /// 2026-10-18 追加；前端 `BookBlocks.tsx` 按同一张固定顺序表套元素。
    pub styles: Vec<String>,
    /// 链接目标；`null` = 不是链接。
    pub href: Option<String>,
    /// 图片的**已落盘绝对路径**（供前端 `convertFileSrc`）；`null` = 不是图片。
    pub image: Option<String>,
    /// 书自带的**文字颜色**（CSS 颜色值，如 `#c00` / `rgb(...)`）；`null` = 未声明。
    ///
    /// **原样透传而不是压成主题色**：参考实现（koodo-reader 的 `StyleHelper`）
    /// 默认保留书自己的颜色，只在用户显式打开"覆盖文字色"时才用 `!important`
    /// 强制替换——用户的"彩色文字"要求正是要看着书原本的配色。
    /// 值由解析侧的白名单给出（见 [`BookSpanItem`] 的安全边界说明）；
    /// 前端把它写进 React 的 `style` 对象，不经过 HTML 字符串。
    pub color: Option<String>,
    /// 书自带的**文字底色**（CSS 颜色值）；`null` = 未声明。
    ///
    /// 与 [`BookSpanItem::styles`] 的 `highlight` 是两件事：`highlight` 是
    /// EPUB 的**语义高亮标记**（`<mark>`），这里是书里写死的背景色。
    pub bg: Option<String>,
    /// 书自带的**字号倍数**（em；`1.5` = 1.5 倍正文）；`null` = 未声明。
    ///
    /// EPUB 的 `font-size: 150%` / `1.5em` / `large` 在解析侧折算成这个倍数。
    /// 前端夹紧在 `0.5–4` 之后才写进 CSS：畸形的 `font-size: 3000%` 会把一栏挤成
    /// 一两个字，而"夹紧"是渲染侧的口径（后端如实上报书里写了什么）。
    pub size_em: Option<f32>,
}

/// 一个**列表项**（`book.content` 返回）。
#[derive(Serialize, TS, Debug, Clone)]
pub struct BookListItem {
    /// `true` / `false` = 已勾选 / 未勾选（GFM 任务列表）；`null` = 不是任务项。
    pub checked: Option<bool>,
    /// 项内的块（列表项可以含多段、嵌套列表、代码块）。
    pub blocks: Vec<BookBlockItem>,
}

/// **表格的一行**（`book.content` 返回）。
#[derive(Serialize, TS, Debug, Clone)]
pub struct BookTableRowItem {
    /// 各单元格（每个单元格是一组行内片段）。
    pub cells: Vec<Vec<BookSpanItem>>,
}

/// 查看器正文的**块**（`book.content` 返回）。
///
/// **不是 HTML**：见 [`BookSpanItem`] 的安全边界说明。
///
/// `kind` 取值与各自填充的字段：
/// - `heading`：`level` + `spans`
/// - `paragraph`：`spans`
/// - `image`：`path`（已落盘的绝对路径，供 `convertFileSrc`）
/// - `code_block`：`lang` + `text`
/// - `blockquote`：`quote_kind` + `blocks`
/// - `list`：`ordered` + `start` + `list_items`
/// - `rule`：无附加字段
/// - `table`：`align` + `head` + `rows`
/// - `footnote`：`label` + `blocks`
/// - `definition_list`：`definitions`
/// - **`figure`**：`figure`（图片块本体）+ `caption`（图注）+ `full_page`
/// - **`comment`**：`label` + `blocks`（作者/译者的注释，与 `blockquote` 分开：
///   引用是**正文的一部分**，注释是**旁注**，两者的排印与断页口径不同）
/// - **`page_break`**：无附加字段（一条**显式换页**标记，见 `full_page` 的说明）
#[derive(Serialize, TS, Debug, Clone)]
pub struct BookBlockItem {
    pub kind: String,
    /// `heading` 的层级 1–6；其余块为 `null`。
    pub level: Option<u8>,
    /// 行内内容（`heading` / `paragraph`）；其余块为 `null`。
    pub spans: Option<Vec<BookSpanItem>>,
    /// `image` 的已落盘绝对路径（供前端 `convertFileSrc`）；其余为 `null`。
    pub path: Option<String>,
    /// `code_block` 的语言标记；其余为 `null`。
    pub lang: Option<String>,
    /// `code_block` 的代码原文（**保留缩进**）；其余为 `null`。
    pub text: Option<String>,
    /// `blockquote` / `footnote` 内的块；其余为 `null`。
    pub blocks: Option<Vec<BookBlockItem>>,
    /// GFM 告示种类（`note` / `tip` / `important` / `warning` / `caution`）；其余为 `null`。
    pub quote_kind: Option<String>,
    /// `list` 是否有序；其余为 `null`。
    pub ordered: Option<bool>,
    /// `list` 的起始序号；其余为 `null`。
    pub start: Option<u32>,
    /// `list` 的项；其余为 `null`。
    pub list_items: Option<Vec<BookListItem>>,
    /// `table` 的每列对齐（`none` / `left` / `center` / `right`）；其余为 `null`。
    pub align: Option<Vec<String>>,
    /// `table` 的表头单元格；其余为 `null`。
    pub head: Option<Vec<Vec<BookSpanItem>>>,
    /// `table` 的表体行；其余为 `null`。
    pub rows: Option<Vec<BookTableRowItem>>,
    /// `footnote` 的标签；其余为 `null`。
    pub label: Option<String>,
    /// `definition_list` 的各项（术语 + 释义组）；其余为 `null`。
    pub definitions: Option<Vec<BookDefinitionItem>>,
    /// **`figure`** 的图片块本体（形如 `kind = "image"` 的块）；其余为 `null`。
    ///
    /// 为什么图组要单独一种 `kind`、而不是直接放一个 `image` 块：EPUB 的
    /// `<figure>` 是**图片 + 图注**一个整体（`<img>` + `<figcaption>`），
    /// 排版要求是"图与图注不许被拆到两栏/两页"——把图注拆出去就丢了这个约束。
    pub figure: Option<Box<BookBlockItem>>,
    /// **`figure`** 的图注（`<figcaption>` 的行内内容）；其余为 `null`。
    pub caption: Option<Vec<BookSpanItem>>,
    /// **`figure` / `image`** 是否要求**独占一页**；其余为 `null`
    /// （`null` 与 `Some(false)` 同义：不要求）。
    ///
    /// 判据在**解析侧**：EPUB 的 `epub:type="pagebreak"`、仅含单张图的
    /// `<section>`/`<div>`、以及封面页，都要求整页只放这张图。
    /// 前端据此让这一块**横跨整栏**并单独成页（见 `styles.css` 的
    /// `.vr-figure-full-page` 与 `.vr-page-break`）。
    pub full_page: Option<bool>,
}

/// **定义列表的一项**（`术语` + 若干条释义）。
#[derive(Serialize, TS, Debug, Clone)]
pub struct BookDefinitionItem {
    /// 术语（行内内容）。
    pub term: Vec<BookSpanItem>,
    /// 释义（每条释义是一组块）。
    pub definitions: Vec<Vec<BookBlockItem>>,
}

/// `book.content` 返回：查看器要显示的正文**一页**。
///
/// 四种文件走同一个返回体（用户 2026-10-09 口径：txt 与 epub 都在查看器里看；
/// 2026-10-10 追加 md 的**渲染**；2026-10-11 追加 PDF 的**栅格化**）：
/// - `txt`：一页就是一段连续文本（`text` 非空、`blocks` 为空）；
/// - `md` / `markdown`：一页是**渲染后**的块（`blocks` 非空、`text` 为空）；
/// - `epub`：一页就是**一个章节**的块（`blocks` 非空、`text` 为空）；
/// - `pdf`：一页就是**一张整页位图**（`blocks` 是**单个** `image` 块，
///   `path` 指向已落盘的栅格化 JPEG）——PDF 是版式描述而非文本流，
///   抽文字会丢掉分栏 / 表格 / 乐谱，因此所见即原貌（见 `hp-pdf` 的模块文档）。
///
/// **`section` 对四种格式含义一致**（"第几段 / 第几章 / 第几页"），
/// 因此前端只有一套分页与进度提示；只有 `format` 决定怎么渲染它。
#[derive(Serialize, TS)]
pub struct BookContentResult {
    /// 书的格式：`text`（纯文本）、`markdown`（渲染后的 md）、`epub` 或 `pdf`。
    pub format: String,
    /// 纯文本的**编码名**（`UTF-8` / `GBK` / `UTF-16LE` …）；epub / pdf 为 `null`。
    ///
    /// 面板据此提示"这是 GBK 文件"，也让"读出来是乱码"这件事可被用户判断。
    pub encoding: Option<String>,
    /// 纯文本页的内容；epub / pdf 为 `null`。
    pub text: Option<String>,
    /// epub 章节的块 / pdf 整页位图的块；纯文本为 `null`。
    pub blocks: Option<Vec<BookBlockItem>>,
    /// 下一页游标（纯文本 = 下一个**字符偏移**；epub / pdf = 下一个**序号**）；
    /// `null` = 没有更多（**到末尾不是错误**）。
    pub next_cursor: Option<String>,
    /// 本页序号（0 起；纯文本恒为 0，epub 是章节序号，pdf 是**页码**）。
    pub section: u32,
    /// epub 的章节总数 / pdf 的**页数**；纯文本与 markdown 为 `null`。
    pub section_count: Option<u32>,
    /// 本页标题（epub 的章节标题；纯文本 / pdf 为 `null`）。
    pub title: Option<String>,
    /// 本页是否**另起一页**（epub：`section > 0`；其余格式恒 `false`）。
    ///
    /// 用户口径（需求 4）："每个章节应该是全新的一页，而不是接在上一章后面"。
    /// 这个标记是**排版层的判据**：前端在相邻两页容器之间、以及带该标记的页容器
    /// 之前断页（滚动模式给明显的分页分隔，分页模式给 `break-before: column`）。
    ///
    /// 为什么不让前端按 `section > 0` 自己算：PDF 的一页是**位图**（`section` 是页码）、
    /// 纯文本恒为 0——三种格式的 `section` 语义不同，**只有后端知道"这一页是不是新章"**。
    pub page_break_before: bool,
    /// 内容是否因**上限**被截断（用户口径"固定上限"；面板据此提示"仅显示开头"）。
    pub capped: bool,
}

/// `book.cover` 返回：一个文件的**封面覆盖**（用户自设的颜色或图片）。
///
/// 用户口径（2026-10-09）："txt 右键可以更换封面颜色或自定义图片"。
/// `kind` 取值：`color`（`value` = `#rrggbb`）/ `image`（`value` = **已落盘**的
/// 绝对路径，供前端 `convertFileSrc`）；两个字段同为 `null` = 这本书没有覆盖，
/// 面板按默认封面渲染（内嵌封面或文字封面）。
#[derive(Serialize, TS, Debug)]
pub struct BookCoverResult {
    /// `color` / `image`；`null` = 没有覆盖。
    pub kind: Option<String>,
    /// `color` 为 `#rrggbb`；`image` 为**已落盘**的绝对路径；无覆盖为 `null`。
    pub value: Option<String>,
}

/// `book.covers` 返回元素：一个文件的封面覆盖（**只返回真有覆盖的**）。
///
/// 与 [`BookCoverResult`] 的差别只有一处：这里带 `file_id`（批量结果要靠它对应回条目），
/// 且**两个字段都必然有值**——没有覆盖的文件根本不出现在数组里。
#[derive(Serialize, TS, Debug)]
pub struct BookCoverItem {
    /// 文件 ID。
    pub file_id: String,
    /// `color` / `image`。
    pub kind: String,
    /// `color` 为 `#rrggbb`；`image` 为**已落盘**的绝对路径（供 `convertFileSrc`）。
    pub value: String,
}

/// `book.toc` 返回元素：目录的**一项**。
///
/// 三种格式走同一个返回体（EPUB 取 nav / NCX，纯文本按**内置小说章节规则**识别，
/// Markdown 取顶层标题）——阅读器因此只有一套目录渲染与跳转。
#[derive(Serialize, TS, Debug, Clone)]
pub struct BookTocItem {
    /// 章节标题。
    ///
    /// **可能是空串**：EPUB 缺 `<title>`、或那个 `<title>` 不是章节名时如实留空；
    /// 前端按 i18n 显示序号（后端不内联用户可见文案）。
    pub title: String,
    /// 层级（1 = 顶层）；EPUB 取自 nav / NCX 的嵌套深度，Markdown 用标题层级，
    /// 纯文本按「卷 / 部 / 集」分组。
    pub level: u32,
    /// 跳转游标：**与 `book.content` 的 `cursor` 同语义**
    /// （epub = 章节序号；txt = 字符偏移；md = 顶层块序号）。
    /// 阅读器把它原样回传给 `book.content` 即完成跳转。
    pub cursor: String,
}

/// `book.toc` 返回：一本书的目录。
#[derive(Serialize, TS, Debug)]
pub struct BookTocResult {
    /// 书的格式：`text` / `markdown` / `epub` / `pdf`；空串 = 不是可读的"书"
    /// （与 [`BookContentResult::format`] 同口径）。
    pub format: String,
    /// 目录项（按书内顺序；可能为空 = 这本书没有目录）。
    ///
    /// **空数组不是错误**：PDF 没有目录结构、损坏的书也读不出目录，
    /// 阅读器此时只显示正文（目录栏给空态）。
    pub entries: Vec<BookTocItem>,
    /// **全书总单位数**，供阅读器算进度（`当前游标 / total`）。
    ///
    /// - 纯文本 = **字符数**（与 `cursor` 同为字符口径）；
    /// - Markdown = **顶层块数**（游标是块序号）；
    /// - `epub` / `pdf` = `None`：它们的进度用 `BookContentResult` 的
    ///   `section` / `section_count`（章节 / 页码），不由目录接口给。
    ///
    /// `None`（而不是 `0`）表示"后端说不出来"：界面显示 `—`，不假装 0%。
    pub total: Option<u32>,
}

/// `reader.annotations` 返回元素：一条**阅读批注**（书签 / 笔记 / 高亮）。
///
/// 三者是同一件事的三种形态（见 `hp_core::annotation` 的模块文档），因此共用一个 DTO、
/// 由 `kind` 区分。`cursor` 与 `book.content` 的游标**同语义**——"点批注跳回去"就是把它
/// 原样交给 `book.content`，前端不做换算（与 `book.toc` 的目录项同一条口径）。
#[derive(Serialize, TS, Debug, Clone)]
pub struct ReaderAnnotationItem {
    /// 主键（UUID；删除时用它）。
    pub id: String,
    /// `bookmark` / `note` / `highlight`。
    pub kind: String,
    /// 位置游标（与 `book.content` 同语义）。
    pub cursor: String,
    /// 保存时的阅读进度（0–10000，两位小数百分比）；仅供列表展示。
    pub progress: u32,
    /// 位置标题（章节名 / 目录项）；空串 = 取不到标题。
    pub title: String,
    /// 高亮的选中原文**快照**；空串 = 没有（书签 / 笔记）。
    pub excerpt: String,
    /// 读者写的备注 / 笔记正文；空串 = 没有。
    pub note: String,
    /// 创建时间（ISO 8601）。
    pub created_at: String,
}

// ─────────────────────────── 事件载荷（契约 §4） ───────────────────────────
//
// **D77（2026-09）**：事件载荷一律 `#[serde(rename_all = "camelCase")]`，前端按驼峰消费。
// 这些类型是本 crate 里唯一带 `rename_all` 的一族：命令返回值历史上是蛇形，
// 改动会波及全部前端调用点，故只把**事件**这一族统一到驼峰（与 D77 一致）。
//
// 之所以把它们搬进 `hp-dto`（2026-11-11，裁决见 `docs/issues/README.md` 第 37 轮）：
// 事件载荷过去是各命令模块里的私有结构体 + 前端 `events.ts` 手写同名接口，
// 两边靠人工对齐；现在是同一份 Rust 定义 + 生成 TS，漂移由 `pnpm check:types` 守住。

/// `scan.progress` 载荷。
///
/// 扫描与**单文件重新分析**共用这一条事件（"分析时和源全量同款浮窗"就是靠复用同一族事件
/// 达成的：前端只认事件、不认命令）。两者差别只有两处，因此写在载荷里而不是靠前端猜：
/// `total`（扫描是文件总数，单文件分析是 0 = 总数未知 → 不定进度条）与
/// `pausable`（分析没有暂停点 → 浮窗不显示暂停按钮，免得留一个按不动的键）。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgressPayload {
    pub task_id: String,
    pub source_id: String,
    #[ts(type = "number")]
    pub processed: u64,
    /// 遍历阶段为 0（总数未知）。
    #[ts(type = "number")]
    pub total: u64,
    /// `walking`（遍历目录）| `indexing`（逐文件索引）。
    pub phase: String,
    /// 正在处理的条目（相对路径或目录）；代表该文件正在被哈希/抽帧。
    pub current: Option<String>,
    /// 该任务是否支持暂停/恢复（整源扫描为 `true`，单文件分析为 `false`）。
    pub pausable: bool,
}

/// `scan.completed` 载荷。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanCompletedPayload {
    pub task_id: String,
    pub source_id: String,
    #[ts(type = "number")]
    pub indexed: u64,
    #[ts(type = "number")]
    pub changed: u64,
    #[ts(type = "number")]
    pub missing: u64,
    #[ts(type = "number")]
    pub skipped: u64,
    /// 是否被用户取消（取消不是错误，统计为已完成部分）。
    pub cancelled: bool,
}

/// `scan.error` 载荷。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanErrorPayload {
    pub task_id: String,
    pub source_id: String,
    pub error: String,
}

/// `source.unmount.progress` 载荷（完全卸载的分阶段进度）。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceUnmountProgressPayload {
    pub task_id: String,
    pub source_id: String,
    /// `counting` / `syncRules` / `children` / `derived` / `files` / `source`。
    pub phase: String,
    #[ts(type = "number")]
    pub processed: u64,
    /// 0 = 该阶段总数未知（界面按不定进度显示）。
    #[ts(type = "number")]
    pub total: u64,
}

/// `source.unmount.completed` 载荷（完全卸载结果）。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceUnmountCompletedPayload {
    pub task_id: String,
    pub source_id: String,
    /// 是否被用户取消（取消时整个事务回滚，什么都没删）。
    pub cancelled: bool,
    /// 删除的相册成员关系条数。
    #[ts(type = "number")]
    pub members: u64,
    /// 删除的文件索引行数。
    #[ts(type = "number")]
    pub files: u64,
    /// 删除的 tag 关联数。
    #[ts(type = "number")]
    pub tags: u64,
    /// 删除的评分数。
    #[ts(type = "number")]
    pub ratings: u64,
    /// 删除的色彩参考数。
    #[ts(type = "number")]
    pub colors: u64,
    /// 降级为普通相册的跟随相册数。
    #[ts(type = "number")]
    pub sync_albums: u64,
    /// 摘挂为顶层源的子源数。
    #[ts(type = "number")]
    pub child_sources: u64,
}

/// `source.unmount.error` 载荷。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceUnmountErrorPayload {
    pub task_id: String,
    pub source_id: String,
    pub error: String,
}

/// `album.sync.progress` 载荷。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSyncProgressPayload {
    pub task_id: String,
    pub album_id: String,
    #[ts(type = "number")]
    pub added: u64,
    #[ts(type = "number")]
    pub removed: u64,
    #[ts(type = "number")]
    pub pinned: u64,
}

/// `album.sync.conflict` 载荷（**逐文件**，缺陷 0004）：一个冲突成员一条事件。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSyncConflictPayload {
    pub task_id: String,
    pub album_id: String,
    /// 冲突成员的 file ID——**不再是空串**。
    pub file_id: String,
    /// 稳定原因码（`pinned_kept`：成员已被用户固定，`mirror` 本应移除却保留）。
    pub reason: String,
}

/// `album.sync.failed` 载荷（**整体失败**，缺陷 0004）：与逐文件冲突分开。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSyncFailedPayload {
    pub task_id: String,
    pub album_id: String,
    /// 诊断串（结构化错误码仍以命令层 `code` 为准）。
    pub error: String,
}

/// `color.extracted` 载荷。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColorExtractedPayload {
    pub task_id: String,
    pub file_id: String,
    pub palette: Vec<String>,
}

/// `plugin.loaded` 载荷（契约 §4）。
///
/// 语义：校验通过、`LoadOutcome` 已产出即算"加载完成"（**生命周期骨架**）——
/// **不代表**常驻进程已拉起，那属 `external-process` 监督（仍未实现）。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginLoadedPayload {
    pub plugin_id: String,
    pub repo_id: String,
}

/// `plugin.changed` 载荷：注册表**不落库**，事件只带"哪个仓库的启用状态变了"。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginChangedPayload {
    pub repo_id: String,
}

/// `blueprint.changed` 载荷（RFC 0007）：前端据此重载生效蓝图并重新对账布局。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintChangedPayload {
    pub repo_id: String,
    /// 变更后的生效蓝图；`None` = 该仓库没有生效蓝图。
    pub blueprint_id: Option<String>,
}

/// `file.missing` 载荷（缺陷 0045）：监听发现**已索引**的文件从磁盘消失。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileMissingPayload {
    pub repo_id: String,
    pub file_id: String,
}

/// `file.restored` 载荷（缺陷 0045）：此前标记为缺失的文件又回到磁盘。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileRestoredPayload {
    pub repo_id: String,
    pub file_id: String,
}

/// `file.changed` 载荷（缺陷 0045）：目录里已有文件的内容变了。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChangedPayload {
    pub repo_id: String,
    pub file_id: String,
    /// 契约枚举里的值：本模块只会发 `modified`（`renamed` / `moved` 无可靠判定源）。
    pub change: String,
}

/// `file.created` 载荷（缺陷 0045 的续档；2026-11-11 第 37 轮裁决）。
///
/// 语义：监听发现**磁盘上有、索引里还没有**的文件。此时它还没有 `fileId`（索引行尚未
/// 生成），因此载荷带的是**定位用的三元组**：仓库 + 媒体源 + 源内相对路径。前端据此可以把
/// "新到的文件"先摆到界面（占位/闪烁），真正的索引行由随后的增量扫描建立——扫描完成时
/// `scan.completed` 会照常到达。
///
/// 之所以不并进 `file.changed.change`：那个字段的枚举是 `modified|renamed|moved`，
/// 描述的是**已索引**文件的变化；新增带不来 `fileId`，字段集合本来就不一样。

#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileCreatedPayload {
    pub repo_id: String,
    pub source_id: String,
    /// 源内相对路径（`/` 分隔，与 `files.relative_path` 同口径）。
    pub relative_path: String,
}

/// 图片尺寸回填的进度（缺陷 0043 阶段 2）。
///
/// 为什么不复用 `scan.progress`：扫描的 `processed/total` 是"本次扫描走了多少文件"，
/// 回填的是"全库还剩多少张图没尺寸"，两者的总量与节流口径都不同；而契约里
/// `task.progress` 已在 2026-09 撤下（语义与具体任务的事件重叠）。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileBackfillProgressPayload {
    pub task_id: String,
    /// 已处理（成功 + 失败）的行数。
    pub processed: u64,
    /// 本轮开始时待回填的总行数（`width IS NULL` 的图片数，**整轮不变**）。
    pub total: u64,
}

/// 图片尺寸回填的收尾（缺陷 0043 阶段 2）。
#[derive(Serialize, TS, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileBackfillCompletedPayload {
    pub task_id: String,
    /// 真的写进了库的行数（读头失败、或扫描刚好抢先写入的行不计）。
    pub filled: u64,
    /// 读头失败的行数（文件缺失/损坏/格式不支持）——这些行保持 `NULL`，下次打开仓库会再试。
    pub failed: u64,
    pub cancelled: bool,
    /// 整轮中止的原因（库打不开、线程 panic）。正常结束与用户取消都是 `null`：
    /// 「读头失败若干行」不算错误，它是常态的一部分。
    pub error: Option<String>,
}
