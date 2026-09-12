//! hp-store：SQLite 访问、迁移、事务、仓库库/全局库边界。

mod album_repo;
mod file_repo;
mod global_db;
mod migrate;
mod repo_db;
mod source_repo;
mod util;

pub use global_db::{GlobalDb, RepoRow};
pub use repo_db::RepoDb;
