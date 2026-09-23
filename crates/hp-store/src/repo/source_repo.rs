//! 媒体源仓储（RFC 0003 / database-schema.md 第 4.2 节）。

use hp_core::{HpError, HpResult, RepoId, Source, SourceId};
use rusqlite::{params, OptionalExtension, Row};

use crate::repo::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err};

impl RepoDb {
    /// 挂载媒体源到仓库；返回写入的 `Source`。
    ///
    /// 同一仓库内若已存在**同一路径且处于离线**的源，则复用它（翻回在线）而不是新建一行：
    /// RFC 0003 要求"重新挂载同一路径且内容哈希一致时恢复解释数据"，而解释数据
    /// （tag/评分/相册成员）挂在文件索引行上，文件索引行又挂在**源 ID** 上；
    /// 若新建一行，旧的索引与解释数据就会变成永远取不回的孤儿。
    /// 复用同时保留原别名（用户改过的名字不该因为重新挂载而丢失）。
    pub fn mount_source(
        &mut self,
        repo_id: &str,
        local_path: &str,
        alias: Option<&str>,
        parent_source_id: Option<&str>,
    ) -> HpResult<Source> {
        require_nonempty(repo_id, "仓库 ID")?;
        require_nonempty(local_path, "媒体源路径")?;

        if let Some(mut existing) = self.find_offline_source_by_path(repo_id, local_path)? {
            let mounted_at = now_iso();
            self.conn()
                .execute(
                    "UPDATE sources SET mounted = 1, mounted_at = ?2 WHERE id = ?1",
                    params![existing.id.as_str(), mounted_at],
                )
                .map_err(|e| store_err("重新挂载媒体源", e))?;
            existing.mounted = true;
            existing.mounted_at = mounted_at;
            return Ok(existing);
        }

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
            .map_err(|e| store_err("挂载媒体源", e))?;

        Ok(source)
    }

    /// 查找同仓库内路径相同且已离线的源（用于重新挂载时恢复原源）。
    ///
    /// 路径比较忽略大小写与首尾分隔符：Windows 路径大小写不敏感，
    /// 而原生文件夹对话框与手工输入可能给出不同写法。
    fn find_offline_source_by_path(
        &self,
        repo_id: &str,
        local_path: &str,
    ) -> HpResult<Option<Source>> {
        // 归一化：忽略大小写，并去掉首尾空白与路径分隔符（`E:\Media` 与 `e:/media/` 视为同路径）
        let normalize = |expr: &str| format!("lower(rtrim(rtrim(rtrim({expr}, '/'), '\\'), ' '))");
        let sql = format!(
            "SELECT id, repo_id, local_path, alias, parent_source_id, mounted, mounted_at
             FROM sources
             WHERE repo_id = ?1 AND mounted = 0 AND {} = {}
             ORDER BY mounted_at DESC LIMIT 1",
            normalize("local_path"),
            normalize("?2"),
        );
        self.conn()
            .query_row(&sql, params![repo_id, local_path], row_to_source)
            .optional()
            .map_err(|e| store_err("查询离线媒体源", e))
    }

    /// 卸载媒体源：保留文件索引，仅标记离线（RFC 0003）。
    pub fn unmount_source(&mut self, source_id: &str) -> HpResult<()> {
        require_nonempty(source_id, "媒体源 ID")?;
        let n = self
            .conn()
            .execute(
                "UPDATE sources SET mounted = 0 WHERE id = ?1",
                params![source_id],
            )
            .map_err(|e| store_err("卸载媒体源", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("媒体源不存在: {source_id}")));
        }
        Ok(())
    }

    /// 重命名媒体源别名。
    pub fn rename_source(&mut self, source_id: &str, alias: &str) -> HpResult<()> {
        require_nonempty(source_id, "媒体源 ID")?;
        require_nonempty(alias, "别名")?;
        let n = self
            .conn()
            .execute(
                "UPDATE sources SET alias = ?2 WHERE id = ?1",
                params![source_id, alias],
            )
            .map_err(|e| store_err("重命名媒体源别名", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("媒体源不存在: {source_id}")));
        }
        Ok(())
    }

    /// 列出仓库下全部媒体源（含离线；按挂载时间升序）。
    ///
    /// 供"恢复/迁移"类逻辑使用。**界面列表不要用它**——否则已卸载的源会重新出现在
    /// 「已添加的媒体源」里（这正是"卸载后又冒出来"的根因），请用 [`Self::list_mounted_sources`]。
    pub fn list_sources(&self, repo_id: &str) -> HpResult<Vec<Source>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, repo_id, local_path, alias, parent_source_id, mounted, mounted_at
                 FROM sources WHERE repo_id = ?1 ORDER BY mounted_at",
            )
            .map_err(|e| store_err("查询媒体源列表", e))?;
        let rows = stmt
            .query_map(params![repo_id], row_to_source)
            .map_err(|e| store_err("读取媒体源列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析媒体源列表", e))?;
        Ok(rows)
    }

    /// 列出仓库下**在线**媒体源（按挂载时间升序）：界面「已添加的媒体源」的唯一数据源。
    pub fn list_mounted_sources(&self, repo_id: &str) -> HpResult<Vec<Source>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, repo_id, local_path, alias, parent_source_id, mounted, mounted_at
                 FROM sources WHERE repo_id = ?1 AND mounted = 1 ORDER BY mounted_at",
            )
            .map_err(|e| store_err("查询在线媒体源列表", e))?;
        let rows = stmt
            .query_map(params![repo_id], row_to_source)
            .map_err(|e| store_err("读取在线媒体源列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析在线媒体源列表", e))?;
        Ok(rows)
    }

    /// 按 ID 查询媒体源；不存在返回 `None`。
    pub fn get_source(&self, source_id: &str) -> HpResult<Option<Source>> {
        self.conn()
            .query_row(
                "SELECT id, repo_id, local_path, alias, parent_source_id, mounted, mounted_at
                 FROM sources WHERE id = ?1",
                params![source_id],
                row_to_source,
            )
            .optional()
            .map_err(|e| store_err("查询媒体源", e))
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
