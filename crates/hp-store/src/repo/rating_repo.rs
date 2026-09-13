//! 评分仓储（database-schema.md 第 4.5 节）。

use hp_core::{validate_rating, FileId, HpError, HpResult, Rating};
use rusqlite::{params, OptionalExtension, Row};

use crate::repo::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err};

impl RepoDb {
    /// 写入或更新文件评分（0..=5）。
    pub fn upsert_rating(&mut self, file_id: &str, rating: i64) -> HpResult<Rating> {
        require_nonempty(file_id, "文件 ID")?;
        if !validate_rating(rating) {
            return Err(HpError::InvalidArgument(format!(
                "评分超出范围(0-5): {rating}"
            )));
        }
        let updated_at = now_iso();
        self.conn()
            .execute(
                "INSERT INTO ratings (file_id, rating, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(file_id) DO UPDATE SET
                     rating = excluded.rating,
                     updated_at = excluded.updated_at",
                params![file_id, rating, updated_at],
            )
            .map_err(|e| store_err("写入评分", e))?;
        Ok(Rating {
            file_id: FileId::from_raw(file_id),
            rating,
            updated_at,
        })
    }

    /// 查询文件评分；不存在返回 `None`。
    pub fn get_rating(&self, file_id: &str) -> HpResult<Option<Rating>> {
        self.conn()
            .query_row(
                "SELECT file_id, rating, updated_at FROM ratings WHERE file_id = ?1",
                params![file_id],
                row_to_rating,
            )
            .optional()
            .map_err(|e| store_err("查询评分", e))
    }

    /// 删除文件评分。
    pub fn delete_rating(&mut self, file_id: &str) -> HpResult<()> {
        self.conn()
            .execute("DELETE FROM ratings WHERE file_id = ?1", params![file_id])
            .map_err(|e| store_err("删除评分", e))?;
        Ok(())
    }
}

fn row_to_rating(row: &Row) -> rusqlite::Result<Rating> {
    Ok(Rating {
        file_id: FileId::from_raw(row.get::<_, String>(0)?),
        rating: row.get(1)?,
        updated_at: row.get(2)?,
    })
}
