//! 仓库库（每仓库一个 SQLite 文件）：连接/迁移 + 各领域仓储。

mod album_repo;
mod color_repo;
mod file_repo;
mod rating_repo;
mod repo_db;
mod source_repo;
mod source_tree;
mod tag_repo;

pub use repo_db::RepoDb;
pub use source_tree::{build_source_tree, SourceTree, TreeNode};
