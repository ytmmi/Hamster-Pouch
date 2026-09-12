//! 色彩参考仓储（D18 / database-schema.md 第 4.5 节）。

use hp_core::{ColorRef, FileId, HpResult};
use rusqlite::{params, OptionalExtension, Row};

use crate::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err};

impl RepoDb {
    /// 写入或更新文件色彩参考（自动提取或手动锁定，仅图片）。
    pub fn upsert_color_ref(&mut self, file_id: &str, color_json: &str) -> HpResult<ColorRef> {
        require_nonempty(file_id, "文件 ID")?;
        require_nonempty(color_json, "色彩参考 JSON")?;
        let updated_at = now_iso();
        self.conn()
            .execute(
                "INSERT INTO color_refs (file_id, color_json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(file_id) DO UPDATE SET
                     color_json = excluded.color_json,
                     updated_at = excluded.updated_at",
                params![file_id, color_json, updated_at],
            )
            .map_err(|e| store_err("写入色彩参考", e))?;
        Ok(ColorRef {
            file_id: FileId::from_raw(file_id),
            color_json: color_json.to_string(),
            updated_at,
        })
    }

    /// 查询文件色彩参考；不存在返回 `None`。
    pub fn get_color_ref(&self, file_id: &str) -> HpResult<Option<ColorRef>> {
        self.conn()
            .query_row(
                "SELECT file_id, color_json, updated_at FROM color_refs WHERE file_id = ?1",
                params![file_id],
                row_to_color_ref,
            )
            .optional()
            .map_err(|e| store_err("查询色彩参考", e))
    }

    /// 删除色彩参考。
    pub fn delete_color_ref(&mut self, file_id: &str) -> HpResult<()> {
        self.conn()
            .execute(
                "DELETE FROM color_refs WHERE file_id = ?1",
                params![file_id],
            )
            .map_err(|e| store_err("删除色彩参考", e))?;
        Ok(())
    }
}

fn row_to_color_ref(row: &Row) -> rusqlite::Result<ColorRef> {
    Ok(ColorRef {
        file_id: FileId::from_raw(row.get::<_, String>(0)?),
        color_json: row.get(1)?,
        updated_at: row.get(2)?,
    })
}
