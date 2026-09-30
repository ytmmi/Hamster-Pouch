//! tag 词库命令：内置基底库（Top 5000，`data/system/tag_dict_base.sqlite3`）的查询。

use hp_core::HpResult;
use hp_store::TagDictDb;
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
) -> ApiResponse<Vec<hp_core::TagDictSuggestion>> {
    let outcome = (|| -> HpResult<Vec<hp_core::TagDictSuggestion>> {
        let limit = limit.unwrap_or(20).min(100);
        let guard = state
            .tag_dict
            .lock()
            .map_err(|_| hp_core::HpError::Store("tag 词库锁中毒".into()))?;
        match guard.as_ref() {
            Some(db) => db.suggest(&query, limit),
            None => Ok(Vec::new()), // 词库未加载时返回空
        }
    })();
    api_from_hp(outcome)
}
