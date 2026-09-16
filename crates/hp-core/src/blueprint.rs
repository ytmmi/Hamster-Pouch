//! 蓝图领域模型（RFC 0007 / D28-D32）。
//!
//! 蓝图是仓库内节点式「控件显隐 + 组布局控制」配置文档（一个 JSON 图 + schema 版本）。
//! 节点分：控件（Control）/ 控件内部的类（Class）/ 控件内的对象（Object），以及
//! 组（互斥/独立）、事件、条件、动作等逻辑节点；边语义含 contains / memberOf /
//! fires / guards。
//!
//! 本模块只承载纯数据模型与校验（`validate`），不依赖 Tauri/SQLite/文件系统；
//! 存储与命令桥接分别位于 hp-store 与 src-tauri。

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde::{Deserialize, Serialize};

/// 蓝图文档 schema 版本（当前 = 1）。
pub const BLUEPRINT_SCHEMA_VERSION: i64 = 1;

/// 节点 key（蓝图内唯一，边引用寻址依据）。
pub type NodeKey = String;

// ============================== 枚举 ==============================

/// 节点类型（RFC 0007 决策 1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    /// 布局块：顶层布局区域（如左/中/右三栏），包含标签组与控件。
    LayoutBlock,
    /// 控件：UI 组件实例，绑定 dockview 面板。
    Control,
    /// 类：控件内部条目分类（按 media_type）。
    Class,
    /// 对象：类内条目实例。
    Object,
    /// 组：控件容器（互斥/独立）。
    Group,
    /// 事件：触发求值。
    Event,
    /// 条件：基础判定。
    Condition,
    /// 动作：显隐/收起操作。
    Action,
}

impl NodeType {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeType::LayoutBlock => "layout_block",
            NodeType::Control => "control",
            NodeType::Class => "class",
            NodeType::Object => "object",
            NodeType::Group => "group",
            NodeType::Event => "event",
            NodeType::Condition => "condition",
            NodeType::Action => "action",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "layout_block" => Some(NodeType::LayoutBlock),
            "control" => Some(NodeType::Control),
            "class" => Some(NodeType::Class),
            "object" => Some(NodeType::Object),
            "group" => Some(NodeType::Group),
            "event" => Some(NodeType::Event),
            "condition" => Some(NodeType::Condition),
            "action" => Some(NodeType::Action),
            _ => None,
        }
    }
}

impl fmt::Display for NodeType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 组模式（RFC 0007 决策 1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupMode {
    /// 互斥组：同一时间至多一个成员显示，其余默认隐藏。
    Exclusive,
    /// 独立组：各成员显隐互不影响。
    Independent,
}

impl GroupMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            GroupMode::Exclusive => "exclusive",
            GroupMode::Independent => "independent",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "exclusive" => Some(GroupMode::Exclusive),
            "independent" => Some(GroupMode::Independent),
            _ => None,
        }
    }
}

impl fmt::Display for GroupMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 组隐藏方向（RFC 0007 决策 1 / D29）。
///
/// 组收起时释放的空间沿该方向让给相邻组；`toward:<groupKey>` 精确指定吸收者。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HideDirection {
    Left,
    Right,
    Up,
    Down,
    /// 指向具体邻居组（`toward:<groupKey>`）。
    Toward(String),
}

impl HideDirection {
    pub fn as_str(&self) -> String {
        match self {
            HideDirection::Left => "left".to_string(),
            HideDirection::Right => "right".to_string(),
            HideDirection::Up => "up".to_string(),
            HideDirection::Down => "down".to_string(),
            HideDirection::Toward(key) => format!("toward:{key}"),
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "left" => Some(HideDirection::Left),
            "right" => Some(HideDirection::Right),
            "up" => Some(HideDirection::Up),
            "down" => Some(HideDirection::Down),
            _ => s
                .strip_prefix("toward:")
                .filter(|k| !k.is_empty())
                .map(|k| HideDirection::Toward(k.to_string())),
        }
    }

    /// 是否为 `toward:<groupKey>` 形式。
    pub fn toward_target(&self) -> Option<&str> {
        match self {
            HideDirection::Toward(key) => Some(key.as_str()),
            _ => None,
        }
    }
}

impl fmt::Display for HideDirection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_str())
    }
}

impl Serialize for HideDirection {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.as_str())
    }
}

impl<'de> Deserialize<'de> for HideDirection {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        HideDirection::from_str(&s)
            .ok_or_else(|| serde::de::Error::custom(format!("未知隐藏方向: {s}")))
    }
}

/// 事件触发（RFC 0007 决策 1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trigger {
    Click,
    DoubleClick,
    SelectionChange,
}

impl Trigger {
    pub fn as_str(&self) -> &'static str {
        match self {
            Trigger::Click => "click",
            Trigger::DoubleClick => "double_click",
            Trigger::SelectionChange => "selection_change",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "click" => Some(Trigger::Click),
            "double_click" => Some(Trigger::DoubleClick),
            "selection_change" => Some(Trigger::SelectionChange),
            _ => None,
        }
    }
}

impl fmt::Display for Trigger {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 动作操作（RFC 0007 决策 1 / D29：show/hide/toggle + collapse/expand）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionOp {
    /// 显示控件。
    Show,
    /// 隐藏控件。
    Hide,
    /// 切换（控件或组）。
    Toggle,
    /// 收起组（组的隐藏 = 最小化至 6px，标签条保留）。
    Collapse,
    /// 展开组（恢复收起前尺寸）。
    Expand,
}

impl ActionOp {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActionOp::Show => "show",
            ActionOp::Hide => "hide",
            ActionOp::Toggle => "toggle",
            ActionOp::Collapse => "collapse",
            ActionOp::Expand => "expand",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "show" => Some(ActionOp::Show),
            "hide" => Some(ActionOp::Hide),
            "toggle" => Some(ActionOp::Toggle),
            "collapse" => Some(ActionOp::Collapse),
            "expand" => Some(ActionOp::Expand),
            _ => None,
        }
    }

    /// 是否为组级操作（目标必须是组节点）。
    pub fn is_group_op(&self) -> bool {
        matches!(self, ActionOp::Collapse | ActionOp::Expand)
    }
}

impl fmt::Display for ActionOp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 边类型（RFC 0007 决策 1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    /// 包含：控件 → 类 → 对象。
    Contains,
    /// 归属：控件 → 组（契约字段为 `memberOf`，与 rename_all=snake_case 冲突故显式指定）。
    #[serde(rename = "memberOf")]
    MemberOf,
    /// 触发：事件 → 条件/动作。
    Fires,
    /// 守卫：条件 → 动作。
    Guards,
}

impl EdgeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EdgeKind::Contains => "contains",
            EdgeKind::MemberOf => "memberOf",
            EdgeKind::Fires => "fires",
            EdgeKind::Guards => "guards",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "contains" => Some(EdgeKind::Contains),
            "memberOf" => Some(EdgeKind::MemberOf),
            "fires" => Some(EdgeKind::Fires),
            "guards" => Some(EdgeKind::Guards),
            _ => None,
        }
    }
}

impl fmt::Display for EdgeKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// ============================== 节点 ==============================

/// 组/控件的目标锚点（画布编辑器定位 + 浮动/停靠；RFC 0007 / D29）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlueprintPosition {
    pub x: f64,
    pub y: f64,
}

/// 蓝图节点（扁平结构，按 `node_type` 各取所需字段；RFC 0007 决策 1）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlueprintNode {
    pub key: NodeKey,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    /// 显示名称（用户自定义）；缺省时由前端按类型本地化生成（如「控件 1」）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    // control
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_key: Option<String>,
    // class（所属控件 key）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control: Option<NodeKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    // object（所属类 key）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<NodeKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    // group
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<GroupMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_visible: Option<Vec<NodeKey>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide_direction: Option<HideDirection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<BlueprintPosition>,
    // event（target = 类或对象 key）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<Trigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<NodeKey>,
    // condition
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expr: Option<String>,
    // action（target = 控件或组 key）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<ActionOp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

/// 蓝图边（RFC 0007 决策 1）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlueprintEdge {
    pub from: NodeKey,
    pub to: NodeKey,
    #[serde(rename = "kind")]
    pub edge_kind: EdgeKind,
    /// 求值链排序（`fires`/`guards` 沿 order 升序执行）。
    #[serde(default)]
    pub order: i64,
}

/// 蓝图图文档（整文档 JSON 存储，RFC 0007 决策 2）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlueprintGraph {
    #[serde(default = "default_schema_version")]
    pub schema_version: i64,
    /// 内置默认蓝图版本（仅内置默认图携带；用户图无此字段）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_version: Option<i64>,
    #[serde(default)]
    pub nodes: Vec<BlueprintNode>,
    #[serde(default)]
    pub edges: Vec<BlueprintEdge>,
}

fn default_schema_version() -> i64 {
    BLUEPRINT_SCHEMA_VERSION
}

impl BlueprintGraph {
    /// 解析蓝图 JSON 文档。
    pub fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("蓝图 JSON 解析失败: {e}"))
    }

    /// 序列化为 JSON 文档（紧凑格式）。
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// 解析并校验；返回全部错误（空 = 有效）。
    pub fn validate_json(json: &str) -> Vec<String> {
        match Self::from_json(json) {
            Ok(graph) => graph.validate(),
            Err(e) => vec![e],
        }
    }

    /// 按 key 查找节点。
    pub fn node(&self, key: &str) -> Option<&BlueprintNode> {
        self.nodes.iter().find(|n| n.key == key)
    }

    /// 语义校验（RFC 0007 决策 6）：返回全部错误，空 = 有效。
    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();

        if self.schema_version != BLUEPRINT_SCHEMA_VERSION {
            errors.push(format!(
                "不支持的蓝图 schema 版本: {}（当前为 {}）",
                self.schema_version, BLUEPRINT_SCHEMA_VERSION
            ));
        }

        // 节点 key 唯一
        let mut seen = HashSet::new();
        for node in &self.nodes {
            if node.key.trim().is_empty() {
                errors.push("存在空 key 的节点".into());
                continue;
            }
            if !seen.insert(node.key.clone()) {
                errors.push(format!("节点 key 重复: {}", node.key));
            }
        }

        let by_key: HashMap<&str, &BlueprintNode> =
            self.nodes.iter().map(|n| (n.key.as_str(), n)).collect();

        // 各节点类型字段校验
        for node in &self.nodes {
            validate_node(node, &by_key, &mut errors);
        }

        // 边校验
        let mut edge_seen = HashSet::new();
        for edge in &self.edges {
            validate_edge(edge, &by_key, &mut errors);
            if !edge_seen.insert((edge.from.clone(), edge.to.clone(), edge.edge_kind)) {
                errors.push(format!(
                    "重复边: {} --{}--> {}",
                    edge.from, edge.edge_kind, edge.to
                ));
            }
        }

        // 互斥组 default_visible 至多一个成员
        for node in &self.nodes {
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

        // fires/guards 求值子图必须无环（DAG）
        if let Some(cycle) = find_cycle(&self.edges) {
            errors.push(format!(
                "fires/guards 求值链存在环: {}",
                cycle
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(" -> ")
            ));
        }

        errors
    }
}

/// 校验单个节点字段与引用。
fn validate_node(
    node: &BlueprintNode,
    by_key: &HashMap<&str, &BlueprintNode>,
    errors: &mut Vec<String>,
) {
    let key = &node.key;
    match node.node_type {
        NodeType::LayoutBlock => {
            // 布局块：结构节点，仅要求 key 非空（name/position 可选）。
        }
        NodeType::Control => {
            if node.panel_id.as_deref().unwrap_or("").trim().is_empty() {
                errors.push(format!("控件节点 {key} 缺少 panel_id"));
            }
        }
        NodeType::Class => {
            let control_key = node.control.as_deref();
            match control_key {
                Some(ck) if by_key.get(ck).map(|n| n.node_type) == Some(NodeType::Control) => {}
                _ => errors.push(format!(
                    "类节点 {key} 的 control 必须是控件节点 key（当前: {}）",
                    control_key.unwrap_or("")
                )),
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
            let class_key = node.class.as_deref();
            match class_key {
                Some(ck) if by_key.get(ck).map(|n| n.node_type) == Some(NodeType::Class) => {}
                _ => errors.push(format!(
                    "对象节点 {key} 的 class 必须是类节点 key（当前: {}）",
                    class_key.unwrap_or("")
                )),
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
                    if by_key.get(vk.as_str()).map(|n| n.node_type) != Some(NodeType::Control) {
                        errors.push(format!(
                            "组节点 {key} 的 default_visible 成员 {vk} 必须是控件节点"
                        ));
                    }
                }
            }
            if let Some(dir) = &node.hide_direction {
                if let Some(target) = dir.toward_target() {
                    if by_key.get(target).map(|n| n.node_type) != Some(NodeType::Group) {
                        errors.push(format!(
                            "组节点 {key} 的 hide_direction 指向的 {target} 必须是组节点"
                        ));
                    }
                }
            }
        }
        NodeType::Event => {
            if node.trigger.is_none() {
                errors.push(format!("事件节点 {key} 缺少 trigger"));
            }
            match node.target.as_deref().and_then(|t| by_key.get(t)) {
                Some(t) if matches!(t.node_type, NodeType::Class | NodeType::Object) => {}
                _ => errors.push(format!(
                    "事件节点 {key} 的 target 必须是类或对象节点 key（当前: {}）",
                    node.target.as_deref().unwrap_or("")
                )),
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
            let target_key = node.target.as_deref();
            let target_type = target_key.and_then(|t| by_key.get(t)).map(|n| n.node_type);
            match op {
                Some(ActionOp::Show) | Some(ActionOp::Hide) => {
                    if target_type != Some(NodeType::Control) {
                        errors.push(format!(
                            "动作节点 {key} 的 target 必须是控件节点（当前: {}）",
                            target_key.unwrap_or("")
                        ));
                    }
                }
                Some(ActionOp::Collapse) | Some(ActionOp::Expand) => {
                    if target_type != Some(NodeType::Group) {
                        errors.push(format!(
                            "动作节点 {key} 的 target 必须是组节点（当前: {}）",
                            target_key.unwrap_or("")
                        ));
                    }
                }
                Some(ActionOp::Toggle) => {
                    if !matches!(target_type, Some(NodeType::Control) | Some(NodeType::Group)) {
                        errors.push(format!(
                            "动作节点 {key} 的 target 必须是控件或组节点（当前: {}）",
                            target_key.unwrap_or("")
                        ));
                    }
                }
                None => {}
            }
        }
    }
}

/// 校验边：端点存在性 + 端点类型与边类型匹配。
fn validate_edge(
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
        (EdgeKind::Contains, Some(NodeType::LayoutBlock), Some(NodeType::Group))
        | (EdgeKind::Contains, Some(NodeType::LayoutBlock), Some(NodeType::Control))
        | (EdgeKind::Contains, Some(NodeType::Control), Some(NodeType::Class))
        | (EdgeKind::Contains, Some(NodeType::Class), Some(NodeType::Object)) => true,
        (EdgeKind::MemberOf, Some(NodeType::Control), Some(NodeType::Group)) => true,
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

/// 条件表达式校验（基础集，RFC 0007 决策 1）。
fn validate_expr(expr: &str) -> Option<String> {
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
fn find_cycle(edges: &[BlueprintEdge]) -> Option<Vec<NodeKey>> {
    // 只保留求值链边
    let eval_edges: Vec<&BlueprintEdge> = edges
        .iter()
        .filter(|e| matches!(e.edge_kind, EdgeKind::Fires | EdgeKind::Guards))
        .collect();
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in &eval_edges {
        adj.entry(e.from.as_str()).or_default().push(e.to.as_str());
    }
    // 0=未访问 1=访问中 2=已结束；记录路径用于还原环。
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
) -> Option<Vec<NodeKey>> {
    state.insert(node, 1);
    path.push(node);
    if let Some(nexts) = adj.get(node) {
        for &next in nexts {
            match state.get(next) {
                Some(&1) => {
                    // 找到环：从 next 到 path 末尾截取
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

// ============================== 存储行 ==============================

/// 仓库蓝图行：与仓库库 `blueprints` 表一一对应。
#[derive(Debug, Clone, PartialEq)]
pub struct BlueprintRow {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub is_default: bool,
    pub schema_version: i64,
    pub blueprint_json: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 全局蓝图模板行：与全局库 `blueprint_templates` 表一一对应。
#[derive(Debug, Clone, PartialEq)]
pub struct BlueprintTemplateRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub schema_version: i64,
    pub blueprint_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control(key: &str, panel_id: &str) -> BlueprintNode {
        BlueprintNode {
            key: key.into(),
            node_type: NodeType::Control,
            name: None,
            panel_id: Some(panel_id.into()),
            title_key: None,
            control: None,
            media_type: None,
            class: None,
            scope: None,
            mode: None,
            default_visible: None,
            hide_direction: None,
            position: None,
            trigger: None,
            target: None,
            expr: None,
            op: None,
            payload: None,
        }
    }

    fn node_of(key: &str, node_type: NodeType) -> BlueprintNode {
        BlueprintNode {
            key: key.into(),
            node_type,
            ..control("placeholder", "p")
        }
    }

    #[test]
    fn enums_roundtrip() {
        for v in [
            NodeType::LayoutBlock,
            NodeType::Control,
            NodeType::Class,
            NodeType::Object,
            NodeType::Group,
            NodeType::Event,
            NodeType::Condition,
            NodeType::Action,
        ] {
            assert_eq!(NodeType::from_str(v.as_str()), Some(v));
        }
        for v in [GroupMode::Exclusive, GroupMode::Independent] {
            assert_eq!(GroupMode::from_str(v.as_str()), Some(v));
        }
        for v in [
            Trigger::Click,
            Trigger::DoubleClick,
            Trigger::SelectionChange,
        ] {
            assert_eq!(Trigger::from_str(v.as_str()), Some(v));
        }
        for v in [
            ActionOp::Show,
            ActionOp::Hide,
            ActionOp::Toggle,
            ActionOp::Collapse,
            ActionOp::Expand,
        ] {
            assert_eq!(ActionOp::from_str(v.as_str()), Some(v));
            assert_eq!(v.is_group_op(), matches!(v, ActionOp::Collapse | ActionOp::Expand));
        }
        for v in [
            EdgeKind::Contains,
            EdgeKind::MemberOf,
            EdgeKind::Fires,
            EdgeKind::Guards,
        ] {
            assert_eq!(EdgeKind::from_str(v.as_str()), Some(v));
        }
    }

    #[test]
    fn hide_direction_roundtrip_including_toward() {
        for d in [
            HideDirection::Left,
            HideDirection::Right,
            HideDirection::Up,
            HideDirection::Down,
            HideDirection::Toward("g_other".into()),
        ] {
            assert_eq!(HideDirection::from_str(&d.as_str()), Some(d));
        }
        assert_eq!(HideDirection::from_str("toward:"), None);
        assert_eq!(HideDirection::from_str("unknown"), None);
        assert_eq!(
            HideDirection::Toward("g".into()).toward_target(),
            Some("g")
        );
        assert_eq!(HideDirection::Left.toward_target(), None);
    }

    #[test]
    fn hide_direction_serde_json() {
        let json = serde_json::to_string(&HideDirection::Toward("g_x".into())).unwrap();
        assert_eq!(json, "\"toward:g_x\"");
        let back: HideDirection = serde_json::from_str(&json).unwrap();
        assert_eq!(back, HideDirection::Toward("g_x".into()));
    }

    #[test]
    fn graph_json_roundtrip() {
        let json = r#"{
          "schema_version": 1,
          "nodes": [
            {"key":"c_v","type":"control","panel_id":"viewer","title_key":"panel.viewer"},
            {"key":"k_i","type":"class","control":"c_v","media_type":"image"},
            {"key":"o_1","type":"object","class":"k_i","scope":"double_clicked"},
            {"key":"g_1","type":"group","mode":"exclusive","default_visible":[],
             "hide_direction":"left","position":{"x":10,"y":20}},
            {"key":"e_1","type":"event","trigger":"double_click","target":"o_1"},
            {"key":"c_1","type":"condition","expr":"media_type == image"},
            {"key":"a_1","type":"action","op":"show","target":"c_v"}
          ],
          "edges": [
            {"from":"e_1","to":"c_1","kind":"fires","order":1},
            {"from":"c_1","to":"a_1","kind":"guards","order":1},
            {"from":"c_v","to":"k_i","kind":"contains","order":1},
            {"from":"k_i","to":"o_1","kind":"contains","order":1},
            {"from":"c_v","to":"g_1","kind":"memberOf","order":1}
          ]
        }"#;
        let graph = BlueprintGraph::from_json(json).expect("解析失败");
        assert_eq!(graph.nodes.len(), 7);
        assert_eq!(graph.edges.len(), 5);
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
        let back = BlueprintGraph::from_json(&graph.to_json()).expect("再解析失败");
        assert_eq!(back, graph);
    }

    #[test]
    fn validate_rejects_duplicate_key() {
        let mut graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"c","type":"control","panel_id":"player"}
            ],"edges":[]}"#,
        )
        .unwrap();
        let errors = graph.validate();
        assert!(errors.iter().any(|e| e.contains("key 重复")));
        graph.nodes.pop();
        assert!(graph.validate().is_empty());
    }

    #[test]
    fn validate_accepts_layout_block_contains_group_and_control() {
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"blk","type":"layout_block","name":"右栏"},
              {"key":"g","type":"group","mode":"exclusive"},
              {"key":"c","type":"control","panel_id":"viewer"}
            ],"edges":[
              {"from":"blk","to":"g","kind":"contains","order":1},
              {"from":"blk","to":"c","kind":"contains","order":1}
            ]}"#,
        )
        .unwrap();
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
        // 反向：控件 contains 布局块 → 非法
        let bad = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"blk","type":"layout_block"},
              {"key":"c","type":"control","panel_id":"viewer"}
            ],"edges":[{"from":"c","to":"blk","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(bad.validate().iter().any(|e| e.contains("非法边")));
    }

    #[test]
    fn validate_rejects_dangling_edge() {
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"a","type":"action","op":"show","target":"c"}
            ],"edges":[{"from":"e_missing","to":"a","kind":"fires","order":1}]}"#,
        )
        .unwrap();
        assert!(graph.validate().iter().any(|e| e.contains("不存在的起点")));
    }

    #[test]
    fn node_name_field_roundtrip_and_optional() {
        let json = r#"{"schema_version":1,"nodes":[
          {"key":"c","type":"control","name":"媒体预览","panel_id":"media"}
        ],"edges":[]}"#;
        let graph = BlueprintGraph::from_json(json).expect("解析失败");
        assert_eq!(graph.nodes[0].name.as_deref(), Some("媒体预览"));
        assert!(graph.validate().is_empty());
        let back = BlueprintGraph::from_json(&graph.to_json()).expect("再解析失败");
        assert_eq!(back.nodes[0].name.as_deref(), Some("媒体预览"));

        // 缺省 name → None（旧文档兼容）
        let legacy = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"media"}
            ],"edges":[]}"#,
        )
        .expect("解析失败");
        assert_eq!(legacy.nodes[0].name, None);
        assert!(legacy.validate().is_empty());
    }

    #[test]
    fn validate_rejects_illegal_edge_endpoints() {
        // fires 的起点必须是事件节点
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"a","type":"action","op":"show","target":"c"}
            ],"edges":[{"from":"c","to":"a","kind":"fires","order":1}]}"#,
        )
        .unwrap();
        assert!(graph.validate().iter().any(|e| e.contains("非法边")));
    }

    #[test]
    fn validate_rejects_cycle_in_fires_guards() {
        // 人为构造：条件 A fires 条件 B，B fires A → 环
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"ca","type":"condition","expr":"media_type == image"},
              {"key":"cb","type":"condition","expr":"media_type == video"},
              {"key":"a","type":"action","op":"show","target":"c"}
            ],"edges":[
              {"from":"ca","to":"cb","kind":"fires","order":1},
              {"from":"cb","to":"ca","kind":"fires","order":1},
              {"from":"cb","to":"a","kind":"guards","order":1}
            ]}"#,
        )
        .unwrap();
        let errors = graph.validate();
        assert!(errors.iter().any(|e| e.contains("存在环")), "{errors:?}");
    }

    #[test]
    fn validate_rejects_exclusive_group_multi_default_visible() {
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c1","type":"control","panel_id":"viewer"},
              {"key":"c2","type":"control","panel_id":"player"},
              {"key":"g","type":"group","mode":"exclusive","default_visible":["c1","c2"]}
            ],"edges":[]}"#,
        )
        .unwrap();
        assert!(graph
            .validate()
            .iter()
            .any(|e| e.contains("default_visible 至多一个成员")));
    }

    #[test]
    fn validate_rejects_class_control_not_control_node() {
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"k","type":"class","control":"g","media_type":"image"},
              {"key":"g","type":"group","mode":"exclusive"}
            ],"edges":[]}"#,
        )
        .unwrap();
        assert!(graph.validate().iter().any(|e| e.contains("必须是控件节点")));
    }

    #[test]
    fn validate_rejects_bad_expr_and_action_target() {
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"cond","type":"condition","expr":"rating == 3"},
              {"key":"a","type":"action","op":"collapse","target":"c"}
            ],"edges":[]}"#,
        )
        .unwrap();
        let errors = graph.validate();
        assert!(errors.iter().any(|e| e.contains("不支持的条件")), "{errors:?}");
        assert!(errors.iter().any(|e| e.contains("必须是组节点")), "{errors:?}");
    }
}
