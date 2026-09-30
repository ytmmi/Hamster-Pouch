//! tag 库命令：四库查询（RFC 0008）与装配状态。
//!
//! 查询经 `TagLibSet` 聚合层（内置基底 + 已装配扩展包 + 用户库），调用方不感知来源层
//! （D36）。装配由 `commands::shared::build_tag_lib_set` 完成，扩展包来自插件安装目录。

use hp_core::HpResult;
use serde::Serialize;
use tauri::State;

use crate::commands::shared::{api_from_hp, ApiResponse};
use crate::AppState;

/// `tag_dict.suggest`：按关键词搜索词库，返回候选列表。
///
/// 词库文件不存在（首次运行尚未分发基底库时）返回空列表而非错误。
#[tauri::command]
pub(crate) fn tag_dict_suggest(
    query: String,
    limit: Option<u32>,
    state: State<AppState>,
) -> ApiResponse<Vec<hp_core::TagConceptDetail>> {
    let outcome = (|| -> HpResult<Vec<hp_core::TagConceptDetail>> {
        let limit = limit.unwrap_or(20).min(100);
        let guard = state
            .tag_lib
            .lock()
            .map_err(|_| hp_core::HpError::Store("tag 库锁中毒".into()))?;
        match guard.as_ref() {
            Some(set) => set.suggest(&query, limit),
            None => Ok(Vec::new()), // 词库未装配时返回空
        }
    })();
    api_from_hp(outcome)
}

/// 重新装配 tag 库并替换全局状态。
///
/// **扩展安装 / 启用 / 禁用后必须调用**：tag 扩展是纯数据包，宿主只在启动时装配一次；
/// 不重装配则「装完、启用后数据根本不生效」，界面看不出任何变化。
///
/// 无内置基底库时保持原状（首次运行尚未分发基底库的场景）。
pub(crate) fn reload(state: &State<AppState>) {
    let root = state.plugin_root.as_ref().clone();
    if let Some(set) = crate::commands::shared::build_tag_lib_set(&root) {
        match state.tag_lib.lock() {
            Ok(mut guard) => *guard = Some(set),
            Err(_) => eprintln!("[taglib] 重装配失败：tag 库锁中毒"),
        }
    }
}

/// tag 库装配状态（`taglib.status`）。
///
/// 用户要求：界面上要能看到「共多少个 tag」与「合并了多少条重复」。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TagLibStatusItem {
    /// 是否已装配（无内置基底库时为 false）。
    loaded: bool,
    /// 已装配的层数（内置基底 + 各扩展包）。
    layers: usize,
    /// 归并后的概念总数（跨扩展去重后）。
    concept_count: usize,
    /// 因跨扩展重复而归并掉的概念数。
    duplicate_count: usize,
}

/// `taglib.status`：词库装配状态（界面展示「共多少个 tag」「合并了多少条重复」）。
#[tauri::command]
pub(crate) fn taglib_status(state: State<AppState>) -> ApiResponse<TagLibStatusItem> {
    let outcome = (|| -> HpResult<TagLibStatusItem> {
        let guard = state
            .tag_lib
            .lock()
            .map_err(|_| hp_core::HpError::Store("tag 库锁中毒".into()))?;
        Ok(match guard.as_ref() {
            Some(set) => {
                let (concept_count, duplicate_count) = set.duplicate_stats().unwrap_or((0, 0));
                TagLibStatusItem {
                    loaded: true,
                    layers: set.len(),
                    concept_count,
                    duplicate_count,
                }
            }
            None => TagLibStatusItem {
                loaded: false,
                layers: 0,
                concept_count: 0,
                duplicate_count: 0,
            },
        })
    })();
    api_from_hp(outcome)
}
