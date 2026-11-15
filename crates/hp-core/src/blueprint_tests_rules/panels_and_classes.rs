// 由 `blueprint_tests.rs` 通过 include! 引入（D219：本文件是它的一个分片）。

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
