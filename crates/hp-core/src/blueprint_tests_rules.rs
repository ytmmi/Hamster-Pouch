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

    /// **D137（v3）**：标记从"类目下的从属轴"再下沉一级，改为**挂在对象之下**
    /// （`class ⊃ object ⊃ mark`，链的末梢）。
    ///
    /// 用户原话（2026-11-02）：「标记要接在**对象**后面，标记是对**单个对象**的细分。」
    /// 这里钉住三件事：
    /// 1. `object --contains--> mark` 合法（v3 新增的合法边）；
    /// 2. `class --contains--> mark` **非法**（D136 的旧方向，v3 已撤销）；
    /// 3. `class --contains--> object` 仍合法（对象仍与子类并列挂在类目下）。
    #[test]
    fn mark_contains_parent_is_object_not_class() {
        // 1) 对象 → 标记：合法（标记挂在对象下）。
        let ok = BlueprintGraph::from_json(
            r#"{"schema_version":3,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"blk","type":"layout_block","layer":"l_a","name":"栏"},
                  {"key":"c","type":"control","panel_id":"media","layer":"l_a"},
                  {"key":"k","type":"class","control":"c","media_type":"image","layer":"l_a"},
                  {"key":"o","type":"object","class":"k","scope":"double_clicked","layer":"l_a"},
                  {"key":"m","type":"mark","object":"o","mark":"manga","layer":"l_a"}
                ],
                "edges":[
                  {"from":"ui","to":"blk","kind":"contains","order":1},
                  {"from":"blk","to":"c","kind":"contains","order":2},
                  {"from":"c","to":"k","kind":"contains","order":3},
                  {"from":"k","to":"o","kind":"contains","order":4},
                  {"from":"o","to":"m","kind":"contains","order":5}
                ]}"#,
        )
        .unwrap();
        assert!(
            ok.validate().is_empty(),
            "对象 → 标记 是 v3 的新合法边：{:?}",
            ok.validate()
        );
        assert!(ok.warnings().is_empty(), "{:?}", ok.warnings());

        // 2) 类目 → 标记：**非法**（D136 的旧方向，v3 已撤销）。
        let old_relation = BlueprintGraph::from_json(
            r#"{"schema_version":3,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"c","type":"control","panel_id":"media","layer":"l_a"},
                  {"key":"k","type":"class","control":"c","media_type":"image","layer":"l_a"},
                  {"key":"o","type":"object","class":"k","scope":"clicked","layer":"l_a"},
                  {"key":"m","type":"mark","object":"o","mark":"manga","layer":"l_a"}
                ],
                "edges":[
                  {"from":"c","to":"k","kind":"contains","order":1},
                  {"from":"k","to":"m","kind":"contains","order":2}
                ]}"#,
        )
        .unwrap();
        assert!(
            old_relation.validate().iter().any(|e| e.contains("非法边")),
            "类目 → 标记 在 v3 之后必须被拒：{:?}",
            old_relation.validate()
        );

        // 3) 类目下子类与对象**并列共存**，对象下面再挂标记：同一条链全通。
        let both = BlueprintGraph::from_json(
            r#"{"schema_version":3,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"blk","type":"layout_block","layer":"l_a","name":"栏"},
                  {"key":"c","type":"control","panel_id":"bookpreview","layer":"l_a"},
                  {"key":"k","type":"class","control":"c","media_type":"text","layer":"l_a"},
                  {"key":"s","type":"subclass","subclass":"k","format":"txt","layer":"l_a"},
                  {"key":"o","type":"object","subclass":"s","scope":"click","layer":"l_a"},
                  {"key":"m","type":"mark","object":"o","mark":"manga","layer":"l_a"}
                ],
                "edges":[
                  {"from":"ui","to":"blk","kind":"contains","order":1},
                  {"from":"blk","to":"c","kind":"contains","order":2},
                  {"from":"c","to":"k","kind":"contains","order":3},
                  {"from":"k","to":"s","kind":"contains","order":4},
                  {"from":"s","to":"o","kind":"contains","order":5},
                  {"from":"o","to":"m","kind":"contains","order":6}
                ]}"#,
        )
        .unwrap();
        assert!(
            both.validate().is_empty(),
            "子类/对象/标记三级链应全部合法：{:?}",
            both.validate()
        );
        assert!(both.warnings().is_empty(), "{:?}", both.warnings());
    }

    /// **D136 / D137 迁移口径**：旧文档里标记节点仍带 `control`（指向面板）时，
    /// 按**未接通软告警**处理——**不阻塞保存**（D136 时用户库实测 0 个 mark 节点，
    /// 但"读进来就保存不了"绝不能成为迁移事故；D137 起用户库确有 mark 节点，
    /// 由 v2 → v3 迁移改写结构父）。
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

    /// **D137（v3）残留字段**：D136 那一版标记用 `class` 指向**类目**，v3 改挂对象后
    /// 改用 `object`；旧文档里残留的 `class` 同样只报**未接通软告警**、**不阻塞保存**
    /// （否则"打开旧蓝图就存不回去"会变成新的迁移事故）。
    #[test]
    fn legacy_mark_class_is_soft_warning_not_error() {
        let legacy = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"c","type":"control","panel_id":"media","layer":"l_a"},
                  {"key":"k","type":"class","control":"c","media_type":"image","layer":"l_a"},
                  {"key":"m","type":"mark","class":"k","mark":"manga","layer":"l_a"}
                ],
                "edges":[]}"#,
        )
        .unwrap();
        assert!(
            legacy.validate().is_empty(),
            "旧 mark.class 不得阻塞保存：{:?}",
            legacy.validate()
        );
        let warnings = legacy.warnings();
        assert!(
            warnings.iter().any(|w| w.contains("旧字段 class")),
            "应报「仍带旧字段 class」软告警：{warnings:?}"
        );
        // 未接通（缺 object）+ 残留字段，两条软告警都要有。
        assert!(
            warnings.iter().any(|w| w.contains("缺少必要引用")),
            "缺 object 应报未接通：{warnings:?}"
        );
        // 节点与字段**原样保留**（不因迁移口径删数据）。
        assert_eq!(legacy.nodes[2].class.as_deref(), Some("k"));
        assert_eq!(legacy.nodes[2].object, None);
    }

    /// **D137（v3）对象侧残留字段**：v2 及更早的对象有第三条语义轴 `mark_ref`，
    /// v3 起改为「标记挂在对象下」（`对象 --contains--> 标记`），该轴废弃；
    /// 残留值同样只报**未接通软告警**、**不阻塞保存**（与 `mark.control` /
    /// `mark.class` 同口径，RFC 0007 / 节点标准第 10 条）。
    #[test]
    fn legacy_object_mark_ref_is_soft_warning_not_error() {
        let legacy = BlueprintGraph::from_json(
            r#"{"schema_version":3,
                "layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[
                  {"key":"c","type":"control","panel_id":"media","layer":"l_a"},
                  {"key":"k","type":"class","control":"c","media_type":"image","layer":"l_a"},
                  {"key":"o","type":"object","class":"k","scope":"double_clicked","mark_ref":"m","layer":"l_a"},
                  {"key":"m","type":"mark","object":"o","mark":"manga","layer":"l_a"}
                ],
                "edges":[]}"#,
        )
        .unwrap();
        assert!(
            legacy.validate().is_empty(),
            "旧 object.mark_ref 不得阻塞保存：{:?}",
            legacy.validate()
        );
        let warnings = legacy.warnings();
        let hits = warnings
            .iter()
            .filter(|w| w.contains("旧字段 mark_ref"))
            .count();
        assert_eq!(
            hits, 1,
            "应恰好报一条「仍带旧字段 mark_ref」软告警：{warnings:?}"
        );
        assert!(
            warnings.iter().any(|w| w.contains("v3/D137 起该轴已废弃")),
            "告警要说清 v3 不再用这条轴：{warnings:?}"
        );
        // 对象已声明 `class` 轴 ⇒ 不该再报"缺少必要引用"（残留 mark_ref **不**算声明）。
        assert!(
            !warnings.iter().any(|w| w.contains("缺少必要引用")),
            "声明了 class 轴就不该报未接通：{warnings:?}"
        );
        // 节点与字段**原样保留**（不因迁移口径删数据）。
        assert_eq!(legacy.nodes[2].mark_ref.as_deref(), Some("m"));
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

    /// **D138：`scope` ↔ `trigger` 错配是软告警**（不阻塞保存）。
    ///
    /// 图完全合法、引用一个不缺，但运行时的判定顺序是"`trigger` 决定本次上报的
    /// `scope`"，再要求对象的 `scope` 相等；`click` 配 `double_clicked` 这类错配
    /// 让这条链**永远不会命中**——用户看到的是"点了没反应、也没有任何提示"。
    /// 它与"缺引用"同级：只报软告警，允许先保存中间状态。
    #[test]
    fn scope_trigger_mismatch_is_soft_warning_not_error() {
        // 相机：类目 ⊃ 对象(scope=double_clicked) ⊃ 标记(image) --on--> 操作(click)
        let build = |scope: &str, trigger: &str, use_on_edge: bool| {
            let edge = if use_on_edge {
                r#"[{"from":"m","to":"e","kind":"on","order":1}]"#
            } else {
                "[]"
            };
            let target = if use_on_edge { "" } else { r#","target":"m""# };
            format!(
                r#"{{"schema_version":3,
                    "layers":[{{"key":"l_a","name":"主界面"}}],
                    "nodes":[
                      {{"key":"c","type":"control","panel_id":"media","layer":"l_a"}},
                      {{"key":"k","type":"class","control":"c","media_type":"image","layer":"l_a"}},
                      {{"key":"o","type":"object","class":"k","scope":"{scope}","layer":"l_a"}},
                      {{"key":"m","type":"mark","object":"o","mark":"image","layer":"l_a"}},
                      {{"key":"e","type":"event","trigger":"{trigger}"{target},"layer":"l_a"}}
                    ],
                    "edges":{edge}}}"#
            )
        };

        // ① 错配（click 事件 + double_clicked 对象）：恰好一条「不配对」软告警。
        let mismatch = BlueprintGraph::from_json(&build("double_clicked", "click", true)).unwrap();
        assert!(
            mismatch.validate().is_empty(),
            "scope/trigger 错配不得阻塞保存：{:?}",
            mismatch.validate()
        );
        let warnings = mismatch.warnings();
        let hits = warnings.iter().filter(|w| w.contains("不配对")).count();
        assert_eq!(
            hits, 1,
            "应恰好报一条「触发方式与来源对象的 scope 不配对」：{warnings:?}"
        );
        assert!(
            warnings.iter().any(|w| w.contains("click↔clicked")),
            "告警要给出三种正确配对：{warnings:?}"
        );

        // ② 配对（click 事件 + clicked 对象）：不报该告警。
        let matched = BlueprintGraph::from_json(&build("clicked", "click", true)).unwrap();
        assert!(
            !matched.warnings().iter().any(|w| w.contains("不配对")),
            "配对正确时不该报错配：{:?}",
            matched.warnings()
        );

        // ③ `scope` 写成具体 `file_id`：可被对应实例命中，**不算**错配。
        let file_id = BlueprintGraph::from_json(&build("alb-1", "click", true)).unwrap();
        assert!(
            !file_id.warnings().iter().any(|w| w.contains("不配对")),
            "具体 file_id 的 scope 是对实例的精确匹配，不算错配：{:?}",
            file_id.warnings()
        );

        // ④ 旧图形态：没有 `on` 入边、只在事件上写 `target` 也要判（与运行时同序）。
        let legacy = BlueprintGraph::from_json(&build("double_clicked", "click", false)).unwrap();
        assert!(
            legacy.warnings().iter().any(|w| w.contains("不配对")),
            "旧图用 target 指向来源时同样要报错配：{:?}",
            legacy.warnings()
        );
    }
