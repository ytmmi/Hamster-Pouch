//! hp-store：SQLite 访问、迁移、事务、仓库库/全局库/词库边界。

mod dict;
mod global;
mod migrate;
mod repo;
mod util;

pub use dict::{ConceptKey, MergeIndex, MergedConcept, TagDictDb, TagLibDb, TagLibSet};
pub use global::{GlobalDb, LayoutPresetRow, RepoRow, SeedOutcome};
pub use hp_core::HpError;
pub use repo::{
    ALBUM_MEMBERS_MAX_LIMIT, AlbumMemberCursor, AlbumSourceMembers, FILE_QUERY_MAX_LIMIT,
    FileQueryCursor, FileQueryFilter, NewAnnotation, OpsHistoryRow, PurgePhase, PurgeResult,
    RepoDb, ScanPrepareRow, SourceDataCounts, SourceExclusion, SourceFileLocation, SourceTree,
    TagTree, TagTreeNode, TreeNode, build_source_tree, build_tag_tree, is_excluded_path,
    retain_visible_paths,
};
