//! tag 词库（独立 SQLite 文件，应用级共享）：
//! - [`TagDictDb`]：RFC 0006 旧形态（原始 tag 为锚），保留作对照与回退。
//! - [`TagLibDb`] / [`TagLibSet`]：RFC 0008 四库（概念为锚）+ 三层聚合查询层。
//! - [`MergeIndex`]：多个扩展包之间的**重复概念归并**（按概念身份而非 ID）。
//!
//! 四库域内分工：`tag_lib_db.rs` 单库句柄与只读查询 / `tag_lib_write.rs` 用户库写入 /
//! `tag_lib_set.rs` 跨层聚合查询 / `tag_lib_merge.rs` 重复概念归并。

mod dict_db;
mod tag_lib_db;
mod tag_lib_merge;
mod tag_lib_set;
mod tag_lib_write;

pub use dict_db::TagDictDb;
pub use tag_lib_db::TagLibDb;
pub use tag_lib_merge::{ConceptKey, MergeIndex, MergedConcept};
pub use tag_lib_set::TagLibSet;
