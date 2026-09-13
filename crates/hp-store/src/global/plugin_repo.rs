//! 全局配置库插件与 AI 仓储（RFC 0004 / database-schema.md 第 3.4-3.6 节）。
//!
//! - `plugin_registry`：全局安装的插件注册表。
//! - `plugin_repo_state`：按仓库启用 + 按仓库能力授权。
//! - `ai_provider_config`：AI 提供方配置引用（不保存密钥明文）。

use hp_core::{
    AiProviderConfig, AiProviderConfigId, Capability, HpError, HpResult, PluginId, PluginRegistryRow,
    PluginRepoState, RepoId, RuntimeKind, SourceKind, TrustLevel,
};
use rusqlite::{params, OptionalExtension, Row};

use super::global_db::GlobalDb;
use crate::util::{now_iso, require_nonempty, store_err};

/// `plugin_registry` 表列清单（与迁移 0001 顺序一致）。
const PLUGIN_COLUMNS: &str =
    "id, name, version, trust_level, source_kind, source_ref, runtime_kind, installed_at, manifest_json";

impl GlobalDb {
    /// 插入或更新插件注册行（按 `id` UPSERT）。
    pub fn upsert_plugin(&mut self, row: &PluginRegistryRow) -> HpResult<()> {
        require_nonempty(row.id.as_str(), "插件 ID")?;
        require_nonempty(&row.name, "插件名")?;
        require_nonempty(&row.version, "插件版本")?;
        self.conn()
            .execute(
                "INSERT INTO plugin_registry
                     (id, name, version, trust_level, source_kind, source_ref, runtime_kind, installed_at, manifest_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     version = excluded.version,
                     trust_level = excluded.trust_level,
                     source_kind = excluded.source_kind,
                     source_ref = excluded.source_ref,
                     runtime_kind = excluded.runtime_kind,
                     manifest_json = excluded.manifest_json",
                params![
                    row.id.as_str(),
                    row.name,
                    row.version,
                    row.trust_level.as_str(),
                    row.source_kind.as_str(),
                    row.source_ref,
                    row.runtime_kind.as_str(),
                    row.installed_at,
                    row.manifest_json,
                ],
            )
            .map_err(|e| store_err("写入插件注册表", e))?;
        Ok(())
    }

    /// 按 ID 查询插件注册行；不存在返回 `None`。
    pub fn get_plugin(&self, plugin_id: &str) -> HpResult<Option<PluginRegistryRow>> {
        self.conn()
            .query_row(
                &format!("SELECT {PLUGIN_COLUMNS} FROM plugin_registry WHERE id = ?1"),
                params![plugin_id],
                row_to_plugin,
            )
            .optional()
            .map_err(|e| store_err("查询插件注册行", e))
    }

    /// 列出全部插件注册行（按安装时间升序）。
    pub fn list_plugins(&self) -> HpResult<Vec<PluginRegistryRow>> {
        let mut stmt = self
            .conn()
            .prepare(&format!(
                "SELECT {PLUGIN_COLUMNS} FROM plugin_registry ORDER BY installed_at"
            ))
            .map_err(|e| store_err("查询插件列表", e))?;
        let rows = stmt
            .query_map([], row_to_plugin)
            .map_err(|e| store_err("读取插件列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析插件列表", e))?;
        Ok(rows)
    }

    /// 删除插件注册行及其全部仓库状态。
    pub fn remove_plugin(&mut self, plugin_id: &str) -> HpResult<()> {
        require_nonempty(plugin_id, "插件 ID")?;
        let tx = self
            .conn()
            .unchecked_transaction()
            .map_err(|e| store_err("开启插件删除事务", e))?;
        tx.execute(
            "DELETE FROM plugin_repo_state WHERE plugin_id = ?1",
            params![plugin_id],
        )
        .map_err(|e| store_err("删除插件仓库状态", e))?;
        let n = tx
            .execute(
                "DELETE FROM plugin_registry WHERE id = ?1",
                params![plugin_id],
            )
            .map_err(|e| store_err("删除插件注册行", e))?;
        tx.commit()
            .map_err(|e| store_err("提交插件删除事务", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("插件不存在: {plugin_id}")));
        }
        Ok(())
    }

    /// 插入或更新插件仓库级状态（按 `(plugin_id, repo_id)` UPSERT）。
    pub fn upsert_plugin_repo_state(&mut self, state: &PluginRepoState) -> HpResult<()> {
        require_nonempty(state.plugin_id.as_str(), "插件 ID")?;
        require_nonempty(state.repo_id.as_str(), "仓库 ID")?;
        self.conn()
            .execute(
                "INSERT INTO plugin_repo_state (plugin_id, repo_id, enabled, grants_json)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(plugin_id, repo_id) DO UPDATE SET
                     enabled = excluded.enabled,
                     grants_json = excluded.grants_json",
                params![
                    state.plugin_id.as_str(),
                    state.repo_id.as_str(),
                    state.enabled as i64,
                    grants_to_json(&state.grants),
                ],
            )
            .map_err(|e| store_err("写入插件仓库状态", e))?;
        Ok(())
    }

    /// 查询单个插件在某仓库的状态；不存在返回 `None`。
    pub fn get_plugin_repo_state(
        &self,
        plugin_id: &str,
        repo_id: &str,
    ) -> HpResult<Option<PluginRepoState>> {
        self.conn()
            .query_row(
                "SELECT plugin_id, repo_id, enabled, grants_json
                 FROM plugin_repo_state WHERE plugin_id = ?1 AND repo_id = ?2",
                params![plugin_id, repo_id],
                row_to_repo_state,
            )
            .optional()
            .map_err(|e| store_err("查询插件仓库状态", e))
    }

    /// 列出某仓库下全部插件状态。
    pub fn list_plugin_repo_states(&self, repo_id: &str) -> HpResult<Vec<PluginRepoState>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT plugin_id, repo_id, enabled, grants_json
                 FROM plugin_repo_state WHERE repo_id = ?1",
            )
            .map_err(|e| store_err("查询插件仓库状态列表", e))?;
        let rows = stmt
            .query_map(params![repo_id], row_to_repo_state)
            .map_err(|e| store_err("读取插件仓库状态列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析插件仓库状态列表", e))?;
        Ok(rows)
    }

    /// 插件在某仓库是否已启用。
    pub fn is_plugin_enabled(&self, plugin_id: &str, repo_id: &str) -> HpResult<bool> {
        let enabled: Option<i64> = self
            .conn()
            .query_row(
                "SELECT enabled FROM plugin_repo_state WHERE plugin_id = ?1 AND repo_id = ?2",
                params![plugin_id, repo_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| store_err("查询插件启用状态", e))?;
        Ok(enabled.unwrap_or(0) != 0)
    }

    /// 插入或更新 AI 提供方配置。
    pub fn upsert_ai_provider_config(&mut self, config: &AiProviderConfig) -> HpResult<()> {
        require_nonempty(config.id.as_str(), "提供方配置 ID")?;
        require_nonempty(&config.provider, "提供方名")?;
        self.conn()
            .execute(
                "INSERT INTO ai_provider_config (id, provider, model, config_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                     provider = excluded.provider,
                     model = excluded.model,
                     config_json = excluded.config_json",
                params![
                    config.id.as_str(),
                    config.provider,
                    config.model,
                    config.config_json,
                    config.created_at,
                ],
            )
            .map_err(|e| store_err("写入 AI 提供方配置", e))?;
        Ok(())
    }

    /// 按 ID 查询 AI 提供方配置；不存在返回 `None`。
    pub fn get_ai_provider_config(&self, id: &str) -> HpResult<Option<AiProviderConfig>> {
        self.conn()
            .query_row(
                "SELECT id, provider, model, config_json, created_at
                 FROM ai_provider_config WHERE id = ?1",
                params![id],
                row_to_ai_config,
            )
            .optional()
            .map_err(|e| store_err("查询 AI 提供方配置", e))
    }

    /// 列出全部 AI 提供方配置（按创建时间升序）。
    pub fn list_ai_provider_configs(&self) -> HpResult<Vec<AiProviderConfig>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, provider, model, config_json, created_at
                 FROM ai_provider_config ORDER BY created_at",
            )
            .map_err(|e| store_err("查询 AI 提供方配置列表", e))?;
        let rows = stmt
            .query_map([], row_to_ai_config)
            .map_err(|e| store_err("读取 AI 提供方配置列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析 AI 提供方配置列表", e))?;
        Ok(rows)
    }

    /// 删除 AI 提供方配置。
    pub fn remove_ai_provider_config(&mut self, id: &str) -> HpResult<()> {
        require_nonempty(id, "提供方配置 ID")?;
        let n = self
            .conn()
            .execute("DELETE FROM ai_provider_config WHERE id = ?1", params![id])
            .map_err(|e| store_err("删除 AI 提供方配置", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("AI 提供方配置不存在: {id}")));
        }
        Ok(())
    }

    /// 生成一个新的 AI 提供方配置并写入。
    pub fn create_ai_provider_config(
        &mut self,
        provider: &str,
        model: Option<&str>,
        config_json: &str,
    ) -> HpResult<AiProviderConfig> {
        require_nonempty(provider, "提供方名")?;
        require_nonempty(config_json, "提供方配置内容")?;
        let config = AiProviderConfig {
            id: AiProviderConfigId::generate(),
            provider: provider.to_string(),
            model: model.map(|m| m.to_string()),
            config_json: config_json.to_string(),
            created_at: now_iso(),
        };
        self.upsert_ai_provider_config(&config)?;
        Ok(config)
    }
}

fn grants_to_json(grants: &[Capability]) -> String {
    let names: Vec<&str> = grants.iter().map(|c| c.as_str()).collect();
    serde_json::to_string(&names).unwrap_or_else(|_| "[]".to_string())
}

fn grants_from_json(raw: &str) -> Vec<Capability> {
    serde_json::from_str::<Vec<String>>(raw)
        .map(|v| {
            v.iter()
                .filter_map(|s| Capability::from_str(s))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn row_to_plugin(row: &Row) -> rusqlite::Result<PluginRegistryRow> {
    let trust: String = row.get(3)?;
    let source_kind: String = row.get(4)?;
    let runtime: String = row.get(6)?;
    Ok(PluginRegistryRow {
        id: PluginId::from_raw(row.get::<_, String>(0)?),
        name: row.get(1)?,
        version: row.get(2)?,
        trust_level: TrustLevel::from_str(&trust).unwrap_or(TrustLevel::Community),
        source_kind: SourceKind::from_str(&source_kind).unwrap_or(SourceKind::LocalPath),
        source_ref: row.get(5)?,
        runtime_kind: RuntimeKind::from_str(&runtime).unwrap_or(RuntimeKind::ExternalProcess),
        installed_at: row.get(7)?,
        manifest_json: row.get(8)?,
    })
}

fn row_to_repo_state(row: &Row) -> rusqlite::Result<PluginRepoState> {
    let enabled: i64 = row.get(2)?;
    let grants_json: String = row.get(3)?;
    Ok(PluginRepoState {
        plugin_id: PluginId::from_raw(row.get::<_, String>(0)?),
        repo_id: RepoId::from_raw(row.get::<_, String>(1)?),
        enabled: enabled != 0,
        grants: grants_from_json(&grants_json),
    })
}

fn row_to_ai_config(row: &Row) -> rusqlite::Result<AiProviderConfig> {
    Ok(AiProviderConfig {
        id: AiProviderConfigId::from_raw(row.get::<_, String>(0)?),
        provider: row.get(1)?,
        model: row.get(2)?,
        config_json: row.get(3)?,
        created_at: row.get(4)?,
    })
}
