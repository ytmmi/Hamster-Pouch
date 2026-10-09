//! 源间复制实现（RFC 0001：内容哈希一致则解释数据不丢失）。

use hp_core::{AddedBy, FileId, FileIndexRow, HpError, HpResult, Source, ThumbStatus, VerifyStatus};
use hp_store::RepoDb;

use crate::util;

/// 复制单个文件到目标源，返回 `(新文件 ID, 目标相对路径)`。
///
/// 新索引行沿用源文件的内容哈希与媒体信息；tag / 评分 / 相册成员关系继承到新文件
/// （RFC 0001 决策 5）。
pub(crate) fn copy_one(
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
    let dst_abs = util::abs_path(&target_source.local_path, &target_rel);
    if dst_abs.exists() {
        return Err(HpError::AlreadyExists(format!(
            "目标文件已存在: {}",
            dst_abs.display()
        )));
    }

    util::ensure_parent(&dst_abs)?;
    std::fs::copy(&src_abs, &dst_abs).map_err(|e| HpError::Io(format!("复制文件失败: {e}")))?;

    let new_row = FileIndexRow {
        id: FileId::generate(),
        source_id: target_source.id.clone(),
        relative_path: target_rel,
        media_type: file.media_type,
        // 标记随文件一起复制（D102）：它是用户在条目上的选择，复制出的新条目
        // 应当继承（与 tag / 评分"内容哈希一致时保留解释数据"同一口径）。
        marks: file.marks.clone(),
        content_hash: file.content_hash.clone(),
        content_hash_algo: file.content_hash_algo.clone(),
        content_hash_algo_version: file.content_hash_algo_version,
        perceptual_hash: file.perceptual_hash.clone(),
        perceptual_hash_algo: file.perceptual_hash_algo.clone(),
        perceptual_hash_algo_version: file.perceptual_hash_algo_version,
        size: file.size,
        mtime: file.mtime.clone(),
        scan_time: file.scan_time.clone(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::NotGenerated,
        missing_status: 0,
        media_info_json: file.media_info_json.clone(),
    };
    db.upsert_file(&new_row)?;

    inherit_associations(db, file.id.as_str(), new_row.id.as_str())?;
    Ok((new_row.id, new_row.relative_path))
}

/// 把原文件的 tag（人工 + 自动）/ 评分 / 相册成员关系继承到新文件。
fn inherit_associations(db: &mut RepoDb, from: &str, to: &str) -> HpResult<()> {
    // 人工 tag 关联
    for ft in db.list_file_tags(from)? {
        db.add_file_tag(to, ft.tag_id.as_str())?;
    }
    // 自动 tag 关联（RFC 0001：解释数据不丢失）
    for ft in db.list_file_auto_tags(from)? {
        db.add_file_auto_tag(
            to,
            ft.tag_id.as_str(),
            ft.confidence,
            ft.source_model.as_deref(),
        )?;
    }
    if let Some(rating) = db.get_rating(from)? {
        db.upsert_rating(to, rating.rating)?;
    }
    for album_id in db.list_album_ids_for_file(from)? {
        db.add_album_member(&album_id, to, AddedBy::User, false)?;
    }
    Ok(())
}
