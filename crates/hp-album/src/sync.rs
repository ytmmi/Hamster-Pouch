//! 跟随源同步：按规则维护成员关系（RFC 0002；同步相册的镜像子树见 D128）。

use std::collections::HashSet;

use hp_core::{AddedBy, AlbumKind, AlbumSyncState, HpError, HpResult, SyncMode};
use hp_store::RepoDb;

use crate::mirror::ensure_mirror_tree;
use crate::service::{CONFLICT_REASON_PINNED_KEPT, SyncConflict, SyncOutcome};

/// 执行一次跟随源同步。
///
/// 若该相册是**同步根**（`sync_root_album_id` 指向自己，D128），先按源目录层级维护
/// 镜像子树——缺失的镜像子相册新建、被挪走的搬回源对应位置——再依次同步整棵树的成员；
/// 若它是镜像子相册，只同步自己的成员（子树由同步根负责）。
pub fn run_sync(db: &mut RepoDb, repo_id: &str, album_id: &str) -> HpResult<SyncOutcome> {
    let album = db
        .get_album(album_id)?
        .ok_or_else(|| HpError::NotFound(format!("相册不存在: {album_id}")))?;
    if album.kind != AlbumKind::FollowSource {
        return Err(HpError::InvalidArgument(format!(
            "固定型相册没有同步规则: {album_id}"
        )));
    }

    let is_sync_root = album
        .sync_root_album_id
        .as_ref()
        .is_some_and(|root| root.as_str() == album.id.as_str());
    if !is_sync_root {
        return sync_one(db, repo_id, &album);
    }

    let rule = db
        .get_sync_rule(album_id)?
        .ok_or_else(|| HpError::NotFound(format!("同步规则不存在: {album_id}")))?;
    // 规则停用或根源离线时不做结构变更：离线源的目录树不可信，
    // 此时建出来的镜像会与源分叉，恢复挂载后再同步才是正确的。
    let root_mounted = db
        .get_source(rule.source_id.as_str())?
        .map(|s| s.mounted)
        .unwrap_or(false);
    if !rule.enabled || !root_mounted {
        return sync_one(db, repo_id, &album);
    }

    // 先建/摆正镜像子树，再逐个同步成员。
    let tree = ensure_mirror_tree(db, &album, &rule)?;
    let mut total = SyncOutcome {
        added: 0,
        removed: 0,
        pinned_kept: 0,
        conflicts: Vec::new(),
    };
    for node in &tree {
        let outcome = sync_one(db, repo_id, node)?;
        total.added += outcome.added;
        total.removed += outcome.removed;
        total.pinned_kept += outcome.pinned_kept;
        total.conflicts.extend(outcome.conflicts);
    }
    Ok(total)
}

/// 同步单个相册的成员关系（不建子树）。
fn sync_one(db: &mut RepoDb, repo_id: &str, album: &hp_core::Album) -> HpResult<SyncOutcome> {
    let album_id = album.id.as_str();
    let rule = db
        .get_sync_rule(album_id)?
        .ok_or_else(|| HpError::NotFound(format!("同步规则不存在: {album_id}")))?;
    if !rule.enabled {
        return Ok(SyncOutcome {
            added: 0,
            removed: 0,
            pinned_kept: 0,
            conflicts: Vec::new(),
        });
    }

    // 根源已卸载：不参与当前媒体库，同步必须是**空操作**。
    // 否则 mirror 会把它当作"匹配集合为空"而清空相册（连同手工加入的成员）。
    let root_mounted = db
        .get_source(rule.source_id.as_str())?
        .map(|s| s.mounted)
        .unwrap_or(false);
    if !root_mounted {
        let state = AlbumSyncState {
            album_id: album.id.clone(),
            source_id: rule.source_id.clone(),
            last_synced_at: Some(now_iso()),
            last_scan_cursor: None,
            status: Some("source_offline".to_string()),
        };
        db.upsert_sync_state(&state)?;
        return Ok(SyncOutcome {
            added: 0,
            removed: 0,
            pinned_kept: 0,
            conflicts: Vec::new(),
        });
    }

    let source_ids = collect_source_ids(
        db,
        repo_id,
        rule.source_id.as_str(),
        rule.include_subsources,
    )?;

    // 可选的目录前缀过滤（同步根的子目录 / 镜像子相册对应的源目录场景）。
    let dir_prefix = parse_dir_prefix(rule.filter_json.as_deref());

    // 镜像相册（有 `sync_dir_path`）按**精确目录**收录成员：`a/b/x.jpg` 只属于镜像
    // `"a/b"`，不会同时落进镜像 `"a"`（否则同一文件在每级祖先里重复出现，D128）。
    // 非镜像的跟随源相册保持原有前缀语义，向后兼容。
    let exact_dir = album.sync_dir_path.as_deref();

    // 用户手动移除过的成员必须留痕，否则下一轮同步会把它原样加回来（D128）。
    let excluded: HashSet<String> = db
        .list_album_sync_exclusions(album_id)?
        .into_iter()
        .collect();

    // 匹配同步规则媒体过滤（以及可选目录前缀）的文件集合。
    let mut matched: Vec<String> = Vec::new();
    for source_id in &source_ids {
        for file in db.list_files_by_source(source_id)? {
            let media_ok = rule.media_type.contains(file.media_type);
            let dir_ok = match (exact_dir, dir_prefix.as_deref()) {
                (Some(dir), _) => crate::mirror::file_dir(&file.relative_path) == *dir,
                (None, Some(prefix)) => file.relative_path.starts_with(prefix),
                (None, None) => true,
            };
            let file_id = file.id.as_str().to_string();
            if media_ok && dir_ok && !excluded.contains(&file_id) {
                matched.push(file_id);
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
    //
    // 每个"本应移除但因 pinned 保留"的成员都是一条**逐文件的冲突**（缺陷 0004）：
    // RFC 0002 要求 UI 明确提示"mirror 会移除用户以为还存在的成员"，
    // 所以这里不能只累加计数，必须把**真实 file_id** 带上抛给命令层。
    let mut removed = 0u64;
    let mut pinned_kept = 0u64;
    let mut conflicts: Vec<SyncConflict> = Vec::new();
    if rule.sync_mode == SyncMode::Mirror {
        let members = db.list_album_members(album_id)?;
        let mut to_remove = Vec::new();
        for member in &members {
            let matched_now = matched_set.contains(member.file_id.as_str());
            if member.pinned {
                if !matched_now {
                    pinned_kept += 1;
                    conflicts.push(SyncConflict {
                        file_id: member.file_id.as_str().to_string(),
                        reason: CONFLICT_REASON_PINNED_KEPT.to_string(),
                    });
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
        conflicts,
    })
}

/// 收集参与同步的源 ID（可选递归嵌套子源）。
///
/// 只收集**在线**源：离线源不属于当前媒体库，不能贡献成员。
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
    let sources = db.list_mounted_sources(repo_id)?;
    let mut frontier = vec![root.to_string()];
    while let Some(parent) = frontier.pop() {
        for source in &sources {
            let is_child = source
                .parent_source_id
                .as_ref()
                .is_some_and(|p| p.as_str() == parent.as_str());
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

/// 从 `filter_json` 解析可选的目录前缀（`{"dirPrefix":"<相对路径>"}`）。
///
/// 返回 `None` 当且仅当：`filter_json` 为 `None`、无法解析、没有 `dirPrefix`，
/// 或归一化后为空。归一化规则：`\` 替换为 `/`，去除首尾 `/`。
/// 返回 `Some("前缀/")`，确保前缀 `"a"` 匹配 `"a/x.jpg"` 但不匹配 `"ab/x.jpg"`。
fn parse_dir_prefix(filter_json: Option<&str>) -> Option<String> {
    let raw = filter_json?;
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let prefix = value.get("dirPrefix")?.as_str()?;
    let normalized = prefix.replace('\\', "/").trim_matches('/').to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(format!("{normalized}/"))
    }
}

/// 当前 UTC 时间的 ISO 8601 文本。
fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}
