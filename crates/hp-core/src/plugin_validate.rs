//! 插件清单**校验**：结构校验、贡献点完备性、贡献点与声明的取值域校验
//! （RFC 0004「运行形态边界」/ `docs/spec/plugin-standard.md` 第 6 节）。
//!
//! 本文件只实现 [`PluginManifest`] 的校验方法与其**校验上下文**构建；清单结构本身在
//! [`crate::plugin`]（与蓝图域 `blueprint.rs` / `blueprint_validate.rs` 同口径拆分：
//! **拆的是文件，不是职责**——清单结构一处、校验规则一处）。
//!
//! 纯数据 + 纯函数：不依赖 Tauri/SQLite/文件系统。

use crate::blueprint_registry::validate_node_decl;
use crate::error::{HpError, HpResult};
use crate::panel_types::{
    validate_panel_decl, PanelCategory, PanelDeclCtx, PanelSettingKind, PanelSettingScope,
};
use crate::plugin::PluginManifest;
use crate::plugin_contribution::{ContributionKind, DataQueryReturns};
use crate::plugin_types::{Capability, HostApiVersion, RuntimeKind, HOST_API_VERSION};
use crate::setting_types::{validate_setting_decl, SettingCategory, SettingDecl};

impl PluginManifest {
    /// 宿主校验规则（RFC 0004「运行形态边界」/ `docs/spec/plugin-standard.md` 第 6 节）。
    ///
    /// = [`PluginManifest::validate_structure`] + 贡献点**完备性**（`title_key` 等必填项）。
    /// 安装/加载路径用本方法；解析路径用 `validate_structure`（允许读旧包）。
    pub fn validate(&self) -> HpResult<()> {
        self.validate_structure()?;
        self.validate_contribution_completeness()?;
        Ok(())
    }

    /// 结构校验：字段非空、运行形态与信任/能力匹配、宿主 API 版本兼容、
    /// 贡献点 id 与声明名合法。
    pub fn validate_structure(&self) -> HpResult<()> {
        if self.id.as_str().trim().is_empty() {
            return Err(HpError::InvalidArgument("插件 ID 不能为空".into()));
        }
        if self.name.trim().is_empty() {
            return Err(HpError::InvalidArgument("插件名不能为空".into()));
        }
        if self.version.trim().is_empty() {
            return Err(HpError::InvalidArgument("插件版本不能为空".into()));
        }
        // `entry` 非空校验**不适用于 StaticData**（纯数据包）。
        // 解析层（`hp-plugin-host` 的 `parse_manifest`）对 StaticData 显式把 entry
        // 置为空串（「StaticData 形态不需要 entry」），若这里仍要求非空，则**所有
        // 纯数据扩展包都会在校验阶段被拒**——这正是 tag 词典/关系扩展「装不上」的
        // 根因。纯数据包由宿主直接读取数据文件，没有可执行入口。
        if self.runtime_kind != RuntimeKind::StaticData && self.entry.trim().is_empty() {
            return Err(HpError::InvalidArgument("插件入口不能为空".into()));
        }
        if self.api_version == 0 {
            return Err(HpError::InvalidArgument("插件 api_version 必须 >= 1".into()));
        }
        if self.runtime_kind == RuntimeKind::DynamicLibrary {
            if !self.capabilities.contains(&Capability::NativeCode) {
                return Err(HpError::InvalidArgument(
                    "动态库插件必须声明 native.code 能力".into(),
                ));
            }
            if !self.trust_requested.allows_dynamic_library() {
                return Err(HpError::InvalidArgument(
                    "动态库仅 system/trusted 信任等级可用".into(),
                ));
            }
        }
        if !HostApiVersion::current().is_compatible(self.min_host_version) {
            return Err(HpError::InvalidArgument(format!(
                "插件要求宿主 API 版本 >= {}，当前为 {}",
                self.min_host_version, HOST_API_VERSION
            )));
        }
        self.validate_contributions()?;
        self.validate_declarations()?;
        Ok(())
    }

    /// 贡献点完备性：标准化后新增的必填项（如面板/命令的 `title_key`）。
    ///
    /// 单独成方法的原因：解析层要能读**标准化之前**发布的旧包（那时贡献点是字符串数组、
    /// 没有 `title_key`），但安装/加载必须拒绝不完备的贡献点。
    pub fn validate_contribution_completeness(&self) -> HpResult<()> {
        for c in &self.contributions {
            if matches!(
                c.kind,
                ContributionKind::Panel | ContributionKind::Command | ContributionKind::MetadataField
            ) && c.title_key.as_deref().unwrap_or("").trim().is_empty()
            {
                return Err(HpError::InvalidArgument(format!(
                    "贡献点 {} / {} 缺少 title_key（D27：系统文字必须走 i18n）",
                    c.kind, c.id
                )));
            }
            // 面板：命名空间 + 完整声明参数（`docs/spec/panel-standard.md` 第 4、7.1 节）。
            if c.kind == ContributionKind::Panel {
                let decl = c.panel_decl(Some(self.id.as_str()));
                let errors = validate_panel_decl(&decl, &self.panel_decl_ctx());
                if let Some(first) = errors.first() {
                    return Err(HpError::InvalidArgument(format!(
                        "面板贡献点 {}/{} 声明不合规（共 {} 项）: {first}",
                        c.kind,
                        c.id,
                        errors.len()
                    )));
                }
            }
            // 蓝图节点类型：命名空间（id 与 type 双份）+ 纯声明校验（决策 5/6）。
            if c.kind == ContributionKind::BlueprintNode {
                if !crate::namespace::is_id_in_plugin_namespace(&c.id, self.id.as_str()) {
                    return Err(HpError::InvalidArgument(format!(
                        "蓝图节点贡献点 id 必须是 plugin.{}.<local_id> 形式: {}",
                        self.id, c.id
                    )));
                }
                let Some(decl) = c.node.as_ref() else {
                    return Err(HpError::InvalidArgument(format!(
                        "蓝图节点贡献点 {} 缺少 type/role/fields 等声明参数",
                        c.id
                    )));
                };
                let errors = validate_node_decl(decl, Some(self.id.as_str()), &self.node_decl_ctx());
                if let Some(first) = errors.first() {
                    return Err(HpError::InvalidArgument(format!(
                        "蓝图节点贡献点 {} 声明不合规（共 {} 项）: {first}",
                        c.id,
                        errors.len()
                    )));
                }
            }
            // 设置分节：只能归入既有大类，且设置项形状与设置标准一致（决策 7）。
            if c.kind == ContributionKind::SettingsSection {
                if c.title_key.as_deref().unwrap_or("").trim().is_empty() {
                    return Err(HpError::InvalidArgument(format!(
                        "设置分节 {} 缺少 title_key（D27）",
                        c.id
                    )));
                }
                let category = c.category.as_deref().unwrap_or("");
                if SettingCategory::from_str(category).is_none() {
                    return Err(HpError::InvalidArgument(format!(
                        "设置分节 {} 的 category 不在五大大类内: {category}（插件不能新增或改名大类）",
                        c.id
                    )));
                }
                let mut seen_keys: Vec<String> = Vec::new();
                for (index, setting) in c.settings.iter().enumerate() {
                    let decl = SettingDecl {
                        id: setting.key.clone(),
                        category: c.category.clone(),
                        owner_kind: Some("plugin".to_string()),
                        owner_id: Some(self.id.as_str().to_string()),
                        title_key: Some(setting.title_key.clone()),
                        kind: Some(setting.kind.clone()),
                        default: setting.default.clone(),
                        scope: setting.scope.clone(),
                        requires_capability: setting.requires_capability.clone(),
                        keywords: Vec::new(),
                        section_key: None,
                    };
                    let mut ctx = self.setting_decl_ctx();
                    ctx.taken_keys = seen_keys.clone();
                    let errors = validate_setting_decl(&decl, &ctx);
                    if let Some(first) = errors.first() {
                        return Err(HpError::InvalidArgument(format!(
                            "设置分节 {} 的第 {} 项设置不合规: {first}",
                            c.id,
                            index + 1
                        )));
                    }
                    seen_keys.push(decl.storage_key());
                }
            }
        }
        Ok(())
    }

    /// 面板声明校验上下文：宿主内置节点类型 + **本 manifest 声明**的插件节点类型。
    ///
    /// 插件注册的节点类型可以在同一份 manifest 里被面板的 `blueprint_node` 引用，
    /// 因此"已注册"必须把本包自己的注册项算进去（RFC 0010 决策 5）。
    pub fn panel_decl_ctx(&self) -> PanelDeclCtx {
        let mut ctx = PanelDeclCtx::builtin();
        for c in &self.contributions {
            if c.kind == ContributionKind::BlueprintNode {
                if let Some(ty) = c.blueprint_node_type() {
                    ctx.registered_node_types.push(ty.to_string());
                }
            }
        }
        ctx
    }

    /// 蓝图节点声明校验上下文：宿主内置节点类型 + 本 manifest 自己声明的节点类型。
    pub fn node_decl_ctx(&self) -> crate::blueprint_registry::NodeDeclCtx {
        let mut ctx = crate::blueprint_registry::NodeDeclCtx::builtin();
        for c in &self.contributions {
            if c.kind == ContributionKind::BlueprintNode {
                if let Some(ty) = c.blueprint_node_type() {
                    ctx.registered_node_types.push(ty.to_string());
                }
            }
        }
        ctx
    }

    /// 设置项校验上下文：能力白名单 + 本插件 id（同名 id 冲突由调用方逐项累积判定）。
    pub fn setting_decl_ctx(&self) -> crate::setting_types::SettingDeclCtx {
        let mut ctx = crate::setting_types::SettingDeclCtx::permissive();
        ctx.registered_plugins.push(self.id.as_str().to_string());
        ctx
    }

    /// 贡献点校验（id 规则、重复、类型专属取值域、能力要求）。
    fn validate_contributions(&self) -> HpResult<()> {
        let mut seen: Vec<(ContributionKind, &str)> = Vec::new();
        for c in &self.contributions {
            if !c.has_valid_id() {
                return Err(HpError::InvalidArgument(format!(
                    "贡献点 id 非法: {:?}（要求 ^[a-z][a-z0-9._-]{{0,63}}$）",
                    c.id
                )));
            }
            if seen.iter().any(|(k, id)| *k == c.kind && *id == c.id.as_str()) {
                return Err(HpError::InvalidArgument(format!(
                    "贡献点重复: {} / {}",
                    c.kind, c.id
                )));
            }
            seen.push((c.kind, c.id.as_str()));

            if matches!(c.kind, ContributionKind::Viewer | ContributionKind::MetadataField)
                && !matches!(c.media_type.as_deref(), Some("image" | "video" | "audio"))
            {
                return Err(HpError::InvalidArgument(format!(
                    "贡献点 {} / {} 缺少合法 media_type（image/video/audio）",
                    c.kind, c.id
                )));
            }
            if c.kind == ContributionKind::DataQuery
                && DataQueryReturns::from_str(c.returns.as_deref().unwrap_or("")).is_none()
            {
                return Err(HpError::InvalidArgument(format!(
                    "贡献点 dataQuery / {} 的 returns 必须是 rows/object/scalar",
                    c.id
                )));
            }
            // 面板 / 设置分节：**已给出**的取值域立即硬错误（歧义即拒绝，不静默降级）。
            // "必需项缺失"留给完备性校验：旧包必须在解析层读得出来。
            if c.kind == ContributionKind::Panel {
                if let Some(category) = c.category.as_deref() {
                    if PanelCategory::from_str(category).is_none() {
                        return Err(HpError::InvalidArgument(format!(
                            "面板贡献点 {} 的 category 非法: {category}（允许 source/media/info/system/other）",
                            c.id
                        )));
                    }
                }
                for cap in &c.capabilities {
                    if Capability::from_str(cap).is_none() {
                        return Err(HpError::InvalidArgument(format!(
                            "面板贡献点 {} 声明了未知能力: {cap}",
                            c.id
                        )));
                    }
                }
            }
            if matches!(
                c.kind,
                ContributionKind::Panel | ContributionKind::SettingsSection
            ) {
                for setting in &c.settings {
                    if PanelSettingKind::from_str(&setting.kind).is_none() {
                        return Err(HpError::InvalidArgument(format!(
                            "贡献点 {} / {} 的设置项 {} 的 kind 不是输入类控件: {}",
                            c.kind, c.id, setting.key, setting.kind
                        )));
                    }
                    if let Some(cap) = setting.requires_capability.as_deref() {
                        if Capability::from_str(cap).is_none() {
                            return Err(HpError::InvalidArgument(format!(
                                "贡献点 {} / {} 的设置项 {} 声明了未知能力: {cap}",
                                c.kind, c.id, setting.key
                            )));
                        }
                    }
                    if PanelSettingScope::from_str(setting.scope.as_deref().unwrap_or("app")).is_none()
                    {
                        return Err(HpError::InvalidArgument(format!(
                            "贡献点 {} / {} 的设置项 {} 的 scope 非法: {:?}",
                            c.kind,
                            c.id,
                            setting.key,
                            setting.scope
                        )));
                    }
                }
            }
            if c.kind == ContributionKind::SettingsSection {
                if let Some(category) = c.category.as_deref() {
                    if SettingCategory::from_str(category).is_none() {
                        return Err(HpError::InvalidArgument(format!(
                            "设置分节 {} 的 category 不在五大大类内: {category}",
                            c.id
                        )));
                    }
                }
            }
            if let Some(required) = c.required_capability() {
                if let Some(cap) = Capability::from_str(required) {
                    if !self.capabilities.contains(&cap) {
                        return Err(HpError::InvalidArgument(format!(
                            "贡献点 {} / {} 需要能力 {required}，manifest 未声明",
                            c.kind, c.id
                        )));
                    }
                }
            }
        }
        Ok(())
    }

    /// 声明校验：数据查询名/事件 id 合法且不重复，`returns` 在取值域内。
    fn validate_declarations(&self) -> HpResult<()> {
        let mut names: Vec<&str> = Vec::new();
        for q in &self.data_queries {
            if !crate::plugin_contribution::is_valid_contribution_id(&q.name) {
                return Err(HpError::InvalidArgument(format!("数据查询名非法: {:?}", q.name)));
            }
            if names.contains(&q.name.as_str()) {
                return Err(HpError::InvalidArgument(format!("数据查询名重复: {}", q.name)));
            }
            names.push(q.name.as_str());
            if DataQueryReturns::from_str(&q.returns).is_none() {
                return Err(HpError::InvalidArgument(format!(
                    "数据查询 {} 的 returns 必须是 rows/object/scalar",
                    q.name
                )));
            }
        }
        let mut ids: Vec<&str> = Vec::new();
        for e in &self.events {
            if !crate::plugin_contribution::is_valid_contribution_id(&e.id) {
                return Err(HpError::InvalidArgument(format!("事件 id 非法: {:?}", e.id)));
            }
            if ids.contains(&e.id.as_str()) {
                return Err(HpError::InvalidArgument(format!("事件 id 重复: {}", e.id)));
            }
            ids.push(e.id.as_str());
        }
        Ok(())
    }
}
