//! tag 词库（独立 SQLite 文件，应用级共享）：
//! - [`TagDictDb`]：RFC 0006 旧形态（原始 tag 为锚），保留作对照与回退。
//! - [`TagLibDb`] / [`TagLibSet`]：RFC 0008 四库（概念为锚）+ 三层聚合查询层。
//! - [`MergeIndex`]：多个扩展包之间的**重复概念归并**（按概念身份而非 ID）。

mod dict_db;
mod tag_lib_db;
mod tag_lib_merge;

pub use dict_db::TagDictDb;
pub use tag_lib_db::{TagLibDb, TagLibSet};
pub use tag_lib_merge::{ConceptKey, MergeIndex, MergedConcept};
