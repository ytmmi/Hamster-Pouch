//! 垂直「界面页」标签条的页面组持久化（D124）。
//!
//! 只做**一件事**：按仓库读写一份不透明的 JSON 字符串（形状由 `shared/repo_blob.rs` 定，D213）。
//! 分组结构（组名、组内界面归属、折叠状态）的语义完全在前端 `shared/interfacePages.ts`，桥接层**不解析**也不校验内容——
//! 它不认识蓝图层的概念，硬要校验就会把两份真相焊死。
//!
//! 为什么落在应用设置而不是新库表：这是**观感/导航状态**，不是数据。它的生命周期跟着
//! 仓库走、丢了只是回到初始状态，不需要事务、迁移与索引；新表会为一个纯 UI 状态
//! 引入 schema 版本负担（对照 D54 的「当前层」 同样存 `app_settings`）。
//!
//! 形状遵循 **D76**（`{ ok, data?, error? }`，全部**已包装**）。

use tauri::State;

use crate::AppState;
use crate::commands::shared::{ApiResponse, api_from_hp, get_repo_blob, set_repo_blob};

/// 这类状态的设置键前缀（D124）。
const PREFIX: &str = "interfacePages";

/// interfacePages.get：读取某仓库的界面页分组（未设置返回 `None`）。
#[tauri::command]
pub(crate) fn interface_pages_get(
    repo_id: String,
    state: State<AppState>,
) -> ApiResponse<Option<String>> {
    api_from_hp(get_repo_blob(&state, PREFIX, &repo_id))
}

/// interfacePages.set：覆盖写入某仓库的界面页分组（空串 = 清空）。
#[tauri::command]
pub(crate) fn interface_pages_set(
    repo_id: String,
    pages_json: String,
    state: State<AppState>,
) -> ApiResponse<()> {
    api_from_hp(set_repo_blob(&state, PREFIX, &repo_id, &pages_json))
}
