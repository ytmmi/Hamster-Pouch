//! 蓝图语义校验算法（RFC 0007 决策 6 / D28-D60；D218 按规则族分文件）。
//!
//! 只承载**硬错误**（拒绝保存）的判定，且**全部**集中在本模块：节点字段、引用类型、
//! 边端点类型、重复边、互斥组默认可见、求值链成环、分层规则、状态冲突（D66）。
//! 图级入口是 `validate_graph`（由 `BlueprintGraph::validate` 转发）。
//! 未接通类**软告警**（不阻塞保存）在 `blueprint_warnings.rs`；
//! 数据模型在 `blueprint.rs` / `blueprint_node.rs` / `blueprint_types.rs`。
//!
//! 文件划分（D218）：每个文件装一族规则，加规则时落点是确定的，单文件也不再逼近
//! `check:line-count` 的 1200 行硬上限：
//! - `fields.rs`：节点字段与引用（`validate_node_with` / `validate_node_fields`）；
//! - `classes.rs`：类目与面板声明（`has_class` / `overlay_content`）的冲突判定；
//! - `state.rs`：同界面同对象同触发的多状态冲突（D66）；
//! - `edges.rs`：边端点/类型、条件表达式、求值链成环；
//! - `layers.rs`：分层规则（D51/D58/D60）。

mod classes;
mod edges;
mod fields;
mod layers;
mod state;

use self::classes::find_panel_class_violations;
use self::edges::{find_cycle, validate_edge_with};
use self::fields::validate_node_with;
use self::layers::validate_layers;
use self::state::find_state_conflicts;

use crate::blueprint::{BLUEPRINT_SCHEMA_VERSION, BlueprintGraph};
use crate::blueprint_node::BlueprintNode;
use crate::blueprint_registry::{NodeRegistry, SeverityLevel};
use crate::blueprint_types::{GroupMode, NodeType};
use std::collections::{HashMap, HashSet};

/// 一条校验结论：消息 + **分级**（硬错误 / 未接通软告警）。
///
/// 分级来自节点类型注册表的 `severity`：内置 10 种的缺省口径是
/// **字段问题 = 硬错误、引用缺失 = 软告警**，因此本结构不改变既有行为。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeIssue {
    pub message: String,
    pub severity: SeverityLevel,
}

impl NodeIssue {
    fn hard(message: String) -> Self {
        Self {
            message,
            severity: SeverityLevel::Hard,
        }
    }

    /// 是否硬错误（拒绝保存）。
    pub fn is_hard(&self) -> bool {
        self.severity == SeverityLevel::Hard
    }
}

/// 图级校验入口：返回全部硬错误（空 = 有效，可保存）。
///
/// 判定顺序（与 RFC 0007 决策 6 的条目顺序一致）：版本闸门 → 节点 key 唯一 →
/// 各节点字段/引用 → 边端点与类型 → 分层规则 → 互斥组默认可见 → 求值链无环。
pub(crate) fn validate_graph(graph: &BlueprintGraph) -> Vec<String> {
    validate_graph_with(graph, &NodeRegistry::builtin_only())
        .into_iter()
        .filter(NodeIssue::is_hard)
        .map(|i| i.message)
        .collect()
}

/// 图级校验入口（带节点类型注册表）：返回**全部分级结论**。
///
/// 宿主把插件注册表注入后，已启用插件的节点类型不再被标为「未接通」；
/// 未注入（`builtin_only`）时，命名合法但无注册项的类型按**软告警**处理
/// （不阻塞保存，RFC 0010 决策 6）。
pub(crate) fn validate_graph_with(
    graph: &BlueprintGraph,
    registry: &NodeRegistry,
) -> Vec<NodeIssue> {
    let mut issues: Vec<NodeIssue> = Vec::new();

    // 版本闸门：`>` 当前版本才是硬错误；更低版本先走迁移（D58），迁移后再校验。
    if graph.schema_version > BLUEPRINT_SCHEMA_VERSION {
        issues.push(NodeIssue::hard(format!(
            "不支持的蓝图 schema 版本: {}（当前为 {}）",
            graph.schema_version, BLUEPRINT_SCHEMA_VERSION
        )));
    }

    // 节点 key 唯一 + `type` 命名规则（**未知 type 分流**，RFC 0010 决策 6）：
    // 不合命名规则 = 硬错误；命名合法但当前无注册项 = 软告警（见 warnings）。
    let mut seen = HashSet::new();
    for node in &graph.nodes {
        if node.key.trim().is_empty() {
            issues.push(NodeIssue::hard("存在空 key 的节点".into()));
            continue;
        }
        if !seen.insert(node.key.clone()) {
            issues.push(NodeIssue::hard(format!("节点 key 重复: {}", node.key)));
        }
        let raw = node.node_type.as_str();
        if NodeType::from_str(raw).is_none() {
            issues.push(NodeIssue::hard(format!(
                "节点 {} 的 type 不合命名规则: {raw}（宿主内置用裸 id，插件注册用 plugin.<plugin_id>.<local_id>）",
                node.key
            )));
        }
    }

    let by_key: HashMap<&str, &BlueprintNode> =
        graph.nodes.iter().map(|n| (n.key.as_str(), n)).collect();

    // 各节点类型字段校验（硬错误，按注册表的 `severity` 分级）。
    for node in &graph.nodes {
        validate_node_with(node, &by_key, registry, &mut issues);
    }

    // 边校验（悬空、端点类型不符、重复）
    let mut edge_seen = HashSet::new();
    for edge in &graph.edges {
        validate_edge_with(edge, &by_key, registry, &mut issues);
        if !edge_seen.insert((edge.from.clone(), edge.to.clone(), edge.edge_kind)) {
            issues.push(NodeIssue::hard(format!(
                "重复边: {} --{}--> {}",
                edge.from, edge.edge_kind, edge.to
            )));
        }
    }

    // 分层规则（D51/D58/D60）：层 key/名、每层至多一个界面、节点 layer 归属、跨层边。
    // 分层规则全部是硬错误（与既有口径一致），因此直接映射成 `NodeIssue::hard`。
    let mut layer_errors: Vec<String> = Vec::new();
    validate_layers(graph, &mut layer_errors);
    issues.extend(layer_errors.into_iter().map(NodeIssue::hard));

    // 互斥组 default_visible 至多一个成员。
    for node in &graph.nodes {
        if node.node_type != NodeType::Group || node.mode != Some(GroupMode::Exclusive) {
            continue;
        }
        if let Some(visible) = &node.default_visible
            && visible.len() > 1
        {
            issues.push(NodeIssue::hard(format!(
                "互斥组 {} 的 default_visible 至多一个成员（当前 {} 个）",
                node.key,
                visible.len()
            )));
        }
    }

    // 类目挂在**无类目**的面板下（RFC 0010 决策 4 / 面板标准第 5.1、7.1 节）：
    // `has_class = false` 的面板下出现 `control → class` 的 `contains` 边。
    // 分级按**声明者是否可变**：宿主内置面板 = 硬错误；插件注册面板 = 未接通软告警
    // （插件升级可能把 `has_class` 由 true 改成 false，不能把用户既有文档变成"保存失败"）。
    issues.extend(find_panel_class_violations(graph, registry, &by_key));

    // fires/guards 求值子图必须无环（DAG）。
    if let Some(cycle) = find_cycle(&graph.edges) {
        issues.push(NodeIssue::hard(format!(
            "fires/guards 求值链存在环: {}",
            cycle
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(" -> ")
        )));
    }

    // **同界面 + 同对象 + 同触发 + 多状态冲突**（用户新增规则）：一次交互不可能同时
    // 落到两个互斥结果上——要么目标被同时显示与隐藏，要么互斥组里有两个成员被同时显示。
    issues.extend(find_state_conflicts(graph, registry));

    // 「未接通」类软问题（缺引用、缺触发来源、无根层、浮层未连界面）不在此处报错，
    // 见 `blueprint_warnings::collect`：删除关联节点后允许先存下中间状态。
    issues
}
