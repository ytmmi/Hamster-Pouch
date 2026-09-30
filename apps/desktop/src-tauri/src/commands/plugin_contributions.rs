//! 插件**贡献点注册视图**命令桥接：`plugin.contributions`（RFC 0010 决策 3/4/5/7）。
//!
//! 把某个仓库当前**已启用**插件声明的面板 / 蓝图节点类型 / 设置分节发给前端，由前端登记
//! 进三张注册表。注册项**不落库**：宿主按当前安装与启用状态实时构造。
//!
//! 「扩展」菜单的目录通道（含无面板的数据扩展）是另一条口径，见 `plugin_catalog.rs`。

use hp_core::HpResult;
use hp_plugin_host::PluginHost;
use serde::Serialize;
use tauri::State;

use crate::commands::shared::{api_from_hp, ensure_global, global, lock_global, ApiResponse};
use crate::AppState;

/// 面板贡献项（前端登记进面板注册表）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelContributionItem {
    plugin_id: String,
    id: String,
    title_key: String,
    category: String,
    has_class: bool,
    blueprint_node: String,
    settings: Vec<hp_core::PanelSettingDecl>,
    read_only: bool,
    mount: hp_core::PanelMount,
}

/// 设置分节贡献项（前端登记进设置注册表）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsSectionItem {
    plugin_id: String,
    title_key: String,
    category: String,
    settings: Vec<hp_core::PanelSettingDecl>,
}

/// 蓝图节点类型贡献项（前端登记进节点类型注册表）。
///
/// `plugin_id` 与声明字段**平铺**：前端拿到的每一项都是一份可直接登记的纯声明
/// （`type` 已是 `plugin.<plugin_id>.<local_id>`）。
#[derive(Serialize)]
pub(crate) struct NodeContributionItem {
    plugin_id: String,
    #[serde(flatten)]
    node: hp_core::BlueprintNodeDecl,
}

/// 三张注册表的插件注册视图。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginContributions {
    panels: Vec<PanelContributionItem>,
    /// 蓝图节点类型声明（`type` 已由宿主校验为 `plugin.<plugin_id>.<local_id>`）。
    node_types: Vec<NodeContributionItem>,
    settings_sections: Vec<SettingsSectionItem>,
}

/// plugin.contributions：某仓库当前**已启用**插件注册的面板 / 蓝图节点类型 / 设置分节
/// （RFC 0010 决策 3/4/5/7）。
///
/// 注册项**不落库**：宿主按当前安装与启用状态实时构造，前端据此登记到三张注册表。
/// 插件未安装 / 未启用 / 宿主 API 不兼容时，其注册项**缺席**——蓝图侧对这类
/// `type` / `panel_id` 按「未接通」处理（软告警 + 灰显 + 允许保存 + 恢复后自动恢复），
/// 见 `docs/spec/panel-standard.md` 第 7.2 节与 RFC 0010 决策 6。
#[tauri::command]
pub(crate) fn plugin_contributions(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<PluginContributions> {
    let outcome = (|| -> HpResult<PluginContributions> {
        ensure_global(&state, &app)?;
        let entries = {
            let guard = lock_global(&state)?;
            let g = global(&guard)?;
            PluginHost.repo_contributions(g, &repo_id)?
        };

        let mut panels = Vec::new();
        let mut node_types = Vec::new();
        let mut settings_sections = Vec::new();
        for entry in entries {
            if let Some(panel) = entry.panel {
                panels.push(PanelContributionItem {
                    plugin_id: entry.plugin_id.clone(),
                    id: panel.id.clone(),
                    title_key: panel.title_key.clone().unwrap_or_default(),
                    category: panel.category.clone().unwrap_or_else(|| "other".into()),
                    has_class: panel.has_class.unwrap_or(false),
                    blueprint_node: panel.blueprint_node.clone().unwrap_or_default(),
                    settings: panel.settings.clone(),
                    read_only: panel.resolved_read_only(),
                    mount: panel.mount.unwrap_or_default(),
                });
            }
            if let Some(node) = entry.node {
                node_types.push(NodeContributionItem {
                    plugin_id: entry.plugin_id.clone(),
                    node,
                });
            }
            if let Some(section) = entry.settings_section {
                settings_sections.push(SettingsSectionItem {
                    plugin_id: entry.plugin_id.clone(),
                    title_key: section.title_key,
                    category: section.category,
                    settings: section.settings,
                });
            }
        }
        Ok(PluginContributions {
            panels,
            node_types,
            settings_sections,
        })
    })();
    api_from_hp(outcome)
}
