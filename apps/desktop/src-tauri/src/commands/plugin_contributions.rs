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

use crate::AppState;
use crate::commands::shared::{ApiResponse, api_from_hp, global, global_guard};

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
#[serde(rename_all = "camelCase")]
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
) -> ApiResponse<PluginContributions> {
    let outcome = (|| -> HpResult<PluginContributions> {
        let entries = {
            let guard = global_guard(&state)?;
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

#[cfg(test)]
mod wire_shape_tests {
    //! 缺陷 0042 的同族钉子（D221）：`plugin.contributions` 是**桥接层视图**，顶层三项
    //! 与每项的字段必须是驼峰（`pluginId` / `titleKey` / `nodeTypes` / `settingsSections`）；
    //! 内嵌的插件声明（`settings[]` / `mount` / 节点声明的 `label_key`）保持 manifest 的
    //! 蛇形。真机症状：前端按驼峰读，结构体漏了 `rename_all` 时
    //! `contributions.node_types.map(...)` 抛 TypeError，整批插件注册一次都不生效。

    use super::*;
    use hp_core::{BlueprintNodeDecl, NodeFieldDecl, PanelMount, PanelSettingDecl};

    fn setting() -> PanelSettingDecl {
        PanelSettingDecl {
            key: "grid_size".into(),
            kind: "numberInput".into(),
            title_key: "palette.gridSize".into(),
            default: None,
            scope: None,
            requires_capability: None,
        }
    }

    fn contributions() -> PluginContributions {
        PluginContributions {
            panels: vec![PanelContributionItem {
                plugin_id: "dev.hamsterpouch.palette".into(),
                id: "plugin.dev.hamsterpouch.palette.palette".into(),
                title_key: "panel.palette".into(),
                category: "system".into(),
                has_class: false,
                blueprint_node: "control".into(),
                settings: vec![setting()],
                read_only: true,
                mount: PanelMount::default(),
            }],
            node_types: vec![NodeContributionItem {
                plugin_id: "dev.hamsterpouch.palette".into(),
                node: BlueprintNodeDecl {
                    node_type: "plugin.dev.hamsterpouch.palette.swatch".into(),
                    label_key: "palette.node.swatch".into(),
                    role: "structural".into(),
                    name_from_layer: false,
                    provides_name: true,
                    fields: vec![NodeFieldDecl {
                        name: "name".into(),
                        field_type: "string".into(),
                        required: false,
                        soft_when_missing: true,
                        values: vec![],
                    }],
                    parents: vec![],
                    children: vec![],
                    events: vec![],
                    ports: vec![],
                    severity: None,
                    evaluation_role: None,
                },
            }],
            settings_sections: vec![SettingsSectionItem {
                plugin_id: "dev.hamsterpouch.palette".into(),
                title_key: "palette.settings.title".into(),
                category: "plugin".into(),
                settings: vec![setting()],
            }],
        }
    }

    fn keys(value: &serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> = value
            .as_object()
            .expect("返回体应是对象")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    #[test]
    fn contributions_view_serializes_camel_case_keys() {
        let json = serde_json::to_value(contributions()).expect("序列化应成功");

        assert_eq!(
            keys(&json),
            vec!["nodeTypes", "panels", "settingsSections"],
            "顶层三项必须是驼峰：{json:?}"
        );

        let panel = &json["panels"][0];
        let panel_keys = keys(panel);
        for expected in [
            "blueprintNode",
            "hasClass",
            "pluginId",
            "readOnly",
            "titleKey",
        ] {
            assert!(
                panel_keys.iter().any(|k| k == expected),
                "面板项缺少驼峰键 {expected}：{panel_keys:?}"
            );
        }
        assert!(
            !panel_keys.iter().any(|k| k == "plugin_id"),
            "不得再出蛇形键"
        );
        // `mount` 是 manifest 形状，刻意保持蛇形（`docs/spec/panel-standard.md` 5.4）。
        assert!(
            keys(&panel["mount"]).iter().any(|k| k == "overlay_content"),
            "mount 三项沿用 manifest 的蛇形名"
        );

        let node = &json["nodeTypes"][0];
        let node_keys = keys(node);
        assert!(
            node_keys.iter().any(|k| k == "pluginId"),
            "节点项缺 pluginId：{node_keys:?}"
        );
        assert!(node_keys.iter().any(|k| k == "type"), "节点项缺 type");
        assert!(
            node_keys.iter().any(|k| k == "label_key"),
            "节点声明的 label_key 沿用 manifest 的蛇形名"
        );
        assert!(
            keys(&node["fields"][0])
                .iter()
                .any(|k| k == "softWhenMissing"),
            "fields[].softWhenMissing 是逐字段 rename 的驼峰"
        );

        let section = &json["settingsSections"][0];
        let section_keys = keys(section);
        assert!(section_keys.iter().any(|k| k == "pluginId"));
        assert!(section_keys.iter().any(|k| k == "titleKey"));
        assert!(section_keys.iter().any(|k| k == "settings"));
    }
}
