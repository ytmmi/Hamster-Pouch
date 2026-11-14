//! hp-store：全局库与词库的 SQLite 访问、迁移、事务；仓库库的表结构、迁移清单与领域仓储
//! 自 D186 起拆到独立 crate `hp-repo`，这里只做再导出，`hp_store::RepoDb` 等路径保持不变。

mod dict;
mod global;
mod util;

pub use dict::{ConceptKey, MergeIndex, MergedConcept, TagDictDb, TagLibDb, TagLibSet};
pub use global::{GlobalDb, LayoutPresetRow, RepoRow, SeedOutcome};
pub use hp_core::HpError;
pub use hp_repo::{
    ALBUM_MEMBERS_MAX_LIMIT, AlbumMemberCursor, AlbumSourceMembers, FILE_QUERY_MAX_LIMIT,
    FileQueryCursor, FileQueryFilter, NewAnnotation, OpsHistoryRow, PurgePhase, PurgeResult,
    RepoDb, ScanPrepareRow, SourceDataCounts, SourceExclusion, SourceFileLocation, SourceTree,
    TagTree, TagTreeNode, TreeNode, build_source_tree, build_tag_tree, is_excluded_path,
    retain_visible_paths,
};
