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
    /// 包含：布局块 → 标签组/控件；标签组 → 控件；控件 → 类 → 对象。
    Contains,
    /// 归属：控件 → 组（兼容旧图）。
    #[serde(rename = "memberOf")]
    MemberOf,
    /// 规则三元组之「对象 → 操作」：在对象（控件/类/对象）上发生操作。
    On,
    /// 触发：操作 → 条件/状态。
    Fires,
    /// 守卫：条件 → 状态。
    Guards,
}

impl EdgeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EdgeKind::Contains => "contains",
            EdgeKind::MemberOf => "memberOf",
            EdgeKind::On => "on",
            EdgeKind::Fires => "fires",
            EdgeKind::Guards => "guards",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "contains" => Some(EdgeKind::Contains),
            "memberOf" => Some(EdgeKind::MemberOf),
            "on" => Some(EdgeKind::On),
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

        // 各节点类型字段校验（硬错误）
        for node in &self.nodes {
            blueprint_validate::validate_node(node, &by_key, &mut errors);
        }

        // 边校验
        let mut edge_seen = HashSet::new();
        for edge in &self.edges {
            blueprint_validate::validate_edge(edge, &by_key, &mut errors);
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
        if let Some(cycle) = blueprint_validate::find_cycle(&self.edges) {
            errors.push(format!(
                "fires/guards 求值链存在环: {}",
                cycle
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(" -> ")
            ));
        }

        // 操作（事件）必须有对象来源、状态必须有触发来源、条件必须有 fires 入边，
        // 以及必填引用缺失——这些都属**软问题**（未接通），由 `warnings` 报告，
        // 不阻塞保存（删除关联节点后允许先存下中间状态，画布以灰色呈现）。

        errors
    }

    /// 语义校验的"软问题"清单（未接通类）：不阻塞保存，仅供编辑提示与画布呈现。
    ///
    /// 设计意图（RFC 0007）：删除节点/断线后**不级联删除关联节点**，允许先保存中间
    /// 状态；不生效的部分由画布灰色表示，用户接回去即恢复。
    pub fn warnings(&self) -> Vec<String> {
        let by_key: HashMap<&str, &BlueprintNode> =
            self.nodes.iter().map(|n| (n.key.as_str(), n)).collect();
        let mut warnings = Vec::new();

        for node in &self.nodes {
            match node.node_type {
                NodeType::Event => {
                    let has_target = node.target.is_some();
                    let has_on_edge = self
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
                    let has_source = self
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
                    let has_trigger = self.edges.iter().any(|e| {
                        e.to == node.key
                            && (e.edge_kind == EdgeKind::Fires
                                || e.edge_kind == EdgeKind::Guards)
                    });
                    if !has_trigger {
                        warnings.push(format!(
                            "状态节点 {key} 暂未接通：缺触发来源（连线 操作/条件→状态）",
                            key = node.key
                        ));
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
}

/// 校验算法（硬错误 + 软问题/未接通）；数据模型在父模块。
mod blueprint_validate {
    use super::*;

    /// 校验单个节点字段与引用（硬错误）。
    pub(super) fn validate_node(
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
                // panel_id 缺失 → 未接通（软），不阻塞保存。
            }
            NodeType::Class => {
                // control 缺失/指向已删除节点 → 未接通（软）；指向存在但类型不符 → 硬错误。
                if let Some(ck) = node.control.as_deref() {
                    if let Some(target) = by_key.get(ck) {
                        if target.node_type != NodeType::Control {
                            errors.push(format!(
                                "类节点 {key} 的 control 必须指向控件节点（当前指向 {}）",
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
                                    "组节点 {key} 的 default_visible 成员 {vk} 必须是控件节点"
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
                                "操作节点 {key} 的 target 必须指向控件/类/对象节点（当前指向 {}）",
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
                            Some(ActionOp::Show) | Some(ActionOp::Hide) => {
                                actual == NodeType::Control
                            }
                            Some(ActionOp::Collapse) | Some(ActionOp::Expand) => {
                                actual == NodeType::Group
                            }
                            Some(ActionOp::Toggle) => {
                                matches!(actual, NodeType::Control | NodeType::Group)
                            }
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
    pub(super) fn validate_edge(
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

    /// 条件表达式校验（基础集，RFC 0007 决策 1）。
    pub(super) fn validate_expr(expr: &str) -> Option<String> {
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
    pub(super) fn find_cycle(edges: &[BlueprintEdge]) -> Option<Vec<NodeKey>> {
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
    ) -> Option<Vec<NodeKey>> {
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
include!("blueprint_tests.rs");
