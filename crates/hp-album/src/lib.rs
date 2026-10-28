//! hp-album：固定相册、跟随源同步规则、成员维护、相册查询；含媒体属性（D10）。
//!
//! 同步相册（D128）：`sync_root_album_id` 指向自己的跟随源相册是**同步根**，同步时按源
//! 目录层级镜像出子相册（只增不删、位置与源一致）；取消同步即退化为固定型相册。
//!
//! 注：媒体源的**完全卸载**（删源 + 删索引 + 删派生数据）在 `hp-store::purge_source_data`，
//! 属仓库库层面的多表清理，不在此 crate。

mod media;
mod mirror;
mod service;
mod sync;

pub use service::{
    AddMembersOutcome, AlbumService, CONFLICT_REASON_PINNED_KEPT, MoveOutcome, SetMediaTypeOutcome,
    SyncConflict, SyncOutcome, UnsyncOutcome,
};
