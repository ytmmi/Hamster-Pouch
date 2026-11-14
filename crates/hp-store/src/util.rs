//! 通用工具。
//!
//! 四个工具的实现已下沉到 `hp-db`（D185：它们与「打开连接 / 跑迁移」是同一批小件，
//! 且只被 SQLite 访问层使用）。这里保留再导出，领域仓储的 `use crate::util::…` 零改动。

pub(crate) use hp_db::{now_iso, require_nonempty, store_err, uuid};
