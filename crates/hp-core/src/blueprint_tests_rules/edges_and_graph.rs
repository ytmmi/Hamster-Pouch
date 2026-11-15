// 由 `blueprint_tests.rs` 通过 include! 引入（D219：本文件是它的一个分片）。

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
