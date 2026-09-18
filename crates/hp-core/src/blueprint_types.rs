//! 蓝图枚举与取值类型（RFC 0007 决策 1 / D29 / D46-D60）。
//!
//! 只承载**取值域**：节点类型、组模式、隐藏方向、触发、动作、边类型、外观档位、浮层锚点。
//! 每个枚举都提供 `as_str` / `from_str`（与 JSON 文档的字符串取值一一对应），
//! 另加一个语义谓词（如 `is_group_op`）以便校验层按语义而非硬编码字符串分类。
//!
//! 结构体（节点/边/层/尺寸）在 `blueprint_node.rs`，图文档在 `blueprint.rs`；
//! 本文件是纯数据，不依赖 Tauri/SQLite/文件系统。

use std::fmt;

use serde::{Deserialize, Serialize};

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
    /// 包含：界面 → 布局块/浮层；布局块/浮层 → 标签组/面板控件；
    /// 标签组 → 面板控件；面板控件 → 类 → 对象。
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
            OverlayAnchor::BottomLeft
            | OverlayAnchor::BottomCenter
            | OverlayAnchor::BottomRight => AnchorAxis::End,
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
