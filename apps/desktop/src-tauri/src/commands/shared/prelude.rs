//! 子模块共用的外部导入与宿主状态类型（各模块一律先 use super::prelude::*;）。
//!
//! 收在这里是为了让拆分后的每个文件只写自己真正需要的跨模块 use，而不是各自重复一遍
//! hp_* / tauri 的导入表。

pub(crate) use crate::AppState;
pub(crate) use hp_ai::AiTaggingService;
pub(crate) use hp_core::{FileIndexRow, HpError, HpResult};
pub(crate) use hp_dict::TagLibSet;
pub(crate) use hp_global::GlobalDb;
pub(crate) use hp_plugin_host::{PanelSchemaCache, SupervisionRegistry};
pub(crate) use hp_repo::RepoDb;
pub(crate) use serde::Serialize;
pub(crate) use std::path::PathBuf;
pub(crate) use tauri::Emitter;
