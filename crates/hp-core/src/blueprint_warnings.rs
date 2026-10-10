//! 蓝图**未接通软告警**（RFC 0007 决策 6 / D48 / D50 / D55；RFC 0010 决策 6）。
//!
//! 软告警 = **不阻塞保存**的"暂时接不通"提示：必填引用缺失或指向已删除节点、
//! 求值链缺触发来源、无根层（D55）、跳转失效（D55）、浮层未连接到界面（D50 修订）、
//! **结构节点缺少结构父**（D108：`layout_block` / `group` / `control` 没有 `contains` 入边，
//! 面板的兼容旧图形式 `memberOf` 也算接好）、
//! **节点类型当前无注册项**（插件未安装 / 未启用 / 宿主 API 不兼容，RFC 0010 决策 6）。
//!
//! 设计意图：删除节点/断线后**不级联删除关联节点**，允许先保存中间状态；
//! 不生效的部分由画布灰色呈现，用户接回去即恢复。
//! 与之相对，**硬错误**（拒绝保存）在 `blueprint_validate.rs`，
//! 二者口径必须一致：凡"引用存在但类型不符"一律是硬错误，不算未接通。
//! **前端同口径**：`apps/desktop/src/app_ui/shared/blueprintLint.ts` 的 `analyzeUnlinked`
//! 是同一套判定的前端副本（画布灰显与顶部提示用），两者由 `pnpm check:blueprint-nodes`
//! 的"结构父缺失"断言块用**同一批夹具**跑两侧比对（逐项同结论），不得只改一侧。
//!
//! 「未知 `type`」的**分流**（RFC 0010 决策 6）：`type` 不合命名规则 → 硬错误
//! （在 `blueprint_validate.rs`）；命名合法但当前无注册项 → **本文件的软告警**。

use std::collections::HashMap;

use crate::blueprint::{BlueprintGraph, OVERLAY_MIN_HEIGHT, OVERLAY_MIN_WIDTH};
use crate::blueprint_node::BlueprintNode;
use crate::blueprint_registry::{NodeRegistry, SeverityLevel};
use crate::blueprint_types::{ActionOp, EdgeKind, NodeType};

/// 收集全部未接通软告警（空 = 无告警）。
pub(crate) fn collect(graph: &BlueprintGraph) -> Vec<String> {
    collect_with(graph, &NodeRegistry::builtin_only())
}

/// 该结构节点是否有**结构父**（与前端 `blueprintLint.hasStructuralParent` 同口径）。
///
/// - `contains` **入边**（父节点须存在）= 接好了；
/// - 面板另有兼容旧图的 `memberOf` **出边**（`面板 → 标签组`，D59）= 也算接好了。
///
/// 悬空边（端点不存在）**不算**接好：它与前端 `byKey.has(...)` 的判定一致，
/// 而悬空边本身是硬错误（`validate` 会拒绝保存）。
fn has_structural_parent(graph: &BlueprintGraph, node: &BlueprintNode) -> bool {
    let attached = graph.edges.iter().any(|e| {
        e.edge_kind == EdgeKind::Contains && e.to == node.key && graph.node(&e.from).is_some()
    });
    if attached {
        return true;
    }
    node.node_type == NodeType::Control
        && graph.edges.iter().any(|e| {
            e.edge_kind == EdgeKind::MemberOf
                && e.from == node.key
                && graph.node(&e.to).is_some()
        })
}

/// 收集全部未接通软告警（带节点类型注册表）。
///
/// 注册表里没有该类型时按"当前无注册项"报软告警；宿主注入插件注册表后，
/// 已启用插件声明的节点类型不再被标记（"插件恢复后自动恢复"，RFC 0010 决策 6）。
pub(crate) fn collect_with(graph: &BlueprintGraph, registry: &NodeRegistry) -> Vec<String> {
    collect_issues(graph, registry)
        .into_iter()
        .filter(|(_, severity)| *severity == SeverityLevel::Soft)
        .map(|(message, _)| message)
        .collect()
}

/// 收集全部未接通结论（消息 + 注册表 `severity.missing_ref` 给出的分级）。
///
/// 调用方按分级分流：软 → `warnings`（不阻塞保存），硬 → `validate`（拒绝保存）。
/// 内置 10 种的 `missingRef` 缺省是 `soft`，因此分流结果与既有口径逐项相同。
pub(crate) fn collect_issues(
    graph: &BlueprintGraph,
    registry: &NodeRegistry,
) -> Vec<(String, SeverityLevel)> {
    let by_key: HashMap<&str, &BlueprintNode> =
        graph.nodes.iter().map(|n| (n.key.as_str(), n)).collect();
    let mut warnings: Vec<(String, SeverityLevel)> = Vec::new();

    // 无根层（D55）：显式分层的文档里某层没有界面节点 → 该层不可显示、跳转失效。
    if graph.has_layers() {
        for layer in &graph.layers {
            if graph.interface_of_layer(&layer.key).is_none() {
                warnings.push((
                    format!(
                        "层 {name}（{key}）暂未接通：该层没有界面节点（无根层），指向它的界面跳转不会执行",
                        name = layer.name,
                        key = layer.key
                    ),
                    SeverityLevel::Soft,
                ));
            }
        }
    }

    // 节点类型当前无注册项（RFC 0010 决策 6）：节点及其边**原样保留**、不参与求值与
    // 结构对账、画布灰显「未接通」、**允许保存**，插件恢复后自动恢复。
    for node in &graph.nodes {
        if !registry.is_registered(&node.node_type) {
            warnings.push((
                format!(
                    "节点 {key} 暂未接通：类型 {ty} 当前无注册项（插件未安装 / 未启用 / 宿主 API 不兼容）",
                    key = node.key,
                    ty = node.node_type
                ),
                SeverityLevel::Soft,
            ));
        }
    }

    // `mount.multiple_per_interface = false` 但同一界面出现多个实例
    // （面板标准第 7.2 节第 2 条：**软告警**，不阻塞保存）。
    let mut instance_count: HashMap<(String, String), usize> = HashMap::new();
    for node in &graph.nodes {
        if !node.node_type.is_builtin() {
            continue;
        }
        let Some(panel_id) = node.panel_id.as_deref().filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        let Some(fact) = registry.panel_fact(panel_id) else {
            continue;
        };
        if fact.multiple_per_interface {
            continue;
        }
        let layer = graph.node_layer_key(node);
        let counter = instance_count
            .entry((layer.clone(), panel_id.to_string()))
            .or_insert(0);
        *counter += 1;
        if *counter > 1 {
            warnings.push((
                format!(
                    "面板 {panel_id} 声明 mount.multiple_per_interface = false，但界面 {layer} 上出现了第 {n} 个实例",
                    n = *counter
                ),
                SeverityLevel::Soft,
            ));
        }
    }

    for node in &graph.nodes {
        // 非宿主内置类型不参与求值链检查（也没有对应的字段口径）。
        if !node.node_type.is_builtin() {
            continue;
        }
        // **结构父缺失**（D108，与前端 `blueprintLint::analyzeUnlinked` 逐项同口径）：
        // `layout_block` / `group` / `control` 靠 `contains` 边确定"我属于哪个页面/容器"；
        // 没有入边 = 套用布局时不会被对账到（**未接通**，不阻塞保存）。
        // 面板另有**兼容旧图**的等价形式 `面板 --memberOf--> 标签组`（D59），同样放行——
        // 否则老蓝图会被整片标灰，而它们本来是能用的。
        if matches!(
            node.node_type,
            NodeType::LayoutBlock | NodeType::Group | NodeType::Control
        ) && !has_structural_parent(graph, node)
        {
            warnings.push((
                format!(
                    "节点 {key} 暂未接通：没有结构父（连线 父容器→该节点，如 界面→布局块、布局块/标签组→面板）",
                    key = node.key
                ),
                SeverityLevel::Soft,
            ));
        }
        match node.node_type {
            NodeType::Event => {
                let has_target = node.target.is_some();
                let has_on_edge = graph
                    .edges
                    .iter()
                    .any(|e| e.edge_kind == EdgeKind::On && e.to == node.key);
                if !has_target && !has_on_edge {
                    warnings.push((
                        format!(
                            "操作节点 {key} 暂未接通：缺对象来源（连线 对象→操作）",
                            key = node.key
                        ),
                        SeverityLevel::Soft,
                    ));
                }
            }
            NodeType::Condition => {
                let has_source = graph
                    .edges
                    .iter()
                    .any(|e| e.edge_kind == EdgeKind::Fires && e.to == node.key);
                if !has_source {
                    warnings.push((
                        format!(
                            "条件节点 {key} 暂未接通：缺触发来源（连线 操作→条件）",
                            key = node.key
                        ),
                        SeverityLevel::Soft,
                    ));
                }
            }
            NodeType::Action => {
                let has_trigger = graph.edges.iter().any(|e| {
                    e.to == node.key
                        && (e.edge_kind == EdgeKind::Fires || e.edge_kind == EdgeKind::Guards)
                });
                if !has_trigger {
                    warnings.push((
                        format!(
                            "状态节点 {key} 暂未接通：缺触发来源（连线 操作/条件→状态）",
                            key = node.key
                        ),
                        SeverityLevel::Soft,
                    ));
                }
            }
            NodeType::Subclass => {
                // 子类缺 `format` = **未接通**（软告警，不阻塞保存）：没有细分就说不清
                // "这一支子类收哪些文件"，运行时也无从匹配。
                if node.format.as_deref().unwrap_or("").trim().is_empty() {
                    warnings.push((
                        format!(
                            "子类节点 {key} 暂未接通：缺少 format（按所属类目的媒体类型取值，如 text → epub / txt / md）",
                            key = node.key
                        ),
                        SeverityLevel::Soft,
                    ));
                }
            }
            NodeType::Mark => {
                // 标记缺 `mark` = 未接通；填了但**不在可注册清单**里也按未接通
                // （与"节点类型无注册项"同口径：清单是可注册的，未注册不等于非法，
                // 允许保存、清单恢复后自动生效，D102）。
                match node.mark.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    None => warnings.push((
                        format!("标记节点 {key} 暂未接通：缺少 mark（标记清单 id）", key = node.key),
                        SeverityLevel::Soft,
                    )),
                    Some(m) if !crate::blueprint_types::is_builtin_mark(m) => warnings.push((
                        format!(
                            "标记节点 {key} 暂未接通：标记 {m} 不在当前可注册清单内（未注册的标记允许保存，注册后自动生效）",
                            key = node.key
                        ),
                        SeverityLevel::Soft,
                    )),
                    Some(_) => {}
                }
            }
            NodeType::Overlay => {
                // 浮层是容器：内容是**面板/标签组**（由 contains 边表达），
                // 因此不再有"未绑定浮动控件"这类软告警（2026-09 取消浮动控件概念）；
                // 浮层没有子节点也只是"空浮层"，仍可保存。
                //
                // **未连接到界面 = 未接通**：界面的直接子级才有"属于本页"的含义，
                // 断开 `界面 --contains--> 浮层` 后该浮层不应再显示（运行时同样按此判定）。
                let attached = graph.edges.iter().any(|e| {
                    e.edge_kind == EdgeKind::Contains
                        && e.to == node.key
                        && graph
                            .node(&e.from)
                            .map(|n| n.node_type == NodeType::Interface)
                            .unwrap_or(false)
                });
                if !attached {
                    warnings.push((
                        format!(
                            "浮层节点 {key} 暂未接通：未连接到界面（连线 界面→浮层）",
                            key = node.key
                        ),
                        SeverityLevel::Soft,
                    ));
                }
                // 尺寸小于最小尺寸 → 只是被夹紧，提示一下即可（不阻塞保存）。
                if let Some(size) = &node.size {
                    if size.below_minimum() {
                        warnings.push((
                            format!(
                                "浮层 {key} 的尺寸小于最小尺寸（{OVERLAY_MIN_WIDTH}×{OVERLAY_MIN_HEIGHT}），将按最小尺寸显示",
                                key = node.key
                            ),
                            SeverityLevel::Soft,
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
            // 子类指向**类目**（`subclass` 字段在子类节点上是"所属类目"）。
            NodeType::Subclass => match node.subclass.as_deref() {
                Some(ck) => !by_key.contains_key(ck),
                None => true,
            },
            // 标记指向**面板**。
            NodeType::Mark => match node.control.as_deref() {
                Some(ck) => !by_key.contains_key(ck),
                None => true,
            },
            // 对象有**三条正交轴**：声明了哪一条就校验哪一条；一条都没声明 = 未接通。
            NodeType::Object => {
                let declared: Vec<&str> = [
                    node.class.as_deref(),
                    node.subclass.as_deref(),
                    node.mark_ref.as_deref(),
                ]
                .into_iter()
                .flatten()
                .filter(|k| !k.trim().is_empty())
                .collect();
                if declared.is_empty() {
                    true
                } else {
                    declared.iter().any(|k| !by_key.contains_key(*k))
                }
            }
            NodeType::Action => match node.target.as_deref() {
                // 界面跳转的目标是界面节点；指向已删除界面属未接通（软告警，D48/D55）。
                Some(t) if node.op == Some(ActionOp::Navigate) => !matches!(
                    by_key.get(t).map(|n| &n.node_type),
                    Some(NodeType::Interface)
                ),
                Some(t) => !by_key.contains_key(t),
                None => true,
            },
            _ => false,
        };
        if missing_ref {
            // 分级来自注册表的 `severity.missing_ref`（内置 10 种缺省为软告警）。
            warnings.push((
                format!(
                    "节点 {key} 暂未接通：缺少必要引用或引用已被删除",
                    key = node.key
                ),
                registry.severity(&node.node_type).missing_ref,
            ));
        }
    }
    warnings
}
