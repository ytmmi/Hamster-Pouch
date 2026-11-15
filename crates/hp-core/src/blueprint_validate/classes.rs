//! 类目挂在**无类目**面板下的冲突判定（RFC 0010 决策 4 / 面板标准 5.1、7.1；D218 拆出）。
//!
//! 分级按**声明者是否可变**：宿主内置面板 = 硬错误；插件注册面板 = 未接通软告警
//! （插件升级可能把 `has_class` 由 true 改成 false，不能把用户既有文档变成保存失败）。

use super::NodeIssue;

use crate::blueprint::BlueprintGraph;
use crate::blueprint_node::BlueprintNode;
use crate::blueprint_registry::{NodeRegistry, SeverityLevel};
use crate::blueprint_types::{EdgeKind, NodeType};
use std::collections::HashMap;

/// 面板声明（`has_class` / `overlay_content`）与文档结构冲突的判定。
///
/// 逐条对应面板标准第 7.1 节第 6/7 条：
/// 1. `has_class = false` 的面板下出现 `control --contains--> class`：**宿主内置**面板为
///    硬错误（宿主声明是不变量），**插件注册**面板为未接通软告警（声明随版本可变）；
/// 2. `mount.overlay_content = false` 的面板被浮层 `contains`：**硬错误**（与"浮层不得
///    contains 布局块"同级）。
///
/// 面板未注册（插件缺失）或 `panel_id` 缺失时无从判定，按「未接通」交给软告警层。
pub(super) fn find_panel_class_violations(
    graph: &BlueprintGraph,
    registry: &NodeRegistry,
    by_key: &HashMap<&str, &BlueprintNode>,
) -> Vec<NodeIssue> {
    let mut issues = Vec::new();
    for edge in &graph.edges {
        if edge.edge_kind != EdgeKind::Contains {
            continue;
        }
        let (Some(parent), Some(child)) =
            (by_key.get(edge.from.as_str()), by_key.get(edge.to.as_str()))
        else {
            continue;
        };

        // 1. 类目挂在无类目面板下。
        if parent.node_type == NodeType::Control
            && child.node_type == NodeType::Class
            && let Some(panel_id) = parent.panel_id.as_deref().filter(|s| !s.trim().is_empty())
            && let Some(fact) = registry.panel_fact(panel_id)
            && !fact.has_class
        {
            if fact.plugin {
                issues.push(NodeIssue {
                                message: format!(
                                    "类目节点 {} 暂未接通：面板 {} 声明 has_class = false（插件注册面板，声明可能随插件版本变化）",
                                    child.key, panel_id
                                ),
                                severity: SeverityLevel::Soft,
                            });
            } else {
                issues.push(NodeIssue::hard(format!(
                                "类目节点 {} 挂在无类目的面板 {} 下：宿主内置面板的 has_class = false 是不变量，不允许出现 面板→类目 的结构边",
                                child.key, panel_id
                            )));
            }
        }

        // 2. 浮层内容不合法：面板声明 `mount.overlay_content = false` 却被浮层 contains。
        if parent.node_type == NodeType::Overlay
            && child.node_type == NodeType::Control
            && let Some(panel_id) = child.panel_id.as_deref().filter(|s| !s.trim().is_empty())
            && let Some(fact) = registry.panel_fact(panel_id)
            && !fact.overlay_content
        {
            issues.push(NodeIssue::hard(format!(
                "面板 {} 声明 mount.overlay_content = false，不能作为浮层 {} 的内容",
                panel_id, parent.key
            )));
        }
    }
    issues
}

/// 类目所属面板的 `panel_id`（D135 分域判定的输入）。
///
/// 返回 `None` 的三种情形都要按**未接通**对待、**不**做分域判定：
/// `control` 字段为空、指向不存在的节点、指向的节点不是面板（后者已单独报硬错误）。
/// `control` 节点自身没填 `panel_id`（面板未接通）同样返回 `None`。
pub(super) fn class_owner_panel_id(
    node: &BlueprintNode,
    by_key: &HashMap<&str, &BlueprintNode>,
) -> Option<String> {
    let control_key = node.control.as_deref()?.trim();
    let control = by_key.get(control_key)?;
    if control.node_type != NodeType::Control {
        return None;
    }
    let panel_id = control.panel_id.as_deref()?.trim();
    if panel_id.is_empty() {
        return None;
    }
    Some(panel_id.to_string())
}
