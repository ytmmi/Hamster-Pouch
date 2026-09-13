//! 操作历史仓储（database-schema.md 第 4.7 节）。
//!
//! 所有真实文件操作（复制/移动/重命名）与索引重建、同步、相册属性变更
//! 都必须写入 `ops_history`，供追溯与撤销。

use hp_core::{HpError, HpResult};
use rusqlite::{params, OptionalExtension, Row};

use crate::repo::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err, uuid};

/// 操作历史行：与 `ops_history` 表一一对应。
#[derive(Debug, Clone, PartialEq)]
pub struct OpsHistoryRow {
    pub id: String,
    pub repo_id: String,
    pub op_type: String,
    pub payload_json: String,
    pub undo_json: Option<String>,
    pub created_at: String,
}

impl RepoDb {
    /// 写入操作历史；返回记录 ID。
    pub fn insert_ops_history(
        &mut self,
        repo_id: &str,
        op_type: &str,
        payload_json: &str,
        undo_json: Option<&str>,
    ) -> HpResult<String> {
        require_nonempty(repo_id, "仓库 ID")?;
        require_nonempty(op_type, "操作类型")?;
        let id = uuid();
        self.conn()
            .execute(
                "INSERT INTO ops_history (id, repo_id, op_type, payload_json, undo_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, repo_id, op_type, payload_json, undo_json, now_iso()],
            )
            .map_err(|e| store_err("写入操作历史", e))?;
        Ok(id)
    }

    /// 按 ID 查询操作历史；不存在返回 `None`。
    pub fn get_ops_history(&self, id: &str) -> HpResult<Option<OpsHistoryRow>> {
        self.conn()
            .query_row(
                "SELECT id, repo_id, op_type, payload_json, undo_json, created_at
                 FROM ops_history WHERE id = ?1",
                params![id],
                row_to_ops,
            )
            .optional()
            .map_err(|e| store_err("查询操作历史", e))
    }

    /// 列出仓库操作历史（按创建时间倒序，最新在前）。
    pub fn list_ops_history(&self, repo_id: &str, limit: i64) -> HpResult<Vec<OpsHistoryRow>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, repo_id, op_type, payload_json, undo_json, created_at
                 FROM ops_history WHERE repo_id = ?1 ORDER BY created_at DESC LIMIT ?2",
            )
            .map_err(|e| store_err("查询操作历史列表", e))?;
        let rows = stmt
            .query_map(params![repo_id, limit], row_to_ops)
            .map_err(|e| store_err("读取操作历史列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析操作历史列表", e))?;
        Ok(rows)
    }

    /// 删除操作历史记录。
    pub fn delete_ops_history(&mut self, id: &str) -> HpResult<()> {
        require_nonempty(id, "操作记录 ID")?;
        let n = self
            .conn()
            .execute("DELETE FROM ops_history WHERE id = ?1", params![id])
            .map_err(|e| store_err("删除操作历史", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("操作记录不存在: {id}")));
        }
        Ok(())
    }
}

fn row_to_ops(row: &Row) -> rusqlite::Result<OpsHistoryRow> {
    Ok(OpsHistoryRow {
        id: row.get(0)?,
        repo_id: row.get(1)?,
        op_type: row.get(2)?,
        payload_json: row.get(3)?,
        undo_json: row.get(4)?,
        created_at: row.get(5)?,
    })
}
