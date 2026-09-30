//! tag 库命令：内置基底库（RFC 0008 四库，`data/system/tag_lib_base.sqlite3`）的查询。
//!
//! 查询经 `TagLibSet` 聚合层（内置基底 + 已装配扩展包 + 用户库），调用方不感知来源层
//! （D36）。当前只装配了内置基底；扩展包装配通道见 RFC 0008「延后事项登记」。

use hp_core::HpResult;
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
