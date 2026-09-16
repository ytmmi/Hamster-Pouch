//! 仓库库：每仓库一个 SQLite 文件；创建/打开/关闭/schema 版本（RFC 0003 第 3 节）。

use std::path::Path;

use hp_core::{HpError, HpResult};
use rusqlite::{params, Connection, OptionalExtension};

use crate::migrate;
use crate::util::{now_iso, require_nonempty, store_err};

/// 仓库库迁移脚本（按版本升序）。
const REPO_MIGRATIONS: &[&str] = &[
    include_str!("../../migrations/repo/0001_init.sql"),
    include_str!("../../migrations/repo/0002_media_info.sql"),
    include_str!("../../migrations/repo/0003_plugin_ai.sql"),
    include_str!("../../migrations/repo/0004_split_tag_tables.sql"),
    include_str!("../../migrations/repo/0005_tag_relations.sql"),
    include_str!("../../migrations/repo/0006_blueprint.sql"),
];

/// 仓库库句柄。
pub struct RepoDb {
    conn: Connection,
}

impl RepoDb {
    /// 内部连接访问器（供 `source_repo` / `file_repo` 等仓储扩展方法使用）。
    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    /// 在指定路径创建新仓库库；路径已存在则报错（不覆盖）。
    pub fn create(path: impl AsRef<Path>, name: &str) -> HpResult<Self> {
        require_nonempty(name, "仓库名")?;
        let path = path.as_ref();
        if path.exists() {
            return Err(HpError::AlreadyExists(format!(
                "仓库库文件已存在: {}",
                path.display()
            )));
        }
        let db = Self::open_inner(path)?;
        db.set_meta("name", name)?;
        db.set_meta("created_at", &now_iso())?;
        let version = db.schema_version()?.to_string();
        db.set_meta("schema_version", &version)?;
        Ok(db)
    }

    /// 打开已有仓库库；不存在则报错。
    pub fn open(path: impl AsRef<Path>) -> HpResult<Self> {
        let path = path.as_ref();
        if !path.exists() {
            return Err(HpError::NotFound(format!(
                "仓库库文件不存在: {}",
                path.display()
            )));
        }
        Self::open_inner(path)
    }

    fn open_inner(path: &Path) -> HpResult<Self> {
        let mut conn = Connection::open(path).map_err(|e| store_err("打开仓库库", e))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| store_err("设置 WAL", e))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| store_err("开启外键", e))?;
        migrate::apply(&mut conn, REPO_MIGRATIONS)?;
        Ok(Self { conn })
    }

    /// 当前 schema 版本。
    pub fn schema_version(&self) -> HpResult<i64> {
        self.conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| store_err("读取 schema 版本", e))
    }

    /// 读取仓库元信息；不存在返回 None。
    pub fn meta(&self, key: &str) -> HpResult<Option<String>> {
        let value = self
            .conn
            .query_row(
                "SELECT value FROM repo_meta WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| store_err("读取仓库元信息", e))?;
        Ok(value)
    }

    /// 更新仓库元信息中的仓库名（仓库库侧与全局注册表保持一致）。
    pub fn set_repo_name(&mut self, name: &str) -> HpResult<()> {
        require_nonempty(name, "仓库名")?;
        self.set_meta("name", name)
    }

    fn set_meta(&self, key: &str, value: &str) -> HpResult<()> {
        self.conn
            .execute(
                "INSERT INTO repo_meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|e| store_err("写入仓库元信息", e))?;
        Ok(())
    }

    /// 关闭仓库库：WAL 检查点后释放连接。
    pub fn close(self) -> HpResult<()> {
        self.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| store_err("关闭仓库库检查点", e))?;
        Ok(())
    }
}

impl std::fmt::Debug for RepoDb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RepoDb").finish_non_exhaustive()
    }
}

#[allow(unused)]
fn _assert_send() {
    fn assert_send<T: Send>() {}
    assert_send::<RepoDb>();
}
