//! 仓库库（每仓库一个 SQLite 文件）：连接/迁移 + 各领域仓储。

mod ai_undo_repo;
mod album_repo;
mod blueprint_repo;
mod color_repo;
mod file_repo;
mod ops_repo;
mod rating_repo;
mod repo_db;
mod source_repo;
mod source_tree;
mod tag_relation_repo;
mod tag_repo;
mod tag_tree;

pub use ops_repo::OpsHistoryRow;
pub use repo_db::RepoDb;
pub use source_tree::{build_source_tree, SourceTree, TreeNode};
pub use tag_tree::{build_tag_tree, TagTree, TagTreeNode};
