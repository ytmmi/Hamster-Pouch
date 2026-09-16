//! 仓库库蓝图仓储（RFC 0007 / D30）。
//!
//! `blueprints` 表（迁移 0006）：定义按仓库持久化（每仓库一个仓库库文件），
//! 整文档 JSON 存储，save = 整文档替换（对齐 D1 `panel_layouts` 先例）；
//! `is_default` 每仓库唯一，无默认时由消费层回退内置默认蓝图。
//!
//! 语义校验（`BlueprintGraph::validate`）在 hp-core，由命令层在保存前执行；
//! 本仓储只做存储与默认标记维护。

use hp_core::{BlueprintGraph, BlueprintRow, HpError, HpResult};
use rusqlite::{params, OptionalExtension, Row};

use crate::repo::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err, uuid};

/// `blueprints` 表列清单（与迁移 0006 顺序一致）。
const BLUEPRINT_COLUMNS: &str =
    "id, repo_id, name, is_default, schema_version, blueprint_json, created_at, updated_at";

/// 从文档 JSON 读取 schema 版本（解析失败记 0，权威版本在 JSON 内）。
fn doc_schema_version(json: &str) -> i64 {
    BlueprintGraph::from_json(json)
        .map(|g| g.schema_version)
        .unwrap_or(0)
}

impl RepoDb {
    /// 新建蓝图；`blueprint_json` 必须是已通过校验的文档（由命令层保证）。
    pub fn create_blueprint(
        &mut self,
        repo_id: &str,
        name: &str,
        blueprint_json: &str,
    ) -> HpResult<BlueprintRow> {
        require_nonempty(repo_id, "仓库 ID")?;
        require_nonempty(name, "蓝图名")?;
        require_nonempty(blueprint_json, "蓝图内容")?;
        let now = now_iso();
        let row = BlueprintRow {
            id: uuid(),
            repo_id: repo_id.to_string(),
            name: name.to_string(),
            is_default: false,
            schema_version: doc_schema_version(blueprint_json),
            blueprint_json: blueprint_json.to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        self.conn()
            .execute(
                "INSERT INTO blueprints
                     (id, repo_id, name, is_default, schema_version, blueprint_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    row.id,
                    row.repo_id,
                    row.name,
                    row.is_default as i64,
                    row.schema_version,
                    row.blueprint_json,
                    row.created_at,
                    row.updated_at,
                ],
            )
            .map_err(|e| store_err("写入蓝图", e))?;
        Ok(row)
    }

    /// 按 ID 查询蓝图；不存在返回 `None`。
    pub fn get_blueprint(&self, id: &str) -> HpResult<Option<BlueprintRow>> {
        require_nonempty(id, "蓝图 ID")?;
        self.conn()
            .query_row(
                &format!("SELECT {BLUEPRINT_COLUMNS} FROM blueprints WHERE id = ?1"),
                params![id],
                row_to_blueprint,
            )
            .optional()
            .map_err(|e| store_err("查询蓝图", e))
    }

    /// 列出仓库下全部蓝图（按 `updated_at` 倒序，最新在前）。
    pub fn list_blueprints(&self, repo_id: &str) -> HpResult<Vec<BlueprintRow>> {
        require_nonempty(repo_id, "仓库 ID")?;
        let mut stmt = self
            .conn()
            .prepare(&format!(
                "SELECT {BLUEPRINT_COLUMNS} FROM blueprints WHERE repo_id = ?1 ORDER BY updated_at DESC"
            ))
            .map_err(|e| store_err("查询蓝图列表", e))?;
        let rows = stmt
            .query_map(params![repo_id], row_to_blueprint)
            .map_err(|e| store_err("读取蓝图列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析蓝图列表", e))?;
        Ok(rows)
    }

    /// 整文档保存（可改名）；`blueprint_json` 必须已通过校验（由命令层保证）。
    pub fn save_blueprint(
        &mut self,
        repo_id: &str,
        id: &str,
        name: &str,
        blueprint_json: &str,
    ) -> HpResult<BlueprintRow> {
        require_nonempty(repo_id, "仓库 ID")?;
        require_nonempty(id, "蓝图 ID")?;
        require_nonempty(name, "蓝图名")?;
        require_nonempty(blueprint_json, "蓝图内容")?;
        let existing = self.get_blueprint(id)?;
        let mut row = existing.ok_or_else(|| HpError::NotFound(format!("蓝图不存在: {id}")))?;
        // 仓库 ID 归属校验：蓝图必须属于当前仓库（防御性，仓库库通常单仓库）。
        if row.repo_id != repo_id {
            return Err(HpError::NotFound(format!("蓝图不存在: {id}")));
        }
        row.name = name.to_string();
        row.blueprint_json = blueprint_json.to_string();
        row.schema_version = doc_schema_version(blueprint_json);
        row.updated_at = now_iso();
        let n = self
            .conn()
            .execute(
                "UPDATE blueprints SET name = ?2, schema_version = ?3, blueprint_json = ?4, updated_at = ?5
                 WHERE id = ?1",
                params![id, row.name, row.schema_version, row.blueprint_json, row.updated_at],
            )
            .map_err(|e| store_err("更新蓝图", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("蓝图不存在: {id}")));
        }
        Ok(row)
    }

    /// 删除蓝图；删除默认蓝图后 `get_default_blueprint` 返回 `None`（消费层回退内置默认）。
    pub fn delete_blueprint(&mut self, id: &str) -> HpResult<()> {
        require_nonempty(id, "蓝图 ID")?;
        let n = self
            .conn()
            .execute("DELETE FROM blueprints WHERE id = ?1", params![id])
            .map_err(|e| store_err("删除蓝图", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("蓝图不存在: {id}")));
        }
        Ok(())
    }

    /// 设为默认蓝图：清除仓库内其他默认标记后置位。
    pub fn set_default_blueprint(&mut self, repo_id: &str, id: &str) -> HpResult<()> {
        require_nonempty(repo_id, "仓库 ID")?;
        require_nonempty(id, "蓝图 ID")?;
        // 目标必须存在且属于当前仓库。
        let existing = self.get_blueprint(id)?;
        match existing {
            Some(row) if row.repo_id == repo_id => {}
            _ => return Err(HpError::NotFound(format!("蓝图不存在: {id}"))),
        }
        let tx = self
            .conn()
            .unchecked_transaction()
            .map_err(|e| store_err("开启设默认事务", e))?;
        tx.execute(
            "UPDATE blueprints SET is_default = 0 WHERE repo_id = ?1",
            params![repo_id],
        )
        .map_err(|e| store_err("清除原默认蓝图", e))?;
        tx.execute(
            "UPDATE blueprints SET is_default = 1, updated_at = ?2 WHERE id = ?1",
            params![id, now_iso()],
        )
        .map_err(|e| store_err("设置默认蓝图", e))?;
        tx.commit()
            .map_err(|e| store_err("提交设默认事务", e))?;
        Ok(())
    }

    /// 读取仓库默认蓝图；未设置返回 `None`。
    pub fn get_default_blueprint(&self, repo_id: &str) -> HpResult<Option<BlueprintRow>> {
        require_nonempty(repo_id, "仓库 ID")?;
        self.conn()
            .query_row(
                &format!(
                    "SELECT {BLUEPRINT_COLUMNS} FROM blueprints WHERE repo_id = ?1 AND is_default = 1 LIMIT 1"
                ),
                params![repo_id],
                row_to_blueprint,
            )
            .optional()
            .map_err(|e| store_err("查询默认蓝图", e))
    }

    /// 仓库内是否已有任何蓝图（供消费层判断是否需要种子默认蓝图）。
    pub fn count_blueprints(&self, repo_id: &str) -> HpResult<i64> {
        self.conn()
            .query_row(
                "SELECT COUNT(*) FROM blueprints WHERE repo_id = ?1",
                params![repo_id],
                |row| row.get(0),
            )
            .map_err(|e| store_err("统计蓝图数量", e))
    }
}

fn row_to_blueprint(row: &Row) -> rusqlite::Result<BlueprintRow> {
    let is_default: i64 = row.get(3)?;
    Ok(BlueprintRow {
        id: row.get(0)?,
        repo_id: row.get(1)?,
        name: row.get(2)?,
        is_default: is_default != 0,
        schema_version: row.get(4)?,
        blueprint_json: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
