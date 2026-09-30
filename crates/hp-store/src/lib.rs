//! hp-store：SQLite 访问、迁移、事务、仓库库/全局库/词库边界。

mod dict;
mod global;
mod migrate;
mod repo;
mod util;

pub use dict::{TagDictDb, TagLibDb, TagLibSet};
pub use global::{GlobalDb, PanelLayoutRow, RepoRow};
pub use repo::{
    build_source_tree, build_tag_tree, AlbumSourceMembers, FileQueryCursor, FileQueryFilter,
    OpsHistoryRow, PurgePhase, PurgeResult, RepoDb, SourceDataCounts, SourceTree, TagTree,
    TagTreeNode, TreeNode, FILE_QUERY_MAX_LIMIT,
};
