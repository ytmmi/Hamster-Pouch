//! hp-album：固定相册、跟随源同步规则、成员维护、相册查询；含媒体属性（D10）。
//!
//! 注：媒体源的**完全卸载**（删源 + 删索引 + 删派生数据）在 `hp-store::purge_source_data`，
//! 属仓库库层面的多表清理，不在此 crate。

mod media;
mod service;
mod sync;

pub use service::{AddMembersOutcome, AlbumService, SetMediaTypeOutcome, SyncOutcome};
