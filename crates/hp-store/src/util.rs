//! 通用工具。

use hp_core::{HpError, HpResult};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// 当前 UTC 时间的 ISO 8601 文本。
pub(crate) fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| String::new())
}

/// 把 rusqlite 错误统一映射为 HpError::Store。
pub(crate) fn store_err(context: &str, e: rusqlite::Error) -> HpError {
    HpError::Store(format!("{context}: {e}"))
}

/// 生成 UUID v4 文本。
pub(crate) fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 校验非空字符串参数。
pub(crate) fn require_nonempty(value: &str, field: &str) -> HpResult<()> {
    if value.trim().is_empty() {
        return Err(HpError::InvalidArgument(format!("{field} 不能为空")));
    }
    Ok(())
}
