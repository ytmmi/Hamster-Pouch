//! AI tag 高置信覆盖的撤销记录仓储（D6 / 迁移 0003）。
//!
//! AI 打标结果直接写入 `file_tags`；当置信度达到阈值覆盖用户已有 tag 时，
//! 先把覆盖前状态写入 `ai_tag_undo`，保证可撤销。

use hp_core::{AiTagUndo, FileId, HpError, HpResult, RepoId, TagId, TagSource};
use rusqlite::{params, OptionalExtension, Row};

use crate::repo::repo_db::RepoDb;
use crate::util::{require_nonempty, store_err};

impl RepoDb {
    /// 写入一条 AI 覆盖撤销记录。
    pub fn insert_ai_tag_undo(&mut self, undo: &AiTagUndo) -> HpResult<()> {
        require_nonempty(&undo.id, "撤销记录 ID")?;
        require_nonempty(undo.repo_id.as_str(), "仓库 ID")?;
        require_nonempty(undo.file_id.as_str(), "文件 ID")?;
        require_nonempty(undo.tag_id.as_str(), "tag ID")?;
        self.conn()
            .execute(
                "INSERT INTO ai_tag_undo
                     (id, repo_id, file_id, tag_id, prev_source, prev_confidence, prev_source_model, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    undo.id,
                    undo.repo_id.as_str(),
                    undo.file_id.as_str(),
                    undo.tag_id.as_str(),
                    undo.prev_source.as_str(),
                    undo.prev_confidence,
                    undo.prev_source_model,
                    undo.created_at,
                ],
            )
            .map_err(|e| store_err("写入 AI 撤销记录", e))?;
        Ok(())
    }

    /// 列出某文件的全部 AI 覆盖撤销记录（按创建时间升序）。
    pub fn list_ai_tag_undo_for_file(&self, file_id: &str) -> HpResult<Vec<AiTagUndo>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, repo_id, file_id, tag_id, prev_source, prev_confidence, prev_source_model, created_at
                 FROM ai_tag_undo WHERE file_id = ?1 ORDER BY created_at",
            )
            .map_err(|e| store_err("查询 AI 撤销记录", e))?;
        let rows = stmt
            .query_map(params![file_id], row_to_undo)
            .map_err(|e| store_err("读取 AI 撤销记录", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析 AI 撤销记录", e))?;
        Ok(rows)
    }

    /// 列出仓库全部 AI 覆盖撤销记录（按创建时间倒序，最新在前）。
    pub fn list_ai_tag_undo(&self, repo_id: &str, limit: i64) -> HpResult<Vec<AiTagUndo>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, repo_id, file_id, tag_id, prev_source, prev_confidence, prev_source_model, created_at
                 FROM ai_tag_undo WHERE repo_id = ?1 ORDER BY created_at DESC LIMIT ?2",
            )
            .map_err(|e| store_err("查询 AI 撤销记录列表", e))?;
        let rows = stmt
            .query_map(params![repo_id, limit], row_to_undo)
            .map_err(|e| store_err("读取 AI 撤销记录列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析 AI 撤销记录列表", e))?;
        Ok(rows)
    }

    /// 查询某文件某 tag 最近一条覆盖撤销记录；不存在返回 `None`。
    pub fn latest_ai_tag_undo(
        &self,
        file_id: &str,
        tag_id: &str,
    ) -> HpResult<Option<AiTagUndo>> {
        self.conn()
            .query_row(
                "SELECT id, repo_id, file_id, tag_id, prev_source, prev_confidence, prev_source_model, created_at
                 FROM ai_tag_undo WHERE file_id = ?1 AND tag_id = ?2
                 ORDER BY created_at DESC LIMIT 1",
                params![file_id, tag_id],
                row_to_undo,
            )
            .optional()
            .map_err(|e| store_err("查询最近 AI 撤销记录", e))
    }

    /// 删除一条 AI 撤销记录（撤销完成后清理）。
    pub fn delete_ai_tag_undo(&mut self, id: &str) -> HpResult<()> {
        require_nonempty(id, "撤销记录 ID")?;
        let n = self
            .conn()
            .execute("DELETE FROM ai_tag_undo WHERE id = ?1", params![id])
            .map_err(|e| store_err("删除 AI 撤销记录", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("AI 撤销记录不存在: {id}")));
        }
        Ok(())
    }

    /// 统计仓库内 AI 覆盖撤销记录数。
    pub fn count_ai_tag_undo(&self, repo_id: &str) -> HpResult<i64> {
        self.conn()
            .query_row(
                "SELECT COUNT(*) FROM ai_tag_undo WHERE repo_id = ?1",
                params![repo_id],
                |row| row.get(0),
            )
            .map_err(|e| store_err("统计 AI 撤销记录数", e))
    }
}

fn row_to_undo(row: &Row) -> rusqlite::Result<AiTagUndo> {
    let prev_source: String = row.get(4)?;
    Ok(AiTagUndo {
        id: row.get(0)?,
        repo_id: RepoId::from_raw(row.get::<_, String>(1)?),
        file_id: FileId::from_raw(row.get::<_, String>(2)?),
        tag_id: TagId::from_raw(row.get::<_, String>(3)?),
        prev_source: TagSource::from_str(&prev_source).unwrap_or(TagSource::User),
        prev_confidence: row.get(5)?,
        prev_source_model: row.get(6)?,
        created_at: row.get(7)?,
    })
}
