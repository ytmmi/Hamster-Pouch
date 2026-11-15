//! 分层规则（D51/D58/D60；D218 从 `blueprint_validate.rs` 拆出）。

use crate::blueprint::BlueprintGraph;
use crate::blueprint_types::NodeType;
use std::collections::HashSet;

/// 分层校验（D51/D58/D60）。
///
/// 规则：
/// - `layers` **非空**时才是"显式分层文档"：层 `key` 唯一非空、层 `name` 非空且蓝图内唯一、
///   每层至多一个 `interface`、节点 `layer` 必须存在（缺 `layer` 即硬错误）；
/// - `layers` 缺失/为空 → 按**单层文档**兜底（D51），只校验"每层至多一个 interface"
///   （此时所有界面节点同属该兜底层，两个以上即冲突，需显式分层）；
/// - 边的端点必须**同层**（跨层只允许 `navigate` 引用，而 `navigate` 是字段引用不是边）。
pub(crate) fn validate_layers(graph: &BlueprintGraph, errors: &mut Vec<String>) {
    let interface_keys: Vec<&str> = graph
        .nodes
        .iter()
        .filter(|n| n.node_type == NodeType::Interface)
        .map(|n| n.key.as_str())
        .collect();

    if graph.layers.is_empty() {
        // 单层兜底：所有界面节点同层 → 至多一个。
        if interface_keys.len() > 1 {
            errors.push(format!(
                "同层出现 {} 个界面节点（每层至多一个，D51）：请为每个界面建立独立层",
                interface_keys.len()
            ));
        }
        return;
    }

    let mut seen_keys: HashSet<&str> = HashSet::new();
    let mut seen_names: HashSet<&str> = HashSet::new();
    for layer in &graph.layers {
        if layer.key.trim().is_empty() {
            errors.push("存在空 key 的层".into());
            continue;
        }
        if !seen_keys.insert(layer.key.as_str()) {
            errors.push(format!("层 key 重复: {}", layer.key));
        }
        let name = layer.name.trim();
        if name.is_empty() {
            errors.push(format!("层 {} 的 name 不能为空", layer.key));
        } else if !seen_names.insert(name) {
            errors.push(format!("层名重复（层名在蓝图内唯一，D60）: {name}"));
        }

        let count = graph
            .nodes
            .iter()
            .filter(|n| {
                n.node_type == NodeType::Interface && n.layer.as_deref() == Some(layer.key.as_str())
            })
            .count();
        if count > 1 {
            errors.push(format!(
                "层 {} 至多一个界面节点（当前 {count} 个）",
                layer.key
            ));
        }
    }

    // 主界面标记（D67）：至多一个层可标记 `is_home`。
    let home_layers: Vec<&str> = graph
        .layers
        .iter()
        .filter(|l| l.is_home())
        .map(|l| l.key.as_str())
        .collect();
    if home_layers.len() > 1 {
        errors.push(format!(
            "主界面标记重复（D67）：{} 个层同时标记为主界面（同层至多一个），请只保留一个",
            home_layers.len()
        ));
    }

    // 节点 layer 必须存在；`layers` 存在而缺 layer = 硬错误（不静默压成单层）。
    for node in &graph.nodes {
        match node.layer.as_deref() {
            None => errors.push(format!(
                "节点 {} 缺少 layer（文档已分层，节点必须归属某一层，D51/D58）",
                node.key
            )),
            Some(k) if k.trim().is_empty() => errors.push(format!(
                "节点 {} 的 layer 不能为空（文档已分层，D51/D58）",
                node.key
            )),
            Some(k) if !seen_keys.contains(k) => {
                errors.push(format!("节点 {} 的 layer 指向不存在的层: {k}", node.key))
            }
            Some(_) => {}
        }
    }

    // 边的端点必须同层（跨层只允许 navigate 引用）。
    for edge in &graph.edges {
        let (Some(from), Some(to)) = (graph.node(&edge.from), graph.node(&edge.to)) else {
            continue; // 悬空边已单独报错
        };
        let (Some(from_layer), Some(to_layer)) = (from.layer.as_deref(), to.layer.as_deref())
        else {
            continue; // 缺 layer 已单独报错
        };
        if from_layer != to_layer {
            errors.push(format!(
                "跨层边: {}（{from_layer}）--{}--> {}（{to_layer}）：边端点必须同层，跨层只允许界面跳转",
                edge.from, edge.edge_kind, edge.to
            ));
        }
    }
}
