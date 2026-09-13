//! 源间剪切/移动实现（RFC 0001：路径变化但内容哈希一致，保留 id 与解释数据）。

use hp_core::{FileId, FileIndexRow, HpError, HpResult, Source};
use hp_store::RepoDb;

use crate::util;

/// 移动单个文件到目标源，返回 `(原文件 ID, 目标相对路径)`。
///
/// 保留原文件 ID，因此 tag / 评分 / 相册成员关系不丢失。
pub(crate) fn move_one(
    db: &mut RepoDb,
    source: &Source,
    file: &FileIndexRow,
    target_source: &Source,
    target_dir: Option<&str>,
) -> HpResult<(FileId, String)> {
    let src_abs = util::abs_path(&source.local_path, &file.relative_path);
    if !src_abs.exists() {
        return Err(HpError::NotFound(format!(
            "源文件不存在: {}",
            src_abs.display()
        )));
    }

    let name = util::file_name_of(&file.relative_path);
    let target_rel = util::target_rel_path(target_dir, name);
    if target_source.id.as_str() == file.source_id.as_str() && target_rel == file.relative_path {
        return Err(HpError::InvalidArgument("目标位置与原位置相同".into()));
    }

    let dst_abs = util::abs_path(&target_source.local_path, &target_rel);
    if dst_abs.exists() {
        return Err(HpError::AlreadyExists(format!(
            "目标文件已存在: {}",
            dst_abs.display()
        )));
    }

    util::ensure_parent(&dst_abs)?;
    util::move_file(&src_abs, &dst_abs)?;
    db.update_file_path(file.id.as_str(), target_source.id.as_str(), &target_rel)?;
    Ok((file.id.clone(), target_rel))
}
