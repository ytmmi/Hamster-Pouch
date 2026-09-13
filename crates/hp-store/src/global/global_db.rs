//! 全局配置库：仓库注册表、应用设置（RFC 0003 / database-schema.md 第 3 节）。
//!
//! 全局库知道"有哪些仓库"；面板布局、插件注册表等表已建但 API 在后续里程碑提供。

use std::path::Path;

use hp_core::HpResult;
use rusqlite::{params, Connection, OptionalExtension};

use crate::migrate;
use crate::util::{now_iso, require_nonempty, store_err, uuid};

/// 全局配置库迁移脚本（按版本升序）。
const GLOBAL_MIGRATIONS: &[&str] = &[include_str!("../../migrations/global/0001_init.sql")];

/// 仓库注册表行。
#[derive(Debug, Clone, PartialEq)]
pub struct RepoRow {
    pub id: String,
    pub name: String,
    pub repo_db_path: String,
    pub created_at: String,
    pub last_opened_at: Option<String>,
}

/// 面板布局行（决策 D1：全局配置库，每行带 `repo_id`）。
#[derive(Debug, Clone, PartialEq)]
pub struct PanelLayoutRow {
    pub id: String,
    pub repo_id: String,
    /// 命名布局标识（承载“布局名”）。
    pub workspace: String,
    pub layout_json: String,
    pub updated_at: String,
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

    /// 保存（UPSERT）某仓库下的命名面板布局。
    ///
    /// 决策 D1：布局存全局库、每行带 `repo_id`，按仓库隔离。
    /// `repo_id` 允许为空串（表示未打开仓库 / 全局默认布局）。
    /// `workspace` 承载命名布局标识（布局名）；同 `(repo_id, workspace)` 覆盖旧值。
    pub fn save_panel_layout(
        &mut self,
        repo_id: &str,
        workspace: &str,
        layout_json: &str,
    ) -> HpResult<PanelLayoutRow> {
        require_nonempty(workspace, "布局名")?;
        require_nonempty(layout_json, "布局内容")?;

        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM panel_layouts WHERE repo_id = ?1 AND workspace = ?2 LIMIT 1",
                params![repo_id, workspace],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| store_err("查询面板布局", e))?;

        let row = match existing {
            Some(id) => {
                let updated_at = now_iso();
                self.conn
                    .execute(
                        "UPDATE panel_layouts SET layout_json = ?2, updated_at = ?3 WHERE id = ?1",
                        params![id, layout_json, updated_at],
                    )
                    .map_err(|e| store_err("更新面板布局", e))?;
                PanelLayoutRow {
                    id,
                    repo_id: repo_id.to_string(),
                    workspace: workspace.to_string(),
                    layout_json: layout_json.to_string(),
                    updated_at,
                }
            }
            None => {
                let row = PanelLayoutRow {
                    id: uuid(),
                    repo_id: repo_id.to_string(),
                    workspace: workspace.to_string(),
                    layout_json: layout_json.to_string(),
                    updated_at: now_iso(),
                };
                self.conn
                    .execute(
                        "INSERT INTO panel_layouts (id, repo_id, workspace, layout_json, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            row.id,
                            row.repo_id,
                            row.workspace,
                            row.layout_json,
                            row.updated_at
                        ],
                    )
                    .map_err(|e| store_err("写入面板布局", e))?;
                row
            }
        };
        Ok(row)
    }

    /// 列出某仓库下全部命名面板布局（按 `updated_at` 倒序，最新在前）。
    pub fn list_panel_layouts(&self, repo_id: &str) -> HpResult<Vec<PanelLayoutRow>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, repo_id, workspace, layout_json, updated_at
                 FROM panel_layouts WHERE repo_id = ?1 ORDER BY updated_at DESC",
            )
            .map_err(|e| store_err("查询面板布局列表", e))?;
        let rows = stmt
            .query_map(params![repo_id], |row| {
                Ok(PanelLayoutRow {
                    id: row.get(0)?,
                    repo_id: row.get(1)?,
                    workspace: row.get(2)?,
                    layout_json: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|e| store_err("读取面板布局列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析面板布局列表", e))?;
        Ok(rows)
    }

    /// 读取某仓库下单个命名面板布局；不存在返回 `None`。
    pub fn get_panel_layout(
        &self,
        repo_id: &str,
        workspace: &str,
    ) -> HpResult<Option<PanelLayoutRow>> {
        let row = self
            .conn
            .query_row(
                "SELECT id, repo_id, workspace, layout_json, updated_at
                 FROM panel_layouts WHERE repo_id = ?1 AND workspace = ?2 LIMIT 1",
                params![repo_id, workspace],
                |row| {
                    Ok(PanelLayoutRow {
                        id: row.get(0)?,
                        repo_id: row.get(1)?,
                        workspace: row.get(2)?,
                        layout_json: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|e| store_err("查询面板布局", e))?;
        Ok(row)
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
