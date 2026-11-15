// 由 `blueprint_tests.rs` 通过 include! 引入（D219：本文件是它的一个分片）。

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
