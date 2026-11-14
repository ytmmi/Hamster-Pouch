//! 文件行 → 前端列表项的转换。

use super::prelude::*;

/// 相册成员 / 文件查询返回项。
#[derive(Serialize)]
pub(crate) struct AlbumFileItem {
    pub(crate) id: String,
    pub(crate) source_id: String,
    pub(crate) relative_path: String,
    pub(crate) media_type: String,
    /// 文件的**标记集合**（D102：可多值、与类目正交；`book` / `manga` / …）。
    ///
    /// 与 `media_type` 的分工见 `hp_core::FileMark`：`media_type` 是扫描判定的**类目**，
    /// 标记是**用户在条目上的选择**。前端据此决定"这本书要不要去取内嵌封面"
    /// 以及蓝图按标记分派的行为。
    pub(crate) marks: Vec<String>,
    pub(crate) size: i64,
    pub(crate) mtime: String,
    /// 图片的**显示宽高**（EXIF 方向已应用，0043）；非图片或未回填为 `None`。
    ///
    /// 消费方（媒体预览虚拟化、胶片栏）必须把 `None` 当"还没补"降级成估计值，
    /// 不得当成 0 或 1:1——那会把"未知"渲染成错得确定的布局。
    pub(crate) width: Option<u32>,
    pub(crate) height: Option<u32>,
}

/// 文件索引行 → 返回项。
pub(crate) fn file_to_item(f: FileIndexRow) -> AlbumFileItem {
    AlbumFileItem {
        id: f.id.as_str().to_string(),
        source_id: f.source_id.as_str().to_string(),
        relative_path: f.relative_path,
        media_type: f.media_type.as_str().to_string(),
        marks: f.marks.iter().map(|m| m.as_str().to_string()).collect(),
        size: f.size,
        mtime: f.mtime,
        width: f.width,
        height: f.height,
    }
}
