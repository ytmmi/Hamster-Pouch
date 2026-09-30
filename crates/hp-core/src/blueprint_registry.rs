//! 蓝图**节点类型注册表**（RFC 0010 决策 5/6 / `docs/spec/blueprint-node-standard.md`
//! 第 2.3、2.4、6 节）。
//!
//! 10 种内置节点类型的定义表在这里升级为**注册表**：宿主内置 10 种 + 插件注册项
//! （`plugin.<plugin_id>.<local_id>`）。声明参数与 TS
//! `packages/config/src/blueprintNodes.ts` 的 `BLUEPRINT_NODE_REGISTRY` 逐项对齐，
//! 一致性由 `pnpm check:blueprint-nodes` 断言。
//!
//! 本文件只放**注册表本体与查询视图**（内置 + 插件 + 面板事实）：
//!
//! - 节点声明与取值域：`blueprint_node_decl.rs`；
//! - 声明校验与端口推导：`blueprint_node_decl_validate.rs`；
//! - 宿主内置 10 种定义表：`blueprint_builtin_nodes.rs`。
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

use crate::blueprint_types::{EdgeKind, NodeType};

// 域内再导出：`crate::blueprint_registry::<节点声明/定义表>` 这些历史路径保持可用
// （消费方只认本模块，域内文件怎么分不影响调用方）。
pub use crate::blueprint_builtin_nodes::{BuiltinNodeSpec, BUILTIN_NODE_SPECS};
pub use crate::blueprint_node_decl::{
    BlueprintNodeDecl, EvaluationRole, NodeFieldDecl, NodePortDecl, NodeRole, NodeSeverity,
    NodeSeverityDecl, PortSide, SeverityLevel,
};
pub use crate::blueprint_node_decl_validate::{
    derive_ports, validate_node_decl, NodeDeclCtx, NODE_EVENT_NAMES, NODE_FIELD_TYPES,
};

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
