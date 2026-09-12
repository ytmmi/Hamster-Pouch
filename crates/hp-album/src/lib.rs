//! hp-album：固定相册、跟随源同步规则、成员维护、相册查询；含媒体属性（D10）。

mod media;
mod service;
mod sync;

pub use service::{AddMembersOutcome, AlbumService, SetMediaTypeOutcome, SyncOutcome};
