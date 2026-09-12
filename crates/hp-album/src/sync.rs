//! 跟随源同步：按规则维护成员关系（RFC 0002）。

use std::collections::HashSet;

use hp_core::{AddedBy, AlbumKind, AlbumSyncState, HpError, HpResult, SyncMode};
use hp_store::RepoDb;

use crate::service::SyncOutcome;

/// 执行一次跟随源同步。
pub fn run_sync(db: &mut RepoDb, repo_id: &str, album_id: &str) -> HpResult<SyncOutcome> {
    let album = db
        .get_album(album_id)?
        .ok_or_else(|| HpError::NotFound(format!("相册不存在: {album_id}")))?;
    if album.kind != AlbumKind::FollowSource {
        return Err(HpError::InvalidArgument(format!(
            "固定型相册没有同步规则: {album_id}"
        )));
    }
    let rule = db
        .get_sync_rule(album_id)?
        .ok_or_else(|| HpError::NotFound(format!("同步规则不存在: {album_id}")))?;
    if !rule.enabled {
        return Ok(SyncOutcome {
            added: 0,
            removed: 0,
            pinned_kept: 0,
        });
    }

    let source_ids = collect_source_ids(
        db,
        repo_id,
        rule.source_id.as_str(),
        rule.include_subsources,
    )?;

    // 匹配同步规则媒体过滤的文件集合。
    let mut matched: Vec<String> = Vec::new();
    for source_id in &source_ids {
        for file in db.list_files_by_source(source_id)? {
            if rule.media_type.contains(file.media_type) {
                matched.push(file.id.as_str().to_string());
            }
        }
    }
    let matched_set: HashSet<&str> = matched.iter().map(|s| s.as_str()).collect();

    // 增量加入匹配文件（add_only 与 mirror 都先补齐）。
    let mut added = 0u64;
    for file_id in &matched {
        if db.get_album_member(album_id, file_id)?.is_none() {
            db.add_album_member(album_id, file_id, AddedBy::SyncRule, false)?;
            added += 1;
        }
    }

    // mirror：移除非 pinned 且不再匹配的成员；pinned 成员保留。
    let mut removed = 0u64;
    let mut pinned_kept = 0u64;
    if rule.sync_mode == SyncMode::Mirror {
        let members = db.list_album_members(album_id)?;
        let mut to_remove = Vec::new();
        for member in &members {
            let matched_now = matched_set.contains(member.file_id.as_str());
            if member.pinned {
                if !matched_now {
                    pinned_kept += 1;
                }
                continue;
            }
            if !matched_now {
                to_remove.push(member.file_id.as_str().to_string());
            }
        }
        if !to_remove.is_empty() {
            removed = db.remove_album_members(album_id, &to_remove)?;
        }
    }

    let state = AlbumSyncState {
        album_id: album.id.clone(),
        source_id: rule.source_id.clone(),
        last_synced_at: Some(now_iso()),
        last_scan_cursor: None,
        status: Some("ok".to_string()),
    };
    db.upsert_sync_state(&state)?;

    Ok(SyncOutcome {
        added,
        removed,
        pinned_kept,
    })
}

/// 收集参与同步的源 ID（可选递归嵌套子源）。
fn collect_source_ids(
    db: &RepoDb,
    repo_id: &str,
    root: &str,
    include_subsources: bool,
) -> HpResult<Vec<String>> {
    let mut out = vec![root.to_string()];
    if !include_subsources {
        return Ok(out);
    }
    let sources = db.list_sources(repo_id)?;
    let mut frontier = vec![root.to_string()];
    while let Some(parent) = frontier.pop() {
        for source in &sources {
            let is_child = source
                .parent_source_id
                .as_ref()
                .map_or(false, |p| p.as_str() == parent.as_str());
            if is_child {
                let id = source.id.as_str().to_string();
                if !out.contains(&id) {
                    out.push(id.clone());
                    frontier.push(id);
                }
            }
        }
    }
    Ok(out)
}

/// 当前 UTC 时间的 ISO 8601 文本。
fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}
