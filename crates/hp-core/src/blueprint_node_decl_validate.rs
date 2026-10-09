//! 插件蓝图节点声明的**校验与端口推导**（RFC 0010 决策 6 /
//! `docs/spec/blueprint-node-standard.md` 第 2.3、2.4、6 节）。
//!
//! 校验返回全部**硬错误**（空 = 可注册）：命名空间、必需声明参数、取值域、`ports` 的
//! 边类型、**不得携带自定义渲染/逻辑**、**暂不能参与结构边**（文档开放点）。
//! 端口推导在 `ports` 未显式声明时给出与内置 10 种**逐项相同**的端口（零回归）。
//!
//! 声明结构在 `blueprint_node_decl.rs`；宿主内置定义表在 `blueprint_builtin_nodes.rs`。
//!
//! 纯数据 + 纯函数：不依赖 Tauri/SQLite/文件系统。

use crate::blueprint_node_decl::{
    BlueprintNodeDecl, EvaluationRole, NodePortDecl, NodeRole, PortSide, SeverityLevel,
};
use crate::blueprint_types::{EdgeKind, NodeType};

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
    // 判据一律用「**包含**某个子类型」而不是「恰好只有一个该子类型」——与 TS 侧
    // `resolveNodePorts` 逐项一致（由 `pnpm check:blueprint-nodes` 断言）。
    // 旧写法 `children == ["class"]` 在类目加了 `subclass` 子级之后会**静默丢掉
    // `on` 输出口**，画布上"类目 → 操作"就再也连不出来（真实回归）。
    let is_panel_like = child_names.contains(&"class");
    let is_object_parent = child_names.contains(&"object");
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
            if is_panel_like || is_object_parent || is_object_like {
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
