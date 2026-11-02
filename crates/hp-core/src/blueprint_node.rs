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
    /// 面板注册表 id（`control` 节点；`title_key` 与显示名见 `docs/spec/panel-standard.md`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_key: Option<String>,
    /// **所属面板** key（`class` 节点用；D135 的分域判定据此解析面板 id）。
    ///
    /// ⚠️ **旧文档兼容（D136 / D137 迁移口径）**：`mark` 节点在 D136 之前也用本字段
    /// 表达"所属面板"，D136 改为 [`class`](Self::class)，D137 起标记再改挂到**对象**之下
    /// （[`object`](Self::object)）。标记节点上残留的 `control` 值一律按**未接通软告警**
    /// 处理（不是硬错误）：旧文档读进来只灰显、不阻塞保存，由 v2 → v3 迁移清除
    /// （详见 `blueprint_warnings::collect_issues` 与 `blueprint_migrate`）。
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
    /// **所属对象** key（`mark` 节点；D137/v3 新增）。
    ///
    /// 用户裁决（D137）：「标记要接在**对象**后面，标记是对**单个对象**的细分。」
    /// 因此 v3 的结构是 `object ⊃ mark`，标记通过本字段与 `contains` 边**双向**表达
    /// "我属于哪个对象"（字段⇔边一致性由 `blueprint_validate` / `blueprint_warnings`
    /// 按 D109 口径检查）。
    ///
    /// 与 [`mark_ref`](Self::mark_ref) **方向相反**：那个是 v2 的"对象指向标记"，
    /// 本字段是 v3 的"标记指向对象"；两者不会在同一份 v3 文档里同时出现。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object: Option<NodeKey>,
    // object（所属 类目 / 子类）
    /// **所属类目** key。
    ///
    /// - `object` 节点：两条语义轴之一（与 `subclass` 互斥）；
    /// - `mark` 节点：**仅旧文档兼容**（v3 起标记用 [`object`](Self::object)）——
    ///   v2 及更早的 `mark.class` 读进来只报**未接通软告警**，不阻塞保存
    ///   （处置方式与 [`control`](Self::control) 上的 D136 残留一致）。
    ///
    /// ⚠️ 这是**同一含义在不同节点上的复用**（"我所属的类目"），**不是**同名不同义：
    /// `class` 节点用 [`control`](Self::control) 表达"所属面板"，那是**另一个**字段名。
    /// 真正"同名不同义"的是 [`subclass`](Self::subclass)（见其注释）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<NodeKey>,
    /// 对象所属的**子类** key（两条轴任选其一）。
    ///
    /// 字段名与 TS 定义表一致；注意它在 `subclass` 节点上是"所属类目"的引用，
    /// 而在 `object` 节点上是"所属子类"的引用——**同名不同义**，按节点类型分流。
    /// （与 `class` 字段那种"同一含义复用"不同：本字段是**同一个字段名承载两个含义**。）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subclass: Option<NodeKey>,
    /// 对象所属的**标记节点** key（v2 的第三条轴）。
    ///
    /// ⚠️ **自 v3（D137）起废弃**：标记的方向反转为 `object ⊃ mark`，对象不再引用标记，
    /// 该字段**不再被解析/校验/告警使用**，仅为**读取旧文档**而保留字段位——
    /// 迁移（`blueprint_migrate`）会把对象上的旧值转写为 mark 节点上的
    /// [`object`](Self::object)，再清空本字段。新代码**不得**写入本字段。
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
