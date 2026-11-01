    #[test]
    fn validate_accepts_overlay_and_rejects_illegal_overlay_actions() {
        // 浮层：interface --contains--> overlay 合法；同一次触发下 `show` + `toggle` 是冲突的
        // （同一目标不可能既显示又切换），因此本夹具同时覆盖新规则「同界面同对象同触发多状态冲突」。
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a",
                   "name":"浮层 1","visible":true,"height":5},
                  {"key":"c","type":"control","panel_id":"viewer","layer":"l_a"},
                  {"key":"e","type":"event","trigger":"click","layer":"l_a"},
                  {"key":"g","type":"group","mode":"exclusive","layer":"l_a"},
                  {"key":"a_show","type":"action","op":"show","target":"ov","layer":"l_a"},
                  {"key":"a_hide","type":"action","op":"hide","target":"ov","layer":"l_a"},
                  {"key":"a_toggle","type":"action","op":"toggle","target":"ov","layer":"l_a"}
                ],
                "edges":[
                  {"from":"ui","to":"ov","kind":"contains","order":1},
                  {"from":"c","to":"e","kind":"on","order":2},
                  {"from":"e","to":"a_show","kind":"fires","order":3},
                  {"from":"e","to":"a_hide","kind":"fires","order":4},
                  {"from":"e","to":"a_toggle","kind":"fires","order":5}
                ]}"#,
        )
        .unwrap();
        let errors = graph.validate();
        assert!(
            errors.iter().any(|e| e.contains("状态冲突")),
            "show/hide 同时作用于同一目标应报状态冲突：{errors:?}"
        );
        assert_eq!(graph.nodes[1].height, Some(5));

        // 把冲突的两个状态摘掉后，同一张图应当干净通过（确认上面报的是新规则）。
        let clean = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a",
                   "name":"浮层 1","visible":true,"height":5},
                  {"key":"c","type":"control","panel_id":"viewer","layer":"l_a"},
                  {"key":"e","type":"event","trigger":"click","layer":"l_a"},
                  {"key":"g","type":"group","mode":"exclusive","layer":"l_a"},
                  {"key":"a_show","type":"action","op":"show","target":"ov","layer":"l_a"}
                ],
                "edges":[
                  {"from":"ui","to":"ov","kind":"contains","order":1},
                  {"from":"c","to":"e","kind":"on","order":2},
                  {"from":"e","to":"a_show","kind":"fires","order":3}
                ]}"#,
        )
        .unwrap();
        assert!(clean.validate().is_empty(), "{:?}", clean.validate());

        // collapse / expand 指向浮层 → 硬错误（D50）
        let collapse = BlueprintGraph::from_json(
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a"},
                  {"key":"a","type":"action","op":"collapse","target":"ov","layer":"l_a"}
                ],
                "edges":[{"from":"ui","to":"ov","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(
            collapse
                .validate()
                .iter()
                .any(|e| e.contains("target 类型不符")),
            "{:?}",
            collapse.validate()
        );

        // navigate 指向浮层 → 硬错误（D50）
        let navigate = BlueprintGraph::from_json(
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a","name":"浮层"},
                  {"key":"a","type":"action","op":"navigate","target":"ov","layer":"l_a"}
                ],
                "edges":[{"from":"ui","to":"ov","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(
            navigate
                .validate()
                .iter()
                .any(|e| e.contains("target 类型不符")),
            "{:?}",
            navigate.validate()
        );

        // height 越界 → 硬错误（D57：1–10）
        let bad_height = BlueprintGraph::from_json(
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a","name":"浮层","height":11}
                ],
                "edges":[{"from":"ui","to":"ov","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(
            bad_height
                .validate()
                .iter()
                .any(|e| e.contains("height 必须在 1-10")),
            "{:?}",
            bad_height.validate()
        );
    }

    #[test]
    fn overlay_is_a_container_for_controls_and_groups() {
        // D50 修订：浮层是**容器**（与布局块同级），可 contains 面板控件与标签组；
        // 标签组再 contains 面板控件（组内标签页）。外观取宿主 token 档位。
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a",
                   "name":"浮层 1","visible":true,"height":2,
                   "shadow":"lg","radius":"md","hide_label":true},
                  {"key":"c_tip","type":"control","layer":"l_a","panel_id":"metadata",
                   "title_key":"panel.metadata"},
                  {"key":"g_float","type":"group","layer":"l_a","mode":"exclusive"},
                  {"key":"c_alt","type":"control","layer":"l_a","panel_id":"color"}
                ],
                "edges":[
                  {"from":"ui","to":"ov","kind":"contains","order":1},
                  {"from":"ov","to":"c_tip","kind":"contains","order":2},
                  {"from":"ov","to":"g_float","kind":"contains","order":3},
                  {"from":"g_float","to":"c_alt","kind":"contains","order":4}
                ]}"#,
        )
        .unwrap();
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
        let ov = graph.nodes.iter().find(|n| n.key == "ov").unwrap();
        assert_eq!(ov.shadow, Some(TokenLevel::Lg));
        assert_eq!(ov.radius, Some(TokenLevel::Md));
        assert_eq!(ov.hide_label, Some(true));

        // 序列化往返：外观档位不丢
        let back = BlueprintGraph::from_json(&graph.to_json()).unwrap();
        assert_eq!(back, graph);

        // 浮层**不能** contains 类/对象（层级：浮层 → 标签组/面板控件 → 类 → 对象）
        let bad = BlueprintGraph::from_json(
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a","name":"浮层"},
                  {"key":"k","type":"class","layer":"l_a","media_type":"image"}
                ],
                "edges":[
                  {"from":"ui","to":"ov","kind":"contains","order":1},
                  {"from":"ov","to":"k","kind":"contains","order":2}
                ]}"#,
        )
        .unwrap();
        assert!(
            bad.validate().iter().any(|e| e.contains("非法边")),
            "{:?}",
            bad.validate()
        );

        // 非法外观档位（解析层报错）
        assert!(
            !BlueprintGraph::validate_json(
                r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"}],
                    "nodes":[
                      {"key":"ui","type":"interface","layer":"l_a"},
                      {"key":"ov","type":"overlay","layer":"l_a","shadow":"huge"}
                    ],"edges":[]}"#
            )
            .is_empty()
        );
    }

    #[test]
    fn schema_version_gate_is_greater_than_only() {
        // 低于当前版本 → 不拒绝（走迁移，D58）
        let old = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[{"key":"c","type":"control","panel_id":"viewer"}],
                "edges":[]}"#,
        )
        .unwrap();
        assert!(old.validate().is_empty(), "{:?}", old.validate());

        // 高于当前版本 → 硬错误
        let newer = BlueprintGraph::from_json(&format!(
            r#"{{"schema_version":{},"nodes":[],"edges":[]}}"#,
            BLUEPRINT_SCHEMA_VERSION + 1
        ))
        .unwrap();
        assert!(
            newer
                .validate()
                .iter()
                .any(|e| e.contains("不支持的蓝图 schema 版本")),
            "{:?}",
            newer.validate()
        );
    }

    #[test]
    fn migrate_v1_splits_interfaces_into_layers() {
        use crate::blueprint_migrate::{migrate_document, normalize_document};

        // v1 单界面文档：界面 name → 层名；其余节点归属该层；版本升为当前
        let v1 = r#"{"schema_version":1,"default_version":6,"nodes":[
          {"key":"ui","type":"interface","name":"主界面","position":{"x":40,"y":40}},
          {"key":"blk","type":"layout_block","name":"左栏"},
          {"key":"c","type":"control","panel_id":"viewer"}
        ],"edges":[{"from":"ui","to":"blk","kind":"contains","order":1}]}"#;
        let migrated = migrate_document(v1).unwrap().expect("v1 应触发迁移");
        assert_eq!(migrated.schema_version, BLUEPRINT_SCHEMA_VERSION);
        let graph = BlueprintGraph::from_json(&migrated.json).unwrap();
        assert_eq!(graph.layers.len(), 1);
        assert_eq!(graph.layers[0].name, "主界面");
        assert_eq!(graph.layers[0].key, "l_ui");
        assert_eq!(graph.nodes[0].name, None, "界面显示名改由层名承载");
        assert_eq!(graph.nodes[0].layer.as_deref(), Some("l_ui"));
        assert_eq!(graph.nodes[1].layer.as_deref(), Some("l_ui"));
        assert_eq!(graph.nodes[2].layer.as_deref(), Some("l_ui"));
        assert_eq!(graph.default_version, Some(6), "内置默认标记保留");
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());

        // v1 多界面文档：每个界面拆一层
        let v1_multi = r#"{"schema_version":1,"nodes":[
          {"key":"ui_a","type":"interface","name":"浏览"},
          {"key":"ui_b","type":"interface","name":"编辑"}
        ],"edges":[]}"#;
        let migrated = migrate_document(v1_multi).unwrap().expect("v1 应触发迁移");
        let graph = BlueprintGraph::from_json(&migrated.json).unwrap();
        assert_eq!(graph.layers.len(), 2);
        assert_eq!(graph.layers[0].name, "浏览");
        assert_eq!(graph.layers[1].name, "编辑");
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());

        // 已是当前版本 → 不迁移（返回 None，不做无谓改写）
        let current = format!(r#"{{"schema_version":{BLUEPRINT_SCHEMA_VERSION},"nodes":[],"edges":[]}}"#);
        assert!(migrate_document(&current).unwrap().is_none());

        // normalize_document：低版本返回迁移结果，当前版本原样返回
        let (json, version) = normalize_document(v1).unwrap();
        assert_eq!(version, BLUEPRINT_SCHEMA_VERSION);
        assert!(json.contains("\"layers\""));
        let (same, version) = normalize_document(&current).unwrap();
        assert_eq!(same, current);
        assert_eq!(version, BLUEPRINT_SCHEMA_VERSION);

        // validate_json 也走迁移后再校验（低版本文档不会被版本闸门拒绝）
        assert!(BlueprintGraph::validate_json(v1).is_empty());
    }

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
    fn validate_rejects_dangling_edge() {
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"a","type":"action","op":"show","target":"c"}
            ],"edges":[{"from":"e_missing","to":"a","kind":"fires","order":1}]}"#,
        )
        .unwrap();
        assert!(graph.validate().iter().any(|e| e.contains("不存在的起点")));
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
    fn node_name_field_roundtrip_and_optional() {
        let json = r#"{"schema_version":1,"nodes":[
          {"key":"c","type":"control","name":"媒体预览","panel_id":"media"}
        ],"edges":[]}"#;
        let graph = BlueprintGraph::from_json(json).expect("解析失败");
        assert_eq!(graph.nodes[0].name.as_deref(), Some("媒体预览"));
        assert!(graph.validate().is_empty());
        let back = BlueprintGraph::from_json(&graph.to_json()).expect("再解析失败");
        assert_eq!(back.nodes[0].name.as_deref(), Some("媒体预览"));

        // 缺省 name → None（旧文档兼容）
        let legacy = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"media"}
            ],"edges":[]}"#,
        )
        .expect("解析失败");
        assert_eq!(legacy.nodes[0].name, None);
        assert!(legacy.validate().is_empty());
    }

    #[test]
    fn validate_rejects_illegal_edge_endpoints() {
        // fires 的起点必须是事件节点
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"a","type":"action","op":"show","target":"c"}
            ],"edges":[{"from":"c","to":"a","kind":"fires","order":1}]}"#,
        )
        .unwrap();
        assert!(graph.validate().iter().any(|e| e.contains("非法边")));
    }

    #[test]
    fn validate_rejects_cycle_in_fires_guards() {
        // 人为构造：条件 A fires 条件 B，B fires A → 环
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"ca","type":"condition","expr":"media_type == image"},
              {"key":"cb","type":"condition","expr":"media_type == video"},
              {"key":"a","type":"action","op":"show","target":"c"}
            ],"edges":[
              {"from":"ca","to":"cb","kind":"fires","order":1},
              {"from":"cb","to":"ca","kind":"fires","order":1},
              {"from":"cb","to":"a","kind":"guards","order":1}
            ]}"#,
        )
        .unwrap();
        let errors = graph.validate();
        assert!(errors.iter().any(|e| e.contains("存在环")), "{errors:?}");
    }

    #[test]
    fn validate_rejects_exclusive_group_multi_default_visible() {
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c1","type":"control","panel_id":"viewer"},
              {"key":"c2","type":"control","panel_id":"player"},
              {"key":"g","type":"group","mode":"exclusive","default_visible":["c1","c2"]}
            ],"edges":[]}"#,
        )
        .unwrap();
        assert!(graph
            .validate()
            .iter()
            .any(|e| e.contains("default_visible 至多一个成员")));
    }

    #[test]
    fn unlinked_nodes_are_warnings_not_errors() {
        // 删除关联节点后的中间状态：**允许保存**（画布以灰色"未接通"呈现），
        // 不再作为硬错误拒绝落库。这里逐项验证"缺失即软问题"。
        let cases: &[(&str, &str)] = &[
            (
                "类缺 control",
                r#"{"schema_version":1,"nodes":[{"key":"k","type":"class","media_type":"image"}],"edges":[]}"#,
            ),
            (
                "对象缺 class",
                r#"{"schema_version":1,"nodes":[{"key":"o","type":"object","scope":"clicked"}],"edges":[]}"#,
            ),
            (
                "状态缺 target",
                r#"{"schema_version":1,"nodes":[
                  {"key":"e","type":"event","trigger":"double_click","target":"o"},
                  {"key":"o","type":"object","scope":"clicked"},
                  {"key":"a","type":"action","op":"show"}
                ],"edges":[{"from":"e","to":"a","kind":"fires","order":1}]}"#,
            ),
            (
                "引用指向已删除节点",
                r#"{"schema_version":1,"nodes":[
                  {"key":"o","type":"object","class":"gone","scope":"clicked"}
                ],"edges":[]}"#,
            ),
            (
                "操作缺对象来源",
                r#"{"schema_version":1,"nodes":[{"key":"e","type":"event","trigger":"double_click"}],"edges":[]}"#,
            ),
        ];
        for (label, json) in cases {
            let graph = BlueprintGraph::from_json(json).expect("解析失败");
            assert!(
                graph.validate().is_empty(),
                "{label}: 未接通不应阻塞保存，但报错 {:?}",
                graph.validate()
            );
            assert!(
                !graph.warnings().is_empty(),
                "{label}: 应产生未接通提示"
            );
        }
    }

    #[test]
    fn validate_rejects_wrong_reference_type() {
        // 引用**存在但类型不符**仍是硬错误（那是数据错误，不是"未接通"）。
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"k","type":"class","control":"o","media_type":"image"},
              {"key":"o","type":"object","scope":"clicked"}
            ],"edges":[]}"#,
        )
        .unwrap();
        let errors = graph.validate();
        assert!(
            errors.iter().any(|e| e.contains("必须指向面板控件节点")),
            "{errors:?}"
        );

        // 状态指向不存在节点 → 软；指向存在但类型不符 → 硬
        let bad = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"k2","type":"class","control":"c","media_type":"image"},
              {"key":"a","type":"action","op":"show","target":"k2"},
              {"key":"e","type":"event","trigger":"double_click","target":"c"}
            ],"edges":[{"from":"e","to":"a","kind":"fires","order":1}]}"#,
        )
        .unwrap();
        assert!(
            bad.validate().iter().any(|e| e.contains("target 类型不符")),
            "{:?}",
            bad.validate()
        );
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

    /// RFC 0010 决策 4 / 面板标准第 5.1、7.1 节：**类目挂在无类目面板下**的分级。
    ///
    /// - 宿主内置面板（`has_class` 是不变量）→ **硬错误**（拒绝保存）；
    /// - 插件注册面板（声明随插件版本可变）→ **未接通软告警**（灰显、允许保存）；
    /// - `panel_id` 缺失或面板当前无注册项 → 不判定（按未接通，允许保存）。
    #[test]
    fn panel_has_class_violation_is_graded_by_declarer() {
        fn doc(panel_id: &str) -> String {
            format!(
                r#"{{"schema_version":2,
                    "layers":[{{"key":"l_a","name":"主界面"}}],
                    "nodes":[
                      {{"key":"ui","type":"interface","layer":"l_a"}},
                      {{"key":"blk","type":"layout_block","layer":"l_a","name":"栏"}},
                      {{"key":"c","type":"control","panel_id":"{panel_id}","layer":"l_a"}},
                      {{"key":"k","type":"class","control":"c","media_type":"image","layer":"l_a"}}
                    ],
                    "edges":[
                      {{"from":"ui","to":"blk","kind":"contains","order":1}},
                      {{"from":"blk","to":"c","kind":"contains","order":2}},
                      {{"from":"c","to":"k","kind":"contains","order":3}}
                    ]}}"#
            )
        }

        // 内置面板 media 有类目 → 合法。
        let media = BlueprintGraph::from_json(&doc("media")).unwrap();
        assert!(media.validate().is_empty(), "{:?}", media.validate());

        // 内置面板 viewer 无类目 → 硬错误（宿主声明是不变量）。
        let viewer = BlueprintGraph::from_json(&doc("viewer")).unwrap();
        let errors = viewer.validate();
        assert!(
            errors.iter().any(|e| e.contains("has_class")),
            "内置面板 has_class=false 却挂类目应为硬错误：{errors:?}"
        );

        // 插件注册面板声明 has_class=false → 未接通软告警（允许保存）。
        let plugin_panel = "plugin.dev.hamsterpouch.palette.palette";
        let plugin_graph = BlueprintGraph::from_json(&doc(plugin_panel)).unwrap();
        let registry = NodeRegistry::builtin_only().with_plugin_panels(vec![PanelFact {
            id: plugin_panel.to_string(),
            has_class: false,
            overlay_content: true,
            multiple_per_interface: true,
            plugin: true,
        }]);
        assert!(
            plugin_graph.validate_with(&registry).is_empty(),
            "插件面板的同类违约不得阻塞保存：{:?}",
            plugin_graph.validate_with(&registry)
        );
        assert!(
            plugin_graph
                .warnings_with(&registry)
                .iter()
                .any(|w| w.contains("has_class")),
            "插件面板的同类违约应报未接通软告警：{:?}",
            plugin_graph.warnings_with(&registry)
        );

        // 面板当前无注册项（插件缺失）→ 不判定硬错误，也不丢数据。
        let ghost = BlueprintGraph::from_json(&doc("plugin.dev.gone.panel")).unwrap();
        assert!(ghost.validate().is_empty(), "{:?}", ghost.validate());
    }

    /// 节点标准第 2.1 节（D135）：类目的 `media_type` 必须**属于它所属面板的类型域**。
    ///
    /// 用户口径：「所有选项面板都是反向读取的，源的面板的类目就不能出现媒体预览面板的
    /// 类目的图像、视频、音频」。三件事要一起成立：
    /// 1. **越域**（源面板下写 `image`）= 硬错误；
    /// 2. **同域**（源面板下写 `source`、相册面板下写 `album`）= 合法（D135 放开的两个面板）；
    /// 3. `control` **缺失**（未接通软告警）时**不判分域**——缺失不得绑架用户数据，
    ///    否则断一条线就把既有文档判成"保存失败"。
    #[test]
    fn class_media_type_must_fit_owner_panel_domain() {
        /// 类目**接线到面板**（`control` 有值）的夹具：这是分域判定真正生效的情形。
        fn wired(panel_id: &str, media_type: &str) -> String {
            format!(
                r#"{{"schema_version":2,
                    "layers":[{{"key":"l_a","name":"主界面"}}],
                    "nodes":[
                      {{"key":"ui","type":"interface","layer":"l_a"}},
                      {{"key":"blk","type":"layout_block","layer":"l_a","name":"栏"}},
                      {{"key":"c","type":"control","panel_id":"{panel_id}","layer":"l_a"}},
                      {{"key":"k","type":"class","control":"c","media_type":"{media_type}","layer":"l_a"}}
                    ],
                    "edges":[
                      {{"from":"ui","to":"blk","kind":"contains","order":1}},
                      {{"from":"blk","to":"c","kind":"contains","order":2}},
                      {{"from":"c","to":"k","kind":"contains","order":3}}
                    ]}}"#
            )
        }
        /// 类目**未接线**（`control` 缺失）的夹具：分域判定必须**不生效**。
        fn unwired(panel_id: &str, media_type: &str) -> String {
            format!(
                r#"{{"schema_version":2,
                    "layers":[{{"key":"l_a","name":"主界面"}}],
                    "nodes":[
                      {{"key":"ui","type":"interface","layer":"l_a"}},
                      {{"key":"blk","type":"layout_block","layer":"l_a","name":"栏"}},
                      {{"key":"c","type":"control","panel_id":"{panel_id}","layer":"l_a"}},
                      {{"key":"k","type":"class","media_type":"{media_type}","layer":"l_a"}}
                    ],
                    "edges":[
                      {{"from":"ui","to":"blk","kind":"contains","order":1}},
                      {{"from":"blk","to":"c","kind":"contains","order":2}}
                    ]}}"#
            )
        }

        // 1. 越域：源面板下不能出现媒体预览的类目类型（用户报的那个现象）。
        let crossed = BlueprintGraph::from_json(&wired("sources", "image")).unwrap();
        let errors = crossed.validate();
        assert!(
            errors.iter().any(|e| e.contains("类型域")),
            "源面板下的 image 类目应为硬错误：{errors:?}"
        );

        // 2. 同域：D135 放开的两个面板各自只收自己的类型值。
        let source_ok = BlueprintGraph::from_json(&wired("sources", "source")).unwrap();
        assert!(source_ok.validate().is_empty(), "{:?}", source_ok.validate());
        let album_ok = BlueprintGraph::from_json(&wired("albums", "album")).unwrap();
        assert!(album_ok.validate().is_empty(), "{:?}", album_ok.validate());
        // 媒体预览只收三个媒体类型：album / source 在它下面同样是越域。
        let media_album = BlueprintGraph::from_json(&wired("media", "album")).unwrap();
        assert!(
            media_album.validate().iter().any(|e| e.contains("类型域")),
            "{:?}",
            media_album.validate()
        );

        // 3. `control` 缺失（未接通软告警）：不做分域判定，允许保存。
        let orphan = BlueprintGraph::from_json(&unwired("sources", "image")).unwrap();
        assert!(orphan.validate().is_empty(), "{:?}", orphan.validate());
        assert!(
            orphan.warnings().iter().any(|w| w.contains("暂未接通")),
            "{:?}",
            orphan.warnings()
        );
    }

    /// 面板标准第 7.1 节第 6 条：`mount.overlay_content = false` 的面板被浮层 contains
    /// = **硬错误**（与"浮层不得 contains 布局块"同级）。
    #[test]
    fn panel_without_overlay_content_cannot_be_overlay_child() {
        let json = r#"{"schema_version":2,
            "layers":[{"key":"l_a","name":"主界面"}],
            "nodes":[
              {"key":"ui","type":"interface","layer":"l_a"},
              {"key":"ov","type":"overlay","layer":"l_a","name":"浮层"},
              {"key":"c","type":"control","panel_id":"plugin.dev.hamsterpouch.palette.palette","layer":"l_a"}
            ],
            "edges":[
              {"from":"ui","to":"ov","kind":"contains","order":1},
              {"from":"ov","to":"c","kind":"contains","order":2}
            ]}"#;
        let graph = BlueprintGraph::from_json(json).unwrap();
        let registry = NodeRegistry::builtin_only().with_plugin_panels(vec![PanelFact {
            id: "plugin.dev.hamsterpouch.palette.palette".to_string(),
            has_class: true,
            overlay_content: false,
            multiple_per_interface: true,
            plugin: true,
        }]);
        let errors = graph.validate_with(&registry);
        assert!(
            errors.iter().any(|e| e.contains("overlay_content")),
            "{errors:?}"
        );
        // 未注入面板事实时（面板无注册项）不判定：按未接通处理，允许保存。
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
    }

    /// 面板标准第 7.2 节第 2 条：`mount.multiple_per_interface = false` 但同一界面出现
    /// 多个实例 = **软告警**（不阻塞保存）。
    #[test]
    fn multiple_per_interface_violation_is_soft() {
        let json = r#"{"schema_version":2,
            "layers":[{"key":"l_a","name":"主界面"}],
            "nodes":[
              {"key":"ui","type":"interface","layer":"l_a"},
              {"key":"blk","type":"layout_block","layer":"l_a","name":"栏"},
              {"key":"c1","type":"control","panel_id":"plugin.dev.hamsterpouch.palette.palette","layer":"l_a"},
              {"key":"c2","type":"control","panel_id":"plugin.dev.hamsterpouch.palette.palette","layer":"l_a"}
            ],
            "edges":[
              {"from":"ui","to":"blk","kind":"contains","order":1},
              {"from":"blk","to":"c1","kind":"contains","order":2},
              {"from":"blk","to":"c2","kind":"contains","order":3}
            ]}"#;
        let graph = BlueprintGraph::from_json(json).unwrap();
        let registry = NodeRegistry::builtin_only().with_plugin_panels(vec![PanelFact {
            id: "plugin.dev.hamsterpouch.palette.palette".to_string(),
            has_class: true,
            overlay_content: true,
            multiple_per_interface: false,
            plugin: true,
        }]);
        assert!(graph.validate_with(&registry).is_empty());
        assert!(
            graph
                .warnings_with(&registry)
                .iter()
                .any(|w| w.contains("multiple_per_interface")),
            "{:?}",
            graph.warnings_with(&registry)
        );
    }

    /// RFC 0010 决策 6：节点 `type` 的分流——命名不合法 = 硬错误；
    /// 命名合法但当前无注册项 = 未接通软告警（**允许保存**、节点与边原样保留）。
    #[test]
    fn unknown_node_type_is_split_by_naming_rule() {
        let illegal = BlueprintGraph::from_json(
            r#"{"schema_version":2,"nodes":[{"key":"x","type":"Magic Type"}],"edges":[]}"#,
        )
        .unwrap();
        assert!(
            illegal
                .validate()
                .iter()
                .any(|e| e.contains("不合命名规则")),
            "{:?}",
            illegal.validate()
        );

        let legal_unknown = BlueprintGraph::from_json(
            r#"{"schema_version":2,"nodes":[{"key":"x","type":"magic"}],
                "edges":[{"from":"x","to":"x","kind":"on","order":1}]}"#,
        )
        .unwrap();
        assert!(
            legal_unknown.validate().is_empty(),
            "命名合法但无注册项不得阻塞保存：{:?}",
            legal_unknown.validate()
        );
        assert!(
            legal_unknown
                .warnings()
                .iter()
                .any(|w| w.contains("当前无注册项")),
            "{:?}",
            legal_unknown.warnings()
        );
        // 节点与边**原样保留**（不因未接通而删除）。
        assert_eq!(legal_unknown.nodes.len(), 1);
        assert_eq!(legal_unknown.edges.len(), 1);
        assert_eq!(legal_unknown.nodes[0].node_type.as_str(), "magic");
    }

    /// **D136**：标记从"面板下的平行轴"改为"类目下的从属轴"（与子类并列）。
    ///
    /// 用户原话：「修改蓝图节点逻辑，标记连接到类目上，标记和子类类似。」
    /// 这里钉住三件事：
    /// 1. `class --contains--> mark` 合法（**新增**的合法边，D136 之前是被拒的）；
    /// 2. `control --contains--> mark` **非法**（旧关系的反向断言，防"旧关系偷偷残留"）；
    /// 3. `class --contains--> subclass` 仍合法（子类与标记**并列共存**，不是替换）。
    #[test]
    fn mark_contains_parent_is_class_not_panel() {
        // 1) 类目 → 标记：合法（标记挂在类目下）。
        let ok = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"blk","type":"layout_block","layer":"l_a","name":"栏"},
                  {"key":"c","type":"control","panel_id":"media","layer":"l_a"},
                  {"key":"k","type":"class","control":"c","media_type":"image","layer":"l_a"},
                  {"key":"m","type":"mark","class":"k","mark":"manga","layer":"l_a"}
                ],
                "edges":[
                  {"from":"ui","to":"blk","kind":"contains","order":1},
                  {"from":"blk","to":"c","kind":"contains","order":2},
                  {"from":"c","to":"k","kind":"contains","order":3},
                  {"from":"k","to":"m","kind":"contains","order":4}
                ]}"#,
        )
        .unwrap();
        assert!(
            ok.validate().is_empty(),
            "类目 → 标记 是 D136 的新合法边：{:?}",
            ok.validate()
        );
        assert!(ok.warnings().is_empty(), "{:?}", ok.warnings());

        // 2) 面板 → 标记：**非法**（标记不再直挂面板）。
        let old_relation = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"c","type":"control","panel_id":"media","layer":"l_a"},
                  {"key":"m","type":"mark","mark":"manga","layer":"l_a"}
                ],
                "edges":[{"from":"c","to":"m","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(
            old_relation
                .validate()
                .iter()
                .any(|e| e.contains("非法边")),
            "面板 → 标记 在 D136 之后必须被拒：{:?}",
            old_relation.validate()
        );

        // 3) 类目下子类与标记**并列共存**：同一条线接上两者都合法。
        let both = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"c","type":"control","panel_id":"bookpreview","layer":"l_a"},
                  {"key":"k","type":"class","control":"c","media_type":"text","layer":"l_a"},
                  {"key":"s","type":"subclass","subclass":"k","format":"txt","layer":"l_a"},
                  {"key":"m","type":"mark","class":"k","mark":"manga","layer":"l_a"}
                ],
                "edges":[
                  {"from":"c","to":"k","kind":"contains","order":1},
                  {"from":"k","to":"s","kind":"contains","order":2},
                  {"from":"k","to":"m","kind":"contains","order":3}
                ]}"#,
        )
        .unwrap();
        assert!(
            both.validate().is_empty(),
            "子类与标记在类目下应并列共存：{:?}",
            both.validate()
        );
    }

    /// **D136 迁移口径**：旧文档里标记节点仍带 `control`（指向面板）时，
    /// 按**未接通软告警**处理——**不阻塞保存**（用户库实测 0 个 mark 节点，
    /// 但"读进来就保存不了"绝不能成为迁移事故）。
    #[test]
    fn legacy_mark_control_is_soft_warning_not_error() {
        let legacy = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"c","type":"control","panel_id":"media","layer":"l_a"},
                  {"key":"m","type":"mark","control":"c","mark":"manga","layer":"l_a"}
                ],
                "edges":[]}"#,
        )
        .unwrap();
        assert!(
            legacy.validate().is_empty(),
            "旧 mark.control 不得阻塞保存：{:?}",
            legacy.validate()
        );
        let warnings = legacy.warnings();
        assert!(
            warnings.iter().any(|w| w.contains("旧字段 control")),
            "应报「仍带旧字段 control」软告警：{warnings:?}"
        );
        assert!(
            warnings.iter().any(|w| w.contains(&"m".to_string())),
            "告警应指向这个标记节点：{warnings:?}"
        );
        // 节点与字段**原样保留**（不因迁移口径删数据）。
        assert_eq!(legacy.nodes[1].control.as_deref(), Some("c"));
    }

    /// 标记的 `class` 引用**存在但类型不符**仍是**硬错误**（与"未接通"区分）：
    /// 指向面板节点而非类目节点。
    #[test]
    fn mark_class_must_point_to_class_node() {
        let wrong = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"c","type":"control","panel_id":"media","layer":"l_a"},
                  {"key":"m","type":"mark","class":"c","mark":"manga","layer":"l_a"}
                ],
                "edges":[]}"#,
        )
        .unwrap();
        assert!(
            wrong
                .validate()
                .iter()
                .any(|e| e.contains("class 必须指向类目节点")),
            "{:?}",
            wrong.validate()
        );

        // 缺 `class`（未接通）→ 软告警，不阻塞保存。
        let missing = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "nodes":[{"key":"m","type":"mark","mark":"manga"}],
                "edges":[]}"#,
        )
        .unwrap();
        assert!(missing.validate().is_empty(), "{:?}", missing.validate());
        assert!(!missing.warnings().is_empty(), "缺 class 应报未接通");
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
        // D136 的三处改动**逐项互指**（显式钉住，防止整体对称成立但这条关系被改到别处）。
        let spec_of = |t: &str| {
            BUILTIN_NODE_SPECS
                .iter()
                .find(|s| s.node_type.as_str() == t)
                .expect("内置类型必须存在")
        };
        assert_eq!(spec_of("mark").parents, &["class"], "标记的父是类目（D136）");
        assert!(spec_of("class").children.contains(&"mark"));
        assert!(
            !spec_of("control").children.contains(&"mark"),
            "面板的 children 不得再含 mark（D136：标记不再直挂面板）"
        );
        assert!(spec_of("class").children.contains(&"subclass"));
        assert_eq!(spec_of("object").parents, &["class", "subclass", "mark"]);
    }
