//! 前向迁移执行器。
//!
//! 以 `PRAGMA user_version` 记录已应用版本；每个迁移在事务中执行，失败回滚。
//! 规则：不允许修改已发布的迁移文件，新增需求一律追加新迁移（database-schema.md 第 5 节）。

use hp_core::{HpError, HpResult};
use rusqlite::Connection;

/// 应用所有待执行迁移。`migrations` 按版本升序排列（index 0 = 版本 1）。
pub(crate) fn apply(conn: &mut Connection, migrations: &[&str]) -> HpResult<()> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| HpError::Store(format!("读取 schema 版本失败: {e}")))?;

    for (idx, sql) in migrations.iter().enumerate() {
        let version = (idx + 1) as i64;
        if version > current {
            let tx = conn
                .transaction()
                .map_err(|e| HpError::Store(format!("开启迁移事务失败: {e}")))?;
            tx.execute_batch(sql)
                .map_err(|e| HpError::Store(format!("执行迁移 {version} 失败: {e}")))?;
            tx.pragma_update(None, "user_version", version)
                .map_err(|e| HpError::Store(format!("更新 schema 版本失败: {e}")))?;
            tx.commit()
                .map_err(|e| HpError::Store(format!("提交迁移 {version} 失败: {e}")))?;
        }
    }
    Ok(())
}
