//! 蓝图结构体（RFC 0007 决策 1 / D50 修订 / D51）。
//!
//! 节点（界面/布局块/浮层/标签组/面板控件/类/对象/事件/条件/动作共用扁平结构）、
//! 边、层与浮层尺寸/坐标。取值域（枚举）在 `blueprint_types.rs`，
//! 图文档（`BlueprintGraph`）与校验入口在 `blueprint.rs`。
//!
//! 纯数据：不依赖 Tauri/SQLite/文件系统；字段的**必填/可选取舍**由
//! `blueprint_validate.rs`（硬错误）与 `blueprint_warnings.rs`（未接通软告警）判定。

use serde::{Deserialize, Serialize};

use crate::blueprint::{OVERLAY_MIN_HEIGHT, OVERLAY_MIN_WIDTH};
use crate::blueprint_types::{
    ActionOp, EdgeKind, GroupMode, HideDirection, NodeType, OverlayAnchor, TokenLevel, Trigger,
};

/// 节点 key（蓝图内唯一，边引用寻址依据）。
pub type NodeKey = String;

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
///
/// `is_home`（D67）= **主界面标记**：应用进入该仓库时默认显示的界面。同一蓝图**至多一个**
/// 层可标记（多于一个为硬错误）；无标记时由消费层回退到**第一个层**（旧文档兼容）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlueprintLayer {
    /// 层 key（蓝图内唯一、非空）。
    pub key: String,
    /// 层名（非空、蓝图内唯一，D60）；即该层界面的显示名。
    pub name: String,
    /// 是否为主界面（默认进入该仓库时显示的界面，D67）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_home: Option<bool>,
}

impl BlueprintLayer {
    /// 普通层（非主界面）。
    pub fn new(key: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            name: name.into(),
            is_home: None,
        }
    }

    /// 主界面层（D67）。
    pub fn home(key: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            name: name.into(),
            is_home: Some(true),
        }
    }

    /// 是否被标记为主界面。
    pub fn is_home(&self) -> bool {
        self.is_home == Some(true)
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
    // class（所属面板 key）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control: Option<NodeKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    // subclass
    /// 子类的**格式细分**（`subclass` 节点；取值域按所属类目的 `media_type` 分域：
    /// `text` → `epub` / `txt` / `md`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    // mark
    /// **标记 id**（`mark` 节点；引用可注册的标记清单：`book` / `manga` …）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark: Option<String>,
    // object（所属 类目 / 子类 / 标记 三条轴之一）
    /// 对象所属的**类目** key（三条轴任选其一）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<NodeKey>,
    /// 对象所属的**子类** key（三条轴任选其一）。
    ///
    /// 字段名与 TS 定义表一致；注意它在 `subclass` 节点上是"所属类目"的引用，
    /// 而在 `object` 节点上是"所属子类"的引用——**同名不同义**，按节点类型分流。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subclass: Option<NodeKey>,
    /// 对象所属的**标记节点** key（三条轴任选其一）。
    ///
    /// 刻意**不叫** `mark`：`mark` 已经是"标记 id"（`mark` 节点上的枚举字段），
    /// 而本字段是"挂在哪个标记节点下"的 **key 引用**；扁平的 JSON 结构不允许
    /// 一个键有两种含义，因此加 `_ref` 后缀区分（与 `panel_id` 同为 snake_case）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark_ref: Option<NodeKey>,
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
