//! 相册媒体属性解析与可见成员过滤（D10）。

use std::collections::{HashMap, HashSet};

use hp_core::{Album, AlbumMediaType, FileIndexRow, HpError, HpResult};
use hp_store::{RepoDb, is_excluded_path};

/// 相册嵌套解析的最大深度，防止异常父子环导致死循环。
pub(crate) const MAX_ALBUM_DEPTH: usize = 64;

/// 解析相册有效媒体属性：显式值优先；空值继承父相册；顶层空值视作 `multimedia`（D10）。
pub(crate) fn resolve_media_type(db: &RepoDb, album: &Album) -> HpResult<AlbumMediaType> {
    let mut current = album.clone();
    for _ in 0..MAX_ALBUM_DEPTH {
        if let Some(mt) = current.media_type {
            return Ok(mt);
        }
        match &current.parent_album_id {
            Some(parent_id) => {
                current = db
                    .get_album(parent_id.as_str())?
                    .ok_or_else(|| HpError::NotFound(format!("父相册不存在: {parent_id}")))?;
            }
            None => return Ok(AlbumMediaType::Multimedia),
        }
    }
    Err(HpError::Store("相册嵌套层级过深或存在环".into()))
}

/// 相册可见成员：成员关系中媒体类型匹配有效属性的文件（D10）。
///
/// 同时过滤**离线媒体源**：卸载的源不属于当前媒体库，其文件不得出现在相册里。
/// 这是显示侧的兜底——卸载本身会删除该源的成员关系（`crate::purge`），
/// 但历史数据或未来新增的离线路径仍可能留下成员行。
///
/// 还过滤**被排除子目录**（`source_exclusion`，D149）：与离线源同理，排除是视图级
/// 软隐藏，索引行与成员行都还在库里，所以必须在读取侧兜住，
/// 否则「源面板里没有了、相册里却还在」会直接暴露给用户。
pub(crate) fn visible_members(db: &RepoDb, album_id: &str) -> HpResult<Vec<FileIndexRow>> {
    let album = db
        .get_album(album_id)?
        .ok_or_else(|| HpError::NotFound(format!("相册不存在: {album_id}")))?;
    let media_type = resolve_media_type(db, &album)?;
    let mounted: HashSet<String> = db
        .list_mounted_sources(album.repo_id.as_str())?
        .into_iter()
        .map(|s| s.id.as_str().to_string())
        .collect();
    // 排除前缀**按源惰性装载并缓存**：一个相册的成员通常集中在少数几个源上，
    // 逐成员查一次库会把 N 个成员变成 N+1 次查询。
    let mut exclusions: HashMap<String, Vec<String>> = HashMap::new();
    let members = db.list_album_members(album_id)?;
    let mut out = Vec::new();
    for member in members {
        if let Some(file) = db.get_file(member.file_id.as_str())? {
            let source_id = file.source_id.as_str().to_string();
            if !mounted.contains(&source_id) {
                continue; // 离线源的文件不展示
            }
            let prefixes = match exclusions.get(&source_id) {
                Some(loaded) => loaded,
                None => {
                    let loaded = db.source_exclusion_prefixes(&source_id)?;
                    exclusions.entry(source_id.clone()).or_insert(loaded)
                }
            };
            if is_excluded_path(&file.relative_path, prefixes) {
                continue; // 被排除子目录下的文件不展示
            }
            if media_type.contains(file.media_type) {
                out.push(file);
            }
        }
    }
    Ok(out)
}
