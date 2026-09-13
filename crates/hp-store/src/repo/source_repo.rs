//! 图像源仓储（RFC 0003 / database-schema.md 第 4.2 节）。

use hp_core::{HpError, HpResult, RepoId, Source, SourceId};
use rusqlite::{params, OptionalExtension, Row};

use crate::repo::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err};

impl RepoDb {
    /// 挂载图像源到仓库；返回写入的 `Source`。
    pub fn mount_source(
        &mut self,
        repo_id: &str,
        local_path: &str,
        alias: Option<&str>,
        parent_source_id: Option<&str>,
    ) -> HpResult<Source> {
        require_nonempty(repo_id, "仓库 ID")?;
        require_nonempty(local_path, "图像源路径")?;

        let source = Source {
            id: SourceId::generate(),
            repo_id: RepoId::from_raw(repo_id),
            local_path: local_path.to_string(),
            alias: alias.map(|s| s.to_string()),
            parent_source_id: parent_source_id.map(SourceId::from_raw),
            mounted: true,
            mounted_at: now_iso(),
        };

        self.conn()
            .execute(
                "INSERT INTO sources (id, repo_id, local_path, alias, parent_source_id, mounted, mounted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                params![
                    source.id.as_str(),
                    source.repo_id.as_str(),
                    source.local_path,
                    source.alias,
                    source.parent_source_id.as_ref().map(|p| p.as_str()),
                    source.mounted_at,
                ],
            )
            .map_err(|e| store_err("挂载图像源", e))?;

        Ok(source)
    }

    /// 卸载图像源：保留文件索引，仅标记离线（RFC 0003）。
    pub fn unmount_source(&mut self, source_id: &str) -> HpResult<()> {
        require_nonempty(source_id, "图像源 ID")?;
        let n = self
            .conn()
            .execute(
                "UPDATE sources SET mounted = 0 WHERE id = ?1",
                params![source_id],
            )
            .map_err(|e| store_err("卸载图像源", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("图像源不存在: {source_id}")));
        }
        Ok(())
    }

    /// 重命名图像源别名。
    pub fn rename_source(&mut self, source_id: &str, alias: &str) -> HpResult<()> {
        require_nonempty(source_id, "图像源 ID")?;
        require_nonempty(alias, "别名")?;
        let n = self
            .conn()
            .execute(
                "UPDATE sources SET alias = ?2 WHERE id = ?1",
                params![source_id, alias],
            )
            .map_err(|e| store_err("重命名图像源别名", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("图像源不存在: {source_id}")));
        }
        Ok(())
    }

    /// 列出仓库下全部图像源（按挂载时间升序）。
    pub fn list_sources(&self, repo_id: &str) -> HpResult<Vec<Source>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, repo_id, local_path, alias, parent_source_id, mounted, mounted_at
                 FROM sources WHERE repo_id = ?1 ORDER BY mounted_at",
            )
            .map_err(|e| store_err("查询图像源列表", e))?;
        let rows = stmt
            .query_map(params![repo_id], row_to_source)
            .map_err(|e| store_err("读取图像源列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析图像源列表", e))?;
        Ok(rows)
    }

    /// 按 ID 查询图像源；不存在返回 `None`。
    pub fn get_source(&self, source_id: &str) -> HpResult<Option<Source>> {
        self.conn()
            .query_row(
                "SELECT id, repo_id, local_path, alias, parent_source_id, mounted, mounted_at
                 FROM sources WHERE id = ?1",
                params![source_id],
                row_to_source,
            )
            .optional()
            .map_err(|e| store_err("查询图像源", e))
    }
}

fn row_to_source(row: &Row) -> rusqlite::Result<Source> {
    let id: String = row.get(0)?;
    let repo_id: String = row.get(1)?;
    let local_path: String = row.get(2)?;
    let alias: Option<String> = row.get(3)?;
    let parent_source_id: Option<String> = row.get(4)?;
    let mounted: i64 = row.get(5)?;
    let mounted_at: String = row.get(6)?;
    Ok(Source {
        id: SourceId::from_raw(id),
        repo_id: RepoId::from_raw(repo_id),
        local_path,
        alias,
        parent_source_id: parent_source_id.map(SourceId::from_raw),
        mounted: mounted != 0,
        mounted_at,
    })
}
