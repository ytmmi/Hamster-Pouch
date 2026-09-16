//! Tauri 命令桥接层：按领域拆分，只做参数校验/状态装配/调用 crate。

pub(crate) mod ai;
pub(crate) mod album;
pub(crate) mod blueprint;
pub(crate) mod color;
pub(crate) mod file;
pub(crate) mod fsops;
pub(crate) mod layout;
pub(crate) mod media;
pub(crate) mod plugin;
pub(crate) mod rating;
pub(crate) mod repo;
pub(crate) mod shared;
pub(crate) mod source;
pub(crate) mod tag;
