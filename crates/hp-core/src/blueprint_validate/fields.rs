//! 内置节点类型的字段与引用校验（D218 从 `blueprint_validate.rs` 拆出）。
//!
//! **非宿主内置类型不做字段校验**：插件注册项（字段规格由插件声明）与「命名合法但当前
//! 无注册项」的节点都不参与，前者由插件侧负责、后者按未接通软告警处理（RFC 0010 决策 5/6）。

use super::NodeIssue;
use super::classes::class_owner_panel_id;
use super::edges::validate_expr;

use crate::blueprint::{OVERLAY_HEIGHT_MAX, OVERLAY_HEIGHT_MIN, OVERLAY_MAX_SIZE};
use crate::blueprint_node::BlueprintNode;
use crate::blueprint_registry::NodeRegistry;
use crate::blueprint_types::{
    ActionOp, CLASS_MEDIA_TYPES, NodeType, class_media_type_in_panel_domain,
    class_media_types_for_panel, is_valid_class_media_type, subclass_formats_for,
};
use std::collections::HashMap;

/// 校验单个节点字段与引用（按注册表的 `severity` 分级）。
///
/// **非宿主内置类型不做字段校验**：插件注册项（字段规格由插件声明）与「命名合法但当前
/// 无注册项」的节点都不参与，前者由插件侧负责、后者按未接通软告警处理
/// （RFC 0010 决策 5/6）。
pub(crate) fn validate_node_with(
    node: &BlueprintNode,
    by_key: &HashMap<&str, &BlueprintNode>,
    registry: &NodeRegistry,
    issues: &mut Vec<NodeIssue>,
) {
    let key = &node.key;
    let _ = key;
    let Some(spec) = registry.builtin_spec(&node.node_type) else {
        return;
    };
    let _ = spec;
    let severity = registry.severity(&node.node_type).field_issue;
    let mut local: Vec<String> = Vec::new();
    validate_node_fields(node, by_key, &mut local);
    for message in local {
        issues.push(NodeIssue { message, severity });
    }
}

/// 内置类型的字段校验本体（只产生消息，分级由调用方按注册表的 `severity` 决定）。
fn validate_node_fields(
    node: &BlueprintNode,
    by_key: &HashMap<&str, &BlueprintNode>,
    errors: &mut Vec<String>,
) {
    let key = &node.key;
    match node.node_type {
        NodeType::Interface => {
            // 界面（页面）：结构节点，仅要求 key 非空（position 可选）。
            // 显示名取自层名（D51），界面节点不再另存 name。
            // 可有多个界面，但**每层至多一个**（多页面 = 多层，见 validate_layers）。
        }
        NodeType::LayoutBlock => {
            // 布局块：结构节点，仅要求 key 非空（name/position 可选）。
        }
        NodeType::Overlay => {
            // 浮层（D50 修订）：**容器**——与布局块同级，可 contains **面板控件与标签组**；
            // 并承载外观档位（阴影/圆角/标签隐藏，取宿主设计 token，像素由宿主决定）
            // 与**相对定位**（九宫格锚点 + 双模式偏移）。
            // 2026-09 取消「浮动控件」绑定，浮层不再有 `control_id`。
            // 锚点与偏移的取值合法性由解析层保证（枚举 + 数字）；
            // JSON 的 f64 由 serde_json 保证有限，不会出现 NaN/∞。
            if let Some(h) = node.height
                && !(OVERLAY_HEIGHT_MIN..=OVERLAY_HEIGHT_MAX).contains(&h)
            {
                errors.push(format!(
                        "浮层节点 {key} 的 height 必须在 {OVERLAY_HEIGHT_MIN}-{OVERLAY_HEIGHT_MAX}（当前: {h}）"
                    ));
            }
            // 框体尺寸：必须为正且不超过上限；小于最小尺寸只夹紧（软告警，见 warnings）。
            if let Some(size) = &node.size {
                if size.width <= 0.0 || size.height <= 0.0 {
                    errors.push(format!(
                        "浮层节点 {key} 的 size 宽高必须为正数（当前: {}×{}）",
                        size.width, size.height
                    ));
                } else if size.width > OVERLAY_MAX_SIZE || size.height > OVERLAY_MAX_SIZE {
                    errors.push(format!(
                        "浮层节点 {key} 的 size 宽高不得超过 {OVERLAY_MAX_SIZE}（当前: {}×{}）",
                        size.width, size.height
                    ));
                }
            }
        }
        NodeType::Control => {
            // panel_id 缺失 → 未接通（软），不阻塞保存。
        }
        NodeType::Class => {
            // control 缺失/指向已删除节点 → 未接通（软）；指向存在但类型不符 → 硬错误。
            if let Some(ck) = node.control.as_deref()
                && let Some(target) = by_key.get(ck)
                && target.node_type != NodeType::Control
            {
                errors.push(format!(
                    "类节点 {key} 的 control 必须指向面板控件节点（当前指向 {}）",
                    target.node_type
                ));
            }
            match node.media_type.as_deref() {
                Some(mt) if is_valid_class_media_type(mt) => {
                    // **按面板分域**（D135）：类目有 `control` 且能解析出面板 id 时，
                    // 取值还必须落在该面板的类型域内（如媒体预览下不能建「相册」类目）。
                    // `control` 缺失 / 指向已删节点 = 未接通软告警，**不做分域判定**
                    // ——缺失不得绑架用户数据（否则断一条线就把既有文档判成硬错误）。
                    // 面板未注册（插件缺失）时 `class_media_types_for_panel` 返回全量，
                    // 与 TS `classMediaTypesForPanel` 同口径，不把未知面板的取值判死。
                    if let Some(panel_id) = class_owner_panel_id(node, by_key)
                        && !class_media_type_in_panel_domain(&panel_id, mt)
                    {
                        errors.push(format!(
                            "类节点 {key} 的 media_type = {mt} 不属于面板 {panel_id} 的类型域（该面板只允许 {}，节点标准第 2.1 节）",
                            class_media_types_for_panel(&panel_id).join("/")
                        ));
                    }
                }
                _ => errors.push(format!(
                    "类节点 {key} 的 media_type 必须是 {}（当前: {}）",
                    CLASS_MEDIA_TYPES.join("/"),
                    node.media_type.as_deref().unwrap_or("")
                )),
            }
            // 类目**只按媒体类型分类**：细分交给 `subclass`、语义维度交给挂在对象**之下**的
            // `mark` 节点（D102；D136 把标记从"面板下的平行轴"改到"类目之下"，
            // **D137/v3** 又改到"对象之下"——所以"类目节点本身不带标记 id"这条
            // 从 D102 起就**从未变过**，变的一直是标记**节点自己**挂在哪一级，
            // 见下面的 `NodeType::Mark` 分支）。
            // 类目上出现 `format` 是 2026-10-10 之前的旧写法，
            // 属"字段用在错误的类型上"→ 硬错误（与解析层同口径）。
            if node.format.is_some() {
                errors.push(format!(
                    "类节点 {key} 不得带 format：类目只按 media_type 分类，细分请用 subclass 节点、标记请用挂在对象之下的 mark 节点"
                ));
            }
            if node.mark.is_some() {
                errors.push(format!(
                    "类节点 {key} 不得带 mark：标记是挂在**对象**之下的独立节点（D137/v3，链的末梢）"
                ));
            }
        }
        NodeType::Subclass => {
            // 所属类目引用：缺失/已删除 → 未接通（软）；指向存在但类型不符 → 硬错误。
            if let Some(ck) = node.subclass.as_deref()
                && let Some(target) = by_key.get(ck)
                && target.node_type != NodeType::Class
            {
                errors.push(format!(
                    "子类节点 {key} 的 subclass 必须指向类目节点（当前指向 {}）",
                    target.node_type
                ));
            }
            // `format` 的取值域**按所属类目的媒体类型分域**：`text` 类目下只能是
            // epub/txt/md；其余媒体类型**没有**子类取值域（该类目下不该有子类）。
            match node.format.as_deref() {
                Some(fmt_value) if !fmt_value.trim().is_empty() => {
                    // 能解析到所属类目时就按它的媒体类型精确判定；解析不到（未接通）时
                    // 退化为"必须是某个分域里的取值"，避免把未接通的文档判死。
                    let owner_media = node
                        .subclass
                        .as_deref()
                        .and_then(|ck| by_key.get(ck))
                        .filter(|t| t.node_type == NodeType::Class)
                        .and_then(|t| t.media_type.clone());
                    match owner_media.as_deref() {
                        Some(mt) => {
                            let allowed = subclass_formats_for(mt);
                            if allowed.is_empty() {
                                errors.push(format!(
                                    "子类节点 {key} 挂在 media_type = {mt} 的类目下，但该类目没有子类取值域（节点标准第 2.0.1 节）"
                                ));
                            } else if !allowed.contains(&fmt_value) {
                                errors.push(format!(
                                    "子类节点 {key} 的 format 必须是 {}（{mt} 类目，当前: {fmt_value}）",
                                    allowed.join("/")
                                ));
                            }
                        }
                        None => {
                            // 解析不到所属类目（未接通）：退化为"必须是**某个**分域里的
                            // 取值"，避免把未接通的文档判死（类目接回来即按分域复核）。
                            let known = CLASS_MEDIA_TYPES
                                .iter()
                                .any(|mt| subclass_formats_for(mt).contains(&fmt_value));
                            if !known {
                                errors.push(format!(
                                    "子类节点 {key} 的 format 不在任何子类取值域内（当前: {fmt_value}）"
                                ));
                            }
                        }
                    }
                }
                // 缺 format → 未接通（软告警），不阻塞保存。
                _ => {}
            }
        }
        NodeType::Mark => {
            // **所属对象**引用（D137/v3）：标记挂在对象下、是链的末梢。
            // 缺失 / 指向已删除节点 → 未接通（软）；指向存在但类型不符 → 硬错误。
            //
            // 旧文档兼容（两层，都**不**判硬错误）：
            // - D136 之前标记用 `control` 指向面板；
            // - D136 那一版标记用 `class` 指向类目（v3 起改用 `object`）。
            // 两个残留字段都只在 `blueprint_warnings` 里报软告警（未接通 / 灰显），
            // 因此**旧文档读进来不会命中硬错误**（否则"读进来就保存不了"会变成新的
            // 迁移事故；正常路径上 `validate_json` 会先跑 `migrate_graph`，
            // 残留字段由迁移清掉，见 `blueprint_migrate.rs`）。
            if let Some(ok) = node.object.as_deref()
                && let Some(target) = by_key.get(ok)
                && target.node_type != NodeType::Object
            {
                errors.push(format!(
                    "标记节点 {key} 的 object 必须指向对象节点（当前指向 {}）",
                    target.node_type
                ));
            }
            // `mark` 的取值域是**可注册的标记清单**；内置项恒在，未注册的取值按
            // 「未接通」软告警处理（与节点类型注册表同口径，D102），因此这里只校验
            // **命名合法**（不合规则才是硬错误），注册与否交给软告警层。
            if let Some(m) = node
                .mark
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                && !crate::namespace::is_valid_namespaced_id(m)
            {
                errors.push(format!("标记节点 {key} 的 mark 命名不合规则: {m}"));
            }
        }
        NodeType::Object => {
            // 结构父有**两种**（两条正交的轴任选其一）：类目、子类。
            // 指向存在但类型不符 → 硬错误；缺失 → 未接通（软）。
            //
            // ⚠️ **D137/v3**：v2 的第三条轴 `mark_ref`（对象 → 标记）已废弃——
            // 方向反转为"标记挂在对象之下"，本分支**不再读** `mark_ref`；
            // 旧文档上的残留值由 `blueprint_warnings` 报软告警、由 v2→v3 迁移清掉。
            let parents: [(&str, Option<&str>, NodeType); 2] = [
                ("class", node.class.as_deref(), NodeType::Class),
                ("subclass", node.subclass.as_deref(), NodeType::Subclass),
            ];
            let mut declared = 0usize;
            for (field, key_opt, want) in parents {
                let Some(parent_key) = key_opt else { continue };
                // 空串按"未声明"处理（属性面板清空引用时会写出空串）。
                if parent_key.trim().is_empty() {
                    continue;
                }
                declared += 1;
                if let Some(target) = by_key.get(parent_key)
                    && target.node_type != want
                {
                    errors.push(format!(
                        "对象节点 {key} 的 {field} 必须指向 {} 节点（当前指向 {}）",
                        want, target.node_type
                    ));
                }
            }
            // **两条轴互斥**：对象只属于一个结构父（与"结构父唯一性"同一条约束）。
            if declared > 1 {
                errors.push(format!(
                    "对象节点 {key} 同时声明了 {declared} 个结构父：对象只能挂在 类目 / 子类 两者之一"
                ));
            }
            if node.scope.as_deref().unwrap_or("").trim().is_empty() {
                errors.push(format!("对象节点 {key} 缺少 scope"));
            }
        }
        NodeType::Group => {
            if node.mode.is_none() {
                errors.push(format!("组节点 {key} 缺少 mode"));
            }
            if let Some(visible) = &node.default_visible {
                for vk in visible {
                    if let Some(target) = by_key.get(vk.as_str())
                        && target.node_type != NodeType::Control
                    {
                        errors.push(format!(
                            "组节点 {key} 的 default_visible 成员 {vk} 必须是面板控件节点"
                        ));
                    }
                }
            }
            if let Some(dir) = &node.hide_direction
                && let Some(target_key) = dir.toward_target()
                && let Some(target) = by_key.get(target_key)
                && target.node_type != NodeType::Group
            {
                errors.push(format!(
                    "组节点 {key} 的 hide_direction 指向的 {target_key} 必须是组节点"
                ));
            }
        }
        NodeType::Event => {
            if node.trigger.is_none() {
                errors.push(format!("操作节点 {key} 缺少 trigger"));
            }
            if let Some(t) = node.target.as_deref()
                && let Some(target) = by_key.get(t)
                && !matches!(
                    target.node_type,
                    NodeType::Control | NodeType::Class | NodeType::Object | NodeType::Mark
                )
            {
                errors.push(format!(
                    "操作节点 {key} 的 target 必须指向面板控件/类/对象/标记节点（当前指向 {}）",
                    target.node_type
                ));
            }
        }
        NodeType::Condition => {
            if let Some(expr) = &node.expr {
                if let Some(msg) = validate_expr(expr) {
                    errors.push(format!("条件节点 {key}: {msg}"));
                }
            } else {
                errors.push(format!("条件节点 {key} 缺少 expr"));
            }
        }
        NodeType::Action => {
            let op = node.op;
            if op.is_none() {
                errors.push(format!("动作节点 {key} 缺少 op"));
            }
            if let Some(target_key) = node.target.as_deref()
                && let Some(target) = by_key.get(target_key)
            {
                let actual = target.node_type.clone();
                let ok = match op {
                    // 显隐：面板控件，或浮层（D50：show/hide/toggle 可指向浮层）。
                    Some(ActionOp::Show) | Some(ActionOp::Hide) => {
                        matches!(actual, NodeType::Control | NodeType::Overlay)
                    }
                    // 组收起/展开：只允许标签组；指向浮层为硬错误（D50）。
                    Some(ActionOp::Collapse) | Some(ActionOp::Expand) => actual == NodeType::Group,
                    Some(ActionOp::Toggle) => {
                        matches!(
                            actual,
                            NodeType::Control | NodeType::Group | NodeType::Overlay
                        )
                    }
                    // 界面跳转：目标必须是界面节点（D48）；指向浮层为硬错误（D50）。
                    Some(ActionOp::Navigate) => actual == NodeType::Interface,
                    None => true,
                };
                if !ok {
                    errors.push(format!(
                        "动作节点 {key} 的 target 类型不符：{} 不能指向 {}",
                        op.map(|o| o.as_str()).unwrap_or("?"),
                        actual
                    ));
                }
            }
        }
        // 非宿主内置类型不做字段校验（插件注册项 / 当前无注册项）。
        NodeType::Other(_) => {}
    }
}
