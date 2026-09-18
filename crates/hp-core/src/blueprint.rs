//! 蓝图领域模型（RFC 0007 / D28-D32 / D46-D60）。
//!
//! 蓝图是仓库内节点式「面板控件显隐 + 组布局控制」配置文档（一个 JSON 图 + schema 版本）。
//! 节点分：界面（Interface，层的根与页面）/ 布局块（LayoutBlock）/
//! 浮层（Overlay，与布局块同级的**浮层容器**，D50 修订）/ 标签组（Group）/
//! 面板控件（Control，旧称「控件」）/ 面板控件内部的类（Class）/ 类内的对象（Object），
//! 以及事件、条件、动作等逻辑节点；边语义含 contains / memberOf / fires / guards。
//!
//! **分层（D51）**：一个层 = 一张画布 = 一个界面（页面）；`BlueprintGraph.layers` 列出层，
//! 每个节点用 `layer` 归属某一层；跨层只允许 `navigate`（界面跳转，字段引用，不是边）。
//! `layers` 缺失/为空时按**单层文档**兜底（层名取界面 `name`，无则「主界面」）。
//!
//! 本模块只承载纯数据模型与校验入口（`validate` / `warnings`），不依赖 Tauri/SQLite/文件系统；
//! 校验算法在 `blueprint_validate.rs`，版本迁移在 `blueprint_migrate.rs`，
//! 存储与命令桥接分别位于 hp-store 与 src-tauri。

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::blueprint_validate as validate_impl;

/// 蓝图文档 schema 版本（当前 = 2；v1 → v2 为「引入分层」迁移，D52/D58）。
pub const BLUEPRINT_SCHEMA_VERSION: i64 = 2;

/// 浮层高度参数下界（D57：默认 1，1 最低）。
pub const OVERLAY_HEIGHT_MIN: i64 = 1;

/// 浮层高度参数上界（D57：1–10，值大者在上）。
pub const OVERLAY_HEIGHT_MAX: i64 = 10;

/// 浮层**默认最小宽**（px）：未指定尺寸时按此值，指定值小于它时按此值夹紧。
pub const OVERLAY_MIN_WIDTH: f64 = 240.0;

/// 浮层**默认最小高**（px）：未指定尺寸时按此值，指定值小于它时按此值夹紧。
pub const OVERLAY_MIN_HEIGHT: f64 = 160.0;

/// 浮层尺寸上限（px）：防止写出无意义的巨大数值（超过即硬错误）。
pub const OVERLAY_MAX_SIZE: f64 = 10000.0;

/// 节点 key（蓝图内唯一，边引用寻址依据）。
pub type NodeKey = String;

// ============================== 枚举 ==============================

/// 节点类型（RFC 0007 决策 1；D46/D47/D50）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    /// 界面：层的根节点 + 页面（一个界面 = 一个页面；每层至多一个）。
    Interface,
    /// 布局块：界面上的一个区域（如左/中/右三栏），包含标签组与面板控件。
    LayoutBlock,
    /// 浮层：与布局块同级的**容器**（可 contains 面板控件与标签组），
    /// 并承载阴影/圆角/标签隐藏等外观档位。**不再有「浮动控件」绑定**（2026-09 取消）。
    Overlay,
    /// 面板控件：dockview 面板实例（UI 组件实例，旧称「控件」）。
    Control,
    /// 类：面板控件内部条目分类（按 media_type）。
    Class,
    /// 对象：类内条目实例。
    Object,
    /// 组：面板控件容器（互斥/独立）。
    Group,
    /// 事件：触发求值。
    Event,
    /// 条件：基础判定。
    Condition,
    /// 动作：显隐/收起/界面跳转操作。
    Action,
}

impl NodeType {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeType::Interface => "interface",
            NodeType::LayoutBlock => "layout_block",
            NodeType::Overlay => "overlay",
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
            "interface" => Some(NodeType::Interface),
            "layout_block" => Some(NodeType::LayoutBlock),
            "overlay" => Some(NodeType::Overlay),
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

/// 动作操作（RFC 0007 决策 1 / D29 / D48：show/hide/toggle + collapse/expand + navigate）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionOp {
    /// 显示面板控件。
    Show,
    /// 隐藏面板控件。
    Hide,
    /// 切换（面板控件或组）。
    Toggle,
    /// 收起组（组的隐藏 = 最小化至 6px，标签条保留）。
    Collapse,
    /// 展开组（恢复收起前尺寸）。
    Expand,
    /// 界面跳转：切换到目标界面（页面）。
    Navigate,
}

impl ActionOp {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActionOp::Show => "show",
            ActionOp::Hide => "hide",
            ActionOp::Toggle => "toggle",
            ActionOp::Collapse => "collapse",
            ActionOp::Expand => "expand",
            ActionOp::Navigate => "navigate",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "show" => Some(ActionOp::Show),
            "hide" => Some(ActionOp::Hide),
            "toggle" => Some(ActionOp::Toggle),
            "collapse" => Some(ActionOp::Collapse),
            "expand" => Some(ActionOp::Expand),
            "navigate" => Some(ActionOp::Navigate),
            _ => None,
        }
    }

    /// 是否为组级操作（目标必须是组节点）。
    pub fn is_group_op(&self) -> bool {
        matches!(self, ActionOp::Collapse | ActionOp::Expand)
    }

    /// 是否为界面跳转（界面级操作，目标必须是界面节点，D48）。
    pub fn is_interface_op(&self) -> bool {
        matches!(self, ActionOp::Navigate)
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
    /// 包含：界面 → 布局块；布局块 → 标签组/面板控件；标签组 → 面板控件；面板控件 → 类 → 对象。
    Contains,
    /// 归属：面板控件 → 组（兼容旧图）。
    #[serde(rename = "memberOf")]
    MemberOf,
    /// 规则三元组之「对象 → 操作」：在对象（面板控件/类/对象）上发生操作。
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

/// 浮层外观档位（D50 修订 / D44）：阴影与圆角只允许取**宿主设计 token 档位**，
/// 具体像素由 `packages/ui` 的设计 token 决定，蓝图不写死像素（保证浅色/深色一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenLevel {
    /// 无（无阴影 / 直角）。
    None,
    /// 小档。
    Sm,
    /// 中档。
    Md,
    /// 大档。
    Lg,
}

impl TokenLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            TokenLevel::None => "none",
            TokenLevel::Sm => "sm",
            TokenLevel::Md => "md",
            TokenLevel::Lg => "lg",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "none" => Some(TokenLevel::None),
            "sm" => Some(TokenLevel::Sm),
            "md" => Some(TokenLevel::Md),
            "lg" => Some(TokenLevel::Lg),
            _ => None,
        }
    }
}

impl fmt::Display for TokenLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 浮层锚点（3×3 井字位置，D50 修订）：浮层相对**界面（宿主内容区）**的对齐位置。
///
/// 语义：`top_*` 表示浮层**上边**贴界面上边、`*_center` 表示水平居中 … 依此类推；
/// 再叠加 `offset_x` / `offset_y` 微调（见 `BlueprintNode::offset_x`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlayAnchor {
    TopLeft,
    TopCenter,
    TopRight,
    MiddleLeft,
    Center,
    MiddleRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

impl OverlayAnchor {
    /// 全部锚点（按井字顺序：上排 → 中排 → 下排），供编辑器下拉与校验使用。
    pub const ALL: [OverlayAnchor; 9] = [
        OverlayAnchor::TopLeft,
        OverlayAnchor::TopCenter,
        OverlayAnchor::TopRight,
        OverlayAnchor::MiddleLeft,
        OverlayAnchor::Center,
        OverlayAnchor::MiddleRight,
        OverlayAnchor::BottomLeft,
        OverlayAnchor::BottomCenter,
        OverlayAnchor::BottomRight,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            OverlayAnchor::TopLeft => "top_left",
            OverlayAnchor::TopCenter => "top_center",
            OverlayAnchor::TopRight => "top_right",
            OverlayAnchor::MiddleLeft => "middle_left",
            OverlayAnchor::Center => "center",
            OverlayAnchor::MiddleRight => "middle_right",
            OverlayAnchor::BottomLeft => "bottom_left",
            OverlayAnchor::BottomCenter => "bottom_center",
            OverlayAnchor::BottomRight => "bottom_right",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "top_left" => Some(OverlayAnchor::TopLeft),
            "top_center" => Some(OverlayAnchor::TopCenter),
            "top_right" => Some(OverlayAnchor::TopRight),
            "middle_left" => Some(OverlayAnchor::MiddleLeft),
            "center" => Some(OverlayAnchor::Center),
            "middle_right" => Some(OverlayAnchor::MiddleRight),
            "bottom_left" => Some(OverlayAnchor::BottomLeft),
            "bottom_center" => Some(OverlayAnchor::BottomCenter),
            "bottom_right" => Some(OverlayAnchor::BottomRight),
            _ => None,
        }
    }

    /// 水平分量：左 / 中 / 右。
    pub fn horizontal(&self) -> AnchorAxis {
        match self {
            OverlayAnchor::TopLeft | OverlayAnchor::MiddleLeft | OverlayAnchor::BottomLeft => {
                AnchorAxis::Start
            }
            OverlayAnchor::TopCenter | OverlayAnchor::Center | OverlayAnchor::BottomCenter => {
                AnchorAxis::Middle
            }
            OverlayAnchor::TopRight | OverlayAnchor::MiddleRight | OverlayAnchor::BottomRight => {
                AnchorAxis::End
            }
        }
    }

    /// 垂直分量：上 / 中 / 下。
    pub fn vertical(&self) -> AnchorAxis {
        match self {
            OverlayAnchor::TopLeft | OverlayAnchor::TopCenter | OverlayAnchor::TopRight => {
                AnchorAxis::Start
            }
            OverlayAnchor::MiddleLeft | OverlayAnchor::Center | OverlayAnchor::MiddleRight => {
                AnchorAxis::Middle
            }
            OverlayAnchor::BottomLeft | OverlayAnchor::BottomCenter | OverlayAnchor::BottomRight => {
                AnchorAxis::End
            }
        }
    }
}

/// 锚点在某一轴上的分量（起 / 中 / 末）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorAxis {
    Start,
    Middle,
    End,
}

impl fmt::Display for OverlayAnchor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 浮层尺寸（px，2026-09 用户新增）。
///
/// 与 `BlueprintNode::height`（**叠放高度参数**，1–10）区分：本结构是**框体宽高**。
/// 未指定的分量按 `OVERLAY_MIN_WIDTH` / `OVERLAY_MIN_HEIGHT` 取默认值；
/// 小于最小值时由宿主按最小值夹紧（软告警提示），大于 `OVERLAY_MAX_SIZE` 为硬错误。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OverlaySize {
    pub width: f64,
    pub height: f64,
}

impl OverlaySize {
    /// 解析后的实际尺寸：不足最小值则夹紧到最小值（**默认最小尺寸**语义）。
    pub fn resolved(&self) -> (f64, f64) {
        (
            self.width.max(OVERLAY_MIN_WIDTH),
            self.height.max(OVERLAY_MIN_HEIGHT),
        )
    }

    /// 是否小于最小尺寸（用于软告警提示）。
    pub fn below_minimum(&self) -> bool {
        self.width < OVERLAY_MIN_WIDTH || self.height < OVERLAY_MIN_HEIGHT
    }
}

/// 组/控件的目标锚点（画布编辑器定位 + 浮动/停靠；RFC 0007 / D29）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlueprintPosition {
    pub x: f64,
    pub y: f64,
}

/// 蓝图层（D51）：一个层 = 一张画布 = 一个界面（页面）；`name` 即该层界面的显示名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlueprintLayer {
    /// 层 key（蓝图内唯一、非空）。
    pub key: String,
    /// 层名（非空、蓝图内唯一，D60）；即该层界面的显示名。
    pub name: String,
}

impl BlueprintLayer {
    pub fn new(key: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            name: name.into(),
        }
    }
}

/// 蓝图节点（扁平结构，按 `node_type` 各取所需字段；RFC 0007 决策 1）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlueprintNode {
    pub key: NodeKey,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    /// 所属层 key（D51）；`layers` 为空时缺省按单层兜底推导。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    /// 显示名称（用户自定义）；缺省时由前端按类型本地化生成（如「控件 1」）。
    /// 界面节点的显示名取自**层名**（D51），不使用本字段。
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
    // action（target = 面板控件/标签组/界面/浮层 key）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<ActionOp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    // overlay（浮层，D50：**容器**，2026-09 取消「浮动控件」绑定）
    /// 初始显隐（D50）；缺省视为不显示。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    /// 浮层高度参数（D57：1–10，默认 1，值大者在上）；不是像素高度。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    /// 相对定位锚点（3×3 井字，缺省 = 居中 `center`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<OverlayAnchor>,
    /// 水平偏移：`|v| ≤ 1` 视为**界面宽度的比例**（0.25 = 右移 25%），`|v| > 1` 视为**像素**（24 = 右移 24px）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_x: Option<f64>,
    /// 垂直偏移：`|v| ≤ 1` 视为**界面高度的比例**，`|v| > 1` 视为**像素**。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_y: Option<f64>,
    /// 浮层框体尺寸（px；不写 = 取默认最小尺寸 `240×160`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<OverlaySize>,
    /// 浮层阴影档位（取宿主设计 token；非法档位在解析层报错）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<TokenLevel>,
    /// 浮层圆角档位（取宿主设计 token；非法档位在解析层报错）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<TokenLevel>,
    /// 是否隐藏浮层自带的标签/标题（只显示内容）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide_label: Option<bool>,
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
    /// 层清单（D51）；缺失/为空时按**单层文档**兜底（见 `effective_layers`）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<BlueprintLayer>,
    #[serde(default)]
    pub nodes: Vec<BlueprintNode>,
    #[serde(default)]
    pub edges: Vec<BlueprintEdge>,
}

fn default_schema_version() -> i64 {
    BLUEPRINT_SCHEMA_VERSION
}

impl BlueprintGraph {
    /// 单层兜底时使用的层 key（无界面节点可推导时）。
    pub const FALLBACK_LAYER_KEY: &'static str = "l_main";

    /// 单层兜底时的层名（无界面节点 `name` 可推导时）。
    pub const FALLBACK_LAYER_NAME: &'static str = "主界面";

    /// 解析蓝图 JSON 文档。
    pub fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("蓝图 JSON 解析失败: {e}"))
    }

    /// 序列化为 JSON 文档（紧凑格式）。
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// 解析并校验；返回全部错误（空 = 有效）。
    ///
    /// 低版本文档（`schema_version < 当前版本`）先做**内存迁移**再校验（D58：
    /// 旧文档走迁移而非拒绝；`> 当前版本` 才是硬错误）。
    pub fn validate_json(json: &str) -> Vec<String> {
        match Self::from_json(json) {
            Ok(mut graph) => {
                crate::blueprint_migrate::migrate_graph(&mut graph);
                graph.validate()
            }
            Err(e) => vec![e],
        }
    }

    /// 按 key 查找节点。
    pub fn node(&self, key: &str) -> Option<&BlueprintNode> {
        self.nodes.iter().find(|n| n.key == key)
    }

    /// 是否显式分层（`layers` 非空）。
    pub fn has_layers(&self) -> bool {
        !self.layers.is_empty()
    }

    /// 单层兜底时推导出的层 key：取首个界面节点所属层，无则 `l_main`。
    pub fn fallback_layer_key(&self) -> String {
        self.nodes
            .iter()
            .find(|n| n.node_type == NodeType::Interface)
            .and_then(|n| n.layer.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| Self::FALLBACK_LAYER_KEY.to_string())
    }

    /// 节点所属层 key（`layer` 缺省时按单层兜底推导）。
    pub fn node_layer_key(&self, node: &BlueprintNode) -> String {
        node.layer
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| self.fallback_layer_key())
    }

    /// 有效层清单：显式 `layers`，为空中时按单层兜底推导一层（层名取界面 `name` 或「主界面」）。
    ///
    /// 编辑器的"当前层"、布局的 `layer_key` 维度都以本方法的结果为准，
    /// 因此旧文档（无 `layers`）在 UI 上表现为单层文档。
    pub fn effective_layers(&self) -> Vec<BlueprintLayer> {
        if self.has_layers() {
            return self.layers.clone();
        }
        let name = self
            .nodes
            .iter()
            .find(|n| n.node_type == NodeType::Interface)
            .and_then(|n| n.name.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| Self::FALLBACK_LAYER_NAME.to_string());
        vec![BlueprintLayer::new(self.fallback_layer_key(), name)]
    }

    /// 某层的界面节点（层的根；每层至多一个，返回首个）。
    pub fn interface_of_layer(&self, layer_key: &str) -> Option<&BlueprintNode> {
        self.nodes.iter().find(|n| {
            n.node_type == NodeType::Interface && self.node_layer_key(n) == layer_key
        })
    }

    /// 语义校验（RFC 0007 决策 6）：返回全部错误，空 = 有效。
    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();

        // 版本闸门：`>` 当前版本才是硬错误；更低版本先走迁移（D58），迁移后再校验。
        if self.schema_version > BLUEPRINT_SCHEMA_VERSION {
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
            validate_impl::validate_node(node, &by_key, &mut errors);
        }

        // 边校验
        let mut edge_seen = HashSet::new();
        for edge in &self.edges {
            validate_impl::validate_edge(edge, &by_key, &mut errors);
            if !edge_seen.insert((edge.from.clone(), edge.to.clone(), edge.edge_kind)) {
                errors.push(format!(
                    "重复边: {} --{}--> {}",
                    edge.from, edge.edge_kind, edge.to
                ));
            }
        }

        // 分层规则（D51/D58/D60）：层 key/名、每层至多一个界面、节点 layer 归属、跨层边。
        validate_impl::validate_layers(self, &mut errors);

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
        if let Some(cycle) = validate_impl::find_cycle(&self.edges) {
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
    /// 分层相关的软告警：**无根层**（层内界面节点被软删除）与**浮层未绑定**（D55/D56）。
    pub fn warnings(&self) -> Vec<String> {
        let by_key: HashMap<&str, &BlueprintNode> =
            self.nodes.iter().map(|n| (n.key.as_str(), n)).collect();
        let mut warnings = Vec::new();

        // 无根层（D55）：显式分层的文档里某层没有界面节点 → 该层不可显示、跳转失效。
        if self.has_layers() {
            for layer in &self.layers {
                if self.interface_of_layer(&layer.key).is_none() {
                    warnings.push(format!(
                        "层 {name}（{key}）暂未接通：该层没有界面节点（无根层），指向它的界面跳转不会执行",
                        name = layer.name,
                        key = layer.key
                    ));
                }
            }
        }

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
                NodeType::Overlay => {
                    // 浮层是容器：内容是**面板控件/标签组**（由 contains 边表达），
                    // 因此不再有"未绑定浮动控件"这类软告警（2026-09 取消浮动控件概念）；
                    // 浮层没有子节点也只是"空浮层"，仍可保存。
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
