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
    /// 媒体类型之下的子类型（`book` / `document`；非文本类为 `null`）。
    pub subtype: Option<String>,
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
    /// 媒体类型之下的子类型（`book` / `document`；非文本类为 `null`）。
    pub subtype: Option<String>,
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

/// 查看器正文的**块**（`book.content` 返回）。
///
/// **不是 HTML**：EPUB 的正文是 XHTML，渲染它要么走 `dangerouslySetInnerHTML`
/// （本项目不接受），要么做一遍受控白名单。后端把白名单**做在解析侧**，
/// 前端只拿到这样的纯数据并渲染 React 元素——前端因此没有可注入 HTML 的入口
/// （见 `hp-book` 的 `epub_text` 模块文档）。
///
/// `kind` 取值：`heading`（`level` + `text`）/ `paragraph`（`text`）/
/// `image`（`path`，已落盘的绝对路径，供 `convertFileSrc`）。
#[derive(Serialize, TS, Debug)]
pub struct BookBlockItem {
    pub kind: String,
    /// `heading` 的层级 1–6；其余块为 `null`。
    pub level: Option<u8>,
    /// `heading` / `paragraph` 的文字；`image` 为 `null`。
    pub text: Option<String>,
    /// `image` 的已落盘绝对路径（供前端 `convertFileSrc`）；其余为 `null`。
    pub path: Option<String>,
}

/// `book.content` 返回：查看器要显示的正文**一页**。
///
/// 两种文件走同一个返回体（用户 2026-10-09 口径：txt 与 epub 都在查看器里看）：
/// - `txt` / `md`：一页就是一段连续文本（`text` 非空、`blocks` 为空）；
/// - `epub`：一页就是**一个章节**的块（`blocks` 非空、`text` 为空）。
#[derive(Serialize, TS)]
pub struct BookContentResult {
    /// 书的格式：`text`（纯文本）或 `epub`。
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
