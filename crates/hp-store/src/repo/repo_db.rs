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
    include_str!("../../migrations/repo/0007_album_member_file_index.sql"),
    include_str!("../../migrations/repo/0008_text_subtype.sql"),
    include_str!("../../migrations/repo/0009_file_covers.sql"),
    include_str!("../../migrations/repo/0010_file_marks.sql"),
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
        // 扫描线程持有**独立连接**（不占用主连接的锁以免整个 UI 被长扫描堵住），
        // 因此同一仓库库可能存在两个连接；给写冲突留出等待窗口，避免直接 SQLITE_BUSY。
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| store_err("设置 busy_timeout", e))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| store_err("开启外键", e))?;
        migrate::apply(&mut conn, REPO_MIGRATIONS)?;
        // 打开即把低版本蓝图文档一次性迁移到当前版本并回写（RFC 0007 / D52）。
        crate::repo::blueprint_repo::migrate_blueprint_documents(&mut conn)?;
        // 版本的**唯一权威**是 `PRAGMA user_version`（database-schema.md 第 5 节）；
        // `repo_meta.schema_version` 只是镜像键，必须在**新建与打开两条路径的唯一汇合点**回写，
        // 否则升级过的库会与权威值分叉（缺陷 0006）。此处不能下沉到 `migrate::apply`：
        // 那个执行器由仓库库/全局库/词库共用，且只有全局库与词库没有 `repo_meta`。
        let db = Self { conn };
        db.sync_schema_version_meta()?;
        Ok(db)
    }

    /// 以 `PRAGMA user_version` 为准回写 `repo_meta.schema_version` 镜像键。
    ///
    /// 幂等：每次打开都写一次，值恒等于权威版本。镜像键**不得**被当作版本依据读取。
    fn sync_schema_version_meta(&self) -> HpResult<()> {
        let version = self.schema_version()?.to_string();
        self.set_meta("schema_version", &version)
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
