//! 阅读批注桥接：`reader.annotations` / `reader.addAnnotation` / `reader.deleteAnnotation`
//! （书签 / 笔记 / 高亮；2026-10-16，D113）。
//!
//! ## 为什么命令名是 `reader.*` 而不是 `book.*`
//!
//! `book.*` 是"从**文件**里读出东西"（元数据 / 正文 / 目录）——那些都是**内容的属性**，
//! 命令只认 `file_id` 且不写任何东西。批注是"**读者**留下的东西"，会写库、按仓库隔离、
//! 与文件内容无关（同一本书换个副本，批注不跟过去）。两者是不同的域，因此分命名空间
//! （`docs/spec/commands-events.md` 的 `domain.action` 口径）。
//!
//! ## 位置口径
//!
//! `cursor` 与 `book.content` 的游标**同语义**（epub = 章节序号、纯文本 = 字符偏移、
//! md = 顶层块序号），由**前端**原样带来（它来自 `book.toc` 或当前页的 `next_cursor`）。
//! 桥接层**不做数值校验**：越界游标由 `book.content` 按"回落第一页 / 最后一页"兜底，
//! 这是既有的"翻页游标不该成为新的错误来源"口径（见 `book.rs` 的 `parse_cursor`）。
//!
//! ## `progress` 由前端给
//!
//! 它是**保存时的阅读进度**（0–10000），前端已经算好了（`readerProgress`）——
//! 后端再算一遍就要重读目录（`book.toc`），那是白白多一次解包 / 整本解码。
//! 越界值在仓储侧夹紧（`row_to_annotation`），因此坏值不会让整行读不出来。

use hp_core::{AnnotationKind, HpError, HpResult};
use hp_dto::ReaderAnnotationItem;
use hp_store::NewAnnotation;
use tauri::State;

use crate::AppState;
use crate::commands::shared::{
    ApiAsync, api_async, api_from_hp, lock_repo, open_repo, open_repo_mut,
};

/// 把领域记录转成 DTO（字段一一对应，无换算）。
fn to_item(record: hp_core::ReaderAnnotation) -> ReaderAnnotationItem {
    ReaderAnnotationItem {
        id: record.id,
        kind: record.kind.as_str().to_string(),
        cursor: record.cursor,
        progress: record.progress,
        title: record.title,
        excerpt: record.excerpt,
        note: record.note,
        created_at: record.created_at,
    }
}

/// `reader.annotations`：列出某文件的全部批注（按**创建时间**升序）。
///
/// 为什么按时间而不是按位置：`cursor` 是 TEXT（三种格式语义不同），字典序会把
/// "第 10 章"排在"第 2 章"前面。列表要的是"我留下的顺序"，位置只用于跳转与展示。
///
/// **空数组不是错误**（没留过批注是正常状态）。
#[tauri::command]
pub(crate) async fn reader_annotations(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<Vec<ReaderAnnotationItem>> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<Vec<ReaderAnnotationItem>> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        // 文件必须存在：给不存在的 file_id 列批注是调用方的错（外键也会拒）。
        if db.get_file(&file_id)?.is_none() {
            return Err(HpError::NotFound(format!("文件不存在: {file_id}")));
        }
        Ok(db
            .list_annotations(&file_id)?
            .into_iter()
            .map(to_item)
            .collect())
    })();
    api_async(api_from_hp(outcome))
}

/// `reader.addAnnotation`：新建一条批注（书签 / 笔记 / 高亮）。
///
/// 内容校验在**仓储侧**（`validate_annotation_content`）：种类与内容必须匹配
/// （书签不需要正文；笔记 / 高亮至少要有一项非空）、游标非空、文本不超上限。
/// 违约 → `validation`（不是静默写一条坏记录）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn reader_add_annotation(
    repo_id: String,
    file_id: String,
    kind: String,
    cursor: String,
    progress: u32,
    title: String,
    excerpt: String,
    note: String,
    state: State<'_, AppState>,
) -> ApiAsync<ReaderAnnotationItem> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<ReaderAnnotationItem> {
        let kind = AnnotationKind::from_str(&kind)
            .ok_or_else(|| HpError::InvalidArgument(format!("未知的批注种类: {kind}")))?;
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        if db.get_file(&file_id)?.is_none() {
            return Err(HpError::NotFound(format!("文件不存在: {file_id}")));
        }
        let record = db.create_annotation(NewAnnotation {
            file_id: &file_id,
            kind,
            cursor: &cursor,
            progress,
            title: &title,
            excerpt: &excerpt,
            note: &note,
        })?;
        Ok(to_item(record))
    })();
    api_async(api_from_hp(outcome))
}

/// `reader.deleteAnnotation`：删除一条批注。
///
/// **幂等**：删一个不存在的 id 也返回 `{ ok }`——用户在列表里连点两下删除不该报错
/// （与 `file.setMarks` 的"增删各自幂等"同一口径）。
#[tauri::command]
pub(crate) async fn reader_delete_annotation(
    repo_id: String,
    annotation_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<()> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<()> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        db.delete_annotation(&annotation_id)?;
        Ok(())
    })();
    api_async(api_from_hp(outcome))
}
