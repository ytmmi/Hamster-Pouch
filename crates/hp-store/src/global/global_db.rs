//! 全局配置库：仓库注册表、应用设置（RFC 0003 / database-schema.md 第 3 节）。
//!
//! 全局库知道"有哪些仓库"；面板布局、插件注册表等表已建但 API 在后续里程碑提供。

use std::path::Path;

use hp_core::{HpError, HpResult};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::migrate;
use crate::util::{now_iso, require_nonempty, store_err, uuid};

/// 全局配置库迁移脚本（按版本升序）。
const GLOBAL_MIGRATIONS: &[&str] = &[
    include_str!("../../migrations/global/0001_init.sql"),
    include_str!("../../migrations/global/0002_blueprint_templates.sql"),
    include_str!("../../migrations/global/0003_layout_blueprints.sql"),
    include_str!("../../migrations/global/0004_layout_layers.sql"),
];

/// 仓库注册表行。
#[derive(Debug, Clone, PartialEq)]
pub struct RepoRow {
    pub id: String,
    pub name: String,
    pub repo_db_path: String,
    pub created_at: String,
    pub last_opened_at: Option<String>,
}

/// 面板布局行（决策 D1：全局配置库，每行带 `repo_id`；D53：按层各存一份）。
#[derive(Debug, Clone, PartialEq)]
pub struct PanelLayoutRow {
    pub id: String,
    pub repo_id: String,
    /// 命名布局标识（承载“布局名”）。
    pub workspace: String,
    /// 所属层 key（D53）；空串 = 迁移前的层无关行（读取指定层时兜底命中）。
    pub layer_key: String,
    pub layout_json: String,
    /// 布局绑定的蓝图 ID 列表（1 个布局可绑定多个蓝图）。
    pub blueprint_ids: Vec<String>,
    pub updated_at: String,
}

/// 全局配置库句柄。
pub struct GlobalDb {
    conn: Connection,
}

impl GlobalDb {
    /// 内部连接访问器（供 `plugin_repo` 等仓储扩展方法使用）。
    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    /// 打开（不存在则创建）全局配置库并应用迁移。
    pub fn open(path: impl AsRef<Path>) -> HpResult<Self> {
        let mut conn =
            Connection::open(path.as_ref()).map_err(|e| store_err("打开全局配置库", e))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| store_err("设置 WAL", e))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| store_err("开启外键", e))?;
        migrate::apply(&mut conn, GLOBAL_MIGRATIONS)?;
        // 打开即把低版本蓝图模板一次性迁移到当前版本并回写（RFC 0007 / D52）。
        crate::global::blueprint_template_repo::migrate_blueprint_template_documents(&mut conn)?;
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

    /// 保存（UPSERT）某仓库下、**某一层**的命名面板布局。
    ///
    /// 决策 D1：布局存全局库、每行带 `repo_id`，按仓库隔离。
    /// 决策 D53：每层一份布局 —— 行键为 `(repo_id, workspace, layer_key)`；
    /// `layer_key` 为空串表示层无关行（迁移前的旧预设，读取指定层时兜底命中）。
    /// `repo_id` 允许为空串（表示未打开仓库 / 全局默认布局）。
    /// `workspace` 承载命名布局标识（布局名）。
    /// 蓝图绑定初始为空；绑定/追加走 `set_layout_blueprints`。
    pub fn save_panel_layout(
        &mut self,
        repo_id: &str,
        workspace: &str,
        layer_key: &str,
        layout_json: &str,
    ) -> HpResult<PanelLayoutRow> {
        require_nonempty(workspace, "布局名")?;
        require_nonempty(layout_json, "布局内容")?;

        let existing: Option<(String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT id, blueprint_ids_json FROM panel_layouts
                 WHERE repo_id = ?1 AND workspace = ?2 AND layer_key = ?3 LIMIT 1",
                params![repo_id, workspace, layer_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| store_err("查询面板布局", e))?;

        let row = match existing {
            Some((id, raw_bindings)) => {
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
                    layer_key: layer_key.to_string(),
                    layout_json: layout_json.to_string(),
                    blueprint_ids: parse_blueprint_ids(raw_bindings),
                    updated_at,
                }
            }
            None => {
                let row = PanelLayoutRow {
                    id: uuid(),
                    repo_id: repo_id.to_string(),
                    workspace: workspace.to_string(),
                    layer_key: layer_key.to_string(),
                    layout_json: layout_json.to_string(),
                    blueprint_ids: vec![],
                    updated_at: now_iso(),
                };
                self.conn
                    .execute(
                        "INSERT INTO panel_layouts
                             (id, repo_id, workspace, layer_key, layout_json, blueprint_ids_json, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![
                            row.id,
                            row.repo_id,
                            row.workspace,
                            row.layer_key,
                            row.layout_json,
                            "[]",
                            row.updated_at
                        ],
                    )
                    .map_err(|e| store_err("写入面板布局", e))?;
                row
            }
        };
        Ok(row)
    }

    /// 设置（覆盖）某布局绑定的蓝图 ID 列表（1 个布局可绑定多个蓝图）。
    ///
    /// 绑定是**预设级**语义（不是层级）：同一布局名下的所有层行一起更新。
    pub fn set_layout_blueprints(
        &mut self,
        repo_id: &str,
        workspace: &str,
        blueprint_ids: &[String],
    ) -> HpResult<()> {
        require_nonempty(workspace, "布局名")?;
        let json = serde_json::to_string(blueprint_ids)
            .map_err(|e| HpError::Store(format!("序列化蓝图绑定失败: {e}")))?;
        let n = self
            .conn
            .execute(
                "UPDATE panel_layouts SET blueprint_ids_json = ?3, updated_at = ?4
                 WHERE repo_id = ?1 AND workspace = ?2",
                params![repo_id, workspace, json, now_iso()],
            )
            .map_err(|e| store_err("写入布局蓝图绑定", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("布局不存在: {workspace}")));
        }
        Ok(())
    }

    /// 列出某仓库下全部命名面板布局行（按 `updated_at` 倒序，最新在前）。
    ///
    /// 返回的是**层行**：同一布局名在每个层各一行（D53），调用方按 `workspace` 聚合。
    pub fn list_panel_layouts(&self, repo_id: &str) -> HpResult<Vec<PanelLayoutRow>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, repo_id, workspace, layer_key, layout_json, blueprint_ids_json, updated_at
                 FROM panel_layouts WHERE repo_id = ?1 ORDER BY updated_at DESC",
            )
            .map_err(|e| store_err("查询面板布局列表", e))?;
        let rows = stmt
            .query_map(params![repo_id], row_to_layout)
            .map_err(|e| store_err("读取面板布局列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析面板布局列表", e))?;
        Ok(rows)
    }

    /// 读取某仓库下、某一层的命名面板布局；不存在返回 `None`。
    ///
    /// 兼容：该层没有专属行时回退到 `layer_key = ''` 的层无关行（迁移前的旧预设）。
    pub fn get_panel_layout(
        &self,
        repo_id: &str,
        workspace: &str,
        layer_key: &str,
    ) -> HpResult<Option<PanelLayoutRow>> {
        let exact = self
            .conn
            .query_row(
                "SELECT id, repo_id, workspace, layer_key, layout_json, blueprint_ids_json, updated_at
                 FROM panel_layouts WHERE repo_id = ?1 AND workspace = ?2 AND layer_key = ?3 LIMIT 1",
                params![repo_id, workspace, layer_key],
                row_to_layout,
            )
            .optional()
            .map_err(|e| store_err("查询面板布局", e))?;
        if exact.is_some() || layer_key.is_empty() {
            return Ok(exact);
        }
        self.conn
            .query_row(
                "SELECT id, repo_id, workspace, layer_key, layout_json, blueprint_ids_json, updated_at
                 FROM panel_layouts WHERE repo_id = ?1 AND workspace = ?2 AND layer_key = '' LIMIT 1",
                params![repo_id, workspace],
                row_to_layout,
            )
            .optional()
            .map_err(|e| store_err("查询层无关面板布局", e))
    }

    /// 重命名某仓库下的命名布局（同一布局名的**所有层行**一起改名）。
    pub fn rename_panel_layout(
        &mut self,
        repo_id: &str,
        name: &str,
        new_name: &str,
    ) -> HpResult<()> {
        require_nonempty(name, "布局名")?;
        require_nonempty(new_name, "新布局名")?;
        let n = self
            .conn
            .execute(
                "UPDATE panel_layouts SET workspace = ?3, updated_at = ?4
                 WHERE repo_id = ?1 AND workspace = ?2",
                params![repo_id, name, new_name, now_iso()],
            )
            .map_err(|e| store_err("重命名面板布局", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("布局不存在: {name}")));
        }
        Ok(())
    }

    /// 删除某仓库下的命名布局（同一布局名的**所有层行**一起删除）。
    pub fn delete_panel_layout(&mut self, repo_id: &str, name: &str) -> HpResult<()> {
        require_nonempty(name, "布局名")?;
        let n = self
            .conn
            .execute(
                "DELETE FROM panel_layouts WHERE repo_id = ?1 AND workspace = ?2",
                params![repo_id, name],
            )
            .map_err(|e| store_err("删除面板布局", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("布局不存在: {name}")));
        }
        Ok(())
    }

    /// 重命名仓库注册行。
    pub fn rename_repo(&mut self, id: &str, name: &str) -> HpResult<()> {
        require_nonempty(id, "仓库 ID")?;
        require_nonempty(name, "仓库名")?;
        let n = self
            .conn
            .execute(
                "UPDATE repos SET name = ?2 WHERE id = ?1",
                params![id, name],
            )
            .map_err(|e| store_err("重命名仓库", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("仓库不存在: {id}")));
        }
        Ok(())
    }

    /// 删除仓库注册行及其关联数据（面板布局、插件仓库状态）。
    ///
    /// 不删除仓库库文件本身（由边界层处理），也不删除真实图像源文件。
    pub fn delete_repo(&mut self, id: &str) -> HpResult<()> {
        require_nonempty(id, "仓库 ID")?;
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| store_err("开启仓库删除事务", e))?;
        for table in ["panel_layouts", "plugin_repo_state"] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE repo_id = ?1"),
                params![id],
            )
            .map_err(|e| store_err("删除仓库关联数据", e))?;
        }
        let n = tx
            .execute("DELETE FROM repos WHERE id = ?1", params![id])
            .map_err(|e| store_err("删除仓库注册行", e))?;
        tx.commit()
            .map_err(|e| store_err("提交仓库删除事务", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("仓库不存在: {id}")));
        }
        Ok(())
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

/// `panel_layouts` 行解析（含层归属与蓝图绑定 JSON）。
fn row_to_layout(row: &Row) -> rusqlite::Result<PanelLayoutRow> {
    let raw: Option<String> = row.get(5)?;
    Ok(PanelLayoutRow {
        id: row.get(0)?,
        repo_id: row.get(1)?,
        workspace: row.get(2)?,
        layer_key: row.get(3)?,
        layout_json: row.get(4)?,
        blueprint_ids: parse_blueprint_ids(raw),
        updated_at: row.get(6)?,
    })
}

/// 解析布局行的蓝图绑定 JSON（损坏时按空列表处理）。
fn parse_blueprint_ids(raw: Option<String>) -> Vec<String> {
    raw.and_then(|r| serde_json::from_str::<Vec<String>>(&r).ok())
        .unwrap_or_default()
}
