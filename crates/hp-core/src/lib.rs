//! hp-core：仓鼠颊领域模型（仓库、图像源、虚拟相册、图像、tag、评分）。
//! 本 crate 保持纯净，不依赖 Tauri/SQLite/文件系统。

pub mod error;
pub mod repo;

pub use error::{HpError, HpResult};
pub use repo::RepoId;
