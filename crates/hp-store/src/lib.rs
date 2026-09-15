//! hp-store：SQLite 访问、迁移、事务、仓库库/全局库/词库边界。

mod dict;
mod global;
mod migrate;
mod repo;
mod util;

pub use dict::TagDictDb;
pub use global::{GlobalDb, PanelLayoutRow, RepoRow};
pub use repo::{
    build_source_tree, build_tag_tree, OpsHistoryRow, RepoDb, SourceTree, TagTree, TagTreeNode,
    TreeNode,
};
