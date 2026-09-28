//! 相册业务服务：创建、媒体属性变更、成员维护（RFC 0002 / D10 / D13）。

use hp_core::{
    AddedBy, Album, AlbumKind, AlbumMediaType, AlbumSyncRule, FileIndexRow, HpError, HpResult,
    SourceId, SyncMode,
};
use hp_store::RepoDb;

use crate::media::resolve_media_type;

/// 修改媒体属性的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetMediaTypeOutcome {
    /// 因属性变更被移除的成员数。
    pub removed_count: u64,
    /// 操作历史记录 ID；无成员被移除时为 `None`。
    pub op_record_id: Option<String>,
}

/// 手动加入成员的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddMembersOutcome {
    /// 实际新增的成员数（已存在的成员不计入）。
    pub added: u64,
}

/// 单文件同步冲突的原因码：成员已被用户固定（pinned），`mirror` 本应移除却保留。
pub const CONFLICT_REASON_PINNED_KEPT: &str = "pinned_kept";

/// 单文件同步冲突（缺陷 0004）。
///
/// 语义是**逐文件**的：某个成员不再匹配当前同步规则，但被用户显式固定（pinned）而保留
/// —— RFC 0002 明确要求「`mirror` 模式可能移除用户以为还存在的成员，需要 UI 明确提示」，
/// 因此这条信号必须带**真实 `file_id`**，让界面能逐条列出。
///
/// 与"整体失败"是两件事：后者走事件 `album.sync.failed`，`file_id` 与它无关。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncConflict {
    /// 冲突成员的 file ID（真实值，**不再是空串**）。
    pub file_id: String,
    /// 稳定原因码，见 [`CONFLICT_REASON_PINNED_KEPT`]。
    pub reason: String,
}

/// 跟随源同步结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncOutcome {
    pub added: u64,
    pub removed: u64,
    /// `mirror` 模式下因 pinned 而保留的成员数（等于 `conflicts.len()`，保留以便兼容既有展示）。
    pub pinned_kept: u64,
    /// 逐文件冲突明细（缺陷 0004）：每条都带真实 `file_id`。
    pub conflicts: Vec<SyncConflict>,
}

/// 相册业务服务入口。
pub struct AlbumService;

impl AlbumService {
    /// 创建固定型相册；可选写入初始成员（校验媒体属性）。
    pub fn create_fixed(
        db: &mut RepoDb,
        repo_id: &str,
        name: &str,
        media_type: Option<AlbumMediaType>,
        parent_album_id: Option<&str>,
        file_ids: &[String],
    ) -> HpResult<Album> {
        let album = db.create_album(repo_id, name, AlbumKind::Fixed, media_type, parent_album_id)?;
        if !file_ids.is_empty() {
            Self::add_members(db, album.id.as_str(), file_ids)?;
        }
        Ok(album)
    }

    /// 创建跟随源型相册并写入同步规则（初始成员由 `sync` 维护）。
    #[allow(clippy::too_many_arguments)]
    pub fn create_follow_source(
        db: &mut RepoDb,
        repo_id: &str,
        name: &str,
        media_type: Option<AlbumMediaType>,
        parent_album_id: Option<&str>,
        source_id: &str,
        sync_mode: SyncMode,
        include_subsources: bool,
        filter_json: Option<String>,
    ) -> HpResult<Album> {
        let album = db.create_album(
            repo_id,
            name,
            AlbumKind::FollowSource,
            media_type,
            parent_album_id,
        )?;
        let effective = resolve_media_type(db, &album)?;
        let rule = AlbumSyncRule {
            album_id: album.id.clone(),
            source_id: SourceId::from_raw(source_id),
            include_subsources,
            media_type: effective,
            filter_json,
            sync_mode,
            enabled: true,
        };
        db.upsert_sync_rule(&rule)?;
        Ok(album)
    }

    /// 手动加入成员：不匹配相册属性的文件整体拒绝（D10）。
    ///
    /// 跟随型相册中用户手动加入的成员默认 `pinned=true`，防止被同步移除。
    pub fn add_members(
        db: &mut RepoDb,
        album_id: &str,
        file_ids: &[String],
    ) -> HpResult<AddMembersOutcome> {
        let album = db
            .get_album(album_id)?
            .ok_or_else(|| HpError::NotFound(format!("相册不存在: {album_id}")))?;
        let media_type = resolve_media_type(db, &album)?;

        let mut rejected = Vec::new();
        for file_id in file_ids {
            let file = db
                .get_file(file_id)?
                .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
            if !media_type.contains(file.media_type) {
                rejected.push(file_id.clone());
            }
        }
        if !rejected.is_empty() {
            return Err(HpError::InvalidArgument(format!(
                "文件媒体类型与相册属性不匹配，已拒绝: {}",
                rejected.join(", ")
            )));
        }

        let pinned = album.kind == AlbumKind::FollowSource;
        let mut added = 0u64;
        for file_id in file_ids {
            let existed = db.get_album_member(album_id, file_id)?.is_some();
            db.add_album_member(album_id, file_id, AddedBy::User, pinned)?;
            if !existed {
                added += 1;
            }
        }
        Ok(AddMembersOutcome { added })
    }

    /// 移除成员；返回实际移除数量。
    pub fn remove_members(db: &mut RepoDb, album_id: &str, file_ids: &[String]) -> HpResult<u64> {
        db.remove_album_members(album_id, file_ids)
    }

    /// 修改媒体属性：联动同步规则、移除不匹配成员并写操作历史（D10 / D13）。
    pub fn set_media_type(
        db: &mut RepoDb,
        repo_id: &str,
        album_id: &str,
        media_type: Option<AlbumMediaType>,
    ) -> HpResult<SetMediaTypeOutcome> {
        db.get_album(album_id)?
            .ok_or_else(|| HpError::NotFound(format!("相册不存在: {album_id}")))?;
        db.update_album_media_type(album_id, media_type)?;

        let updated = db
            .get_album(album_id)?
            .ok_or_else(|| HpError::NotFound(format!("相册不存在: {album_id}")))?;
        let effective = resolve_media_type(db, &updated)?;

        // D13：跟随源型相册属性变更时联动更新同步规则的媒体过滤字段。
        if updated.kind == AlbumKind::FollowSource {
            if let Some(mut rule) = db.get_sync_rule(album_id)? {
                rule.media_type = effective;
                db.upsert_sync_rule(&rule)?;
            }
        }

        // 移除不再匹配新属性的成员。
        let members = db.list_album_members(album_id)?;
        let mut to_remove = Vec::new();
        for member in &members {
            if let Some(file) = db.get_file(member.file_id.as_str())? {
                if !effective.contains(file.media_type) {
                    to_remove.push(member.file_id.as_str().to_string());
                }
            }
        }
        let removed_count = if to_remove.is_empty() {
            0
        } else {
            db.remove_album_members(album_id, &to_remove)?
        };

        // 有移除时必须写操作历史，供追溯/撤销。
        let op_record_id = if removed_count > 0 {
            let ids = to_remove
                .iter()
                .map(|f| format!("\"{f}\""))
                .collect::<Vec<_>>()
                .join(",");
            let payload = format!(r#"{{"albumId":"{album_id}","removedFileIds":[{ids}]}}"#);
            Some(db.insert_ops_history(repo_id, "album_media_change", &payload, None)?)
        } else {
            None
        };

        Ok(SetMediaTypeOutcome {
            removed_count,
            op_record_id,
        })
    }

    /// 执行跟随源同步（`add_only` / `mirror`，pinned 成员保留）。
    pub fn sync(db: &mut RepoDb, repo_id: &str, album_id: &str) -> HpResult<SyncOutcome> {
        crate::sync::run_sync(db, repo_id, album_id)
    }

    /// 相册可见成员：按有效媒体属性过滤后的文件索引行（D10）。
    pub fn visible_members(db: &RepoDb, album_id: &str) -> HpResult<Vec<FileIndexRow>> {
        crate::media::visible_members(db, album_id)
    }
}
