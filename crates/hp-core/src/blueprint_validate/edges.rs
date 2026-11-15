//! 边与求值链的校验（D218 从 `blueprint_validate.rs` 拆出）。
//!
//! 三件事同属「连接」这一族：边端点存在性与类型匹配（查注册表，不硬编码类型组合）、
//! 条件表达式的基础语法、fires/guards 子图必须为 DAG。

use super::NodeIssue;

use crate::blueprint_node::{BlueprintEdge, BlueprintNode};
use crate::blueprint_registry::NodeRegistry;
use crate::blueprint_types::{CLASS_MEDIA_TYPES, EdgeKind, is_valid_class_media_type};
use std::collections::HashMap;

/// 校验边：端点存在性 + 端点类型与边类型匹配（查注册表，不再硬编码类型组合）。
pub(crate) fn validate_edge_with(
    edge: &BlueprintEdge,
    by_key: &HashMap<&str, &BlueprintNode>,
    registry: &NodeRegistry,
    issues: &mut Vec<NodeIssue>,
) {
    let from = by_key.get(edge.from.as_str()).map(|n| &n.node_type);
    let to = by_key.get(edge.to.as_str()).map(|n| &n.node_type);
    if from.is_none() {
        issues.push(NodeIssue::hard(format!(
            "边引用不存在的起点: {}",
            edge.from
        )));
    }
    if to.is_none() {
        issues.push(NodeIssue::hard(format!("边引用不存在的终点: {}", edge.to)));
    }
    let ok = match (from, to) {
        // 两端都是宿主内置类型 → 按注册表判定（结构边查 `can_contain`，规则边查边表）。
        (Some(from), Some(to)) if from.is_builtin() && to.is_builtin() => {
            if edge.edge_kind == EdgeKind::Contains {
                registry.can_contain(from, to)
            } else {
                registry.rule_edge_allows(edge.edge_kind, from, to)
            }
        }
        // 端点存在但**不是宿主内置类型**（插件注册项 / 命名合法但当前无注册项）：
        // 不做类型判定——既不是"非法边"硬错误，也不参与求值（未接通，RFC 0010 决策 6）。
        (Some(_), Some(_)) => return,
        // 端点缺失：与既有口径一致，同时报"非法边"。
        _ => false,
    };
    if !ok {
        issues.push(NodeIssue::hard(format!(
            "非法边: {} --{}--> {}（端点类型不匹配或引用缺失）",
            edge.from, edge.edge_kind, edge.to
        )));
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
            // 取值域与类目节点的 `media_type` 同源（含 `text`，2026-10-10）。
            v if is_valid_class_media_type(v) => None,
            _ => Some(format!(
                "media_type 值必须是 {}: {expr}",
                CLASS_MEDIA_TYPES.join("/")
            )),
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
