//! M4/M5：tag 命令桥接（仓库内 tag 的增删查；人工/自动两组，D21）。
//!
//! **D76 迁移状态：已包装**（批次 `tag`，2026-09）。全部命令返回
//! `{ ok, data?, error? }`，错误为结构化 `HpError`；前端 `api/tag.ts` 经
//! `unwrapApi` 解包，界面按 `code` 走 i18n（D27）。

use hp_core::{HpError, HpResult, Tag, TagRelationKind};
use serde::Serialize;
use tauri::State;

use crate::commands::shared::{
    api_from_hp, lock_repo, open_repo, open_repo_mut, ApiResponse,
};
use crate::AppState;

#[derive(Serialize)]
pub(crate) struct TagItem {
    id: String,
    repo_id: String,
    name: String,
    color: Option<String>,
}

/// tag 关系项（D22：层级 + 关联，关系图谱数据源）。
#[derive(Serialize)]
pub(crate) struct TagRelationItem {
    id: String,
    repo_id: String,
    from_tag_id: String,
    to_tag_id: String,
    relation_kind: String,
    created_at: String,
}

/// 文件 tag 项（含自动组置信度；人工组为 `null`）。
#[derive(Serialize)]
pub(crate) struct FileTagItem {
    id: String,
    repo_id: String,
    name: String,
    color: Option<String>,
    confidence: Option<f64>,
}

/// 文件 tag 分组结果（D21：人工组在上、自动组在下）。
#[derive(Serialize)]
pub(crate) struct FileTagsResult {
    manual: Vec<FileTagItem>,
    auto: Vec<FileTagItem>,
}

fn tag_to_item(t: Tag) -> TagItem {
    TagItem {
        id: t.id.as_str().to_string(),
        repo_id: t.repo_id.as_str().to_string(),
        name: t.name,
        color: t.color,
    }
}

fn tag_to_file_item(t: Tag, confidence: Option<f64>) -> FileTagItem {
    FileTagItem {
        id: t.id.as_str().to_string(),
        repo_id: t.repo_id.as_str().to_string(),
        name: t.name,
        color: t.color,
        confidence,
    }
}

/// tag.add：给文件批量添加人工 tag（仓库内，不存在则创建）。
#[tauri::command]
pub(crate) fn tag_add(
    repo_id: String,
    file_ids: Vec<String>,
    tag_name: String,
    state: State<AppState>,
) -> ApiResponse<()> {
    api_from_hp((|| -> HpResult<()> {
        if tag_name.trim().is_empty() {
            return Err(HpError::InvalidArgument("tag 名不能为空".into()));
        }
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        let tag = db.create_tag(&repo_id, &tag_name, None)?;
        for file_id in &file_ids {
            db.add_file_tag(file_id, tag.id.as_str())?;
        }
        Ok(())
    })())
}

/// tag.remove：从文件批量移除人工 tag（不影响自动 tag）。
#[tauri::command]
pub(crate) fn tag_remove(
    repo_id: String,
    file_ids: Vec<String>,
    tag_name: String,
    state: State<AppState>,
) -> ApiResponse<()> {
    api_from_hp((|| -> HpResult<()> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        if let Some(tag) = db.find_tag_by_name(&repo_id, &tag_name)? {
            for file_id in &file_ids {
                db.remove_file_tag(file_id, tag.id.as_str())?;
            }
        }
        Ok(())
    })())
}

/// tag.list：列出仓库内全部 tag 实体。
#[tauri::command]
pub(crate) fn tag_list(repo_id: String, state: State<AppState>) -> ApiResponse<Vec<TagItem>> {
    api_from_hp((|| -> HpResult<Vec<TagItem>> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let tags = db.list_tags(&repo_id)?;
        Ok(tags.into_iter().map(tag_to_item).collect())
    })())
}

/// tag.forFile：列出文件的人工 tag 与自动 tag 两组（D21）。
#[tauri::command]
pub(crate) fn tag_for_file(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> ApiResponse<FileTagsResult> {
    let _ = repo_id;
    api_from_hp((|| -> HpResult<FileTagsResult> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;

        let manual = db
            .list_tags_for_file(&file_id)?
            .into_iter()
            .map(|t| tag_to_file_item(t, None))
            .collect();

        let mut auto: Vec<FileTagItem> = db
            .list_auto_tags_for_file(&file_id)?
            .into_iter()
            .map(|t| tag_to_file_item(t, None))
            .collect();

        // 自动组补上置信度（按 tag_id 匹配）。
        for detail in db.list_file_auto_tags(&file_id)? {
            if let Some(item) = auto.iter_mut().find(|i| i.id == detail.tag_id.as_str()) {
                item.confidence = detail.confidence;
            }
        }

        Ok(FileTagsResult { manual, auto })
    })())
}

fn relation_to_item(r: hp_core::TagRelation) -> TagRelationItem {
    TagRelationItem {
        id: r.id,
        repo_id: r.repo_id.as_str().to_string(),
        from_tag_id: r.from_tag_id.as_str().to_string(),
        to_tag_id: r.to_tag_id.as_str().to_string(),
        relation_kind: r.relation_kind.as_str().to_string(),
        created_at: r.created_at,
    }
}

/// tag.relation.add：建立 tag 关系（层级 / 关联，D22）。
#[tauri::command]
pub(crate) fn tag_relation_add(
    repo_id: String,
    from_tag_id: String,
    to_tag_id: String,
    relation_kind: String,
    state: State<AppState>,
) -> ApiResponse<TagRelationItem> {
    api_from_hp((|| -> HpResult<TagRelationItem> {
        let kind = TagRelationKind::from_str(&relation_kind).ok_or_else(|| {
            HpError::InvalidArgument(format!("未知 tag 关系类型: {relation_kind}"))
        })?;
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        let relation = db.add_tag_relation(&repo_id, &from_tag_id, &to_tag_id, kind)?;
        Ok(relation_to_item(relation))
    })())
}

/// tag.relation.remove：按 ID 删除 tag 关系。
#[tauri::command]
pub(crate) fn tag_relation_remove(
    relation_id: String,
    state: State<AppState>,
) -> ApiResponse<()> {
    api_from_hp((|| -> HpResult<()> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        db.remove_tag_relation(&relation_id)
    })())
}

/// tag.relation.list：列出仓库全部 tag 关系（关系图谱数据源）。
#[tauri::command]
pub(crate) fn tag_relation_list(
    repo_id: String,
    state: State<AppState>,
) -> ApiResponse<Vec<TagRelationItem>> {
    api_from_hp((|| -> HpResult<Vec<TagRelationItem>> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let rows = db.list_tag_relations(&repo_id)?;
        Ok(rows.into_iter().map(relation_to_item).collect())
    })())
}

/// tag.relation.parents：列出某 tag 的直接上级（层级）。
#[tauri::command]
pub(crate) fn tag_relation_parents(
    tag_id: String,
    state: State<AppState>,
) -> ApiResponse<Vec<TagItem>> {
    api_from_hp((|| -> HpResult<Vec<TagItem>> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let tags = db.list_parent_tags(&tag_id)?;
        Ok(tags.into_iter().map(tag_to_item).collect())
    })())
}

/// tag.relation.children：列出某 tag 的直接下级（层级）。
#[tauri::command]
pub(crate) fn tag_relation_children(
    tag_id: String,
    state: State<AppState>,
) -> ApiResponse<Vec<TagItem>> {
    api_from_hp((|| -> HpResult<Vec<TagItem>> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let tags = db.list_child_tags(&tag_id)?;
        Ok(tags.into_iter().map(tag_to_item).collect())
    })())
}

/// tag 树节点（前端树视图；`is_cross` 为交叉 tag，D22）。
#[derive(Serialize)]
pub(crate) struct TagTreeNodeItem {
    id: String,
    name: String,
    color: Option<String>,
    count: i64,
    is_cross: bool,
    children: Vec<TagTreeNodeItem>,
}

fn tree_node_to_item(n: hp_store::TagTreeNode) -> TagTreeNodeItem {
    TagTreeNodeItem {
        id: n.id,
        name: n.name,
        color: n.color,
        count: n.count,
        is_cross: n.is_cross,
        children: n.children.into_iter().map(tree_node_to_item).collect(),
    }
}

/// tag.tree：返回仓库 tag 层级树（多父级 tag 在各上级下各出现一次并标记交叉）。
#[tauri::command]
pub(crate) fn tag_tree(
    repo_id: String,
    state: State<AppState>,
) -> ApiResponse<Vec<TagTreeNodeItem>> {
    api_from_hp((|| -> HpResult<Vec<TagTreeNodeItem>> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;

        let tags = db.list_tags(&repo_id)?;
        let relations = db.list_tag_relations(&repo_id)?;
        let mut counts = std::collections::HashMap::new();
        for t in &tags {
            let c = db.count_tag_files(t.id.as_str())?;
            counts.insert(t.id.as_str().to_string(), c);
        }
        let tree = hp_store::build_tag_tree(&tags, &relations, &counts);
        Ok(tree.roots.into_iter().map(tree_node_to_item).collect())
    })())
}

/// tag.rename：重命名 tag 实体。
#[tauri::command]
pub(crate) fn tag_rename(
    tag_id: String,
    name: String,
    state: State<AppState>,
) -> ApiResponse<()> {
    api_from_hp((|| -> HpResult<()> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        db.rename_tag(&tag_id, &name)
    })())
}

/// tag.createRoot：新建根 tag（同名已存在则复用，不重复创建）。
#[tauri::command]
pub(crate) fn tag_create_root(
    repo_id: String,
    name: String,
    state: State<AppState>,
) -> ApiResponse<TagItem> {
    api_from_hp((|| -> HpResult<TagItem> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        let tag = match db.find_tag_by_name(&repo_id, &name)? {
            Some(existing) => existing,
            None => db.create_tag(&repo_id, &name, None)?,
        };
        Ok(tag_to_item(tag))
    })())
}

/// tag.createChild：在父 tag 下新建子 tag。
///
/// 若同名 tag 已存在则复用该实体并建立层级（即形成交叉关联，D22）。
#[tauri::command]
pub(crate) fn tag_create_child(
    repo_id: String,
    parent_tag_id: String,
    name: String,
    state: State<AppState>,
) -> ApiResponse<TagItem> {
    api_from_hp((|| -> HpResult<TagItem> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        let tag = match db.find_tag_by_name(&repo_id, &name)? {
            Some(existing) => existing,
            None => db.create_tag(&repo_id, &name, None)?,
        };
        db.add_tag_relation(
            &repo_id,
            &parent_tag_id,
            tag.id.as_str(),
            TagRelationKind::Hierarchy,
        )?;
        Ok(tag_to_item(tag))
    })())
}

/// tag.createSibling：新建与参照 tag 同级的 tag（共享其全部层级上级；无上级则为根）。
///
/// 若同名 tag 已存在则复用该实体。
#[tauri::command]
pub(crate) fn tag_create_sibling(
    repo_id: String,
    ref_tag_id: String,
    name: String,
    state: State<AppState>,
) -> ApiResponse<TagItem> {
    api_from_hp((|| -> HpResult<TagItem> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        let parents = db.list_parent_tags(&ref_tag_id)?;
        let tag = match db.find_tag_by_name(&repo_id, &name)? {
            Some(existing) => existing,
            None => db.create_tag(&repo_id, &name, None)?,
        };
        for parent in parents {
            db.add_tag_relation(
                &repo_id,
                parent.id.as_str(),
                tag.id.as_str(),
                TagRelationKind::Hierarchy,
            )?;
        }
        Ok(tag_to_item(tag))
    })())
}

/// tag.move：移动 tag（拖拽 = 移动）；`newParentId` 为空表示移到根。
#[tauri::command]
pub(crate) fn tag_move(
    tag_id: String,
    new_parent_id: Option<String>,
    state: State<AppState>,
) -> ApiResponse<()> {
    api_from_hp((|| -> HpResult<()> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        db.move_tag(&tag_id, new_parent_id.as_deref())
    })())
}

/// tag.detach：解除某 tag 的全部层级上级（拖到根区域 → 成为根）。
#[tauri::command]
pub(crate) fn tag_detach(tag_id: String, state: State<AppState>) -> ApiResponse<()> {
    api_from_hp((|| -> HpResult<()> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        db.detach_tag(&tag_id)
    })())
}
