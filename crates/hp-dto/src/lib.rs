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
    /// `superscript` / `subscript` / `math` / `footnote`；**已归一化成固定次序**）。
    pub styles: Vec<String>,
    /// 链接目标；`null` = 不是链接。
    pub href: Option<String>,
    /// 图片的**已落盘绝对路径**（供前端 `convertFileSrc`）；`null` = 不是图片。
    pub image: Option<String>,
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
/// 三种文件走同一个返回体（用户 2026-10-09 口径：txt 与 epub 都在查看器里看；
/// 2026-10-10 追加 md 的**渲染**）：
/// - `txt`：一页就是一段连续文本（`text` 非空、`blocks` 为空）；
/// - `md` / `markdown`：一页是**渲染后**的块（`blocks` 非空、`text` 为空）；
/// - `epub`：一页就是**一个章节**的块（`blocks` 非空、`text` 为空）。
#[derive(Serialize, TS)]
pub struct BookContentResult {
    /// 书的格式：`text`（纯文本）、`markdown`（渲染后的 md）或 `epub`。
    pub format: String,
    /// 纯文本的**编码名**（`UTF-8` / `GBK` / `UTF-16LE` …）；epub 为 `null`。
    ///
    /// 面板据此提示"这是 GBK 文件"，也让"读出来是乱码"这件事可被用户判断。
    pub encoding: Option<String>,
    /// 纯文本页的内容；epub 为 `null`。
    pub text: Option<String>,
    /// epub 章节的块；纯文本为 `null`。
    pub blocks: Option<Vec<BookBlockItem>>,
    /// 下一页游标（纯文本 = 下一个**字符偏移**；epub = 下一个**章节序号**）；
    /// `null` = 没有更多（**到末尾不是错误**）。
    pub next_cursor: Option<String>,
    /// 本页序号（0 起；纯文本恒为 0，epub 是章节序号）。
    pub section: u32,
    /// epub 的章节总数；纯文本为 `null`。
    pub section_count: Option<u32>,
    /// 本页标题（epub 的章节标题；纯文本为 `null`）。
    pub title: Option<String>,
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
