//! 同步相册的**源目录镜像树**（D128）。
//!
//! 「创建为同步相册」按源目录层级自动生成并维护子相册，位置与源保持一致：
//! - 每个镜像子相册记住 `(sync_root_album_id, sync_dir_path)`，即"我属于哪个同步根、镜像哪个源目录"；
//! - 同步时**只增不删**：缺的镜像子相册新建，用户删掉的子相册下次同步重建；
//! - 已存在的镜像子相册被用户拖到别处时，同步会把它**搬回**源对应的位置（位置与源一致）；
//! - 用户改过的名字**保留**（只纠正位置，不改名）；
//! - 用户手建的子相册（没有镜像身份）不受影响。
//!
//! 镜像只跟随**同步规则所指向的那一个源**：把子源的文件混进同一棵路径树会产生
//! 路径空间歧义（两个源可以有同名目录），因此 `include_subsources` 的成员合并
//! 仍按原有语义进行，但不参与镜像树的层级推导。

use std::collections::BTreeSet;

use hp_core::{Album, AlbumKind, AlbumSyncRule, HpResult, SyncMode};
use hp_store::RepoDb;

use crate::media::resolve_media_type;

/// 目录路径归一化：`\` → `/`，去除首尾 `/`；源根归一化为空串。
pub(crate) fn normalize_dir(path: &str) -> String {
    path.replace('\\', "/").trim_matches('/').to_string()
}

/// 根相册对应的源内目录（无首尾 `/`；源根为空串）。
pub(crate) fn root_dir_prefix(rule: &AlbumSyncRule) -> String {
    rule.filter_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|value| value.get("dirPrefix")?.as_str().map(normalize_dir))
        .unwrap_or_default()
}

/// 目录前缀对应的 `filter_json`（源根返回 `None`，与既有 `dirPrefix` 约定一致）。
pub(crate) fn dir_filter_json(dir: &str) -> Option<String> {
    if dir.is_empty() {
        None
    } else {
        Some(format!(
            "{{\"dirPrefix\":{}}}",
            serde_json::to_string(dir).unwrap_or_default()
        ))
    }
}

/// 目录的父目录（`"a/b"` → `"a"`，`"a"` → `""`）。
fn parent_dir(dir: &str) -> String {
    match dir.rsplit_once('/') {
        Some((parent, _)) => parent.to_string(),
        None => String::new(),
    }
}

/// 目录最后一段（相册名）。
fn dir_name(dir: &str) -> String {
    dir.rsplit('/').next().unwrap_or(dir).to_string()
}

/// 文件所在目录（相对源根，已归一化；源根下的文件返回空串）。
///
/// 镜像子相册按**精确层级**收录成员：`a/b/x.jpg` 只属于目录 `"a/b"`，
/// 不会同时出现在镜像 `"a"` 里（否则同一文件在每级祖先相册里重复出现）。
pub(crate) fn file_dir(relative_path: &str) -> String {
    let normalized = normalize_dir(relative_path);
    parent_dir(&normalized)
}

/// 收集根目录下需要镜像的子目录（相对根目录；父目录一定排在子目录之前）。
pub(crate) fn collect_subdirs(
    db: &RepoDb,
    source_id: &str,
    prefix: &str,
) -> HpResult<BTreeSet<String>> {
    let mut dirs = BTreeSet::new();
    for relative_path in db.list_relative_paths_by_source(source_id)? {
        let normalized = normalize_dir(&relative_path);
        let rest = if prefix.is_empty() {
            normalized.as_str()
        } else {
            let with_slash = format!("{prefix}/");
            match normalized.strip_prefix(with_slash.as_str()) {
                Some(rest) => rest,
                None => continue,
            }
        };
        let mut segments: Vec<&str> = rest.split('/').collect();
        if segments.len() <= 1 {
            continue; // 根目录下的文件：没有子目录
        }
        segments.pop(); // 去掉文件名
        let mut accumulated = String::new();
        for segment in segments {
            if segment.is_empty() {
                continue;
            }
            if !accumulated.is_empty() {
                accumulated.push('/');
            }
            accumulated.push_str(segment);
            dirs.insert(accumulated.clone());
        }
    }
    Ok(dirs)
}

/// 维护同步根的镜像子树：新建缺失的镜像相册、把被挪走的搬回源对应位置。
///
/// 返回**整棵镜像树**（含根相册本身），供调用方逐个执行成员同步。
pub(crate) fn ensure_mirror_tree(
    db: &mut RepoDb,
    root: &Album,
    rule: &AlbumSyncRule,
) -> HpResult<Vec<Album>> {
    let prefix = root_dir_prefix(rule);
    let mut albums = vec![root.clone()];
    for dir in collect_subdirs(db, rule.source_id.as_str(), &prefix)? {
        let full_dir = if prefix.is_empty() {
            dir.clone()
        } else {
            format!("{prefix}/{dir}")
        };
        let expected_parent_id = {
            let parent = parent_dir(&dir);
            if parent.is_empty() {
                root.id.as_str().to_string()
            } else {
                let parent_full = if prefix.is_empty() {
                    parent.clone()
                } else {
                    format!("{prefix}/{parent}")
                };
                match db.find_sync_mirror_album(root.id.as_str(), &parent_full)? {
                    Some(parent_album) => parent_album.id.as_str().to_string(),
                    // 父目录的镜像还没建出来时跳过本目录：下一轮同步会补上，
                    // 这里硬建会得到一个指向错误父级的子相册。
                    None => continue,
                }
            }
        };

        if let Some(existing) = db.find_sync_mirror_album(root.id.as_str(), &full_dir)? {
            // 位置与源保持一致：被用户拖走的镜像子相册搬回源对应位置。
            let current_parent = existing
                .parent_album_id
                .as_ref()
                .map(|p| p.as_str().to_string());
            if current_parent.as_deref() != Some(expected_parent_id.as_str()) {
                db.update_album_parent(existing.id.as_str(), Some(&expected_parent_id))?;
            }
            albums.push(existing);
            continue;
        }

        let created = db.create_album(
            root.repo_id.as_str(),
            &dir_name(&dir),
            AlbumKind::FollowSource,
            None,
            Some(&expected_parent_id),
        )?;
        let effective = resolve_media_type(db, &created)?;
        db.upsert_sync_rule(&AlbumSyncRule {
            album_id: created.id.clone(),
            source_id: rule.source_id.clone(),
            include_subsources: false,
            media_type: effective,
            filter_json: dir_filter_json(&full_dir),
            // 只增不删：同步不会移除源里已消失的成员（D128）。
            sync_mode: SyncMode::AddOnly,
            enabled: true,
        })?;
        db.set_album_sync_mirror(
            created.id.as_str(),
            Some(root.id.as_str()),
            Some(full_dir.as_str()),
        )?;
        let mut created = created;
        created.sync_root_album_id = Some(root.id.clone());
        created.sync_dir_path = Some(full_dir);
        albums.push(created);
    }
    Ok(albums)
}
