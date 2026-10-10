    #[test]
    fn enums_roundtrip() {
        for v in [
            NodeType::Interface,
            NodeType::LayoutBlock,
            NodeType::Overlay,
            NodeType::Control,
            NodeType::Class,
            NodeType::Object,
            NodeType::Group,
            NodeType::Event,
            NodeType::Condition,
            NodeType::Action,
        ] {
            assert_eq!(NodeType::from_str(v.as_str()), Some(v));
        }
        for v in [GroupMode::Exclusive, GroupMode::Independent] {
            assert_eq!(GroupMode::from_str(v.as_str()), Some(v));
        }
        for v in [
            Trigger::Click,
            Trigger::DoubleClick,
            Trigger::SelectionChange,
        ] {
            assert_eq!(Trigger::from_str(v.as_str()), Some(v));
        }
        for v in [
            ActionOp::Show,
            ActionOp::Hide,
            ActionOp::Toggle,
            ActionOp::Collapse,
            ActionOp::Expand,
            ActionOp::Navigate,
        ] {
            assert_eq!(ActionOp::from_str(v.as_str()), Some(v));
            assert_eq!(v.is_group_op(), matches!(v, ActionOp::Collapse | ActionOp::Expand));
            assert_eq!(v.is_interface_op(), matches!(v, ActionOp::Navigate));
        }
        for v in [
            EdgeKind::Contains,
            EdgeKind::MemberOf,
            EdgeKind::On,
            EdgeKind::Fires,
            EdgeKind::Guards,
        ] {
            assert_eq!(EdgeKind::from_str(v.as_str()), Some(v));
        }
        for v in [
            TokenLevel::None,
            TokenLevel::Sm,
            TokenLevel::Md,
            TokenLevel::Lg,
        ] {
            assert_eq!(TokenLevel::from_str(v.as_str()), Some(v));
        }
        for v in OverlayAnchor::ALL {
            assert_eq!(OverlayAnchor::from_str(v.as_str()), Some(v));
        }
        assert_eq!(OverlayAnchor::ALL.len(), 9, "井字锚点应为 9 个");
        assert_eq!(OverlayAnchor::TopLeft.horizontal(), AnchorAxis::Start);
        assert_eq!(OverlayAnchor::TopLeft.vertical(), AnchorAxis::Start);
        assert_eq!(OverlayAnchor::Center.horizontal(), AnchorAxis::Middle);
        assert_eq!(OverlayAnchor::Center.vertical(), AnchorAxis::Middle);
        assert_eq!(OverlayAnchor::BottomRight.horizontal(), AnchorAxis::End);
        assert_eq!(OverlayAnchor::BottomRight.vertical(), AnchorAxis::End);
        assert_eq!(OverlayAnchor::from_str("middle"), None);
    }

    #[test]
    fn overlay_anchor_and_offset_roundtrip() {
        // 相对定位：九宫格锚点 + 双模式偏移（|v| ≤ 1 比例、|v| > 1 像素）
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a","anchor":"bottom_right",
                   "offset_x":0.25,"offset_y":-16,"visible":true,"height":4}
                ],
                "edges":[{"from":"ui","to":"ov","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
        let ov = graph.nodes.iter().find(|n| n.key == "ov").unwrap();
        assert_eq!(ov.anchor, Some(OverlayAnchor::BottomRight));
        assert_eq!(ov.offset_x, Some(0.25));
        assert_eq!(ov.offset_y, Some(-16.0));
        let back = BlueprintGraph::from_json(&graph.to_json()).unwrap();
        assert_eq!(back, graph, "锚点与偏移必须往返不丢");

        // 未知锚点 → 解析层报错（硬错误）
        assert!(
            !BlueprintGraph::validate_json(
                r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"}],
                    "nodes":[
                      {"key":"ui","type":"interface","layer":"l_a"},
                      {"key":"ov","type":"overlay","layer":"l_a","anchor":"middle"}
                    ],"edges":[]}"#
            )
            .is_empty()
        );
    }

    #[test]
    fn overlay_size_defaults_to_minimum_and_rejects_invalid() {
        // 未写尺寸 → 默认最小尺寸（240×160）
        let plain = BlueprintGraph::from_json(
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a"}
                ],
                "edges":[{"from":"ui","to":"ov","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(plain.validate().is_empty(), "{:?}", plain.validate());
        assert!(
            plain.warnings().is_empty(),
            "未写尺寸不算告警：{:?}",
            plain.warnings()
        );
        let ov = plain.nodes.iter().find(|n| n.key == "ov").unwrap();
        assert!(ov.size.is_none());

        // 写了尺寸：往返不丢，且解析出的实际尺寸 = 给定值
        let sized = BlueprintGraph::from_json(
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a","size":{"width":420,"height":300}}
                ],
                "edges":[{"from":"ui","to":"ov","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(sized.validate().is_empty(), "{:?}", sized.validate());
        let size = sized.nodes[1].size.clone().unwrap();
        assert_eq!(size.resolved(), (420.0, 300.0));
        assert!(!size.below_minimum());
        assert_eq!(BlueprintGraph::from_json(&sized.to_json()).unwrap(), sized);

        // 小于最小尺寸 → 不阻塞保存，但夹紧 + 软告警
        let small = BlueprintGraph::from_json(
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a","size":{"width":80,"height":40}}
                ],
                "edges":[{"from":"ui","to":"ov","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(small.validate().is_empty(), "{:?}", small.validate());
        let s = small.nodes[1].size.clone().unwrap();
        assert_eq!(
            s.resolved(),
            (OVERLAY_MIN_WIDTH, OVERLAY_MIN_HEIGHT),
            "小于最小值应按默认最小尺寸夹紧"
        );
        assert!(
            small.warnings().iter().any(|w| w.contains("最小尺寸")),
            "{:?}",
            small.warnings()
        );

        // 非正数 / 超大 → 硬错误
        for bad in [
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"}],
                "nodes":[{"key":"ui","type":"interface","layer":"l_a"},
                         {"key":"ov","type":"overlay","layer":"l_a","size":{"width":0,"height":100}}],
                "edges":[]}"#,
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"A"}],
                "nodes":[{"key":"ui","type":"interface","layer":"l_a"},
                         {"key":"ov","type":"overlay","layer":"l_a","size":{"width":100,"height":99999}}],
                "edges":[]}"#,
        ] {
            let g = BlueprintGraph::from_json(bad).unwrap();
            assert!(
                g.validate().iter().any(|e| e.contains("size")),
                "非法尺寸应为硬错误：{:?}",
                g.validate()
            );
        }
    }

    #[test]
    fn hide_direction_roundtrip_including_toward() {
        for d in [
            HideDirection::Left,
            HideDirection::Right,
            HideDirection::Up,
            HideDirection::Down,
            HideDirection::Toward("g_other".into()),
        ] {
            assert_eq!(HideDirection::from_str(&d.as_str()), Some(d));
        }
        assert_eq!(HideDirection::from_str("toward:"), None);
        assert_eq!(HideDirection::from_str("unknown"), None);
        assert_eq!(
            HideDirection::Toward("g".into()).toward_target(),
            Some("g")
        );
        assert_eq!(HideDirection::Left.toward_target(), None);
    }

    #[test]
    fn hide_direction_serde_json() {
        let json = serde_json::to_string(&HideDirection::Toward("g_x".into())).unwrap();
        assert_eq!(json, "\"toward:g_x\"");
        let back: HideDirection = serde_json::from_str(&json).unwrap();
        assert_eq!(back, HideDirection::Toward("g_x".into()));
    }

    #[test]
    fn graph_json_roundtrip() {
        // 类目必须挂在**有类目**的面板下（RFC 0010 决策 4 / 面板标准第 5.1 节）：
        // 内置 14 个面板里只有 `media` 的 `has_class = true`，所以这里用 media。
        let json = r#"{
          "schema_version": 1,
          "nodes": [
            {"key":"c_v","type":"control","panel_id":"media","title_key":"panel.media"},
            {"key":"k_i","type":"class","control":"c_v","media_type":"image"},
            {"key":"o_1","type":"object","class":"k_i","scope":"double_clicked"},
            {"key":"g_1","type":"group","mode":"exclusive","default_visible":[],
             "hide_direction":"left","position":{"x":10,"y":20}},
            {"key":"e_1","type":"event","trigger":"double_click","target":"o_1"},
            {"key":"c_1","type":"condition","expr":"media_type == image"},
            {"key":"a_1","type":"action","op":"show","target":"c_v"}
          ],
          "edges": [
            {"from":"e_1","to":"c_1","kind":"fires","order":1},
            {"from":"c_1","to":"a_1","kind":"guards","order":1},
            {"from":"c_v","to":"k_i","kind":"contains","order":1},
            {"from":"k_i","to":"o_1","kind":"contains","order":1},
            {"from":"c_v","to":"g_1","kind":"memberOf","order":1}
          ]
        }"#;
        let graph = BlueprintGraph::from_json(json).expect("解析失败");
        assert_eq!(graph.nodes.len(), 7);
        assert_eq!(graph.edges.len(), 5);
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
        let back = BlueprintGraph::from_json(&graph.to_json()).expect("再解析失败");
        assert_eq!(back, graph);
    }

    #[test]
    fn validate_rejects_duplicate_key() {
        let mut graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"c","type":"control","panel_id":"player"}
            ],"edges":[]}"#,
        )
        .unwrap();
        let errors = graph.validate();
        assert!(errors.iter().any(|e| e.contains("key 重复")));
        graph.nodes.pop();
        assert!(graph.validate().is_empty());
    }

    #[test]
    fn validate_accepts_interface_layout_block_group_and_control() {
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"ui","type":"interface","name":"主界面"},
              {"key":"blk","type":"layout_block","name":"右栏"},
              {"key":"g","type":"group","mode":"exclusive"},
              {"key":"c","type":"control","panel_id":"viewer"}
            ],"edges":[
              {"from":"ui","to":"blk","kind":"contains","order":1},
              {"from":"blk","to":"g","kind":"contains","order":1},
              {"from":"blk","to":"c","kind":"contains","order":1}
            ]}"#,
        )
        .unwrap();
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
        // 反向：面板控件 contains 布局块 → 非法
        let bad = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"blk","type":"layout_block"},
              {"key":"c","type":"control","panel_id":"viewer"}
            ],"edges":[{"from":"c","to":"blk","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(bad.validate().iter().any(|e| e.contains("非法边")));
        // 界面不得直接连面板控件（层级：界面 → 布局块 → ...，RFC 0007 决策 1）
        let skip_level = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"ui","type":"interface"},
              {"key":"c","type":"control","panel_id":"viewer"}
            ],"edges":[{"from":"ui","to":"c","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(skip_level.validate().iter().any(|e| e.contains("非法边")));
    }

    #[test]
    fn validate_accepts_navigate_to_interface_and_rejects_other_types() {
        // 界面跳转：目标为**另一层的**界面节点 → 合法（D48/D51：跨层只允许 navigate 引用）
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_main","name":"主界面"},{"key":"l_edit","name":"编辑界面"}],
                "nodes":[
                  {"key":"ui_main","type":"interface","layer":"l_main"},
                  {"key":"ui_edit","type":"interface","layer":"l_edit"},
                  {"key":"blk","type":"layout_block","name":"栏","layer":"l_main"},
                  {"key":"c","type":"control","panel_id":"viewer","layer":"l_main"},
                  {"key":"e","type":"event","trigger":"click","layer":"l_main"},
                  {"key":"a","type":"action","op":"navigate","target":"ui_edit","layer":"l_main"}
                ],
                "edges":[
                  {"from":"ui_main","to":"blk","kind":"contains","order":1},
                  {"from":"blk","to":"c","kind":"contains","order":2},
                  {"from":"c","to":"e","kind":"on","order":3},
                  {"from":"e","to":"a","kind":"fires","order":4}
                ]}"#,
        )
        .unwrap();
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
        assert!(graph.warnings().is_empty(), "{:?}", graph.warnings());

        // 目标为面板控件 → 硬错误
        let bad = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"a","type":"action","op":"navigate","target":"c"}
            ],"edges":[]}"#,
        )
        .unwrap();
        assert!(
            bad.validate().iter().any(|e| e.contains("navigate")),
            "{:?}",
            bad.validate()
        );

        // 目标界面已删除 → 未接通（软告警，不阻塞保存）
        let dangling = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"a","type":"action","op":"navigate","target":"ui_gone"}
            ],"edges":[]}"#,
        )
        .unwrap();
        assert!(dangling.validate().is_empty(), "{:?}", dangling.validate());
        assert!(
            dangling.warnings().iter().any(|w| w.contains("暂未接通")),
            "{:?}",
            dangling.warnings()
        );
    }

    #[test]
    fn multiple_interfaces_require_layers() {
        // 界面 = 页面，可有**多个**（多页面基础，D47）——但自 D51 起，"每层至多一个界面"，
        // 因此多页面必须**显式分层**：同层出现两个界面是硬错误。
        let same_layer = BlueprintGraph::from_json(
            r#"{"schema_version":2,"nodes":[
              {"key":"ui_a","type":"interface"},
              {"key":"ui_b","type":"interface"}
            ],"edges":[]}"#,
        )
        .unwrap();
        assert!(
            same_layer
                .validate()
                .iter()
                .any(|e| e.contains("每层至多一个")),
            "{:?}",
            same_layer.validate()
        );

        // 显式分层：两个界面各占一层 → 合法（多页面）
        let layered = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"浏览层"},{"key":"l_b","name":"编辑层"}],
                "nodes":[
                  {"key":"ui_a","type":"interface","layer":"l_a"},
                  {"key":"ui_b","type":"interface","layer":"l_b"}
                ],"edges":[]}"#,
        )
        .unwrap();
        assert!(layered.validate().is_empty(), "{:?}", layered.validate());
    }

    #[test]
    fn layers_validate_keys_names_and_node_ownership() {
        // 缺 layer（文档已分层）→ 硬错误
        let missing = BlueprintGraph::from_json(
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[{"key":"ui","type":"interface"}],"edges":[]}"#,
        )
        .unwrap();
        assert!(
            missing.validate().iter().any(|e| e.contains("缺少 layer")),
            "{:?}",
            missing.validate()
        );

        // layer 指向不存在的层 → 硬错误
        let unknown = BlueprintGraph::from_json(
            r#"{"schema_version":2,"layers":[{"key":"l_a","name":"主界面"}],
                "nodes":[{"key":"ui","type":"interface","layer":"l_gone"}],"edges":[]}"#,
        )
        .unwrap();
        assert!(
            unknown
                .validate()
                .iter()
                .any(|e| e.contains("指向不存在的层")),
            "{:?}",
            unknown.validate()
        );

        // 层 key 重复 / 层名重复（D60）/ 空层名 → 硬错误
        let dup = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"同名"},{"key":"l_a","name":"同名"}],
                "nodes":[{"key":"ui","type":"interface","layer":"l_a"}],"edges":[]}"#,
        )
        .unwrap();
        let errors = dup.validate();
        assert!(errors.iter().any(|e| e.contains("层 key 重复")), "{errors:?}");
        assert!(errors.iter().any(|e| e.contains("层名重复")), "{errors:?}");

        // 跨层边 → 硬错误（跨层只允许 navigate 引用，而 navigate 是字段不是边）
        let crossing = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"A"},{"key":"l_b","name":"B"}],
                "nodes":[
                  {"key":"ui_a","type":"interface","layer":"l_a"},
                  {"key":"ui_b","type":"interface","layer":"l_b"},
                  {"key":"blk_b","type":"layout_block","layer":"l_b"}
                ],
                "edges":[{"from":"ui_a","to":"blk_b","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(
            crossing
                .validate()
                .iter()
                .any(|e| e.contains("跨层边")),
            "{:?}",
            crossing.validate()
        );
    }

    #[test]
    fn warnings_report_rootless_layer_and_detached_overlay() {
        // 无根层（D55）：层内界面被软删除 → 软告警，不阻塞保存
        let rootless = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"A"},{"key":"l_b","name":"B"}],
                "nodes":[
                  {"key":"ui_a","type":"interface","layer":"l_a"},
                  {"key":"blk_b","type":"layout_block","layer":"l_b"}
                ],"edges":[]}"#,
        )
        .unwrap();
        assert!(rootless.validate().is_empty(), "{:?}", rootless.validate());
        assert!(
            rootless
                .warnings()
                .iter()
                .any(|w| w.contains("无根层")),
            "{:?}",
            rootless.warnings()
        );

        // 浮层：**取消「浮动控件」绑定后**不再有 control_id 相关软告警（空浮层也可保存）
        let overlay = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a"}
                ],
                "edges":[{"from":"ui","to":"ov","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(overlay.validate().is_empty(), "{:?}", overlay.validate());
        assert!(
            overlay.warnings().is_empty(),
            "已连到界面的空浮层不应产生未接通告警：{:?}",
            overlay.warnings()
        );

        // 断开 界面→浮层：浮层"未接通"（软告警，不阻塞保存；运行时不应显示）
        let detached = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"ov","type":"overlay","layer":"l_a","visible":true},
                  {"key":"c","type":"control","layer":"l_a","panel_id":"tasks"}
                ],
                "edges":[{"from":"ov","to":"c","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(detached.validate().is_empty(), "{:?}", detached.validate());
        assert!(
            detached
                .warnings()
                .iter()
                .any(|w| w.contains("未连接到界面")),
            "断开界面连接应报未接通：{:?}",
            detached.warnings()
        );
    }

    #[test]
    fn warnings_report_missing_structural_parent() {
        // 结构父缺失（D108）：`布局块 / 标签组 / 面板` 没有 `contains` 入边 = 不属于任何
        // 页面/容器 → **未接通**（软告警，不阻塞保存）。它是「新增节点不再自动连线」之后
        // "刚摆下还没接好"的可见形态，与前端 `blueprintLint` 同口径（由
        // `pnpm check:blueprint-nodes` 的 TS↔Rust 一致性断言把两侧钉在一起）。
        let orphan = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"blk","type":"layout_block","name":"栏","layer":"l_a"},
                  {"key":"g","type":"group","mode":"exclusive","layer":"l_a"},
                  {"key":"c","type":"control","panel_id":"tasks","layer":"l_a"}
                ],
                "edges":[]}"#,
        )
        .unwrap();
        assert!(orphan.validate().is_empty(), "{:?}", orphan.validate());
        let orphan_warnings = orphan.warnings();
        let missing = orphan_warnings
            .iter()
            .filter(|w| w.contains("没有结构父"))
            .count();
        assert_eq!(
            missing,
            3,
            "布局块/标签组/面板三个都应报结构父缺失（界面是层根，不报）：{:?}",
            orphan_warnings
        );

        // 接好之后告警消失（界面 → 布局块 → 标签组/面板）
        let wired = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"blk","type":"layout_block","name":"栏","layer":"l_a"},
                  {"key":"g","type":"group","mode":"exclusive","layer":"l_a"},
                  {"key":"c","type":"control","panel_id":"tasks","layer":"l_a"}
                ],
                "edges":[
                  {"from":"ui","to":"blk","kind":"contains","order":1},
                  {"from":"blk","to":"g","kind":"contains","order":2},
                  {"from":"g","to":"c","kind":"contains","order":3}
                ]}"#,
        )
        .unwrap();
        assert!(
            wired.warnings().is_empty(),
            "接好结构父后不应再有未接通：{:?}",
            wired.warnings()
        );

        // **兼容旧图**：面板用 `memberOf` 指向标签组（D59 之前的写法）也算接好了
        let legacy = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_a"},
                  {"key":"blk","type":"layout_block","name":"栏","layer":"l_a"},
                  {"key":"g","type":"group","mode":"exclusive","layer":"l_a"},
                  {"key":"c","type":"control","panel_id":"tasks","layer":"l_a"}
                ],
                "edges":[
                  {"from":"ui","to":"blk","kind":"contains","order":1},
                  {"from":"blk","to":"g","kind":"contains","order":2},
                  {"from":"c","to":"g","kind":"memberOf","order":3}
                ]}"#,
        )
        .unwrap();
        assert!(
            !legacy.warnings().iter().any(|w| w.contains("没有结构父")),
            "`面板 --memberOf--> 标签组`（兼容旧图）也算接好：{:?}",
            legacy.warnings()
        );

        // **悬空边不算接好**（与前端 `byKey.has(...)` 一致；悬空边本身是硬错误）
        let dangling = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"A"}],
                "nodes":[
                  {"key":"c","type":"control","panel_id":"tasks","layer":"l_a"}
                ],
                "edges":[{"from":"gone","to":"c","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(!dangling.validate().is_empty(), "悬空边应是硬错误");
        assert!(
            dangling
                .warnings()
                .iter()
                .any(|w| w.contains("没有结构父")),
            "指向不存在节点的边不算结构父：{:?}",
            dangling.warnings()
        );
    }

    #[test]
    fn rejects_conflicting_states_within_one_trigger() {
        // 夹具生成器：同一对象 + 同一触发下的两个动作。
        // `extra_nodes` = 追加节点，`edges` = 追加边；两者都直接插入 JSON 片段。
        let with_actions = |extra_nodes: &str, edges: &str| {
            BlueprintGraph::from_json(&format!(
                r#"{{"schema_version":2,
                    "layers":[{{"key":"l_a","name":"主界面"}}],
                    "nodes":[
                      {{"key":"ui","type":"interface","layer":"l_a"}},
                      {{"key":"blk","type":"layout_block","layer":"l_a","name":"栏"}},
                      {{"key":"c_media","type":"control","panel_id":"media","layer":"l_a"}},
                      {{"key":"c_viewer","type":"control","panel_id":"viewer","layer":"l_a"}},
                      {{"key":"c_player","type":"control","panel_id":"player","layer":"l_a"}},
                      {{"key":"g_v","type":"group","mode":"exclusive","layer":"l_a"}},
                      {{"key":"k","type":"class","control":"c_media","media_type":"image","layer":"l_a"}},
                      {{"key":"o","type":"object","class":"k","scope":"double_clicked","layer":"l_a"}},
                      {{"key":"e1","type":"event","trigger":"double_click","layer":"l_a"}},
                      {{"key":"e2","type":"event","trigger":"double_click","layer":"l_a"}},
                      {{"key":"e_click","type":"event","trigger":"click","layer":"l_a"}}
                      {extra_nodes}
                    ],
                    "edges":[
                      {{"from":"ui","to":"blk","kind":"contains","order":1}},
                      {{"from":"blk","to":"c_media","kind":"contains","order":2}},
                      {{"from":"blk","to":"c_viewer","kind":"contains","order":3}},
                      {{"from":"blk","to":"c_player","kind":"contains","order":4}},
                      {{"from":"blk","to":"g_v","kind":"contains","order":5}},
                      {{"from":"g_v","to":"c_viewer","kind":"contains","order":6}},
                      {{"from":"g_v","to":"c_player","kind":"contains","order":7}},
                      {{"from":"c_media","to":"k","kind":"contains","order":8}},
                      {{"from":"k","to":"o","kind":"contains","order":9}},
                      {{"from":"o","to":"e1","kind":"on","order":10}},
                      {{"from":"o","to":"e2","kind":"on","order":11}},
                      {{"from":"o","to":"e_click","kind":"on","order":12}}
                      {edges}
                    ]}}"#,
            ))
            .unwrap()
        };

        // show + hide（同一目标）= 冲突。
        let conflict = with_actions(
            r#",
                      {"key":"a_show","type":"action","op":"show","target":"c_viewer","layer":"l_a"},
                      {"key":"a_hide","type":"action","op":"hide","target":"c_viewer","layer":"l_a"}"#,
            r#",
                      {"from":"e1","to":"a_show","kind":"fires","order":13},
                      {"from":"e2","to":"a_hide","kind":"fires","order":14}"#,
        );
        assert!(
            conflict.validate().iter().any(|e| e.contains("状态冲突")),
            "show/hide 同目标应冲突：{:?}",
            conflict.validate()
        );

        // collapse + expand（同一标签组）= 冲突。
        let group_conflict = with_actions(
            r#",
                      {"key":"a_c","type":"action","op":"collapse","target":"g_v","layer":"l_a"},
                      {"key":"a_e","type":"action","op":"expand","target":"g_v","layer":"l_a"}"#,
            r#",
                      {"from":"e1","to":"a_c","kind":"fires","order":13},
                      {"from":"e2","to":"a_e","kind":"fires","order":14}"#,
        );
        assert!(
            group_conflict
                .validate()
                .iter()
                .any(|e| e.contains("状态冲突")),
            "collapse/expand 同组应冲突：{:?}",
            group_conflict.validate()
        );

        // 互斥组两个成员被同时显示 = 冲突。
        let exclusive_conflict = with_actions(
            r#",
                      {"key":"a_v","type":"action","op":"show","target":"c_viewer","layer":"l_a"},
                      {"key":"a_p","type":"action","op":"show","target":"c_player","layer":"l_a"}"#,
            r#",
                      {"from":"e1","to":"a_v","kind":"fires","order":13},
                      {"from":"e2","to":"a_p","kind":"fires","order":14}"#,
        );
        assert!(
            exclusive_conflict
                .validate()
                .iter()
                .any(|e| e.contains("互斥组") && e.contains("同时置为显示")),
            "互斥组双成员显示应冲突：{:?}",
            exclusive_conflict.validate()
        );

        // 同一动作重复两次（show + show）= 不冲突；不同触发之间也不冲突。
        let ok = with_actions(
            r#",
                      {"key":"a_one","type":"action","op":"show","target":"c_viewer","layer":"l_a"},
                      {"key":"a_two","type":"action","op":"show","target":"c_viewer","layer":"l_a"},
                      {"key":"a_clk","type":"action","op":"hide","target":"c_viewer","layer":"l_a"}"#,
            r#",
                      {"from":"e1","to":"a_one","kind":"fires","order":13},
                      {"from":"e2","to":"a_two","kind":"fires","order":14},
                      {"from":"e_click","to":"a_clk","kind":"fires","order":15}"#,
        );
        assert!(
            ok.validate().is_empty(),
            "重复同一动作、或不同触发下的相反动作不应报冲突：{:?}",
            ok.validate()
        );

        // 经条件（guards）到达的动作同样纳入冲突判定。
        let via_condition = with_actions(
            r#",
                      {"key":"cond","type":"condition","expr":"media_type == image","layer":"l_a"},
                      {"key":"a_show","type":"action","op":"show","target":"c_viewer","layer":"l_a"},
                      {"key":"a_hide","type":"action","op":"hide","target":"c_viewer","layer":"l_a"}"#,
            r#",
                      {"from":"e1","to":"a_show","kind":"fires","order":13},
                      {"from":"e1","to":"cond","kind":"fires","order":14},
                      {"from":"cond","to":"a_hide","kind":"guards","order":15}"#,
        );
        assert!(
            via_condition
                .validate()
                .iter()
                .any(|e| e.contains("状态冲突")),
            "经条件的动作应纳入冲突判定：{:?}",
            via_condition.validate()
        );
    }

    #[test]
    fn home_layer_marker_rules() {
        // 带 `is_home` 的层：home_layer_key 取标记层。
        let marked = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_main","name":"主界面"},{"key":"l_2","name":"界面 2","is_home":true}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_main"},
                  {"key":"ui_2","type":"interface","layer":"l_2"}
                ],
                "edges":[]}"#,
        )
        .unwrap();
        assert_eq!(marked.home_layer_key().as_deref(), Some("l_2"));
        assert!(marked.validate().is_empty(), "{:?}", marked.validate());

        // 无标记：回退第一个层（旧文档兼容）。
        let unmarked = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_main","name":"主界面"},{"key":"l_2","name":"界面 2"}],
                "nodes":[
                  {"key":"ui","type":"interface","layer":"l_main"},
                  {"key":"ui_2","type":"interface","layer":"l_2"}
                ],
                "edges":[]}"#,
        )
        .unwrap();
        assert_eq!(unmarked.home_layer_key().as_deref(), Some("l_main"));

        // 单层兜底文档：兜底层即主界面。
        let single = BlueprintGraph::from_json(
            r#"{"schema_version":2,"nodes":[{"key":"ui","type":"interface"}],"edges":[]}"#,
        )
        .unwrap();
        assert_eq!(single.home_layer_key().as_deref(), Some("l_main"));

        // 多个 `is_home` → 硬错误（D67）。
        let duplicated = BlueprintGraph::from_json(
            r#"{"schema_version":2,
                "layers":[{"key":"l_a","name":"A","is_home":true},{"key":"l_b","name":"B","is_home":true}],
                "nodes":[{"key":"ui","type":"interface","layer":"l_a"}],
                "edges":[]}"#,
        )
        .unwrap();
        assert!(
            duplicated
                .validate()
                .iter()
                .any(|e| e.contains("主界面标记重复")),
            "{:?}",
            duplicated.validate()
        );
    }

