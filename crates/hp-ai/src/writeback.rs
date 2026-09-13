//! AI 结果回写（D6 / D21）。
//!
//! 结果写入**自动关联表** `file_auto_tags`（tag 实体共用 `tags` 表），标记来源模型与置信度；
//! 人工关联表 `file_tags` 与自动关联表独立，同名可共存、互不影响（D21）。
//! 仅当自动关联已存在同一 tag 时写入撤销记录（D6 接口保留）。

use hp_core::{AiTaggingOutput, AiTagUndo, FileId, HpResult, RepoId, TagId, TagSource};
use hp_store::RepoDb;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

/// 回写成果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WritebackOutcome {
    /// 写入/更新的自动关联数。
    pub written: usize,
    /// 自动关联内被更新的条数（产生撤销记录）。
    pub overwritten: usize,
    /// 生成的撤销记录 ID。
    pub undo_ids: Vec<String>,
}

/// 把 AI 打标结果回写到仓库的自动关联表（不影响人工关联）。
pub fn writeback(
    db: &mut RepoDb,
    repo_id: &str,
    file_id: &str,
    output: &AiTaggingOutput,
) -> HpResult<WritebackOutcome> {
    let existing = db.list_file_auto_tags(file_id)?;
    let mut written = 0;
    let mut overwritten = 0;
    let mut undo_ids = Vec::new();

    for cand in &output.tags {
        let tag = db.create_tag(repo_id, &cand.name, None)?;

        // 仅自动关联已存在同一 tag 时记录撤销；人工关联不受影响。
        if let Some(prev) = existing.iter().find(|ft| ft.tag_id == tag.id) {
            let undo = AiTagUndo {
                id: Uuid::new_v4().to_string(),
                repo_id: RepoId::from_raw(repo_id),
                file_id: FileId::from_raw(file_id),
                tag_id: TagId::from_raw(tag.id.as_str()),
                prev_source: TagSource::Ai,
                prev_confidence: prev.confidence,
                prev_source_model: prev.source_model.clone(),
                created_at: now_iso(),
            };
            db.insert_ai_tag_undo(&undo)?;
            undo_ids.push(undo.id);
            overwritten += 1;
        }

        db.add_file_auto_tag(
            file_id,
            tag.id.as_str(),
            Some(cand.confidence),
            Some(&output.source_model),
        )?;
        written += 1;
    }

    Ok(WritebackOutcome {
        written,
        overwritten,
        undo_ids,
    })
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| String::new())
}
