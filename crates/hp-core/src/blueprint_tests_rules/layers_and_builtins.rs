// 由 `blueprint_tests.rs` 通过 include! 引入（D219：本文件是它的一个分片）。

    #[test]
    fn effective_layers_falls_back_to_single_layer() {
        // 无 layers 的旧文档 → 单层兜底（层名取界面 name）
        let legacy = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"ui","type":"interface","name":"我的界面"}
            ],"edges":[]}"#,
        )
        .unwrap();
        assert!(!legacy.has_layers());
        let layers = legacy.effective_layers();
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].name, "我的界面");
        assert_eq!(layers[0].key, BlueprintGraph::FALLBACK_LAYER_KEY);

        // 完全空文档 → 兜底层名「主界面」
        let empty = BlueprintGraph::from_json(r#"{"schema_version":2,"nodes":[],"edges":[]}"#).unwrap();
        assert_eq!(empty.effective_layers()[0].name, "主界面");

        // 显式分层 → 原样返回
        let layered = BlueprintGraph::from_json(
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"},{"key":"l_b","name":"B"}],
                "nodes":[{"key":"ui","type":"interface","layer":"l_a"}],"edges":[]}"#,
        )
        .unwrap();
        assert_eq!(layered.effective_layers().len(), 2);
        assert!(layered.interface_of_layer("l_a").is_some());
        assert!(layered.interface_of_layer("l_b").is_none());
    }

    #[test]
    fn orphan_action_is_warning_not_error() {
        // 状态节点没有 fires/guards 入边 → 不生效，但**允许保存**（画布灰色呈现），
        // 只作为软问题提示；补上触发来源后告警消失。
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"a","type":"action","op":"show","target":"c"}
            ],"edges":[]}"#,
        )
        .unwrap();
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
        assert!(
            graph
                .warnings()
                .iter()
                .any(|w| w.contains("暂未接通") && w.contains("触发来源")),
            "{:?}",
            graph.warnings()
        );

        let ok = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"ui","type":"interface"},
              {"key":"blk","type":"layout_block","name":"栏"},
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"k","type":"class","control":"c","media_type":"image"},
              {"key":"o","type":"object","class":"k","scope":"double_clicked"},
              {"key":"e","type":"event","trigger":"double_click"},
              {"key":"a","type":"action","op":"show","target":"c"}
            ],"edges":[
              {"from":"ui","to":"blk","kind":"contains","order":1},
              {"from":"blk","to":"c","kind":"contains","order":2},
              {"from":"o","to":"e","kind":"on","order":3},
              {"from":"e","to":"a","kind":"fires","order":4}
            ]}"#,
        )
        .unwrap();
        assert!(ok.validate().is_empty(), "{:?}", ok.validate());
        assert!(ok.warnings().is_empty(), "{:?}", ok.warnings());
    }

    #[test]
    fn validate_rejects_bad_expr_and_action_target() {
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"g","type":"group","mode":"exclusive"},
              {"key":"k","type":"class","control":"c","media_type":"image"},
              {"key":"e","type":"event","trigger":"double_click","target":"c"},
              {"key":"cond","type":"condition","expr":"rating == 3"},
              {"key":"a","type":"action","op":"collapse","target":"k"},
              {"key":"a2","type":"action","op":"collapse","target":"g"}
            ],"edges":[
              {"from":"e","to":"cond","kind":"fires","order":1},
              {"from":"e","to":"a","kind":"fires","order":2},
              {"from":"e","to":"a2","kind":"fires","order":3}
            ]}"#,
        )
        .unwrap();
        let errors = graph.validate();
        assert!(errors.iter().any(|e| e.contains("不支持的条件")), "{errors:?}");
        // collapse 指向类节点（存在但类型不符）→ 硬错误；指向组节点 → 合法
        assert!(
            errors.iter().any(|e| e.contains("target 类型不符")),
            "{errors:?}"
        );
    }

    /// 标记的 `object` 引用**存在但类型不符**仍是**硬错误**（与"未接通"区分）：
    /// 指向面板节点而非对象节点。
    #[test]
    fn mark_object_must_point_to_object_node() {
        let wrong = BlueprintGraph::from_json(
            r#"{"schema_version":3,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"c","type":"control","panel_id":"media","layer":"l_a"},
                  {"key":"m","type":"mark","object":"c","mark":"manga","layer":"l_a"}
                ],
                "edges":[]}"#,
        )
        .unwrap();
        assert!(
            wrong
                .validate()
                .iter()
                .any(|e| e.contains("object 必须指向对象节点")),
            "{:?}",
            wrong.validate()
        );

        // 缺 `object`（未接通）→ 软告警，不阻塞保存。
        let missing = BlueprintGraph::from_json(
            r#"{"schema_version":3,
                "nodes":[{"key":"m","type":"mark","mark":"manga"}],
                "edges":[]}"#,
        )
        .unwrap();
        assert!(missing.validate().is_empty(), "{:?}", missing.validate());
        assert!(!missing.warnings().is_empty(), "缺 object 应报未接通");
    }

    /// **双向对称**（D104 教训的 Rust 侧同款护栏）：内置定义表的
    /// `children` 与 `parents` 必须**逐项互指**——只声明一侧会让该边静默连不出来
    /// （`can_contain` 只读父节点的 `children`，不读子节点的 `parents`）。
    ///
    /// TS 侧同一份判据在 `tools/blueprint-node-check.mjs`（`pnpm check:blueprint-nodes`），
    /// 这里是**后端**的独立副本：门禁脚本扫不到 Rust，Rust 测试也扫不到 TS，两侧各钉一次。
    #[test]
    fn builtin_parent_children_declarations_are_symmetric() {
        use crate::blueprint_registry::BUILTIN_NODE_SPECS;
        let mut asymmetric: Vec<String> = Vec::new();
        for spec in BUILTIN_NODE_SPECS.iter() {
            for child in spec.children {
                let Some(child_spec) = BUILTIN_NODE_SPECS
                    .iter()
                    .find(|s| s.node_type.as_str() == *child)
                else {
                    asymmetric.push(format!("{}.children 含未注册类型 {child}", spec.node_type));
                    continue;
                };
                if !child_spec.parents.contains(&spec.node_type.as_str()) {
                    asymmetric.push(format!(
                        "{}.children 含 {child}，但 {child}.parents 不含 {}（引用方向不一致）",
                        spec.node_type, spec.node_type
                    ));
                }
            }
            for parent in spec.parents {
                let Some(parent_spec) = BUILTIN_NODE_SPECS
                    .iter()
                    .find(|s| s.node_type.as_str() == *parent)
                else {
                    asymmetric.push(format!("{}.parents 含未注册类型 {parent}", spec.node_type));
                    continue;
                };
                if !parent_spec.children.contains(&spec.node_type.as_str()) {
                    asymmetric.push(format!(
                        "{}.parents 含 {parent}，但 {parent}.children 不含 {}（该边连不出来）",
                        spec.node_type, spec.node_type
                    ));
                }
            }
        }
        assert!(
            asymmetric.is_empty(),
            "父子声明必须双向互指：{asymmetric:?}"
        );
        // D136/D137 的几处改动**逐项互指**（显式钉住，防止整体对称成立但这条关系被改到别处）。
        let spec_of = |t: &str| {
            BUILTIN_NODE_SPECS
                .iter()
                .find(|s| s.node_type.as_str() == t)
                .expect("内置类型必须存在")
        };
        assert_eq!(
            spec_of("mark").parents,
            &["object"],
            "标记的父是对象（D137/v3）"
        );
        assert!(
            spec_of("object").children.contains(&"mark"),
            "对象的 children 必须含 mark（否则「对象 → 标记」连不出来）"
        );
        assert!(
            !spec_of("class").children.contains(&"mark"),
            "类目的 children 不得再含 mark（D137：标记改挂对象）"
        );
        assert!(
            !spec_of("control").children.contains(&"mark"),
            "面板的 children 不得含 mark（D136：标记不再直挂面板）"
        );
        assert_eq!(spec_of("mark").children, &[] as &[&str], "标记是链的末梢");
        assert!(spec_of("class").children.contains(&"subclass"));
        assert!(spec_of("class").children.contains(&"object"));
        assert_eq!(spec_of("object").parents, &["class", "subclass"]);
        assert_eq!(spec_of("subclass").children, &["object"]);
    }

    /// `derive_ports` 的「`on` 输出口 = 可作规则源」判据（D137 回归钉）。
    ///
    /// v3 起 `object ⊃ mark`，对象不再是「无 children 的叶子」；若仍按叶子判据推导，
    /// `object` 会**静默丢掉** `out:on`：画布上「对象 → 操作」连不出来，默认蓝图里
    /// 既有的 `object --on--> event` 也无法重放（与 :206-222 记的"按语义集合判定、
    /// 不按当下长相判定"同源）。四个纯结构容器是反例：它们的 children 是结构节点，
    /// 不得有 `on` 输出口，否则「界面/布局块/浮层/分组 → 操作」会被画成合法。
    ///
    /// 与 TS `packages/config/src/blueprintNodes.ts` 的 `resolveNodePorts` 同口径；
    /// `pnpm check:blueprint-nodes` 只覆盖 TS 侧，故后端在这里独立钉一次。
    #[test]
    fn builtin_rule_source_types_expose_on_output() {
        use crate::blueprint_registry::{BUILTIN_NODE_SPECS, PortSide, derive_ports};

        let ports_of = |t: &str| {
            let spec = BUILTIN_NODE_SPECS
                .iter()
                .find(|s| s.node_type.as_str() == t)
                .expect("内置类型必须存在");
            let parents: Vec<String> = spec.parents.iter().map(|p| p.to_string()).collect();
            let children: Vec<String> = spec.children.iter().map(|c| c.to_string()).collect();
            let events: Vec<String> = spec.events.iter().map(|e| e.to_string()).collect();
            derive_ports(spec.evaluation_role, &parents, &children, &events)
        };
        let has_on_out = |t: &str| {
            ports_of(t)
                .iter()
                .any(|p| p.id == "on" && p.side == PortSide::Out.as_str())
        };

        // 判据必须与 `blueprint_registry.rs` 的 `RULE_EDGE_SOURCES.on` **同集合**：
        // 那张表是校验（`rule_edge_allows`）的真相来源，端口只是它在画布上的投影；
        // 两者一旦分叉，就会出现"画布上连得出来、保存却报非法边"（或反过来）。
        let on_sources: Vec<&str> = crate::blueprint_registry::RULE_EDGE_SOURCES
            .iter()
            .find(|(kind, _)| *kind == "on")
            .map(|entry| entry.1.to_vec())
            .expect("`on` 规则边来源必须已注册");

        // 由端口推导出来的类型集合（12 种内置类型全覆盖，含 event/condition/action）。
        let mut derived: Vec<&str> = BUILTIN_NODE_SPECS
            .iter()
            .map(|spec| spec.node_type.as_str())
            .filter(|t| has_on_out(t))
            .collect();
        let mut expected = on_sources.clone();
        derived.sort_unstable();
        expected.sort_unstable();
        assert_eq!(
            derived, expected,
            "derive_ports 的 out:on 类型集合必须与 RULE_EDGE_SOURCES.on 完全一致"
        );

        // 再逐个显式复核（集合相等之外，把"为什么"钉在类型名上）：
        // 可被命中的结构类型 = 面板 / 类目 / 子类 / 对象 / 标记。
        for t in ["control", "class", "subclass", "object", "mark"] {
            assert!(
                has_on_out(t),
                "{t} 必须暴露 out:on（`RULE_EDGE_SOURCES.on` 含它，否则「{t} → 操作」连不出来）"
            );
        }
        // 纯结构容器：命中语义由内部对象承载，不得有 on 输出口。
        for t in ["interface", "layout_block", "overlay", "group"] {
            assert!(
                !has_on_out(t),
                "{t} 不得暴露 out:on（否则「容器 → 操作」会被画成合法边）"
            );
        }
    }
