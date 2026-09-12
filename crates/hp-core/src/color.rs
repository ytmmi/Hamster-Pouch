//! 色彩参考领域模型（D18 / database-schema.md 第 4.5 节）。

use crate::file::FileId;

/// 文件色彩参考：自动提取或手动锁定的调色板，JSON 文本（仅图片，D18）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColorRef {
    pub file_id: FileId,
    /// 调色板 JSON：`{ "colors": ["#rrggbb", ...], "locked": bool }`。
    pub color_json: String,
    pub updated_at: String,
}
