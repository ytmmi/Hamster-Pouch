//! 全局配置库：仓库注册表、应用设置（RFC 0003 / database-schema.md 第 3 节）。
//!
//! 全局库知道"有哪些仓库"；面板布局、插件注册表等表已建但 API 在后续里程碑提供。

use std::path::Path;

use hp_core::HpResult;
use rusqlite::{params, Connection, OptionalExtension};

use crate::migrate;
use crate::util::{now_iso, require_nonempty, store_err, uuid};

/// 全局配置库迁移脚本（按版本升序）。
const GLOBAL_MIGRATIONS: &[&str] = &[include_str!("../migrations/global/0001_init.sql")];

/// 仓库注册表行。
#[derive(Debug, Clone, PartialEq)]
pub struct RepoRow {
    pub id: String,
    pub name: String,
    pub repo_db_path: String,
    pub created_at: String,
    pub last_opened_at: Option<String>,
}

/// 全局配置库句柄。
pub struct GlobalDb {
    conn: Connection,
}

impl GlobalDb {
    /// 打开（不存在则创建）全局配置库并应用迁移。
    pub fn open(path: impl AsRef<Path>) -> HpResult<Self> {
        let mut conn =
            Connection::open(path.as_ref()).map_err(|e| store_err("打开全局配置库", e))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| store_err("设置 WAL", e))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| store_err("开启外键", e))?;
        migrate::apply(&mut conn, GLOBAL_MIGRATIONS)?;
        Ok(Self { conn })
    }

    /// 注册一个新仓库，返回注册行。
    pub fn register_repo(&mut self, name: &str, repo_db_path: &str) -> HpResult<RepoRow> {
        require_nonempty(name, "仓库名")?;
        require_nonempty(repo_db_path, "仓库库路径")?;
        let row = RepoRow {
            id: uuid(),
            name: name.to_string(),
            repo_db_path: repo_db_path.to_string(),
            created_at: now_iso(),
            last_opened_at: None,
        };
        self.conn
            .execute(
                "INSERT INTO repos (id, name, repo_db_path, created_at, last_opened_at)
                 VALUES (?1, ?2, ?3, ?4, NULL)",
                params![row.id, row.name, row.repo_db_path, row.created_at],
            )
            .map_err(|e| store_err("注册仓库", e))?;
        Ok(row)
    }

    /// 列出全部已注册仓库（按创建时间升序）。
    pub fn list_repos(&self) -> HpResult<Vec<RepoRow>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, name, repo_db_path, created_at, last_opened_at
                 FROM repos ORDER BY created_at",
            )
            .map_err(|e| store_err("查询仓库注册表", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(RepoRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    repo_db_path: row.get(2)?,
                    created_at: row.get(3)?,
                    last_opened_at: row.get(4)?,
                })
            })
            .map_err(|e| store_err("读取仓库注册表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析仓库注册表", e))?;
        Ok(rows)
    }

    /// 更新仓库最后打开时间。
    pub fn touch_repo(&mut self, id: &str) -> HpResult<()> {
        self.conn
            .execute(
                "UPDATE repos SET last_opened_at = ?2 WHERE id = ?1",
                params![id, now_iso()],
            )
            .map_err(|e| store_err("更新最后打开时间", e))?;
        Ok(())
    }

    /// 写入应用设置（UPSERT）。
    pub fn set_setting(&self, key: &str, value: &str) -> HpResult<()> {
        require_nonempty(key, "设置键")?;
        self.conn
            .execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|e| store_err("写入应用设置", e))?;
        Ok(())
    }

    /// 读取应用设置；不存在返回 None。
    pub fn get_setting(&self, key: &str) -> HpResult<Option<String>> {
        let value = self
            .conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| store_err("读取应用设置", e))?;
        Ok(value)
    }

    /// 按 ID 查询仓库注册行；不存在返回 None。
    pub fn get_repo(&self, id: &str) -> HpResult<Option<RepoRow>> {
        let row = self
            .conn
            .query_row(
                "SELECT id, name, repo_db_path, created_at, last_opened_at
                 FROM repos WHERE id = ?1",
                params![id],
                |row| {
                    Ok(RepoRow {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        repo_db_path: row.get(2)?,
                        created_at: row.get(3)?,
                        last_opened_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|e| store_err("查询仓库注册行", e))?;
        Ok(row)
    }

    /// 检查仓库是否已注册。
    pub fn repo_exists(&self, id: &str) -> HpResult<bool> {
        let exists: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM repos WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| store_err("查询仓库存在性", e))?;
        Ok(exists)
    }
}

impl std::fmt::Debug for GlobalDb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GlobalDb").finish_non_exhaustive()
    }
}

#[allow(unused)]
fn _assert_send() {
    fn assert_send<T: Send>() {}
    assert_send::<GlobalDb>();
}
