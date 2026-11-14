//! 通用工具（随 `Db` 一起下沉到本 crate：领域层直接 `use hp_db::{…}` 取用）。

use hp_core::{HpError, HpResult};

/// 当前 UTC 时间的 ISO 8601 文本（实现只有 `hp_core::time::now_iso` 一处，D214）。
///
/// 本函数保留是为了不动 `hp-global` / `hp-repo` / `hp-dict` 里已有的 `hp_db::now_iso` 调用点。
pub fn now_iso() -> String {
    hp_core::time::now_iso()
}

/// 把 rusqlite 错误统一映射为 HpError::Store。
pub fn store_err(context: &str, e: rusqlite::Error) -> HpError {
    HpError::Store(format!("{context}: {e}"))
}

/// 生成 UUID v4 文本。
pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 校验非空字符串参数。
pub fn require_nonempty(value: &str, field: &str) -> HpResult<()> {
    if value.trim().is_empty() {
        return Err(HpError::InvalidArgument(format!("{field} 不能为空")));
    }
    Ok(())
}
