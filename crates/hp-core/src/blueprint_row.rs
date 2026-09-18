//! 蓝图**存储行**（RFC 0007 决策 2 / D30）。
//!
//! 与仓库库 `blueprints` 表、全局库 `blueprint_templates` 表一一对应的纯数据行，
//! 供 hp-store 的仓储返回、命令层转 DTO。行结构独立成文件的原因：它是**持久化形态**，
//! 与蓝图文档模型（`blueprint.rs` 的 `BlueprintGraph`）是两件事——
//! 图文档整 JSON 存进 `blueprint_json` 列，行本身只承载元数据（id/名称/版本/默认标记/时间）。

/// 仓库蓝图行：与仓库库 `blueprints` 表一一对应。
#[derive(Debug, Clone, PartialEq)]
pub struct BlueprintRow {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub is_default: bool,
    pub schema_version: i64,
    pub blueprint_json: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 全局蓝图模板行：与全局库 `blueprint_templates` 表一一对应。
#[derive(Debug, Clone, PartialEq)]
pub struct BlueprintTemplateRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub schema_version: i64,
    pub blueprint_json: String,
    pub created_at: String,
    pub updated_at: String,
}
