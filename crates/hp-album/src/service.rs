//! 相册业务服务：创建、媒体属性变更、成员维护、移动与取消同步
//! （RFC 0002 / D10 / D13 / D128）。

use std::collections::HashSet;

use hp_core::{
    AddedBy, Album, AlbumKind, AlbumMediaType, AlbumSyncRule, FileIndexRow, HpError, HpResult,
    SourceId, SyncMode,
};
use hp_store::RepoDb;

use crate::media::resolve_media_type;
use crate::mirror::{dir_filter_json, normalize_dir};

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

/// 移动相册的结果（D128 / D132）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveOutcome {
    /// 父相册是否真的发生变化（拖到原来的父级下即为 `false`）。
    pub parent_changed: bool,
    /// 移动后父相册的 ID；移动到顶层为 `None`。
    pub parent_album_id: Option<String>,
    /// 同级顺序是否真的发生变化（插到自己原来的位置即为 `false`）。
    pub order_changed: bool,
}

/// 取消同步的结果（D128）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsyncOutcome {
    /// 一并退化为固定型相册的**镜像子相册**数量（不含被取消的相册本人）。
    pub released_children: u64,
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
        let album =
            db.create_album(repo_id, name, AlbumKind::Fixed, media_type, parent_album_id)?;
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

    /// 「创建为相册（仅当前对象）」：把源（或源内某个目录）**当前**的对象一次性复制成
    /// **固定型相册**（D128）。
    ///
    /// 这是一份快照：创建之后不再跟随源，源里新增/删除文件都不会影响它。
    /// 与 [`Self::create_sync_album`] 的区别只在于"是否持续同步"。
    #[allow(clippy::too_many_arguments)]
    pub fn create_snapshot(
        db: &mut RepoDb,
        repo_id: &str,
        name: &str,
        media_type: Option<AlbumMediaType>,
        parent_album_id: Option<&str>,
        source_id: &str,
        relative_path: Option<&str>,
        include_subsources: bool,
    ) -> HpResult<Album> {
        let album =
            db.create_album(repo_id, name, AlbumKind::Fixed, media_type, parent_album_id)?;
        let effective = resolve_media_type(db, &album)?;
        let prefix = relative_path.map(normalize_dir).filter(|p| !p.is_empty());
        let dir_prefix = prefix.map(|p| format!("{p}/"));

        let mut source_ids = vec![source_id.to_string()];
        if include_subsources {
            let sources = db.list_mounted_sources(repo_id)?;
            let mut frontier = vec![source_id.to_string()];
            while let Some(parent) = frontier.pop() {
                for source in &sources {
                    let is_child = source
                        .parent_source_id
                        .as_ref()
                        .is_some_and(|p| p.as_str() == parent.as_str());
                    let id = source.id.as_str().to_string();
                    if is_child && !source_ids.contains(&id) {
                        source_ids.push(id.clone());
                        frontier.push(id);
                    }
                }
            }
        }

        let mut file_ids = Vec::new();
        for id in &source_ids {
            for file in db.list_files_by_source(id)? {
                let media_ok = effective.contains(file.media_type);
                let dir_ok = dir_prefix
                    .as_deref()
                    .is_none_or(|p| file.relative_path.starts_with(p));
                if media_ok && dir_ok {
                    file_ids.push(file.id.as_str().to_string());
                }
            }
        }
        if !file_ids.is_empty() {
            Self::add_members(db, album.id.as_str(), &file_ids)?;
        }
        Ok(album)
    }

    /// 「创建为同步相册」：建立**持续同步**的跟随源相册，并按源目录层级自动维护镜像子相册
    /// （D128）。
    ///
    /// 只增不删：源里新出现的对象自动加入；用户手动移除的对象会被记入排除表而不再被加回；
    /// 用户手动加入的对象保持。镜像子相册的位置始终与源目录层级一致。
    #[allow(clippy::too_many_arguments)]
    pub fn create_sync_album(
        db: &mut RepoDb,
        repo_id: &str,
        name: &str,
        media_type: Option<AlbumMediaType>,
        parent_album_id: Option<&str>,
        source_id: &str,
        relative_path: Option<&str>,
    ) -> HpResult<Album> {
        let dir_path = relative_path.map(normalize_dir).unwrap_or_default();
        let album = Self::create_follow_source(
            db,
            repo_id,
            name,
            media_type,
            parent_album_id,
            source_id,
            // 只增不删：同步相册不会因为源里文件消失而移除用户看到的成员（D128）。
            SyncMode::AddOnly,
            false,
            dir_filter_json(&dir_path),
        )?;
        // 同步根指向自己，这是"我是同步根"的唯一标记。
        db.set_album_sync_mirror(
            album.id.as_str(),
            Some(album.id.as_str()),
            Some(dir_path.as_str()),
        )?;
        let mut album = album;
        album.sync_root_album_id = Some(album.id.clone());
        album.sync_dir_path = Some(dir_path);
        Ok(album)
    }

    /// 移动相册到新的父相册（`None` 表示移到顶层），D128。
    ///
    /// 拒绝自包含与任何会形成环的移动：两个相册不允许互为祖先。
    /// 同级顺序不变（相册保持原有 `sort_order`）；要精确插到某一行之前请用
    /// [`Self::move_album_ordered`]（D132）。
    pub fn move_album(
        db: &mut RepoDb,
        album_id: &str,
        new_parent_album_id: Option<&str>,
    ) -> HpResult<MoveOutcome> {
        Self::move_album_ordered(db, album_id, new_parent_album_id, None)
    }

    /// 移动相册并指定同级落点（D132 拖拽排序）。
    ///
    /// `before_album_id` 是**目标父级下已有的一个兄弟相册**，被移动的相册插到它之前；
    /// `None` 表示排到同级末尾。落点不属于目标父级时报 `validation`——
    /// 静默忽略会让"插在中间"变成"随便塞一个地方"，用户看到的结果与操作不符。
    pub fn move_album_ordered(
        db: &mut RepoDb,
        album_id: &str,
        new_parent_album_id: Option<&str>,
        before_album_id: Option<&str>,
    ) -> HpResult<MoveOutcome> {
        let album = db
            .get_album(album_id)?
            .ok_or_else(|| HpError::NotFound(format!("相册不存在: {album_id}")))?;

        if let Some(parent_id) = new_parent_album_id {
            if parent_id == album_id {
                return Err(HpError::InvalidArgument(
                    "相册不能成为自己的子相册".to_string(),
                ));
            }
            let mut cursor = Some(parent_id.to_string());
            // 沿目标父级向上回溯：遇到自己就说明会形成环。上限防御脏数据。
            for _ in 0..crate::media::MAX_ALBUM_DEPTH {
                let Some(current) = cursor else { break };
                if current == album_id {
                    return Err(HpError::InvalidArgument(
                        "目标相册是当前相册的子相册，不能形成互相包含".to_string(),
                    ));
                }
                cursor = db
                    .get_album(&current)?
                    .and_then(|a| a.parent_album_id.map(|p| p.as_str().to_string()));
            }
        }

        let current_parent = album
            .parent_album_id
            .as_ref()
            .map(|p| p.as_str().to_string());
        let parent_changed = current_parent.as_deref() != new_parent_album_id;
        if parent_changed {
            db.update_album_parent(album_id, new_parent_album_id)?;
        }

        // 目标父级下的完整兄弟序列（已按当前顺序排好）
        let mut siblings: Vec<String> = match new_parent_album_id {
            Some(parent_id) => db
                .list_child_albums(parent_id)?
                .into_iter()
                .map(|a| a.id.as_str().to_string())
                .collect(),
            None => db
                .list_albums(album.repo_id.as_str())?
                .into_iter()
                .filter(|a| a.parent_album_id.is_none())
                .map(|a| a.id.as_str().to_string())
                .collect(),
        };
        let previous_order = siblings.clone();
        siblings.retain(|id| id != album_id);
        let insert_at = match before_album_id {
            Some(anchor) => match siblings.iter().position(|id| id == anchor) {
                Some(index) => index,
                None => {
                    return Err(HpError::InvalidArgument(format!(
                        "排序落点不是目标父级下的相册: {anchor}"
                    )));
                }
            },
            None => siblings.len(),
        };
        siblings.insert(insert_at, album_id.to_string());

        // 父级没变且顺序没变 = 空操作，不写库（避免拖回原位也刷新 updated_at）
        let order_changed = siblings != previous_order;
        if order_changed {
            db.reorder_albums(album.repo_id.as_str(), new_parent_album_id, &siblings)?;
        }
        Ok(MoveOutcome {
            parent_changed,
            parent_album_id: new_parent_album_id.map(|p| p.to_string()),
            order_changed,
        })
    }

    /// 取消同步：同步相册退化为一般（固定型）相册（D128）。
    ///
    /// 一并释放它自动生成的镜像子相册，避免它们失去同步根后仍挂着"跟随源"的规则；
    /// 成员关系全部保留（取消同步只改变后续是否跟随，不动已有内容）。
    pub fn unsync_album(db: &mut RepoDb, album_id: &str) -> HpResult<UnsyncOutcome> {
        let album = db
            .get_album(album_id)?
            .ok_or_else(|| HpError::NotFound(format!("相册不存在: {album_id}")))?;
        let is_sync_root = album
            .sync_root_album_id
            .as_ref()
            .is_some_and(|root| root.as_str() == album.id.as_str());
        if album.kind != AlbumKind::FollowSource || !is_sync_root {
            return Err(HpError::InvalidArgument(format!(
                "该相册不是同步相册: {album_id}"
            )));
        }

        // 镜像子相册：同一同步根下、且不是根自己的那些。
        let mirrors = db.list_albums(album.repo_id.as_str())?;
        let mut released_children = 0u64;
        let mut visited: HashSet<String> = HashSet::new();
        visited.insert(album_id.to_string());
        for mirror in mirrors {
            let belongs = mirror
                .sync_root_album_id
                .as_ref()
                .is_some_and(|root| root.as_str() == album_id);
            if !belongs || !visited.insert(mirror.id.as_str().to_string()) {
                continue;
            }
            db.delete_sync_rule(mirror.id.as_str())?;
            db.delete_sync_state(mirror.id.as_str())?;
            db.update_album_kind(mirror.id.as_str(), AlbumKind::Fixed)?;
            db.set_album_sync_mirror(mirror.id.as_str(), None, None)?;
            released_children += 1;
        }

        db.delete_sync_rule(album_id)?;
        db.delete_sync_state(album_id)?;
        db.update_album_kind(album_id, AlbumKind::Fixed)?;
        db.set_album_sync_mirror(album_id, None, None)?;
        Ok(UnsyncOutcome { released_children })
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
            // 用户重新手工加入 = 撤销之前的排除留痕（D128），否则下次同步仍判它被排除。
            if album.kind == AlbumKind::FollowSource {
                db.remove_album_sync_exclusion(album_id, file_id)?;
            }
            if !existed {
                added += 1;
            }
        }
        Ok(AddMembersOutcome { added })
    }

    /// 移除成员；返回实际移除数量。
    ///
    /// 跟随源型相册里被用户手动移除的成员会写入**排除留痕**（D128）：同步是"只增不删、
    /// 尊重用户手动编辑"的，没有这条留痕下一轮同步就会把它原样加回来。
    pub fn remove_members(db: &mut RepoDb, album_id: &str, file_ids: &[String]) -> HpResult<u64> {
        let album = db
            .get_album(album_id)?
            .ok_or_else(|| HpError::NotFound(format!("相册不存在: {album_id}")))?;
        let removed = db.remove_album_members(album_id, file_ids)?;
        if album.kind == AlbumKind::FollowSource {
            for file_id in file_ids {
                db.add_album_sync_exclusion(album_id, file_id)?;
            }
        }
        Ok(removed)
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
        if updated.kind == AlbumKind::FollowSource
            && let Some(mut rule) = db.get_sync_rule(album_id)?
        {
            rule.media_type = effective;
            db.upsert_sync_rule(&rule)?;
        }

        // 移除不再匹配新属性的成员。
        let members = db.list_album_members(album_id)?;
        let mut to_remove = Vec::new();
        for member in &members {
            if let Some(file) = db.get_file(member.file_id.as_str())?
                && !effective.contains(file.media_type)
            {
                to_remove.push(member.file_id.as_str().to_string());
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
    ///
    /// **注意**：本函数一次性返回**全部**可见成员（无上限）。界面取数不要用它，
    /// 走 `RepoDb::query_album_members_page` 的分页版本（`docs/issues/0018`）；
    /// 保留它是给"确实需要全量"的内部逻辑（如测试与将来的导出）。
    pub fn visible_members(db: &RepoDb, album_id: &str) -> HpResult<Vec<FileIndexRow>> {
        crate::media::visible_members(db, album_id)
    }

    /// 相册的**有效**媒体属性（显式值优先、空值继承父相册、顶层空值 = `multimedia`，D10）。
    ///
    /// 分页取数需要先把属性解析出来，才能把它翻译成 SQL 的媒体类型过滤条件。
    pub fn effective_media_type(db: &RepoDb, album_id: &str) -> HpResult<AlbumMediaType> {
        let album = db
            .get_album(album_id)?
            .ok_or_else(|| hp_core::HpError::NotFound(format!("相册不存在: {album_id}")))?;
        crate::media::resolve_media_type(db, &album)
    }
}
