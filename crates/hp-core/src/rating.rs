//! 评分领域模型（database-schema.md 第 4.5 节）。

use crate::file::FileId;

/// 仓库内文件评分（跨仓库隔离）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rating {
    pub file_id: FileId,
    pub rating: i64,
    pub updated_at: String,
}

/// 评分合法区间（含端点）。
pub const RATING_MIN: i64 = 0;
/// 评分合法区间（含端点）。
pub const RATING_MAX: i64 = 5;

/// 校验评分取值是否合法。
pub fn validate_rating(value: i64) -> bool {
    (RATING_MIN..=RATING_MAX).contains(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rating_range_is_enforced() {
        assert!(validate_rating(0));
        assert!(validate_rating(5));
        assert!(!validate_rating(-1));
        assert!(!validate_rating(6));
    }
}
