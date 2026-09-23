//! 蓝图语义校验算法（RFC 0007 决策 6 / D28-D60）。
//!
//! 只承载**硬错误**（拒绝保存）的判定，且**全部**集中在本模块：节点字段、引用类型、
//! 边端点类型、重复边、互斥组默认可见、求值链成环、分层规则。
//! 图级入口是 `validate_graph`（由 `BlueprintGraph::validate` 转发）。
//! 未接通类**软告警**（不阻塞保存）在 `blueprint_warnings.rs`；
//! 数据模型在 `blueprint.rs` / `blueprint_node.rs` / `blueprint_types.rs`。

use std::collections::{HashMap, HashSet};

use crate::blueprint::{
    BlueprintGraph, BLUEPRINT_SCHEMA_VERSION, OVERLAY_HEIGHT_MAX, OVERLAY_HEIGHT_MIN,
    OVERLAY_MAX_SIZE,
};
use crate::blueprint_node::{BlueprintEdge, BlueprintNode};
use crate::blueprint_types::{ActionOp, EdgeKind, GroupMode, NodeType, Trigger};

/// 图级校验入口：返回全部硬错误（空 = 有效，可保存）。
///
/// 判定顺序（与 RFC 0007 决策 6 的条目顺序一致）：版本闸门 → 节点 key 唯一 →
/// 各节点字段/引用 → 边端点与类型 → 分层规则 → 互斥组默认可见 → 求值链无环。
pub(crate) fn validate_graph(graph: &BlueprintGraph) -> Vec<String> {
    let mut errors = Vec::new();

    // 版本闸门：`>` 当前版本才是硬错误；更低版本先走迁移（D58），迁移后再校验。
    if graph.schema_version > BLUEPRINT_SCHEMA_VERSION {
        errors.push(format!(
            "不支持的蓝图 schema 版本: {}（当前为 {}）",
            graph.schema_version, BLUEPRINT_SCHEMA_VERSION
        ));
    }

    // 节点 key 唯一
    let mut seen = HashSet::new();
    for node in &graph.nodes {
        if node.key.trim().is_empty() {
            errors.push("存在空 key 的节点".into());
            continue;
        }
        if !seen.insert(node.key.clone()) {
            errors.push(format!("节点 key 重复: {}", node.key));
        }
    }

    let by_key: HashMap<&str, &BlueprintNode> =
        graph.nodes.iter().map(|n| (n.key.as_str(), n)).collect();

    // 各节点类型字段校验（硬错误）
    for node in &graph.nodes {
        validate_node(node, &by_key, &mut errors);
    }

    // 边校验（悬空、端点类型不符、重复）
    let mut edge_seen = HashSet::new();
    for edge in &graph.edges {
        validate_edge(edge, &by_key, &mut errors);
        if !edge_seen.insert((edge.from.clone(), edge.to.clone(), edge.edge_kind)) {
            errors.push(format!(
                "重复边: {} --{}--> {}",
                edge.from, edge.edge_kind, edge.to
            ));
        }
    }

    // 分层规则（D51/D58/D60）：层 key/名、每层至多一个界面、节点 layer 归属、跨层边。
    validate_layers(graph, &mut errors);

    // 互斥组 default_visible 至多一个成员。
    for node in &graph.nodes {
        if node.node_type != NodeType::Group || node.mode != Some(GroupMode::Exclusive) {
            continue;
        }
        if let Some(visible) = &node.default_visible {
            if visible.len() > 1 {
                errors.push(format!(
                    "互斥组 {} 的 default_visible 至多一个成员（当前 {} 个）",
                    node.key,
                    visible.len()
                ));
            }
        }
    }

    // fires/guards 求值子图必须无环（DAG）。
    if let Some(cycle) = find_cycle(&graph.edges) {
        errors.push(format!(
            "fires/guards 求值链存在环: {}",
            cycle
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(" -> ")
        ));
    }

    // **同界面 + 同对象 + 同触发 + 多状态冲突**（用户新增规则）：一次交互不可能同时
    // 落到两个互斥结果上——要么目标被同时显示与隐藏，要么互斥组里有两个成员被同时显示。
    errors.extend(find_state_conflicts(graph));

    // 「未接通」类软问题（缺引用、缺触发来源、无根层、浮层未连界面）不在此处报错，
    // 见 `blueprint_warnings::collect`：删除关联节点后允许先存下中间状态。
    errors
}

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
fn find_state_conflicts(graph: &BlueprintGraph) -> Vec<String> {
    let mut errors = Vec::new();

    // 触发来源节点：面板控件 / 类 / 对象（与引擎 `eventMatches` 的候选口径一致）。
    for source in &graph.nodes {
        if !matches!(
            source.node_type,
            NodeType::Control | NodeType::Class | NodeType::Object
        ) {
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
            if !unique_triggers.iter().any(|u| *u == t) {
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
                        && graph
                            .edges
                            .iter()
                            .any(|e| e.edge_kind == EdgeKind::On && e.from == source.key && e.to == n.key)
                })
                .map(|n| n.key.as_str())
                .collect();

            // 收集可达动作（事件 fires 条件/动作，条件 guards 动作；带环保护）。
            let mut reached: Vec<&str> = Vec::new();
            let mut queue: Vec<&str> = events.clone();
            let mut seen: HashSet<&str> = events.iter().copied().collect();
            while let Some(key) = queue.pop() {
                for edge in graph.edges.iter().filter(|e| {
                    e.from == key
                        && matches!(e.edge_kind, EdgeKind::Fires | EdgeKind::Guards)
                }) {
                    if !seen.insert(edge.to.as_str()) {
                        continue;
                    }
                    match graph.node(&edge.to) {
                        Some(n) if n.node_type == NodeType::Action => reached.push(n.key.as_str()),
                        Some(n) if n.node_type == NodeType::Condition => {
                            queue.push(n.key.as_str())
                        }
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
                    errors.push(format!(
                        "同界面同对象同触发「{}」状态冲突：对象 {} 的两个状态同时作用于 {}（{}:{} / {}:{}）",
                        trigger.as_str(),
                        source.key,
                        a.target,
                        a.action,
                        a.op.as_str(),
                        b.action,
                        b.op.as_str()
                    ));
                }
            }

            // 2. 同一互斥组里的两个成员被同时显示。
            for (i, a) in states.iter().enumerate() {
                if !is_visible_op(a.op) {
                    continue;
                }
                for b in states.iter().skip(i + 1) {
                    if a.panel_id.is_none()
                        || a.panel_id == b.panel_id
                        || !is_visible_op(b.op)
                    {
                        continue;
                    }
                    let Some(group) = graph.nodes.iter().find(|g| {
                        g.node_type == NodeType::Group
                            && g.mode == Some(GroupMode::Exclusive)
                            && graph.edges.iter().any(|e| {
                                e.edge_kind == EdgeKind::Contains && e.from == g.key && e.to == a.target
                            })
                            && graph.edges.iter().any(|e| {
                                e.edge_kind == EdgeKind::Contains && e.from == g.key && e.to == b.target
                            })
                    }) else {
                        continue;
                    };
                    errors.push(format!(
                        "同界面同对象同触发「{}」状态冲突：互斥组 {} 的成员 {} 与 {} 被同时置为显示",
                        trigger.as_str(),
                        group.key,
                        a.target,
                        b.target
                    ));
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
            // 浮层（D50 修订）：**容器**——与布局块同级，可 contains **面板控件与标签组**；
            // 并承载外观档位（阴影/圆角/标签隐藏，取宿主设计 token，像素由宿主决定）
            // 与**相对定位**（九宫格锚点 + 双模式偏移）。
            // 2026-09 取消「浮动控件」绑定，浮层不再有 `control_id`。
            // 锚点与偏移的取值合法性由解析层保证（枚举 + 数字）；
            // JSON 的 f64 由 serde_json 保证有限，不会出现 NaN/∞。
            if let Some(h) = node.height {
                if !(OVERLAY_HEIGHT_MIN..=OVERLAY_HEIGHT_MAX).contains(&h) {
                    errors.push(format!(
                        "浮层节点 {key} 的 height 必须在 {OVERLAY_HEIGHT_MIN}-{OVERLAY_HEIGHT_MAX}（当前: {h}）"
                    ));
                }
            }
            // 框体尺寸：必须为正且不超过上限；小于最小尺寸只夹紧（软告警，见 warnings）。
            if let Some(size) = &node.size {
                if size.width <= 0.0 || size.height <= 0.0 {
                    errors.push(format!(
                        "浮层节点 {key} 的 size 宽高必须为正数（当前: {}×{}）",
                        size.width, size.height
                    ));
                } else if size.width > OVERLAY_MAX_SIZE || size.height > OVERLAY_MAX_SIZE {
                    errors.push(format!(
                        "浮层节点 {key} 的 size 宽高不得超过 {OVERLAY_MAX_SIZE}（当前: {}×{}）",
                        size.width, size.height
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
        // 浮层是**容器**（D50 修订）：可包含面板控件与标签组；标签组再包含面板控件。
        | (EdgeKind::Contains, Some(NodeType::Overlay), Some(NodeType::Control))
        | (EdgeKind::Contains, Some(NodeType::Overlay), Some(NodeType::Group))
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
