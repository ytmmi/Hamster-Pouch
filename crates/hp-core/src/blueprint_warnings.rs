//! 蓝图**未接通软告警**（RFC 0007 决策 6 / D48 / D50 / D55）。
//!
//! 软告警 = **不阻塞保存**的"暂时接不通"提示：必填引用缺失或指向已删除节点、
//! 求值链缺触发来源、无根层（D55）、跳转失效（D55）、浮层未连接到界面（D50 修订）。
//!
//! 设计意图：删除节点/断线后**不级联删除关联节点**，允许先保存中间状态；
//! 不生效的部分由画布灰色呈现，用户接回去即恢复。
//! 与之相对，**硬错误**（拒绝保存）在 `blueprint_validate.rs`，
//! 二者口径必须一致：凡"引用存在但类型不符"一律是硬错误，不算未接通。

use std::collections::HashMap;

use crate::blueprint::{BlueprintGraph, OVERLAY_MIN_HEIGHT, OVERLAY_MIN_WIDTH};
use crate::blueprint_node::BlueprintNode;
use crate::blueprint_types::{ActionOp, EdgeKind, NodeType};

/// 收集全部未接通软告警（空 = 无告警）。
pub(crate) fn collect(graph: &BlueprintGraph) -> Vec<String> {
    let by_key: HashMap<&str, &BlueprintNode> =
        graph.nodes.iter().map(|n| (n.key.as_str(), n)).collect();
    let mut warnings = Vec::new();

    // 无根层（D55）：显式分层的文档里某层没有界面节点 → 该层不可显示、跳转失效。
    if graph.has_layers() {
        for layer in &graph.layers {
            if graph.interface_of_layer(&layer.key).is_none() {
                warnings.push(format!(
                    "层 {name}（{key}）暂未接通：该层没有界面节点（无根层），指向它的界面跳转不会执行",
                    name = layer.name,
                    key = layer.key
                ));
            }
        }
    }

    for node in &graph.nodes {
        match node.node_type {
            NodeType::Event => {
                let has_target = node.target.is_some();
                let has_on_edge = graph
                    .edges
                    .iter()
                    .any(|e| e.edge_kind == EdgeKind::On && e.to == node.key);
                if !has_target && !has_on_edge {
                    warnings.push(format!(
                        "操作节点 {key} 暂未接通：缺对象来源（连线 对象→操作）",
                        key = node.key
                    ));
                }
            }
            NodeType::Condition => {
                let has_source = graph
                    .edges
                    .iter()
                    .any(|e| e.edge_kind == EdgeKind::Fires && e.to == node.key);
                if !has_source {
                    warnings.push(format!(
                        "条件节点 {key} 暂未接通：缺触发来源（连线 操作→条件）",
                        key = node.key
                    ));
                }
            }
            NodeType::Action => {
                let has_trigger = graph.edges.iter().any(|e| {
                    e.to == node.key
                        && (e.edge_kind == EdgeKind::Fires || e.edge_kind == EdgeKind::Guards)
                });
                if !has_trigger {
                    warnings.push(format!(
                        "状态节点 {key} 暂未接通：缺触发来源（连线 操作/条件→状态）",
                        key = node.key
                    ));
                }
            }
            NodeType::Overlay => {
                // 浮层是容器：内容是**面板控件/标签组**（由 contains 边表达），
                // 因此不再有"未绑定浮动控件"这类软告警（2026-09 取消浮动控件概念）；
                // 浮层没有子节点也只是"空浮层"，仍可保存。
                //
                // **未连接到界面 = 未接通**：界面的直接子级才有"属于本页"的含义，
                // 断开 `界面 --contains--> 浮层` 后该浮层不应再显示（运行时同样按此判定）。
                let attached = graph.edges.iter().any(|e| {
                    e.edge_kind == EdgeKind::Contains
                        && e.to == node.key
                        && graph
                            .node(&e.from)
                            .map(|n| n.node_type == NodeType::Interface)
                            .unwrap_or(false)
                });
                if !attached {
                    warnings.push(format!(
                        "浮层节点 {key} 暂未接通：未连接到界面（连线 界面→浮层）",
                        key = node.key
                    ));
                }
                // 尺寸小于最小尺寸 → 只是被夹紧，提示一下即可（不阻塞保存）。
                if let Some(size) = &node.size {
                    if size.below_minimum() {
                        warnings.push(format!(
                            "浮层 {key} 的尺寸小于最小尺寸（{OVERLAY_MIN_WIDTH}×{OVERLAY_MIN_HEIGHT}），将按最小尺寸显示",
                            key = node.key
                        ));
                    }
                }
            }
            _ => {}
        }

        let missing_ref = match node.node_type {
            NodeType::Control => node.panel_id.as_deref().unwrap_or("").trim().is_empty(),
            NodeType::Class => match node.control.as_deref() {
                Some(ck) => !by_key.contains_key(ck),
                None => true,
            },
            NodeType::Object => match node.class.as_deref() {
                Some(ck) => !by_key.contains_key(ck),
                None => true,
            },
            NodeType::Action => match node.target.as_deref() {
                // 界面跳转的目标是界面节点；指向已删除界面属未接通（软告警，D48/D55）。
                Some(t) if node.op == Some(ActionOp::Navigate) => !matches!(
                    by_key.get(t).map(|n| n.node_type),
                    Some(NodeType::Interface)
                ),
                Some(t) => !by_key.contains_key(t),
                None => true,
            },
            _ => false,
        };
        if missing_ref {
            warnings.push(format!(
                "节点 {key} 暂未接通：缺少必要引用或引用已被删除",
                key = node.key
            ));
        }
    }
    warnings
}
