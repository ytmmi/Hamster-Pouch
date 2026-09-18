// 蓝图领域测试夹具（RFC 0007 / D28-D60），由 `blueprint.rs` 以 `include!` 挂载。
//
// 覆盖范围 = **蓝图这一个功能域**的全部纯逻辑：枚举往返、节点/边/层的 JSON 形态、
// 图级校验（硬错误）、未接通软告警、分层兜底与 v1 → v2 迁移。
// 因此本文件是一个功能域的单一测试文件，不按被测子模块再拆
// （`file-structure.md`：是否需要拆分取决于职责是否杂乱，与行数无关）。
//
// 注：本文件用 `include!` 内联展开，故不使用内层文档注释（`//!`）。

#[cfg(test)]
mod tests {
    use super::*;


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
        let json = r#"{
          "schema_version": 1,
          "nodes": [
            {"key":"c_v","type":"control","panel_id":"viewer","title_key":"panel.viewer"},
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
                  {"key":"c","type":"control","panel_id":"viewer","layer":"l_main"},
                  {"key":"e","type":"event","trigger":"click","layer":"l_main"},
                  {"key":"a","type":"action","op":"navigate","target":"ui_edit","layer":"l_main"}
                ],
                "edges":[
                  {"from":"c","to":"e","kind":"on","order":1},
                  {"from":"e","to":"a","kind":"fires","order":1}
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
    fn validate_accepts_overlay_and_rejects_illegal_overlay_actions() {
        // 浮层：interface --contains--> overlay 合法（浮层是容器，见另一条用例）
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
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
        assert!(graph.warnings().is_empty(), "{:?}", graph.warnings());
        assert_eq!(graph.nodes[1].height, Some(5));

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
              {"key":"c","type":"control","panel_id":"viewer"},
              {"key":"k","type":"class","control":"c","media_type":"image"},
              {"key":"o","type":"object","class":"k","scope":"double_clicked"},
              {"key":"e","type":"event","trigger":"double_click"},
              {"key":"a","type":"action","op":"show","target":"c"}
            ],"edges":[
              {"from":"o","to":"e","kind":"on","order":1},
              {"from":"e","to":"a","kind":"fires","order":2}
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
}
