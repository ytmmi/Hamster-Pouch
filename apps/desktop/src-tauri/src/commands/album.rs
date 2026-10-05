//! M3：虚拟相册命令桥接。
//!
//! **D76 迁移状态：已包装**（批次 `album`，2026-09）。全部命令返回
//! `{ ok, data?, error? }`，错误为结构化 `HpError`；前端 `api/album.ts` 经
//! `unwrapApi` 解包，界面按 `code` 走 i18n（D27）。

use hp_album::AlbumService;
use hp_core::{AlbumKind, AlbumMediaType, HpError, HpResult, SyncMode};
use serde::Serialize;
use tauri::{Emitter, State};

use crate::commands::shared::{
    api_async, api_from_hp, file_to_item, lock_repo, open_repo, open_repo_mut, AlbumFileItem,
    ApiAsync, ApiResponse,
};
use crate::AppState;

#[derive(Serialize)]
pub(crate) struct AlbumItem {
    id: String,
    repo_id: String,
    parent_album_id: Option<String>,
    name: String,
    kind: String,
    media_type: Option<String>,
    /// 成员数量（`album_member` 表行数）。
    member_count: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
pub(crate) struct AlbumCreateResult {
    album_id: String,
}

#[derive(Serialize)]
pub(crate) struct AlbumSetMediaTypeResult {
    removed_count: u64,
    op_record_id: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct AlbumMemberResult {
    added: u64,
}

#[derive(Serialize)]
pub(crate) struct AlbumRemoveResult {
    removed: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AlbumSyncProgressEvent {
    task_id: String,
    album_id: String,
    added: u64,
    removed: u64,
    pinned: u64,
}

/// 单文件同步冲突（缺陷 0004）：**一个成员一条事件**，`fileId` 是真实值。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AlbumSyncConflictEvent {
    task_id: String,
    album_id: String,
    /// 冲突成员的 file ID——**不再是空串**。
    file_id: String,
    /// 稳定原因码（`pinned_kept`：成员已被用户固定，`mirror` 本应移除却保留）。
    reason: String,
}

/// 同步**整体失败**（缺陷 0004）：与"单文件冲突"分开，避免两种语义挤在一个事件名里。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AlbumSyncFailedEvent {
    task_id: String,
    album_id: String,
    /// 诊断串（结构化错误码仍以命令层/`code` 为准）。
    error: String,
}

/// 解析相册媒体属性字符串；缺省或空串表示继承父相册。
fn parse_album_media_type(value: Option<&str>) -> HpResult<Option<AlbumMediaType>> {
    match value {
        None | Some("") => Ok(None),
        Some(s) => AlbumMediaType::from_str(s)
            .map(Some)
            .ok_or_else(|| HpError::InvalidArgument(format!("未知媒体属性: {s}"))),
    }
}

fn album_to_item(a: hp_core::Album, member_count: i64) -> AlbumItem {
    AlbumItem {
        id: a.id.as_str().to_string(),
        repo_id: a.repo_id.as_str().to_string(),
        parent_album_id: a.parent_album_id.map(|p| p.as_str().to_string()),
        name: a.name,
        kind: a.kind.as_str().to_string(),
        media_type: a.media_type.map(|m| m.as_str().to_string()),
        member_count,
        created_at: a.created_at,
        updated_at: a.updated_at,
    }
}

/// album.create：创建固定型或跟随源型相册。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn album_create(
    repo_id: String,
    name: String,
    kind: String,
    media_type: Option<String>,
    parent_album_id: Option<String>,
    source_id: Option<String>,
    sync_mode: Option<String>,
    include_subsources: Option<bool>,
    filter_json: Option<String>,
    file_ids: Option<Vec<String>>,
    state: State<AppState>,
) -> ApiResponse<AlbumCreateResult> {
    let outcome = (|| -> HpResult<AlbumCreateResult> {
        if name.trim().is_empty() {
            return Err(HpError::InvalidArgument("相册名不能为空".into()));
        }
        let kind = AlbumKind::from_str(&kind)
            .ok_or_else(|| HpError::InvalidArgument(format!("未知相册类型: {kind}")))?;
        let media_type = parse_album_media_type(media_type.as_deref())?;

        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;

        let album = match kind {
            AlbumKind::Fixed => {
                let files = file_ids.unwrap_or_default();
                AlbumService::create_fixed(
                    db,
                    &repo_id,
                    &name,
                    media_type,
                    parent_album_id.as_deref(),
                    &files,
                )?
            }
            AlbumKind::FollowSource => {
                let source_id = source_id
                    .ok_or_else(|| HpError::InvalidArgument("跟随源型相册必须提供 sourceId".into()))?;
                let mode = SyncMode::from_str(sync_mode.as_deref().unwrap_or("add_only"))
                    .ok_or_else(|| HpError::InvalidArgument("未知同步模式".into()))?;
                AlbumService::create_follow_source(
                    db,
                    &repo_id,
                    &name,
                    media_type,
                    parent_album_id.as_deref(),
                    &source_id,
                    mode,
                    include_subsources.unwrap_or(false),
                    filter_json,
                )?
            }
        };

        Ok(AlbumCreateResult {
            album_id: album.id.as_str().to_string(),
        })
    })();
    api_from_hp(outcome)
}

/// album.setMediaType：修改相册媒体属性（移除不匹配成员并写操作历史）。
#[tauri::command]
pub(crate) fn album_set_media_type(
    repo_id: String,
    album_id: String,
    media_type: Option<String>,
    state: State<AppState>,
) -> ApiResponse<AlbumSetMediaTypeResult> {
    let outcome = (|| -> HpResult<AlbumSetMediaTypeResult> {
        let media_type = parse_album_media_type(media_type.as_deref())?;
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        let outcome = AlbumService::set_media_type(db, &repo_id, &album_id, media_type)?;
        Ok(AlbumSetMediaTypeResult {
            removed_count: outcome.removed_count,
            op_record_id: outcome.op_record_id,
        })
    })();
    api_from_hp(outcome)
}

/// album.addMember：手动加入成员（不匹配相册属性的文件被拒绝）。
#[tauri::command]
pub(crate) fn album_add_member(
    repo_id: String,
    album_id: String,
    file_ids: Vec<String>,
    state: State<AppState>,
) -> ApiResponse<AlbumMemberResult> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<AlbumMemberResult> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        let outcome = AlbumService::add_members(db, &album_id, &file_ids)?;
        Ok(AlbumMemberResult {
            added: outcome.added,
        })
    })();
    api_from_hp(outcome)
}

/// album.removeMember：移除成员。
#[tauri::command]
pub(crate) fn album_remove_member(
    repo_id: String,
    album_id: String,
    file_ids: Vec<String>,
    state: State<AppState>,
) -> ApiResponse<AlbumRemoveResult> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<AlbumRemoveResult> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        let removed = AlbumService::remove_members(db, &album_id, &file_ids)?;
        Ok(AlbumRemoveResult { removed })
    })();
    api_from_hp(outcome)
}

/// album.list：列出仓库下全部相册。
#[tauri::command]
pub(crate) fn album_list(repo_id: String, state: State<AppState>) -> ApiResponse<Vec<AlbumItem>> {
    let outcome = (|| -> HpResult<Vec<AlbumItem>> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let albums = db.list_albums(&repo_id)?;
        let mut items = Vec::with_capacity(albums.len());
        for a in albums {
            let count = db.count_album_members(a.id.as_str())?;
            items.push(album_to_item(a, count));
        }
        Ok(items)
    })();
    api_from_hp(outcome)
}

/// `album.members` 的返回体：本页 + 下一页游标（`null` = 已到末页）。
///
/// 与 `file.query` 的 `FileQueryPage` **同形**（D78 先例）：界面按同一套"回传 nextCursor"
/// 的写法消费两种分页，不必记两套规则。
#[derive(Serialize)]
pub(crate) struct AlbumMembersPage {
    items: Vec<AlbumFileItem>,
    next_cursor: Option<String>,
}

/// album.members：**游标分页**列出相册可见成员（按有效媒体属性过滤）。
///
/// **为什么要分页**（`docs/issues/0018`）：旧实现一次性返回全部成员，而
/// `list_album_members` 没有上限——5 万成员的相册会把全部行读进内存，
/// 前端还会为每个成员建一个 `IntersectionObserver`（`mediaPreviewCell.tsx`）。
///
/// - 请求 `{ repoId, albumId, cursor?, limit? }`：`limit` 只是**页大小**（默认 500，上限 1000）；
/// - 响应 `{ items, nextCursor }`：把 `nextCursor` 原样回传即可续页，`null` = 末页；
/// - **排序键**：`(added_at, file_id)` 升序（`added_at` 可能同值，必须带 `file_id` 才是全序）；
/// - 游标是**键集游标**：翻页途中相册增删成员不会漏项/重复；
/// - 媒体属性过滤（D10）与离线源排除与旧实现**语义一致**，只是下推到了 SQL。
#[tauri::command]
pub(crate) fn album_members(
    repo_id: String,
    album_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
    state: State<AppState>,
) -> ApiResponse<AlbumMembersPage> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<AlbumMembersPage> {
        let parsed_cursor = match cursor.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => Some(hp_store::AlbumMemberCursor::decode(raw)?),
        };
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        // 有效媒体属性（含嵌套继承）→ 展开成三个布尔标志，交给 SQL 过滤。
        let media_type = AlbumService::effective_media_type(db, &album_id)?;
        let (want_image, want_video, want_audio) = match media_type {
            AlbumMediaType::Multimedia => (true, true, true),
            AlbumMediaType::Image => (true, false, false),
            AlbumMediaType::Video => (false, true, false),
            AlbumMediaType::Audio => (false, false, true),
        };
        let (rows, next) = db.query_album_members_page(
            &album_id,
            want_image,
            want_video,
            want_audio,
            parsed_cursor.as_ref(),
            limit.unwrap_or(500),
        )?;
        Ok(AlbumMembersPage {
            items: rows.into_iter().map(file_to_item).collect(),
            next_cursor: next.map(|c| c.encode()),
        })
    })();
    api_from_hp(outcome)
}

/// album.sync：执行跟随源同步，后台运行并发出进度 / 逐文件冲突 / 整体失败事件。
///
/// 异步命令（含 `State<'_, _>` 引用）按 Tauri 的要求返回 `Result`，
/// 由 [`ApiAsync`] 承载——包装仍落在**成功值**里。
///
/// 返回的是 `taskId`：真正的同步在后台线程执行。**三种结果各有其事件**（缺陷 0004）：
/// - 成功 → `album.sync.progress`（计数汇总）；
/// - 成功但存在"本应移除却被 pinned 保留"的成员 → 每个成员一条 `album.sync.conflict`
///   （带**真实 `fileId`** 与原因码 `pinned_kept`），其余成员照常同步；
/// - 整体失败（相册/规则不存在、库错误等）→ `album.sync.failed`。
/// 旧实现把整体失败也发成 `album.sync.conflict` 且 `fileId` 填空串，前端无法定位冲突文件。
#[tauri::command]
pub(crate) async fn album_sync(
    repo_id: String,
    album_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiAsync<String> {
    let outcome = (|| -> HpResult<String> {
        if album_id.trim().is_empty() {
            return Err(HpError::InvalidArgument("相册 ID 不能为空".into()));
        }
        let task_id = uuid::Uuid::new_v4().to_string();
        let st = state.inner().clone();
        let app_handle = app.clone();
        let emit_task_id = task_id.clone();
        let emit_album_id = album_id.clone();

        tauri::async_runtime::spawn_blocking(move || match run_album_sync(&st, &repo_id, &album_id) {
            Ok(outcome) => {
                let _ = app_handle.emit(
                    "album.sync.progress",
                    AlbumSyncProgressEvent {
                        task_id: emit_task_id.clone(),
                        album_id: emit_album_id.clone(),
                        added: outcome.added,
                        removed: outcome.removed,
                        pinned: outcome.pinned_kept,
                    },
                );
                // 逐文件冲突：一个成员一条事件，fileId 一定非空（缺陷 0004）
                for conflict in &outcome.conflicts {
                    let _ = app_handle.emit(
                        "album.sync.conflict",
                        AlbumSyncConflictEvent {
                            task_id: emit_task_id.clone(),
                            album_id: emit_album_id.clone(),
                            file_id: conflict.file_id.clone(),
                            reason: conflict.reason.clone(),
                        },
                    );
                }
            }
            Err(e) => {
                let _ = app_handle.emit(
                    "album.sync.failed",
                    AlbumSyncFailedEvent {
                        task_id: emit_task_id.clone(),
                        album_id: emit_album_id.clone(),
                        error: e.to_string(),
                    },
                );
            }
        });

        Ok(task_id)
    })();
    api_async(api_from_hp(outcome))
}

/// 在后台线程执行相册同步。
fn run_album_sync(
    state: &AppState,
    repo_id: &str,
    album_id: &str,
) -> HpResult<hp_album::SyncOutcome> {
    let mut guard = lock_repo(state)?;
    let db = open_repo_mut(&mut guard)?;
    AlbumService::sync(db, repo_id, album_id)
}

/// album.rename：重命名相册。
#[tauri::command]
pub(crate) fn album_rename(
    repo_id: String,
    album_id: String,
    name: String,
    state: State<AppState>,
) -> ApiResponse<()> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(HpError::InvalidArgument("相册名不能为空".into()));
        }
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        db.update_album_name(&album_id, name)
    })();
    api_from_hp(outcome)
}

/// album.delete：删除相册（成员关系与同步规则一并清理）。
#[tauri::command]
pub(crate) fn album_delete(
    repo_id: String,
    album_id: String,
    state: State<AppState>,
) -> ApiResponse<()> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<()> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        db.delete_album(&album_id)
    })();
    api_from_hp(outcome)
}
