//! 文件封面覆盖仓储（database-schema.md 第 4.5 节，迁移 repo/0009）。

use hp_core::{
    is_safe_cover_file_name, normalize_cover_color, CoverKind, FileCover, HpError, HpResult,
};
use rusqlite::{params, OptionalExtension, Row};

use crate::repo::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err};

impl RepoDb {
    /// 写入或替换某文件的封面覆盖（`ON CONFLICT` 顶掉旧值，见迁移 0009 的说明）。
    ///
    /// **取值在这里校验**，不接受"库里存了什么就是什么"：
    /// - `Color` 必须是合法 `#rrggbb`（规范化后落库）；
    /// - `Image` 必须是安全裸文件名（目录穿越是**安全边界**，见 `is_safe_cover_file_name`）。
    pub fn upsert_file_cover(
        &mut self,
        file_id: &str,
        kind: CoverKind,
        value: &str,
    ) -> HpResult<FileCover> {
        require_nonempty(file_id, "文件 ID")?;
        let normalized = match kind {
            CoverKind::Color => normalize_cover_color(value).ok_or_else(|| {
                HpError::InvalidArgument(format!("颜色格式非法（应为 #rrggbb）: {value}"))
            })?,
            CoverKind::Image => {
                if !is_safe_cover_file_name(value) {
                    return Err(HpError::InvalidArgument(format!(
                        "封面图片名非法（不得含路径分隔符或 ..）: {value}"
                    )));
                }
                value.to_string()
            }
        };
        let updated_at = now_iso();
        self.conn()
            .execute(
                "INSERT INTO file_covers (file_id, kind, value, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(file_id) DO UPDATE SET
                     kind = excluded.kind,
                     value = excluded.value,
                     updated_at = excluded.updated_at",
                params![file_id, kind.as_str(), normalized, updated_at],
            )
            .map_err(|e| store_err("写入封面覆盖", e))?;
        Ok(FileCover {
            file_id: file_id.to_string(),
            kind,
            value: normalized,
            updated_at,
        })
    }

    /// 查询某文件的封面覆盖；不存在返回 `None`。
    pub fn get_file_cover(&self, file_id: &str) -> HpResult<Option<FileCover>> {
        self.conn()
            .query_row(
                "SELECT file_id, kind, value, updated_at FROM file_covers WHERE file_id = ?1",
                params![file_id],
                row_to_cover,
            )
            .optional()
            .map_err(|e| store_err("查询封面覆盖", e))
    }

    /// 删除某文件的封面覆盖（恢复默认封面）。返回是否真的删掉了一行。
    pub fn delete_file_cover(&mut self, file_id: &str) -> HpResult<bool> {
        let n = self
            .conn()
            .execute("DELETE FROM file_covers WHERE file_id = ?1", params![file_id])
            .map_err(|e| store_err("删除封面覆盖", e))?;
        Ok(n > 0)
    }

    /// 批量取一组文件的封面覆盖（`file_id → FileCover`）。
    ///
    /// **为什么是批量而不是逐个查**：图书预览面板要一次拿到"这一页所有书"的封面，
    /// 逐本发一次 IPC 就是 N 次往返（一本一次，几百本时肉眼可见）。
    /// 调用方按**一页**（≤ `FILE_QUERY_MAX_LIMIT`）传 id，`IN (...)` 的长度因此有界。
    ///
    /// 空列表直接返回空表（不发 SQL——`IN ()` 在 SQLite 里是语法错误）。
    pub fn covers_for_files(
        &self,
        file_ids: &[String],
    ) -> HpResult<std::collections::HashMap<String, FileCover>> {
        use std::collections::HashMap;
        if file_ids.is_empty() {
            return Ok(HashMap::new());
        }
        // 占位符按 id 个数生成（`?1, ?2, …`）；这里没有别的参数，编号不会与别处冲突。
        let placeholders = (1..=file_ids.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql =
            format!("SELECT file_id, kind, value, updated_at FROM file_covers WHERE file_id IN ({placeholders})");
        let mut stmt = self
            .conn()
            .prepare(&sql)
            .map_err(|e| store_err("批量查询封面覆盖", e))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(file_ids.iter()), row_to_cover)
            .map_err(|e| store_err("批量查询封面覆盖", e))?;
        let mut out = HashMap::new();
        for row in rows {
            // 单行解析失败（未知 kind）跳过该行而不是让整批失败：见 `row_to_cover`。
            if let Ok(cover) = row {
                out.insert(cover.file_id.clone(), cover);
            }
        }
        Ok(out)
    }
}

/// 把一行解析成 [`FileCover`]。
///
/// **未知 `kind` 返回 `QueryReturnedNoRows`**（等价于"这行不可用"），而不是退化成
/// 某一种：退化成 `Color` 会让一个读不动的值**假装成**用户设过的颜色，
/// 退化成 `Image` 则可能拿一个非文件名去拼磁盘路径。宁可当作没有覆盖（回落默认封面）。
fn row_to_cover(row: &Row) -> rusqlite::Result<FileCover> {
    let kind: String = row.get(1)?;
    let Some(kind) = CoverKind::from_str(&kind) else {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    };
    Ok(FileCover {
        file_id: row.get(0)?,
        kind,
        value: row.get(2)?,
        updated_at: row.get(3)?,
    })
}
