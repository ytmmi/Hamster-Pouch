//! 全局配置库蓝图模板仓储（RFC 0007 / D30）。
//!
//! `blueprint_templates` 表（全局迁移 0002）：应用级共享的蓝图模板；
//! `blueprint.template.install` 把模板 JSON 一次性复制进仓库库 `blueprints` 表，
//! 复制后与模板脱离（模板后续修改不影响已复制蓝图）。

use hp_core::{BlueprintGraph, BlueprintTemplateRow, HpError, HpResult};
use rusqlite::{params, OptionalExtension, Row};

use super::global_db::GlobalDb;
use crate::util::{now_iso, require_nonempty, store_err, uuid};

/// `blueprint_templates` 表列清单（与全局迁移 0002 顺序一致）。
const TEMPLATE_COLUMNS: &str =
    "id, name, description, schema_version, blueprint_json, created_at, updated_at";

fn doc_schema_version(json: &str) -> i64 {
    BlueprintGraph::from_json(json)
        .map(|g| g.schema_version)
        .unwrap_or(0)
}

impl GlobalDb {
    /// 插入或更新蓝图模板（按 `id` UPSERT）。
    pub fn upsert_blueprint_template(&mut self, row: &BlueprintTemplateRow) -> HpResult<()> {
        require_nonempty(&row.id, "模板 ID")?;
        require_nonempty(&row.name, "模板名")?;
        require_nonempty(&row.blueprint_json, "模板内容")?;
        self.conn()
            .execute(
                "INSERT INTO blueprint_templates
                     (id, name, description, schema_version, blueprint_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     description = excluded.description,
                     schema_version = excluded.schema_version,
                     blueprint_json = excluded.blueprint_json,
                     updated_at = excluded.updated_at",
                params![
                    row.id,
                    row.name,
                    row.description,
                    row.schema_version,
                    row.blueprint_json,
                    row.created_at,
                    row.updated_at,
                ],
            )
            .map_err(|e| store_err("写入蓝图模板", e))?;
        Ok(())
    }

    /// 按 ID 查询蓝图模板；不存在返回 `None`。
    pub fn get_blueprint_template(&self, id: &str) -> HpResult<Option<BlueprintTemplateRow>> {
        require_nonempty(id, "模板 ID")?;
        self.conn()
            .query_row(
                &format!("SELECT {TEMPLATE_COLUMNS} FROM blueprint_templates WHERE id = ?1"),
                params![id],
                row_to_template,
            )
            .optional()
            .map_err(|e| store_err("查询蓝图模板", e))
    }

    /// 列出全部蓝图模板（按 `created_at` 升序）。
    pub fn list_blueprint_templates(&self) -> HpResult<Vec<BlueprintTemplateRow>> {
        let mut stmt = self
            .conn()
            .prepare(&format!(
                "SELECT {TEMPLATE_COLUMNS} FROM blueprint_templates ORDER BY created_at"
            ))
            .map_err(|e| store_err("查询蓝图模板列表", e))?;
        let rows = stmt
            .query_map([], row_to_template)
            .map_err(|e| store_err("读取蓝图模板列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析蓝图模板列表", e))?;
        Ok(rows)
    }

    /// 删除蓝图模板。
    pub fn remove_blueprint_template(&mut self, id: &str) -> HpResult<()> {
        require_nonempty(id, "模板 ID")?;
        let n = self
            .conn()
            .execute(
                "DELETE FROM blueprint_templates WHERE id = ?1",
                params![id],
            )
            .map_err(|e| store_err("删除蓝图模板", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("蓝图模板不存在: {id}")));
        }
        Ok(())
    }

    /// 新增蓝图模板（生成新 ID）。
    pub fn create_blueprint_template(
        &mut self,
        name: &str,
        description: Option<&str>,
        blueprint_json: &str,
    ) -> HpResult<BlueprintTemplateRow> {
        require_nonempty(name, "模板名")?;
        require_nonempty(blueprint_json, "模板内容")?;
        let now = now_iso();
        let row = BlueprintTemplateRow {
            id: uuid(),
            name: name.to_string(),
            description: description.map(|d| d.to_string()),
            schema_version: doc_schema_version(blueprint_json),
            blueprint_json: blueprint_json.to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        self.upsert_blueprint_template(&row)?;
        Ok(row)
    }
}

fn row_to_template(row: &Row) -> rusqlite::Result<BlueprintTemplateRow> {
    Ok(BlueprintTemplateRow {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        schema_version: row.get(3)?,
        blueprint_json: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}
