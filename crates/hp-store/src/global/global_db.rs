//! 全局配置库：仓库注册表、应用设置（RFC 0003 / database-schema.md 第 3 节）。
//!
//! 全局库知道"有哪些仓库"；面板布局、插件注册表等表已建但 API 在后续里程碑提供。

use std::collections::BTreeMap;
use std::path::Path;

use hp_core::{HpError, HpResult};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::Value;

use crate::migrate;
use crate::util::{now_iso, require_nonempty, store_err, uuid};

/// 全局配置库迁移脚本（按版本升序）。
const GLOBAL_MIGRATIONS: &[&str] = &[
    include_str!("../../migrations/global/0001_init.sql"),
    include_str!("../../migrations/global/0002_blueprint_templates.sql"),
    include_str!("../../migrations/global/0003_layout_blueprints.sql"),
    include_str!("../../migrations/global/0004_layout_layers.sql"),
    include_str!("../../migrations/global/0005_layout_presets.sql"),
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

/// 布局预设行（RFC 0011：应用级，无仓库维度；一份布局 = 一行）。
///
/// `layers` 的键是蓝图层 key；空串 `""` 是该布局的层无关快照（只在预设内该层
/// 缺失时兜底，**不跨预设**借行）。
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutPresetRow {
    pub id: String,
    pub name: String,
    /// 各层布局（层 key → 布局 JSON 对象）。
    pub layers: BTreeMap<String, Value>,
    /// 布局绑定的蓝图 ID 列表（预设级，1 个布局可绑定多个蓝图）。
    pub blueprint_ids: Vec<String>,
    /// `'user'` | `'seeded'`（出厂播种；用户保存后转为 `user`）。
    pub origin: String,
    pub updated_at: String,
}

impl LayoutPresetRow {
    /// 该预设的层 key 列表（含 `""` 层无关快照），按字典序。
    pub fn layer_keys(&self) -> Vec<String> {
        self.layers.keys().cloned().collect()
    }

    /// 读取某层的布局 JSON 文本：当前层 → `""`（层无关快照）→ 无。
    pub fn layer_json(&self, layer_key: &str) -> Option<String> {
        let value = self.layers.get(layer_key).or_else(|| self.layers.get(""))?;
        serde_json::to_string(value).ok()
    }
}

/// 出厂播种结果（RFC 0011 决策 5）。
#[derive(Debug, Clone, PartialEq)]
pub struct SeedOutcome {
    /// 本次是否新建了播种预设（库内原先没有任何预设）。
    pub seeded: bool,
    /// 是否用新的出厂形状替换了仍未被用户改动的播种预设。
    pub replaced: bool,
    /// 播种/替换命中的预设名。
    pub name: Option<String>,
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

    /// 列出全部应用设置（「全部设置」界面一次读完，避免逐项往返）。
    ///
    /// 按 key 升序返回，保证界面呈现与诊断输出可复现。
    pub fn list_settings(&self) -> HpResult<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT key, value FROM app_settings ORDER BY key")
            .map_err(|e| store_err("准备列出应用设置", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| store_err("列出应用设置", e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| store_err("读取应用设置行", e))?);
        }
        Ok(out)
    }

    /// 删除应用设置（恢复为该设置项的**声明缺省值**）。
    pub fn delete_setting(&self, key: &str) -> HpResult<()> {
        require_nonempty(key, "设置键")?;
        self.conn
            .execute("DELETE FROM app_settings WHERE key = ?1", params![key])
            .map_err(|e| store_err("删除应用设置", e))?;
        Ok(())
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

    /// 保存（更新）某预设内**某一层**的布局；预设不存在则新建。
    ///
    /// RFC 0011 决策 3：一份布局 = 一行，保存只改该预设内当前层那一格。
    /// 用户保存会把播种预设的 `origin` 从 `seeded` 转为 `user`（决策 5 的
    /// 「用户改过则永不覆盖」判定）。
    pub fn save_layout_layer(
        &mut self,
        name: &str,
        layer_key: &str,
        layout_json: &str,
    ) -> HpResult<LayoutPresetRow> {
        require_nonempty(name, "布局名")?;
        require_nonempty(layout_json, "布局内容")?;
        let value: Value = serde_json::from_str(layout_json)
            .map_err(|e| HpError::InvalidArgument(format!("布局内容不是合法 JSON: {e}")))?;
        if !value.is_object() {
            return Err(HpError::InvalidArgument("布局内容必须是 JSON 对象".into()));
        }

        let mut preset = match self.get_layout_preset(name)? {
            Some(existing) => existing,
            None => LayoutPresetRow {
                id: uuid(),
                name: name.to_string(),
                layers: BTreeMap::new(),
                blueprint_ids: Vec::new(),
                origin: "user".to_string(),
                updated_at: now_iso(),
            },
        };
        preset.layers.insert(layer_key.to_string(), value);
        preset.origin = "user".to_string();
        preset.updated_at = now_iso();

        let layers_json = serde_json::to_string(&preset.layers)
            .map_err(|e| HpError::Store(format!("序列化布局层失败: {e}")))?;
        let bindings_json = serde_json::to_string(&preset.blueprint_ids)
            .map_err(|e| HpError::Store(format!("序列化蓝图绑定失败: {e}")))?;
        self.conn
            .execute(
                "INSERT INTO layout_presets
                     (id, name, layers_json, blueprint_ids_json, origin, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     layers_json = excluded.layers_json,
                     blueprint_ids_json = excluded.blueprint_ids_json,
                     origin = excluded.origin,
                     updated_at = excluded.updated_at",
                params![
                    preset.id,
                    preset.name,
                    layers_json,
                    bindings_json,
                    preset.origin,
                    preset.updated_at
                ],
            )
            .map_err(|e| store_err("写入布局预设", e))?;
        Ok(preset)
    }

    /// 导入一份应用级预设（名字已由调用方解决唯一性）。
    pub fn import_layout_preset(
        &mut self,
        name: &str,
        layers: BTreeMap<String, Value>,
        blueprint_ids: &[String],
    ) -> HpResult<LayoutPresetRow> {
        require_nonempty(name, "布局名")?;
        let preset = LayoutPresetRow {
            id: uuid(),
            name: name.to_string(),
            layers,
            blueprint_ids: blueprint_ids.to_vec(),
            origin: "user".to_string(),
            updated_at: now_iso(),
        };
        let layers_json = serde_json::to_string(&preset.layers)
            .map_err(|e| HpError::Store(format!("序列化布局层失败: {e}")))?;
        let bindings_json = serde_json::to_string(&preset.blueprint_ids)
            .map_err(|e| HpError::Store(format!("序列化蓝图绑定失败: {e}")))?;
        self.conn
            .execute(
                "INSERT INTO layout_presets
                     (id, name, layers_json, blueprint_ids_json, origin, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    preset.id,
                    preset.name,
                    layers_json,
                    bindings_json,
                    preset.origin,
                    preset.updated_at
                ],
            )
            .map_err(|e| store_err("写入导入布局预设", e))?;
        Ok(preset)
    }

    /// 设置（覆盖）某预设绑定的蓝图 ID 列表（预设级，作用于全部层）。
    pub fn set_layout_blueprints(&mut self, name: &str, blueprint_ids: &[String]) -> HpResult<()> {
        require_nonempty(name, "布局名")?;
        let json = serde_json::to_string(blueprint_ids)
            .map_err(|e| HpError::Store(format!("序列化蓝图绑定失败: {e}")))?;
        let n = self
            .conn
            .execute(
                "UPDATE layout_presets SET blueprint_ids_json = ?2, updated_at = ?3
                 WHERE name = ?1",
                params![name, json, now_iso()],
            )
            .map_err(|e| store_err("写入布局蓝图绑定", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("布局不存在: {name}")));
        }
        Ok(())
    }

    /// 列出全部应用级预设（最新在前）。
    pub fn list_layout_presets(&self) -> HpResult<Vec<LayoutPresetRow>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, name, layers_json, blueprint_ids_json, origin, updated_at
                 FROM layout_presets ORDER BY updated_at DESC, name",
            )
            .map_err(|e| store_err("查询布局预设列表", e))?;
        let rows = stmt
            .query_map([], row_to_layout_preset)
            .map_err(|e| store_err("读取布局预设列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析布局预设列表", e))?;
        Ok(rows)
    }

    /// 按名字读取一份预设；不存在返回 `None`。
    pub fn get_layout_preset(&self, name: &str) -> HpResult<Option<LayoutPresetRow>> {
        require_nonempty(name, "布局名")?;
        self.conn
            .query_row(
                "SELECT id, name, layers_json, blueprint_ids_json, origin, updated_at
                 FROM layout_presets WHERE name = ?1 LIMIT 1",
                params![name],
                row_to_layout_preset,
            )
            .optional()
            .map_err(|e| store_err("查询布局预设", e))
    }

    /// 读取某预设内某一层的布局 JSON（当前层 → `""` → 无）；**不跨预设**兜底。
    pub fn get_layout_layer(&self, name: &str, layer_key: &str) -> HpResult<Option<String>> {
        Ok(self
            .get_layout_preset(name)?
            .and_then(|preset| preset.layer_json(layer_key)))
    }

    /// 重命名预设（默认指针与绑定引用都按 id 存，无需跟着改）。
    pub fn rename_layout_preset(&mut self, name: &str, new_name: &str) -> HpResult<()> {
        require_nonempty(name, "布局名")?;
        require_nonempty(new_name, "新布局名")?;
        if new_name != name && self.get_layout_preset(new_name)?.is_some() {
            return Err(HpError::AlreadyExists(format!("布局已存在: {new_name}")));
        }
        let n = self
            .conn
            .execute(
                "UPDATE layout_presets SET name = ?2, updated_at = ?3 WHERE name = ?1",
                params![name, new_name, now_iso()],
            )
            .map_err(|e| store_err("重命名布局预设", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("布局不存在: {name}")));
        }
        Ok(())
    }

    /// 删除预设。命中应用级默认或任一仓库绑定时**拒绝删除**（RFC 0011 决策 11）。
    pub fn delete_layout_preset(&mut self, name: &str) -> HpResult<()> {
        require_nonempty(name, "布局名")?;
        let preset = self
            .get_layout_preset(name)?
            .ok_or_else(|| HpError::NotFound(format!("布局不存在: {name}")))?;
        if self.default_layout_id()?.as_deref() == Some(preset.id.as_str()) {
            return Err(HpError::InvalidArgument(format!(
                "布局「{name}」是应用级默认，先设为其他默认再删除"
            )));
        }
        let bound: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM layout_bindings WHERE preset_id = ?1)",
                params![preset.id],
                |row| row.get(0),
            )
            .map_err(|e| store_err("查询布局绑定", e))?;
        if bound {
            return Err(HpError::InvalidArgument(format!(
                "布局「{name}」被仓库覆盖引用，先解除绑定再删除"
            )));
        }
        self.conn
            .execute(
                "DELETE FROM layout_presets WHERE id = ?1",
                params![preset.id],
            )
            .map_err(|e| store_err("删除布局预设", e))?;
        Ok(())
    }

    /// 设为应用级默认（`app_settings['layout.default']` 存预设 id）。
    pub fn set_default_layout(&mut self, name: &str) -> HpResult<()> {
        let preset = self
            .get_layout_preset(name)?
            .ok_or_else(|| HpError::NotFound(format!("布局不存在: {name}")))?;
        self.conn
            .execute(
                "INSERT INTO app_settings (key, value) VALUES ('layout.default', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![preset.id],
            )
            .map_err(|e| store_err("写入应用级默认布局", e))?;
        Ok(())
    }

    /// 应用级默认预设 id（`layout.default` 的原始值）。
    pub fn default_layout_id(&self) -> HpResult<Option<String>> {
        self.get_setting("layout.default")
            .map(|value| value.filter(|v| !v.is_empty()))
    }

    /// 应用级默认预设名；未设置或指向已不存在的预设时返回 `None`。
    pub fn default_layout_name(&self) -> HpResult<Option<String>> {
        let Some(id) = self.default_layout_id()? else {
            return Ok(None);
        };
        self.conn
            .query_row(
                "SELECT name FROM layout_presets WHERE id = ?1 LIMIT 1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| store_err("查询默认布局名", e))
    }

    /// 某仓库的覆盖绑定（预设名）；无绑定返回 `None`。
    pub fn layout_binding_name(&self, repo_id: &str) -> HpResult<Option<String>> {
        require_nonempty(repo_id, "仓库 ID")?;
        self.conn
            .query_row(
                "SELECT p.name FROM layout_bindings b
                 JOIN layout_presets p ON p.id = b.preset_id
                 WHERE b.repo_id = ?1 LIMIT 1",
                params![repo_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| store_err("查询仓库布局绑定", e))
    }

    /// 设 / 清仓库覆盖（RFC 0011 决策 4）：`Some(name)` 写绑定行，`None` 删除绑定行。
    pub fn bind_layout_repo(&mut self, repo_id: &str, name: Option<&str>) -> HpResult<()> {
        require_nonempty(repo_id, "仓库 ID")?;
        match name {
            Some(name) => {
                let preset = self
                    .get_layout_preset(name)?
                    .ok_or_else(|| HpError::NotFound(format!("布局不存在: {name}")))?;
                self.conn
                    .execute(
                        "INSERT INTO layout_bindings (repo_id, preset_id, updated_at)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT(repo_id) DO UPDATE SET
                             preset_id = excluded.preset_id,
                             updated_at = excluded.updated_at",
                        params![repo_id, preset.id, now_iso()],
                    )
                    .map_err(|e| store_err("写入仓库布局绑定", e))?;
            }
            None => {
                self.conn
                    .execute(
                        "DELETE FROM layout_bindings WHERE repo_id = ?1",
                        params![repo_id],
                    )
                    .map_err(|e| store_err("清除仓库布局绑定", e))?;
            }
        }
        Ok(())
    }

    /// 出厂播种（RFC 0011 决策 5）：库内没有任何预设时把代码内建形状播种为
    /// `origin = 'seeded'` 的应用级预设并设为默认；已有 seed 预设且仍未被用户
    /// 改动时，用新形状替换（`save_layout_layer` 会把 `origin` 转成 `user`）。
    pub fn ensure_seeded_layout(
        &mut self,
        name: &str,
        layers_json: &str,
        blueprint_ids: &[String],
    ) -> HpResult<SeedOutcome> {
        require_nonempty(name, "布局名")?;
        let layers: BTreeMap<String, Value> = serde_json::from_str(layers_json)
            .map_err(|e| HpError::InvalidArgument(format!("布局内容不是合法 JSON: {e}")))?;
        if layers.is_empty() {
            return Err(HpError::InvalidArgument("布局内容不能为空".into()));
        }
        let canonical = serde_json::to_string(&layers)
            .map_err(|e| HpError::Store(format!("序列化布局层失败: {e}")))?;

        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM layout_presets", [], |row| row.get(0))
            .map_err(|e| store_err("统计布局预设", e))?;
        if count == 0 {
            let id = uuid();
            let now = now_iso();
            let bindings = serde_json::to_string(blueprint_ids)
                .map_err(|e| HpError::Store(format!("序列化蓝图绑定失败: {e}")))?;
            self.conn
                .execute(
                    "INSERT INTO layout_presets
                         (id, name, layers_json, blueprint_ids_json, origin, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 'seeded', ?5)",
                    params![id, name, canonical, bindings, now],
                )
                .map_err(|e| store_err("播种出厂布局", e))?;
            self.conn
                .execute(
                    "INSERT INTO app_settings (key, value) VALUES ('layout.default', ?1)
                     ON CONFLICT(key) DO NOTHING",
                    params![id],
                )
                .map_err(|e| store_err("写入播种默认布局", e))?;
            return Ok(SeedOutcome {
                seeded: true,
                replaced: false,
                name: Some(name.to_string()),
            });
        }

        let seeded: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT id, name FROM layout_presets WHERE origin = 'seeded' LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| store_err("查询播种布局", e))?;
        let Some((id, seeded_name)) = seeded else {
            return Ok(SeedOutcome {
                seeded: false,
                replaced: false,
                name: None,
            });
        };

        // 播种预设仍未被改动：内容与出厂形状不一致时按新版本替换。
        let current: String = self
            .conn
            .query_row(
                "SELECT layers_json FROM layout_presets WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| store_err("读取播种布局", e))?;
        let mut replaced = false;
        if current != canonical {
            let bindings = serde_json::to_string(blueprint_ids)
                .map_err(|e| HpError::Store(format!("序列化蓝图绑定失败: {e}")))?;
            self.conn
                .execute(
                    "UPDATE layout_presets
                        SET layers_json = ?2, blueprint_ids_json = ?3, updated_at = ?4
                      WHERE id = ?1",
                    params![id, canonical, bindings, now_iso()],
                )
                .map_err(|e| store_err("替换播种布局", e))?;
            replaced = true;
        }
        // 默认指针缺失（或指向已不存在的预设）时补指到播种预设。
        if self.default_layout_name()?.is_none() {
            self.conn
                .execute(
                    "INSERT INTO app_settings (key, value) VALUES ('layout.default', ?1)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![id],
                )
                .map_err(|e| store_err("修复播种默认布局", e))?;
        }
        Ok(SeedOutcome {
            seeded: false,
            replaced,
            name: Some(seeded_name),
        })
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

    /// 删除仓库注册行及其关联数据（仓库布局绑定、插件仓库状态）。
    ///
    /// RFC 0011：布局预设是应用级的，不再随仓库删除；只删 `layout_bindings` 的覆盖行。
    /// 不删除仓库库文件本身（由边界层处理），也不删除真实媒体源文件。
    pub fn delete_repo(&mut self, id: &str) -> HpResult<()> {
        require_nonempty(id, "仓库 ID")?;
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| store_err("开启仓库删除事务", e))?;
        for table in ["layout_bindings", "plugin_repo_state"] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE repo_id = ?1"),
                params![id],
            )
            .map_err(|e| store_err("删除仓库关联数据", e))?;
        }
        let n = tx
            .execute("DELETE FROM repos WHERE id = ?1", params![id])
            .map_err(|e| store_err("删除仓库注册行", e))?;
        tx.commit().map_err(|e| store_err("提交仓库删除事务", e))?;
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

/// `layout_presets` 行解析（层 JSON 与蓝图绑定 JSON）。
fn row_to_layout_preset(row: &Row) -> rusqlite::Result<LayoutPresetRow> {
    let raw_layers: String = row.get(2)?;
    let raw_bindings: Option<String> = row.get(3)?;
    let layers = serde_json::from_str::<BTreeMap<String, Value>>(&raw_layers).unwrap_or_default();
    Ok(LayoutPresetRow {
        id: row.get(0)?,
        name: row.get(1)?,
        layers,
        blueprint_ids: parse_blueprint_ids(raw_bindings),
        origin: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

/// 解析布局预设的蓝图绑定 JSON（损坏时按空列表处理）。
fn parse_blueprint_ids(raw: Option<String>) -> Vec<String> {
    raw.and_then(|r| serde_json::from_str::<Vec<String>>(&r).ok())
        .unwrap_or_default()
}
