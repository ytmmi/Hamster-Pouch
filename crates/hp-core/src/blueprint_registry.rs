//! 蓝图**节点类型注册表**（RFC 0010 决策 5/6 / `docs/spec/blueprint-node-standard.md`
//! 第 2.3、2.4、6 节）。
//!
//! 10 种内置节点类型的定义表在这里升级为**注册表**：宿主内置 10 种 + 插件注册项
//! （`plugin.<plugin_id>.<local_id>`）。声明参数与 TS
//! `packages/config/src/blueprintNodes.ts` 的 `BLUEPRINT_NODE_REGISTRY` 逐项对齐，
//! 一致性由 `pnpm check:blueprint-nodes` 断言。
//!
//! **本版边界（与文档开放点一致，不自行放宽）**：
//!
//! - `ports` / `severity` / `evaluation_role` 缺省时按现有规则**推导**，内置 10 种的
//!   行为与 RFC 0010 之前**逐项相同**（零回归）；
//! - 插件注册的节点类型**暂不能参与结构边**（`contains` 父/子）——这是文档列明的开放点，
//!   因此注册时声明非空 `parents`/`children` 即硬错误；
//! - 端点类型不是宿主内置类型时，边**不做类型判定**（既不报硬错误也不参与求值）：
//!   `type` 命名合法但当前无注册项时按"未接通"处理（软告警、允许保存、插件恢复后自动恢复），
//!   而不是把用户的整篇蓝图判成非法边。
//!
//! 纯数据 + 纯函数：不依赖 Tauri/SQLite/文件系统。

use serde::{Deserialize, Serialize};

use crate::blueprint_types::{EdgeKind, NodeType};

/// 结构角色（沿用现有取值域）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeRole {
    /// 层根（与层 1:1）。
    Root,
    /// 容器（浮层）。
    Container,
    /// 结构中间层。
    Structural,
    /// 规则三节点（不进结构树）。
    Logic,
}

impl NodeRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeRole::Root => "root",
            NodeRole::Container => "container",
            NodeRole::Structural => "structural",
            NodeRole::Logic => "logic",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "root" => Some(NodeRole::Root),
            "container" => Some(NodeRole::Container),
            "structural" => Some(NodeRole::Structural),
            "logic" => Some(NodeRole::Logic),
            _ => None,
        }
    }
}

/// 引擎语义（`evaluation_role`）：是否进结构树、是否为规则节点、是否可做动作目标。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvaluationRole {
    /// 进结构树（结构对账 + 布局映射）。
    Structural,
    /// 规则起点（操作）。
    Trigger,
    /// 规则中间（条件）。
    Condition,
    /// 规则终点（状态/动作）。
    Action,
}

impl EvaluationRole {
    /// 全部取值（供自检脚本与文档比对）。
    pub const ALL: [EvaluationRole; 4] = [
        EvaluationRole::Structural,
        EvaluationRole::Trigger,
        EvaluationRole::Condition,
        EvaluationRole::Action,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            EvaluationRole::Structural => "structural",
            EvaluationRole::Trigger => "trigger",
            EvaluationRole::Condition => "condition",
            EvaluationRole::Action => "action",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "structural" => Some(EvaluationRole::Structural),
            "trigger" => Some(EvaluationRole::Trigger),
            "condition" => Some(EvaluationRole::Condition),
            "action" => Some(EvaluationRole::Action),
            _ => None,
        }
    }

    /// 是否进结构树（`contains` 层级）。
    pub fn in_structure_tree(&self) -> bool {
        matches!(self, EvaluationRole::Structural)
    }

    /// 是否为规则节点（操作/条件/状态）。
    pub fn is_rule_node(&self) -> bool {
        !self.in_structure_tree()
    }
}

/// 校验策略档位：该类型的字段/引用问题算**硬错误**还是**软告警（未接通）**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeverityLevel {
    /// 硬错误（拒绝保存）。
    Hard,
    /// 软告警（不阻塞保存，画布灰显）。
    Soft,
}

impl SeverityLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            SeverityLevel::Hard => "hard",
            SeverityLevel::Soft => "soft",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "hard" => Some(SeverityLevel::Hard),
            "soft" => Some(SeverityLevel::Soft),
            _ => None,
        }
    }
}

/// 一个类型的校验策略（`severity`）。
///
/// 缺省沿用第 6 节既有口径：**字段问题 = 硬错误**、**引用缺失 = 软告警**
/// （"引用存在但类型不符"仍是硬错误，不在此列）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeSeverity {
    pub field_issue: SeverityLevel,
    pub missing_ref: SeverityLevel,
}

impl Default for NodeSeverity {
    fn default() -> Self {
        Self {
            field_issue: SeverityLevel::Hard,
            missing_ref: SeverityLevel::Soft,
        }
    }
}

/// 端口方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortSide {
    In,
    Out,
}

impl PortSide {
    pub fn as_str(&self) -> &'static str {
        match self {
            PortSide::In => "in",
            PortSide::Out => "out",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "in" => Some(PortSide::In),
            "out" => Some(PortSide::Out),
            _ => None,
        }
    }
}

/// 端口声明（`{ id, side, edge }`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodePortDecl {
    pub id: String,
    pub side: String,
    /// 允许的边类型（`contains` / `memberOf` / `on` / `fires` / `guards`）。
    pub edge: String,
}

/// 校验策略声明（`{ fieldIssue, missingRef }`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeSeverityDecl {
    #[serde(rename = "fieldIssue")]
    pub field_issue: String,
    #[serde(rename = "missingRef")]
    pub missing_ref: String,
}

/// 专属字段声明（插件注册项的 `fields[]`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeFieldDecl {
    pub name: String,
    /// `string` / `number` / `boolean` / `enum` / `ref` / `refArray` / `position` / `size`。
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default, rename = "softWhenMissing")]
    pub soft_when_missing: bool,
    /// `enum` 的允许取值；`ref` 的目标类型。
    #[serde(default)]
    pub values: Vec<String>,
}

/// 插件注册的蓝图节点类型声明（RFC 0010 决策 5/6；纯数据，不含代码）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlueprintNodeDecl {
    /// 节点稳定类型标识（**必须** `plugin.<plugin_id>.<local_id>`）。
    #[serde(rename = "type")]
    pub node_type: String,
    /// i18n 键（显示名走插件自己的语言资源）。
    pub label_key: String,
    /// `root` / `container` / `structural` / `logic`。
    pub role: String,
    #[serde(default)]
    pub name_from_layer: bool,
    #[serde(default = "default_true")]
    pub provides_name: bool,
    #[serde(default)]
    pub fields: Vec<NodeFieldDecl>,
    #[serde(default)]
    pub parents: Vec<String>,
    #[serde(default)]
    pub children: Vec<String>,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub ports: Vec<NodePortDecl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<NodeSeverityDecl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluation_role: Option<String>,
}

/// serde 缺省 `true`（`providesName` 缺省可带自定义 `name`）。
fn default_true() -> bool {
    true
}

impl BlueprintNodeDecl {
    /// 该声明的 `severity`（缺省沿用既有口径）。
    pub fn resolved_severity(&self) -> NodeSeverity {
        match &self.severity {
            Some(s) => NodeSeverity {
                field_issue: SeverityLevel::from_str(&s.field_issue).unwrap_or(SeverityLevel::Hard),
                missing_ref: SeverityLevel::from_str(&s.missing_ref).unwrap_or(SeverityLevel::Soft),
            },
            None => NodeSeverity::default(),
        }
    }

    /// 该声明的 `evaluation_role`（缺省由 `role` 推导）。
    pub fn resolved_evaluation_role(&self) -> EvaluationRole {
        if let Some(raw) = self.evaluation_role.as_deref() {
            if let Some(role) = EvaluationRole::from_str(raw) {
                return role;
            }
        }
        match NodeRole::from_str(&self.role) {
            Some(NodeRole::Logic) => EvaluationRole::Condition,
            _ => EvaluationRole::Structural,
        }
    }

    /// 该声明的 `ports`（未声明即按 `evaluation_role` + `parents`/`children`
    /// **推导**，见 [`derive_ports`]）。
    pub fn resolved_ports(&self) -> Vec<NodePortDecl> {
        if !self.ports.is_empty() {
            return self.ports.clone();
        }
        derive_ports(
            self.resolved_evaluation_role(),
            &self.parents,
            &self.children,
            &self.events,
        )
    }
}

/// 内置类型的一条定义。
#[derive(Debug, Clone)]
pub struct BuiltinNodeSpec {
    pub node_type: NodeType,
    pub role: NodeRole,
    pub evaluation_role: EvaluationRole,
    pub name_from_layer: bool,
    pub provides_name: bool,
    /// 可作为 `contains` 父（空 = 不参与结构边）。
    pub parents: &'static [&'static str],
    /// 可作为 `contains` 子（空 = 不参与结构边）。
    pub children: &'static [&'static str],
    /// 可声明的事件（仅事件节点非空）。
    pub events: &'static [&'static str],
}

/// 宿主内置 10 种节点类型的定义表（顺序与 [`NodeType::BUILTIN_NAMES`] 一致）。
///
/// 与 `packages/config/src/blueprintNodes.ts` 的 `BLUEPRINT_NODE_REGISTRY` 逐项对齐。
pub const BUILTIN_NODE_SPECS: [BuiltinNodeSpec; 10] = [
    BuiltinNodeSpec {
        node_type: NodeType::Interface,
        role: NodeRole::Root,
        evaluation_role: EvaluationRole::Structural,
        name_from_layer: true,
        provides_name: false,
        parents: &[],
        children: &["layout_block", "overlay"],
        events: &[],
    },
    BuiltinNodeSpec {
        node_type: NodeType::LayoutBlock,
        role: NodeRole::Structural,
        evaluation_role: EvaluationRole::Structural,
        name_from_layer: false,
        provides_name: true,
        parents: &["interface"],
        children: &["group", "control"],
        events: &[],
    },
    BuiltinNodeSpec {
        node_type: NodeType::Overlay,
        role: NodeRole::Container,
        evaluation_role: EvaluationRole::Structural,
        name_from_layer: false,
        provides_name: true,
        parents: &["interface"],
        children: &["group", "control"],
        events: &[],
    },
    BuiltinNodeSpec {
        node_type: NodeType::Group,
        role: NodeRole::Structural,
        evaluation_role: EvaluationRole::Structural,
        name_from_layer: false,
        provides_name: true,
        parents: &["layout_block", "overlay"],
        children: &["control"],
        events: &[],
    },
    BuiltinNodeSpec {
        node_type: NodeType::Control,
        role: NodeRole::Structural,
        evaluation_role: EvaluationRole::Structural,
        name_from_layer: false,
        provides_name: true,
        parents: &["layout_block", "group", "overlay"],
        children: &["class"],
        events: &[],
    },
    BuiltinNodeSpec {
        node_type: NodeType::Class,
        role: NodeRole::Structural,
        evaluation_role: EvaluationRole::Structural,
        name_from_layer: false,
        provides_name: true,
        parents: &["control"],
        children: &["object"],
        events: &[],
    },
    BuiltinNodeSpec {
        node_type: NodeType::Object,
        role: NodeRole::Structural,
        evaluation_role: EvaluationRole::Structural,
        name_from_layer: false,
        provides_name: true,
        parents: &["class"],
        children: &[],
        events: &[],
    },
    BuiltinNodeSpec {
        node_type: NodeType::Event,
        role: NodeRole::Logic,
        evaluation_role: EvaluationRole::Trigger,
        name_from_layer: false,
        provides_name: true,
        parents: &[],
        children: &[],
        events: &["click", "double_click", "selection_change"],
    },
    BuiltinNodeSpec {
        node_type: NodeType::Condition,
        role: NodeRole::Logic,
        evaluation_role: EvaluationRole::Condition,
        name_from_layer: false,
        provides_name: true,
        parents: &[],
        children: &[],
        events: &[],
    },
    BuiltinNodeSpec {
        node_type: NodeType::Action,
        role: NodeRole::Logic,
        evaluation_role: EvaluationRole::Action,
        name_from_layer: false,
        provides_name: true,
        parents: &[],
        children: &[],
        events: &[],
    },
];

/// 规则边（非结构边）的**输出侧来源**：`边类型 → 允许的输出节点类型`。
pub const RULE_EDGE_SOURCES: [(&str, &[&str]); 4] = [
    ("memberOf", &["control"]),
    ("on", &["control", "class", "object"]),
    ("fires", &["event"]),
    ("guards", &["condition"]),
];

/// 规则边（非结构边）的**输入侧目标**：`边类型 → 允许的输入节点类型`。
pub const RULE_EDGE_TARGETS: [(&str, &[&str]); 4] = [
    ("memberOf", &["group"]),
    ("on", &["event"]),
    ("fires", &["condition", "action"]),
    ("guards", &["action"]),
];

/// 宿主内置类型的一条查询视图。
pub struct NodeSpecView {
    pub node_type: String,
    pub role: NodeRole,
    pub evaluation_role: EvaluationRole,
    pub name_from_layer: bool,
    pub provides_name: bool,
    pub parents: &'static [&'static str],
    pub children: &'static [&'static str],
    pub events: &'static [&'static str],
    pub severity: NodeSeverity,
    pub builtin: bool,
}

/// 插件注册项在注册表里的条目（宿主把插件声明转成它）。
#[derive(Debug, Clone, PartialEq)]
pub struct RegisteredPluginNode {
    pub node_type: String,
    pub evaluation_role: EvaluationRole,
    pub severity: NodeSeverity,
}

/// 面板事实（宿主按**面板注册表**注入；RFC 0010 决策 4 / 面板标准第 5.1、5.4 节）。
///
/// - `has_class` 是「面板」与「类目」之间的**唯一开关**；违约口径按**声明者是否可变**
///   区分：宿主内置面板 = 硬错误，插件注册面板 = 未接通软告警（插件升级可能改声明）；
/// - `overlay_content = false` 的面板被浮层 `contains` = 硬错误（与"浮层不得 contains
///   布局块"同级）；`multiple_per_interface = false` 但同界面出现多个实例 = 软告警。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelFact {
    pub id: String,
    /// 该面板内部是否有条目分类（能否挂「类目」节点）。
    pub has_class: bool,
    /// 能否作为**浮层内容**（浮层 `contains` 的目标）。
    pub overlay_content: bool,
    /// 同一界面内是否允许多个实例。
    pub multiple_per_interface: bool,
    /// 是否由插件注册（决定 `has_class` 违约分级）。
    pub plugin: bool,
}

/// 宿主内置面板的事实（与 `packages/config/src/panels.ts` 的 `BUILTIN_PANEL_SPECS`
/// 逐项对齐，由 `pnpm check:panels` 断言）。
///
/// 只有**媒体预览**（`media`）有类目（图像 / 视频 / 音频），其余 13 个没有条目分类；
/// 内置面板都没收窄 `mount`（三项全开）。
pub const BUILTIN_PANEL_FACTS: [(&str, bool); 14] = [
    ("repo", false),
    ("sources", false),
    ("albums", false),
    ("media", true),
    ("viewer", false),
    ("imageviewer", false),
    ("metadata", false),
    ("tags", false),
    ("tagtable", false),
    ("color", false),
    ("player", false),
    ("tasks", false),
    ("plugins", false),
    ("blueprint", false),
];

/// 节点类型注册表：宿主内置 10 种 + 宿主注入的插件注册项 + 面板事实（`has_class`）。
///
/// `builtin_only()` 是 hp-core 的默认形态（crate 不持有"当前有哪些插件"这类宿主状态），
/// 但它**包含宿主内置 14 个面板的 `has_class` 事实**——那是宿主内置声明，与
/// [`BUILTIN_NODE_SPECS`] 同属编译期常量，不依赖插件。
/// 命令桥接层再按插件注册表补上插件节点类型与插件面板事实。
#[derive(Debug, Clone, Default)]
pub struct NodeRegistry {
    plugin: Vec<RegisteredPluginNode>,
    plugin_panels: Vec<PanelFact>,
}

impl NodeRegistry {
    /// 只含宿主内置节点类型与内置面板事实。
    pub fn builtin_only() -> Self {
        Self {
            plugin: Vec::new(),
            plugin_panels: Vec::new(),
        }
    }

    /// 含插件注册的节点类型（宿主注入）。
    pub fn with_plugin_nodes(nodes: Vec<RegisteredPluginNode>) -> Self {
        Self {
            plugin: nodes,
            plugin_panels: Vec::new(),
        }
    }

    /// 补上插件注册的面板事实（宿主注入；内置 14 个恒在）。
    pub fn with_plugin_panels(mut self, panels: Vec<PanelFact>) -> Self {
        self.plugin_panels = panels;
        self
    }

    /// 该面板的事实（未注册返回 `None` = 未知，不做判定）。
    pub fn panel_fact(&self, panel_id: &str) -> Option<PanelFact> {
        if let Some((_, has_class)) = BUILTIN_PANEL_FACTS.iter().find(|(id, _)| *id == panel_id) {
            return Some(PanelFact {
                id: panel_id.to_string(),
                has_class: *has_class,
                overlay_content: true,
                multiple_per_interface: true,
                plugin: false,
            });
        }
        self.plugin_panels
            .iter()
            .find(|p| p.id == panel_id)
            .cloned()
    }

    /// 该类型当前是否有注册项（内置或插件）。
    pub fn is_registered(&self, node_type: &NodeType) -> bool {
        match node_type {
            NodeType::Other(name) => self.plugin.iter().any(|n| n.node_type == *name),
            _ => true,
        }
    }

    /// 内置类型的定义（非内置返回 `None`）。
    pub fn builtin_spec(&self, node_type: &NodeType) -> Option<&'static BuiltinNodeSpec> {
        if !node_type.is_builtin() {
            return None;
        }
        BUILTIN_NODE_SPECS
            .iter()
            .find(|s| s.node_type == *node_type)
    }

    /// 该类型的查询视图（未注册返回 `None`）。
    pub fn spec(&self, node_type: &NodeType) -> Option<NodeSpecView> {
        if let Some(spec) = self.builtin_spec(node_type) {
            return Some(NodeSpecView {
                node_type: spec.node_type.as_str().to_string(),
                role: spec.role,
                evaluation_role: spec.evaluation_role,
                name_from_layer: spec.name_from_layer,
                provides_name: spec.provides_name,
                parents: spec.parents,
                children: spec.children,
                events: spec.events,
                severity: NodeSeverity::default(),
                builtin: true,
            });
        }
        let NodeType::Other(name) = node_type else {
            return None;
        };
        let registered = self.plugin.iter().find(|n| n.node_type == *name)?;
        Some(NodeSpecView {
            node_type: name.clone(),
            role: NodeRole::Structural,
            evaluation_role: registered.evaluation_role,
            name_from_layer: false,
            provides_name: true,
            parents: &[],
            children: &[],
            events: &[],
            severity: registered.severity,
            builtin: false,
        })
    }

    /// 该类型的校验策略（未注册 = 既有缺省口径）。
    pub fn severity(&self, node_type: &NodeType) -> NodeSeverity {
        self.spec(node_type)
            .map(|s| s.severity)
            .unwrap_or_default()
    }

    /// 该类型的引擎语义（未注册返回 `None`）。
    pub fn evaluation_role(&self, node_type: &NodeType) -> Option<EvaluationRole> {
        self.spec(node_type).map(|s| s.evaluation_role)
    }

    /// 该类型是否进结构树。
    pub fn in_structure_tree(&self, node_type: &NodeType) -> bool {
        self.evaluation_role(node_type)
            .map(|r| r.in_structure_tree())
            .unwrap_or(false)
    }

    /// `parent --contains--> child` 是否合法。
    ///
    /// **仅内置类型参与结构边**（文档开放点：插件注册项能否参与结构边未开放）。
    pub fn can_contain(&self, parent: &NodeType, child: &NodeType) -> bool {
        let Some(spec) = self.builtin_spec(parent) else {
            return false;
        };
        spec.children.iter().any(|c| *c == child.as_str())
    }

    /// 规则边端点是否合法（仅内置类型参与规则边，同开放点）。
    pub fn rule_edge_allows(&self, kind: EdgeKind, from: &NodeType, to: &NodeType) -> bool {
        let name = kind.as_str();
        let Some((_, sources)) = RULE_EDGE_SOURCES.iter().find(|(k, _)| *k == name) else {
            return false;
        };
        let Some((_, targets)) = RULE_EDGE_TARGETS.iter().find(|(k, _)| *k == name) else {
            return false;
        };
        sources.iter().any(|s| *s == from.as_str())
            && targets.iter().any(|t| *t == to.as_str())
    }
}

/// 字段类型白名单（与定义表的 `BlueprintFieldSpec.type` 一致）。
pub const NODE_FIELD_TYPES: [&str; 8] = [
    "string", "number", "boolean", "enum", "ref", "refArray", "position", "size",
];

/// 可声明的规则事件（固定最小集）。
pub const NODE_EVENT_NAMES: [&str; 3] = ["click", "double_click", "selection_change"];

/// 插件蓝图节点声明的校验上下文。
#[derive(Debug, Clone, Default)]
pub struct NodeDeclCtx {
    /// 已注册的节点类型 id（宿主内置 + 其它插件注册项）：供 `ports`/`fields.values` 引用校验。
    pub registered_node_types: Vec<String>,
}

impl NodeDeclCtx {
    /// 只含宿主内置 10 种的上下文。
    pub fn builtin() -> Self {
        Self {
            registered_node_types: NodeType::BUILTIN_NAMES
                .iter()
                .map(|s| (*s).to_string())
                .collect(),
        }
    }
}

/// 校验一份插件蓝图节点声明；返回全部**硬错误**（空 = 可注册）。
///
/// 逐条对应 `docs/spec/blueprint-node-standard.md` 第 2.3/2.4 节与 RFC 0010 决策 6：
/// 命名空间、必需声明参数、取值域、`ports` 的边类型、**不得携带自定义渲染/逻辑**。
pub fn validate_node_decl(
    decl: &BlueprintNodeDecl,
    plugin_id: Option<&str>,
    ctx: &NodeDeclCtx,
) -> Vec<String> {
    let mut errors = Vec::new();
    let ty = decl.node_type.trim();

    if ty.is_empty() {
        errors.push("蓝图节点声明缺少 type".to_string());
    } else if !crate::namespace::is_plugin_namespaced_id(ty) {
        errors.push(format!(
            "插件注册的节点类型必须用 plugin.<plugin_id>.<local_id> 形式: {ty}"
        ));
    } else if let Some(plugin_id) = plugin_id {
        if !crate::namespace::is_id_in_plugin_namespace(ty, plugin_id) {
            errors.push(format!(
                "节点类型 {ty} 不在本插件（{plugin_id}）的命名空间内：插件不得注册其它插件的类型"
            ));
        }
    }

    if decl.label_key.trim().is_empty() {
        errors.push(format!("节点类型 {ty} 缺少 label_key（D27：显示名走 i18n 键）"));
    }

    if NodeRole::from_str(&decl.role).is_none() {
        errors.push(format!(
            "节点类型 {ty} 的 role 非法: {}（允许 root/container/structural/logic）",
            decl.role
        ));
    }

    for field in &decl.fields {
        if field.name.trim().is_empty() {
            errors.push(format!("节点类型 {ty} 存在无名字段声明"));
        }
        if !NODE_FIELD_TYPES.contains(&field.field_type.as_str()) {
            errors.push(format!(
                "节点类型 {ty} 的字段 {} 类型非法: {}（允许 {}）",
                field.name,
                field.field_type,
                NODE_FIELD_TYPES.join("/")
            ));
        }
    }

    // 开放点：插件注册的节点类型**暂不能参与结构边**（`contains` 父/子）。
    // 在开放点解决前声明非空 parents/children 即硬错误，而不是让引擎接上半套语义。
    if !decl.parents.is_empty() || !decl.children.is_empty() {
        errors.push(format!(
            "节点类型 {ty} 声明了结构边端点（parents/children）：插件注册项暂不能参与 contains 结构边（文档开放点），只能落在规则类位置"
        ));
    }

    for event in &decl.events {
        if !NODE_EVENT_NAMES.contains(&event.as_str()) {
            errors.push(format!(
                "节点类型 {ty} 声明了非法事件 {event}（允许 {}）",
                NODE_EVENT_NAMES.join("/")
            ));
        }
    }

    let mut seen_ports: Vec<(String, String)> = Vec::new();
    for port in &decl.ports {
        if port.id.trim().is_empty() {
            errors.push(format!("节点类型 {ty} 存在无 id 的端口声明"));
        }
        if PortSide::from_str(&port.side).is_none() {
            errors.push(format!(
                "节点类型 {ty} 的端口 {} 方向非法: {}（允许 in/out）",
                port.id, port.side
            ));
        }
        if EdgeKind::from_str(&port.edge).is_none() {
            errors.push(format!(
                "节点类型 {ty} 的端口 {} 边类型非法: {}（允许 contains/memberOf/on/fires/guards）",
                port.id, port.edge
            ));
        }
        let key = (port.side.clone(), port.id.clone());
        if seen_ports.contains(&key) {
            errors.push(format!("节点类型 {ty} 的端口重复: {}/{}", port.side, port.id));
        } else {
            seen_ports.push(key);
        }
    }

    if let Some(severity) = &decl.severity {
        for (label, value) in [
            ("fieldIssue", &severity.field_issue),
            ("missingRef", &severity.missing_ref),
        ] {
            if SeverityLevel::from_str(value).is_none() {
                errors.push(format!(
                    "节点类型 {ty} 的 severity.{label} 非法: {value}（允许 hard/soft）"
                ));
            }
        }
    }

    if let Some(role) = decl.evaluation_role.as_deref() {
        if EvaluationRole::from_str(role).is_none() {
            errors.push(format!(
                "节点类型 {ty} 的 evaluation_role 非法: {role}（允许 structural/trigger/condition/action）"
            ));
        }
    }

    // `fields.values` 里的引用目标必须命中已注册的节点类型（其余取值是自由枚举）。
    for field in &decl.fields {
        if field.field_type != "ref" && field.field_type != "refArray" {
            continue;
        }
        for value in &field.values {
            if !ctx.registered_node_types.iter().any(|t| t == value) {
                errors.push(format!(
                    "节点类型 {ty} 的字段 {} 引用了未注册的节点类型: {value}",
                    field.name
                ));
            }
        }
    }

    errors
}

/// 由定义表的 `evaluation_role` + `parents`/`children`/`events` **推导**端口
/// （`ports` 未显式声明时）。
/// 推导必须与内置 10 种的现有画布端口**逐项相同**（零回归，由
/// `pnpm check:blueprint-nodes` 断言 `PORT_DEFS` 与它一致）：
///
/// - **结构节点**（`Structural`）：有 `parents` 即有一个输入口——**面板**（`children =
///   ["class"]`）用统一输入口 `in`（它另可接收 `memberOf` 旧图兼容边），其余结构子节点用
///   `contains`；有 `children` 即有 `contains` 输出口；**类目**（`children = ["object"]`）、
///   **对象**（有 `parents`、无 `children`）与**面板**另有 `on` 输出口，面板另有
///   `memberOf` 输出口；
/// - **操作**（`Trigger`）：`on` 入 / `fires` 出；
/// - **条件**（`Condition`）：`fires` 入 / `guards` 出；
/// - **状态**（`Action`）：`in` 入。
///
/// 这是**由定义表推导**的确定性规则，插件注册项在没有显式 `ports` 时走同一条路径。
pub fn derive_ports(
    evaluation_role: EvaluationRole,
    parents: &[String],
    children: &[String],
    events: &[String],
) -> Vec<NodePortDecl> {
    let mut ports: Vec<NodePortDecl> = Vec::new();
    let has_parents = !parents.is_empty();
    let has_children = !children.is_empty();
    let child_names: Vec<&str> = children.iter().map(String::as_str).collect();
    let is_panel_like = child_names.as_slice() == ["class"];
    let is_class_like = child_names.as_slice() == ["object"];
    let is_object_like = has_parents && !has_children;

    let mut push = |id: &str, side: PortSide, edge: &str| {
        ports.push(NodePortDecl {
            id: id.to_string(),
            side: side.as_str().to_string(),
            edge: edge.to_string(),
        });
    };

    match evaluation_role {
        EvaluationRole::Structural => {
            if has_parents {
                push(
                    if is_panel_like { "in" } else { "contains" },
                    PortSide::In,
                    EdgeKind::Contains.as_str(),
                );
            }
            if has_children {
                push(EdgeKind::Contains.as_str(), PortSide::Out, EdgeKind::Contains.as_str());
            }
            if is_panel_like {
                push(
                    EdgeKind::MemberOf.as_str(),
                    PortSide::Out,
                    EdgeKind::MemberOf.as_str(),
                );
            }
            if is_panel_like || is_class_like || is_object_like {
                push(EdgeKind::On.as_str(), PortSide::Out, EdgeKind::On.as_str());
            }
        }
        EvaluationRole::Trigger => {
            let _ = events;
            push(EdgeKind::On.as_str(), PortSide::In, EdgeKind::On.as_str());
            push(EdgeKind::Fires.as_str(), PortSide::Out, EdgeKind::Fires.as_str());
        }
        EvaluationRole::Condition => {
            push(EdgeKind::Fires.as_str(), PortSide::In, EdgeKind::Fires.as_str());
            push(EdgeKind::Guards.as_str(), PortSide::Out, EdgeKind::Guards.as_str());
        }
        EvaluationRole::Action => {
            push("in", PortSide::In, EdgeKind::Fires.as_str());
        }
    }
    ports
}
