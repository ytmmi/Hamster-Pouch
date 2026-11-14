//! hp-db：SQLite 连接的公共骨架。
//!
//! 只收「打开连接 → 设 pragma → 跑前向迁移 → 关库检查点」这条四个物理库共用的流程，
//! 外加配套的四个小工具（`store_err` / `now_iso` / `uuid` / `require_nonempty`）。
//!
//! 边界（D185 / S1）：**不含任何 schema、SQL 与迁移清单**——仓库库、全局配置库、tag 词库、
//! tag 库的表结构与迁移仍各自留在 `hp-store` 的领域模块里。拆这一层的理由不是「文件太长」，
//! 而是这条流程原先被四个句柄各抄一遍（4 处开库、8 处 pragma、2 处关库检查点），
//! 于是「哪个库有没有 busy_timeout」「关库要不要 checkpoint」只能靠人肉比对。
//!
//! 四个库的 pragma 并不一致，且这是**现状契约而非疏漏**：全局库与词库不设 `busy_timeout`，
//! tag 库的只读路径不开 WAL。`PragmaSet` 把这些差异显式化成常量——新增库必须挑一个常量
//! 或新声明一个，不允许在别处手写 pragma（`tools/check-db-boundary.mjs` 反向断言）。

use std::ops::{Deref, DerefMut};
use std::path::Path;
use std::time::Duration;

use hp_core::{HpError, HpResult};
use rusqlite::Connection;

mod migrate;
pub mod util;

pub use util::{now_iso, require_nonempty, store_err, uuid};

/// 一个物理库打开时要设的 pragma 组合。
#[derive(Debug, Clone, Copy)]
pub struct PragmaSet {
    /// 是否设 `journal_mode = WAL`。
    pub wal: bool,
    /// `busy_timeout` 等待窗口；`None` 表示不设（撞锁立即返回 SQLITE_BUSY）。
    pub busy_timeout: Option<Duration>,
    /// 是否设 `foreign_keys = ON`。
    pub foreign_keys: bool,
}

impl PragmaSet {
    /// 仓库库：扫描线程持有独立连接，因此需要 5 秒的写冲突等待窗口。
    pub const REPO: Self = Self {
        wal: true,
        busy_timeout: Some(Duration::from_secs(5)),
        foreign_keys: true,
    };

    /// 全局配置库：只有主进程连接，不设 busy_timeout。
    pub const GLOBAL: Self = Self {
        wal: true,
        busy_timeout: None,
        foreign_keys: true,
    };

    /// tag 词库：同上，不设 busy_timeout。
    pub const DICT: Self = Self {
        wal: true,
        busy_timeout: None,
        foreign_keys: true,
    };

    /// 数据层 tag 库（只读打开）：只开外键，不切 WAL（只读连接不做检查点）。
    pub const TAGLIB_READONLY: Self = Self {
        wal: false,
        busy_timeout: None,
        foreign_keys: true,
    };
}

/// 一个已按 `PragmaSet` 配置好的 SQLite 连接。
///
/// 实现 `Deref`/`DerefMut` 到 `Connection`，所以领域仓储里的 `self.conn.execute(…)`
/// 不必改写；需要显式 `&mut Connection` 的地方（事务、迁移）用 `as_conn_mut()`。
pub struct Db {
    conn: Connection,
}

impl Db {
    /// 以读写方式打开（文件不存在则创建），按 `pragmas` 设 pragma。
    ///
    /// `open_context` 只用于错误文案：四个库的「打开…」措辞不同，逐字保留。
    pub fn open(path: impl AsRef<Path>, pragmas: PragmaSet, open_context: &str) -> HpResult<Self> {
        let conn = Connection::open(path).map_err(|e| store_err(open_context, e))?;
        apply_pragmas(&conn, pragmas)?;
        Ok(Self { conn })
    }

    /// 以只读方式打开（数据层资产，宿主不写它），按 `PragmaSet::TAGLIB_READONLY` 设 pragma。
    pub fn open_readonly(path: impl AsRef<Path>, open_context: &str) -> HpResult<Self> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| store_err(open_context, e))?;
        apply_pragmas(&conn, PragmaSet::TAGLIB_READONLY)?;
        Ok(Self { conn })
    }

    /// 内部连接访问器（`&Connection`）。
    pub fn as_conn(&self) -> &Connection {
        &self.conn
    }

    /// 内部连接访问器（`&mut Connection`）。
    pub fn as_conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// 应用所有待执行迁移（`migrations` 升序，index 0 = 版本 1）。
    pub fn apply_migrations(&mut self, migrations: &[&str]) -> HpResult<()> {
        migrate::apply(&mut self.conn, migrations)
    }

    /// 读 `PRAGMA user_version`（schema 版本的唯一权威）。
    pub fn user_version(&self) -> HpResult<i64> {
        self.conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| HpError::Store(format!("读取 schema 版本失败: {e}")))
    }

    /// 关库：WAL 检查点后释放连接。`context` 只用于错误文案。
    pub fn checkpoint_close(self, context: &str) -> HpResult<()> {
        self.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| store_err(context, e))
    }
}

impl Deref for Db {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        &self.conn
    }
}

impl DerefMut for Db {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }
}

/// 按固定顺序（WAL → busy_timeout → foreign_keys）设置 pragma。
fn apply_pragmas(conn: &Connection, pragmas: PragmaSet) -> HpResult<()> {
    if pragmas.wal {
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| store_err("设置 WAL", e))?;
    }
    if let Some(timeout) = pragmas.busy_timeout {
        conn.busy_timeout(timeout)
            .map_err(|e| store_err("设置 busy_timeout", e))?;
    }
    if pragmas.foreign_keys {
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| store_err("开启外键", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_applies_pragmas_and_runs_migrations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repo.db");
        let mut db = Db::open(&path, PragmaSet::REPO, "打开仓库库").unwrap();
        db.apply_migrations(&["CREATE TABLE t (id INTEGER PRIMARY KEY);"])
            .unwrap();
        assert_eq!(db.user_version().unwrap(), 1);
        let journal: String = db
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal.to_lowercase(), "wal");
        db.apply_migrations(&["CREATE TABLE t (id INTEGER PRIMARY KEY);"])
            .unwrap();
        assert_eq!(
            Db::open(&path, PragmaSet::REPO, "打开仓库库")
                .unwrap()
                .user_version()
                .unwrap(),
            1
        );
    }

    #[test]
    fn readonly_open_rejects_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let err = Db::open_readonly(dir.path().join("nope.db"), "以只读方式打开 tag 库");
        assert!(err.is_err());
    }
}
