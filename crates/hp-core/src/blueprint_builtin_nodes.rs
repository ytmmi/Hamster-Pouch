//! 宿主**内置 10 种节点类型的定义表**（`docs/spec/blueprint-node-standard.md` 第 2 节：
//! 字段/父子/端口/事件一处声明的单一事实来源）。
//!
//! 与 `packages/config/src/blueprintNodes.ts` 的 `BLUEPRINT_NODE_REGISTRY` 逐项对齐，
//! 一致性由 `pnpm check:blueprint-nodes` 断言；端口表由本表**派生**（`derive_ports`）。
//!
//! 注册表（内置 + 插件 + 面板事实的查询视图）在 `blueprint_registry.rs`。
//!
//! 纯数据 + 纯函数：不依赖 Tauri/SQLite/文件系统。

use crate::blueprint_node_decl::{EvaluationRole, NodeRole};
use crate::blueprint_types::NodeType;

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

/// 宿主内置 **12 种**节点类型的定义表（顺序与 [`NodeType::BUILTIN_NAMES`] 一致）。
///
/// 与 `packages/config/src/blueprintNodes.ts` 的 `BLUEPRINT_NODE_REGISTRY` 逐项对齐。
pub const BUILTIN_NODE_SPECS: [BuiltinNodeSpec; 12] = [
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
        // 面板之下**只有类目这一条结构轴**（D136：标记不再是面板下的平行轴）。
        // ⚠️ 必须与 `Class` 的 `parents = ["control"]` 双向互指：`can_contain` 只读父节点的
        // `children`，漏一侧会让该边静默连不出来（与 TS `blueprintNodes.ts` 逐项一致，
        // D104 的教训）。
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
        // 类目之下**两条并列的从属轴**（D136）：子类（格式细分）与对象（可执行对象）。
        //
        // ⚠️ **D137（v3）改动**：`mark` 从本行移除——用户的最终裁决是"标记要接在
        // **对象**后面，标记是对**单个对象**的细分"（不是对类目的细分）。
        // 故结构演化为 `control ⊃ class ⊃ {subclass, object}`、`object ⊃ mark`。
        // 旧文档里的 `class --contains--> mark` 由 `blueprint_migrate` 处理，不在这里放行。
        children: &["subclass", "object"],
        events: &[],
    },
    BuiltinNodeSpec {
        node_type: NodeType::Subclass,
        role: NodeRole::Structural,
        evaluation_role: EvaluationRole::Structural,
        name_from_layer: false,
        provides_name: true,
        parents: &["class"],
        children: &["object"],
        events: &[],
    },
    BuiltinNodeSpec {
        node_type: NodeType::Mark,
        role: NodeRole::Structural,
        evaluation_role: EvaluationRole::Structural,
        name_from_layer: false,
        provides_name: true,
        // 标记**从属对象**（D137/v3：`object ⊃ mark`）。
        // D136 的上一版口径是"标记从属类目、与子类并列"；用户随后裁决
        // 「标记要接在对象后面，标记是对单个对象的细分」，故父级由 `class` 改为 `object`。
        // 字段引用同步：`mark.object`（旧的 `mark.class` 仅按软告警兼容）。
        parents: &["object"],
        // 标记是**叶子**：它下面不再挂任何结构节点（v3）。
        children: &[],
        events: &[],
    },
    BuiltinNodeSpec {
        node_type: NodeType::Object,
        role: NodeRole::Structural,
        evaluation_role: EvaluationRole::Structural,
        name_from_layer: false,
        provides_name: true,
        // 对象的结构父有**两种**（两条语义轴任选其一）：类目、子类。
        //
        // ⚠️ **D137（v3）改动**：`mark` 从本行移除——v2 把标记当作对象可选的第三条
        // 父轴（"标记命中即蕴含对象意图"，方向是 `mark ⊃ object`），v3 反转该方向为
        // `object ⊃ mark`。旧的 `object.mark_ref` 字段仅保留读取以兼容旧文档。
        parents: &["class", "subclass"],
        // 对象之下**只有标记**（v3）：标记是对单个对象的细分。
        children: &["mark"],
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
