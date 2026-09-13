//! 全局配置库：仓库注册表、应用设置、面板布局、插件注册表、AI 配置引用
//! （RFC 0003 / database-schema.md 第 3 节）。

mod global_db;
mod plugin_repo;

pub use global_db::{GlobalDb, PanelLayoutRow, RepoRow};
