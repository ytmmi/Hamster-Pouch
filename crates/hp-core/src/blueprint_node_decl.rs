//! 蓝图**节点声明**（RFC 0010 决策 5/6 / `docs/spec/blueprint-node-standard.md`
//! 第 2.3、2.4 节）：取值域（`role` / `evaluation_role` / `severity` / 端口方向）与
//! 声明结构本身，含缺省时的**解析**（未声明即按 `role` 与 `parents`/`children` 推导）。
//!
//! 校验规则在 `blueprint_node_decl_validate.rs`；宿主内置定义表在
//! `blueprint_builtin_nodes.rs`；由声明构成的注册表在 `blueprint_registry.rs`。
//!
//! 纯数据 + 纯函数：不依赖 Tauri/SQLite/文件系统。

use serde::{Deserialize, Serialize};

use crate::blueprint_node_decl_validate::derive_ports;

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
