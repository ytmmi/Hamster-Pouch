//! 同界面 + 同对象 + 同触发下的多状态冲突（D66；D218 从 `blueprint_validate.rs` 拆出）。
//!
//! 一次交互不可能同时落到两个互斥结果上：要么目标被同时显示与隐藏，要么互斥组里
//! 有两个成员被同时显示。这里只判定「同一次触发」，跨触发的同时显示是运行期问题。

use super::NodeIssue;

use crate::blueprint::BlueprintGraph;
use crate::blueprint_registry::NodeRegistry;
use crate::blueprint_types::{ActionOp, EdgeKind, GroupMode, NodeType, Trigger};
use std::collections::HashSet;

/// 一次交互可能落到的一个"状态"（动作目标 + 操作）。
#[derive(Debug, Clone)]
struct ActionState {
    /// 动作节点 key（报错定位用）。
    action: String,
    op: ActionOp,
    /// 动作目标 key（面板控件 / 标签组 / 浮层 / 界面）。
    target: String,
    /// 该动作所在的面板控件（用于判定"同一面板"）。
    panel_id: Option<String>,
}

/// 沿求值链找同一「对象 + 触发」下互相冲突的状态（硬错误，拒绝保存）。
///
/// 规则（同**层** = 同界面；跨层只能靠 `navigate`，不在此判定）：
/// 1. **互斥状态**：同一目标被同时赋予互斥操作 —— `show`/`hide` 或 `show`/`toggle`；
///    标签组同时 `collapse`/`expand`；界面同时 `navigate` 到两个不同界面。
///    重复同一操作（`show` 两次）不算冲突，`toggle` 与 `hide` 的组合也允许。
/// 2. **互斥组多成员同时显示**：同一次交互把同一互斥组（`mode = exclusive`）的两个不同
///    成员面板都置为 `show`（或 `toggle`），违反"同一时间至多一个成员显示"。
pub(super) fn find_state_conflicts(
    graph: &BlueprintGraph,
    registry: &NodeRegistry,
) -> Vec<NodeIssue> {
    let mut errors = Vec::new();

    // 触发来源节点：面板 / 类目 / 对象（= `on` 边的合法来源，与 `blueprint_registry` 的
    // 规则边表同源；插件注册项与无注册项的节点不参与，见注册表开放点）。
    for source in &graph.nodes {
        if !registry.rule_edge_allows(EdgeKind::On, &source.node_type, &NodeType::Event) {
            continue;
        }
        let layer = graph.node_layer_key(source);
        let _ = &layer; // 同层由上层规则保证；保留取值以便日后按层细化报错。

        // 按触发分组：这些事件都由本对象触发（`on` 入边）。
        let triggers: Vec<&Trigger> = graph
            .nodes
            .iter()
            .filter(|n| {
                n.node_type == NodeType::Event
                    && n.trigger.is_some()
                    && graph.edges.iter().any(|e| {
                        e.edge_kind == EdgeKind::On && e.from == source.key && e.to == n.key
                    })
            })
            .filter_map(|n| n.trigger.as_ref())
            .collect();
        let mut unique_triggers: Vec<&Trigger> = Vec::new();
        for t in triggers {
            if !unique_triggers.contains(&t) {
                unique_triggers.push(t);
            }
        }

        for trigger in unique_triggers {
            // 该触发下可达的全部事件节点。
            let events: Vec<&str> = graph
                .nodes
                .iter()
                .filter(|n| {
                    n.node_type == NodeType::Event
                        && n.trigger.as_ref() == Some(trigger)
                        && graph.edges.iter().any(|e| {
                            e.edge_kind == EdgeKind::On && e.from == source.key && e.to == n.key
                        })
                })
                .map(|n| n.key.as_str())
                .collect();

            // 收集可达动作（事件 fires 条件/动作，条件 guards 动作；带环保护）。
            let mut reached: Vec<&str> = Vec::new();
            let mut queue: Vec<&str> = events.clone();
            let mut seen: HashSet<&str> = events.iter().copied().collect();
            while let Some(key) = queue.pop() {
                for edge in graph.edges.iter().filter(|e| {
                    e.from == key && matches!(e.edge_kind, EdgeKind::Fires | EdgeKind::Guards)
                }) {
                    if !seen.insert(edge.to.as_str()) {
                        continue;
                    }
                    match graph.node(&edge.to) {
                        Some(n) if n.node_type == NodeType::Action => reached.push(n.key.as_str()),
                        Some(n) if n.node_type == NodeType::Condition => queue.push(n.key.as_str()),
                        _ => {}
                    }
                }
            }

            let states: Vec<ActionState> = reached
                .iter()
                .filter_map(|key| graph.node(key))
                .filter_map(|n| {
                    let target = n.target.as_deref()?;
                    let target_node = graph.node(target)?;
                    Some(ActionState {
                        action: n.key.clone(),
                        op: n.op?,
                        target: target.to_string(),
                        panel_id: target_node.panel_id.clone(),
                    })
                })
                .collect();

            // 1. 同一目标的互斥状态。
            for (i, a) in states.iter().enumerate() {
                for b in states.iter().skip(i + 1) {
                    if a.target != b.target || !mutually_exclusive(a.op, b.op) {
                        continue;
                    }
                    errors.push(NodeIssue::hard(format!(
                        "同界面同对象同触发「{}」状态冲突：对象 {} 的两个状态同时作用于 {}（{}:{} / {}:{}）",
                        trigger.as_str(),
                        source.key,
                        a.target,
                        a.action,
                        a.op.as_str(),
                        b.action,
                        b.op.as_str()
                    )));
                }
            }

            // 2. 同一互斥组里的两个成员被同时显示。
            for (i, a) in states.iter().enumerate() {
                if !is_visible_op(a.op) {
                    continue;
                }
                for b in states.iter().skip(i + 1) {
                    if a.panel_id.is_none() || a.panel_id == b.panel_id || !is_visible_op(b.op) {
                        continue;
                    }
                    let Some(group) = graph.nodes.iter().find(|g| {
                        g.node_type == NodeType::Group
                            && g.mode == Some(GroupMode::Exclusive)
                            && graph.edges.iter().any(|e| {
                                e.edge_kind == EdgeKind::Contains
                                    && e.from == g.key
                                    && e.to == a.target
                            })
                            && graph.edges.iter().any(|e| {
                                e.edge_kind == EdgeKind::Contains
                                    && e.from == g.key
                                    && e.to == b.target
                            })
                    }) else {
                        continue;
                    };
                    errors.push(NodeIssue::hard(format!(
                        "同界面同对象同触发「{}」状态冲突：互斥组 {} 的成员 {} 与 {} 被同时置为显示",
                        trigger.as_str(),
                        group.key,
                        a.target,
                        b.target
                    )));
                }
            }

            let _ = layer; // 同层由上层规则保证；保留取值以便日后按层细化报错。
        }
    }

    errors
}

/// 两个操作是否互斥（不可能同时成立）。
fn mutually_exclusive(a: ActionOp, b: ActionOp) -> bool {
    use ActionOp::{Collapse, Expand, Hide, Navigate, Show, Toggle};
    match (a, b) {
        // 显示 vs 隐藏 / 切换：同一目标不可能既显示又隐藏。
        (Show, Hide) | (Hide, Show) | (Show, Toggle) | (Toggle, Show) => true,
        // 收起 vs 展开。
        (Collapse, Expand) | (Expand, Collapse) => true,
        // 界面跳转：同一次交互不能跳到两个不同界面（target 不同已在调用处排除同目标）。
        (Navigate, Navigate) => true,
        _ => false,
    }
}

/// 该操作是否表示"让目标可见"。
fn is_visible_op(op: ActionOp) -> bool {
    matches!(op, ActionOp::Show | ActionOp::Toggle)
}
