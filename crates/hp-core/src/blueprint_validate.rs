//! 蓝图语义校验算法（RFC 0007 决策 6 / D28-D60）。
//!
//! 只承载**硬错误**（拒绝保存）的判定：节点字段、引用类型、边端点类型、求值链成环、
//! 分层规则。数据模型在 `blueprint.rs`，未接通类**软告警**在 `BlueprintGraph::warnings`。

use std::collections::{HashMap, HashSet};

use crate::blueprint::{
    ActionOp, BlueprintEdge, BlueprintGraph, BlueprintNode, EdgeKind, NodeType,
    OVERLAY_HEIGHT_MAX, OVERLAY_HEIGHT_MIN,
};

/// 校验单个节点字段与引用（硬错误）。
pub(crate) fn validate_node(
    node: &BlueprintNode,
    by_key: &HashMap<&str, &BlueprintNode>,
    errors: &mut Vec<String>,
) {
    let key = &node.key;
    match node.node_type {
        NodeType::Interface => {
            // 界面（页面）：结构节点，仅要求 key 非空（position 可选）。
            // 显示名取自层名（D51），界面节点不再另存 name。
            // 可有多个界面，但**每层至多一个**（多页面 = 多层，见 validate_layers）。
        }
        NodeType::LayoutBlock => {
            // 布局块：结构节点，仅要求 key 非空（name/position 可选）。
        }
        NodeType::Overlay => {
            // 浮层（D50/D56/D57）：叶子节点，只承载浮动控件的显隐与叠放。
            // control_id 缺失/指向不存在的 schema → 未接通（软告警），不阻塞保存。
            if let Some(h) = node.height {
                if !(OVERLAY_HEIGHT_MIN..=OVERLAY_HEIGHT_MAX).contains(&h) {
                    errors.push(format!(
                        "浮层节点 {key} 的 height 必须在 {OVERLAY_HEIGHT_MIN}-{OVERLAY_HEIGHT_MAX}（当前: {h}）"
                    ));
                }
            }
        }
        NodeType::Control => {
            // panel_id 缺失 → 未接通（软），不阻塞保存。
        }
        NodeType::Class => {
            // control 缺失/指向已删除节点 → 未接通（软）；指向存在但类型不符 → 硬错误。
            if let Some(ck) = node.control.as_deref() {
                if let Some(target) = by_key.get(ck) {
                    if target.node_type != NodeType::Control {
                        errors.push(format!(
                            "类节点 {key} 的 control 必须指向面板控件节点（当前指向 {}）",
                            target.node_type
                        ));
                    }
                }
            }
            match node.media_type.as_deref() {
                Some("image") | Some("video") | Some("audio") => {}
                _ => errors.push(format!(
                    "类节点 {key} 的 media_type 必须是 image/video/audio（当前: {}）",
                    node.media_type.as_deref().unwrap_or("")
                )),
            }
        }
        NodeType::Object => {
            if let Some(class_key) = node.class.as_deref() {
                if let Some(target) = by_key.get(class_key) {
                    if target.node_type != NodeType::Class {
                        errors.push(format!(
                            "对象节点 {key} 的 class 必须指向类节点（当前指向 {}）",
                            target.node_type
                        ));
                    }
                }
            }
            if node.scope.as_deref().unwrap_or("").trim().is_empty() {
                errors.push(format!("对象节点 {key} 缺少 scope"));
            }
        }
        NodeType::Group => {
            if node.mode.is_none() {
                errors.push(format!("组节点 {key} 缺少 mode"));
            }
            if let Some(visible) = &node.default_visible {
                for vk in visible {
                    if let Some(target) = by_key.get(vk.as_str()) {
                        if target.node_type != NodeType::Control {
                            errors.push(format!(
                                "组节点 {key} 的 default_visible 成员 {vk} 必须是面板控件节点"
                            ));
                        }
                    }
                }
            }
            if let Some(dir) = &node.hide_direction {
                if let Some(target_key) = dir.toward_target() {
                    if let Some(target) = by_key.get(target_key) {
                        if target.node_type != NodeType::Group {
                            errors.push(format!(
                                "组节点 {key} 的 hide_direction 指向的 {target_key} 必须是组节点"
                            ));
                        }
                    }
                }
            }
        }
        NodeType::Event => {
            if node.trigger.is_none() {
                errors.push(format!("操作节点 {key} 缺少 trigger"));
            }
            if let Some(t) = node.target.as_deref() {
                if let Some(target) = by_key.get(t) {
                    if !matches!(
                        target.node_type,
                        NodeType::Control | NodeType::Class | NodeType::Object
                    ) {
                        errors.push(format!(
                            "操作节点 {key} 的 target 必须指向面板控件/类/对象节点（当前指向 {}）",
                            target.node_type
                        ));
                    }
                }
            }
        }
        NodeType::Condition => {
            if let Some(expr) = &node.expr {
                if let Some(msg) = validate_expr(expr) {
                    errors.push(format!("条件节点 {key}: {msg}"));
                }
            } else {
                errors.push(format!("条件节点 {key} 缺少 expr"));
            }
        }
        NodeType::Action => {
            let op = node.op;
            if op.is_none() {
                errors.push(format!("动作节点 {key} 缺少 op"));
            }
            if let Some(target_key) = node.target.as_deref() {
                if let Some(target) = by_key.get(target_key) {
                    let actual = target.node_type;
                    let ok = match op {
                        // 显隐：面板控件，或浮层（D50：show/hide/toggle 可指向浮层）。
                        Some(ActionOp::Show) | Some(ActionOp::Hide) => {
                            matches!(actual, NodeType::Control | NodeType::Overlay)
                        }
                        // 组收起/展开：只允许标签组；指向浮层为硬错误（D50）。
                        Some(ActionOp::Collapse) | Some(ActionOp::Expand) => {
                            actual == NodeType::Group
                        }
                        Some(ActionOp::Toggle) => {
                            matches!(
                                actual,
                                NodeType::Control | NodeType::Group | NodeType::Overlay
                            )
                        }
                        // 界面跳转：目标必须是界面节点（D48）；指向浮层为硬错误（D50）。
                        Some(ActionOp::Navigate) => actual == NodeType::Interface,
                        None => true,
                    };
                    if !ok {
                        errors.push(format!(
                            "动作节点 {key} 的 target 类型不符：{} 不能指向 {}",
                            op.map(|o| o.as_str()).unwrap_or("?"),
                            actual
                        ));
                    }
                }
            }
        }
    }
}

/// 校验边：端点存在性 + 端点类型与边类型匹配。
pub(crate) fn validate_edge(
    edge: &BlueprintEdge,
    by_key: &HashMap<&str, &BlueprintNode>,
    errors: &mut Vec<String>,
) {
    let from = by_key.get(edge.from.as_str()).map(|n| n.node_type);
    let to = by_key.get(edge.to.as_str()).map(|n| n.node_type);
    if from.is_none() {
        errors.push(format!("边引用不存在的起点: {}", edge.from));
    }
    if to.is_none() {
        errors.push(format!("边引用不存在的终点: {}", edge.to));
    }
    let ok = match (edge.edge_kind, from, to) {
        // 界面 → 布局块 / 浮层（浮层与布局块同级，D49/D50）。
        (EdgeKind::Contains, Some(NodeType::Interface), Some(NodeType::LayoutBlock))
        | (EdgeKind::Contains, Some(NodeType::Interface), Some(NodeType::Overlay))
        | (EdgeKind::Contains, Some(NodeType::LayoutBlock), Some(NodeType::Group))
        | (EdgeKind::Contains, Some(NodeType::LayoutBlock), Some(NodeType::Control))
        | (EdgeKind::Contains, Some(NodeType::Group), Some(NodeType::Control))
        | (EdgeKind::Contains, Some(NodeType::Control), Some(NodeType::Class))
        | (EdgeKind::Contains, Some(NodeType::Class), Some(NodeType::Object)) => true,
        (EdgeKind::MemberOf, Some(NodeType::Control), Some(NodeType::Group)) => true,
        (EdgeKind::On, Some(NodeType::Control | NodeType::Class | NodeType::Object), Some(NodeType::Event)) => {
            true
        }
        (EdgeKind::Fires, Some(NodeType::Event), Some(NodeType::Condition | NodeType::Action)) => {
            true
        }
        (EdgeKind::Guards, Some(NodeType::Condition), Some(NodeType::Action)) => true,
        _ => false,
    };
    if !ok {
        errors.push(format!(
            "非法边: {} --{}--> {}（端点类型不匹配或引用缺失）",
            edge.from, edge.edge_kind, edge.to
        ));
    }
}

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
            Some(k) if !seen_keys.contains(k) => errors.push(format!(
                "节点 {} 的 layer 指向不存在的层: {k}",
                node.key
            )),
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

/// 条件表达式校验（基础集，RFC 0007 决策 1）。
pub(crate) fn validate_expr(expr: &str) -> Option<String> {
    let tokens: Vec<&str> = expr.split_whitespace().collect();
    if tokens.len() != 3 {
        return Some(format!("条件表达式应为「字段 操作符 值」三段: {expr}"));
    }
    let lhs = tokens[0];
    let op = tokens[1];
    let rhs = tokens[2];
    match (lhs, op) {
        ("media_type", "==") => match rhs {
            "image" | "video" | "audio" => None,
            _ => Some(format!("media_type 值必须是 image/video/audio: {expr}")),
        },
        ("selection", "!=") if rhs == "empty" => None,
        ("selection", _) => Some(format!("selection 仅支持 `selection != empty`: {expr}")),
        ("rating", ">=") => match rhs.parse::<u32>() {
            Ok(v) if v <= 5 => None,
            _ => Some(format!("rating 值必须是 0..=5 的整数: {expr}")),
        },
        ("has_tag", "==") if !rhs.is_empty() => None,
        ("has_tag", _) => Some(format!("has_tag 值不能为空: {expr}")),
        _ => Some(format!("不支持的条件表达式: {expr}")),
    }
}

/// 在 fires/guards 子图上找环（求值链必须为 DAG）。
pub(crate) fn find_cycle(edges: &[BlueprintEdge]) -> Option<Vec<String>> {
    let eval_edges: Vec<&BlueprintEdge> = edges
        .iter()
        .filter(|e| matches!(e.edge_kind, EdgeKind::Fires | EdgeKind::Guards))
        .collect();
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in &eval_edges {
        adj.entry(e.from.as_str()).or_default().push(e.to.as_str());
    }
    let mut state: HashMap<&str, u8> = HashMap::new();
    let mut path: Vec<&str> = Vec::new();
    for start in adj.keys() {
        if state.get(start) == Some(&2) {
            continue;
        }
        if let Some(cycle) = dfs_cycle(start, &adj, &mut state, &mut path) {
            return Some(cycle);
        }
    }
    None
}

fn dfs_cycle<'a>(
    node: &'a str,
    adj: &HashMap<&'a str, Vec<&'a str>>,
    state: &mut HashMap<&'a str, u8>,
    path: &mut Vec<&'a str>,
) -> Option<Vec<String>> {
    state.insert(node, 1);
    path.push(node);
    if let Some(nexts) = adj.get(node) {
        for &next in nexts {
            match state.get(next) {
                Some(&1) => {
                    let start = path.iter().position(|k| *k == next)?;
                    let cycle = path[start..]
                        .iter()
                        .map(|k| k.to_string())
                        .collect::<Vec<_>>();
                    return Some(cycle);
                }
                Some(&2) => {}
                _ => {
                    if let Some(cycle) = dfs_cycle(next, adj, state, path) {
                        return Some(cycle);
                    }
                }
            }
        }
    }
    state.insert(node, 2);
    path.pop();
    None
}
