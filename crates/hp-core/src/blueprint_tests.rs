
#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn enums_roundtrip() {
        for v in [
            NodeType::LayoutBlock,
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
        ] {
            assert_eq!(ActionOp::from_str(v.as_str()), Some(v));
            assert_eq!(v.is_group_op(), matches!(v, ActionOp::Collapse | ActionOp::Expand));
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
    fn validate_accepts_layout_block_contains_group_and_control() {
        let graph = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"blk","type":"layout_block","name":"右栏"},
              {"key":"g","type":"group","mode":"exclusive"},
              {"key":"c","type":"control","panel_id":"viewer"}
            ],"edges":[
              {"from":"blk","to":"g","kind":"contains","order":1},
              {"from":"blk","to":"c","kind":"contains","order":1}
            ]}"#,
        )
        .unwrap();
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
        // 反向：控件 contains 布局块 → 非法
        let bad = BlueprintGraph::from_json(
            r#"{"schema_version":1,"nodes":[
              {"key":"blk","type":"layout_block"},
              {"key":"c","type":"control","panel_id":"viewer"}
            ],"edges":[{"from":"c","to":"blk","kind":"contains","order":1}]}"#,
        )
        .unwrap();
        assert!(bad.validate().iter().any(|e| e.contains("非法边")));
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
            errors.iter().any(|e| e.contains("必须指向控件节点")),
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
