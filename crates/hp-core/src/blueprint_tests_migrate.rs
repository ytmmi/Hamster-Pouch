// 蓝图**迁移**测试清单（v1→v2 单界面分层、v2→v3 标记归位），由 `blueprint.rs`
// 以 `include!` 内联进同一个 `mod tests`（见 `blueprint_tests.rs`）。
//
// 为什么单独一份：`blueprint_tests_rules.rs` 命中单文件 1200 行硬上限
// （`file-structure.md` / `tools/check-line-count.mjs`）。迁移用例自带大段 JSON 夹具，
// 与「校验/规则」清单混在一起既超限也难扫读，故按职责拆出这一份。

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

    /// **v2 → v3（D137）形态一：D136 规范形态** `K --contains--> M --contains--> O`。
    ///
    /// 必须改写为 `K --contains--> O --contains--> M`，且**规则边**从对象改挂到标记：
    /// 旧口径下 `mark ⊃ object`，"对象命中"**已经**蕴含"标记命中"，把触发点从对象
    /// 搬到标记是**等价**改写（task-4 冻结契约第 3 条），不是新增行为。
    #[test]
    fn migrate_v2_moves_mark_from_class_to_object() {
        use crate::blueprint_migrate::migrate_document;
        use crate::blueprint_types::EdgeKind;

        let v2 = r#"{"schema_version":2,
            "layers":[{"key":"l_a","name":"主界面"}],
            "nodes":[
              {"key":"c","type":"control","panel_id":"media","layer":"l_a"},
              {"key":"k","type":"class","control":"c","media_type":"image","layer":"l_a"},
              {"key":"m","type":"mark","class":"k","mark":"manga","layer":"l_a"},
              {"key":"o","type":"object","mark_ref":"m","scope":"clicked","layer":"l_a"},
              {"key":"e1","type":"event","trigger":"click","target":"o","layer":"l_a"},
              {"key":"e2","type":"event","trigger":"click","target":"o","layer":"l_a"},
              {"key":"a","type":"action","op":"toggle","target":"c","layer":"l_a"}
            ],
            "edges":[
              {"from":"c","to":"k","kind":"contains","order":1},
              {"from":"k","to":"m","kind":"contains","order":2},
              {"from":"m","to":"o","kind":"contains","order":3},
              {"from":"o","to":"e1","kind":"on","order":4},
              {"from":"e1","to":"a","kind":"fires","order":5}
            ]}"#;
        let migrated = migrate_document(v2).unwrap().expect("v2 应触发迁移");
        assert_eq!(migrated.schema_version, BLUEPRINT_SCHEMA_VERSION);
        let graph = BlueprintGraph::from_json(&migrated.json).unwrap();
        let node = |key: &str| {
            graph
                .nodes
                .iter()
                .find(|n| n.key == key)
                .expect("节点必须存在")
        };
        let contains = |from: &str, to: &str| {
            graph
                .edges
                .iter()
                .any(|e| e.edge_kind == EdgeKind::Contains && e.from == from && e.to == to)
        };

        // 字段：标记改指对象；对象落回类目轴，废弃的 mark_ref 清空。
        assert_eq!(node("m").object.as_deref(), Some("o"));
        assert_eq!(node("m").class, None, "旧字段 class 应清干净");
        assert_eq!(node("o").class.as_deref(), Some("k"));
        assert_eq!(node("o").mark_ref, None, "废弃的 mark_ref 应清干净");
        // 结构边：旧方向删除，新方向补齐。
        assert!(contains("k", "o"), "类目 → 对象 的连线必须补回来");
        assert!(contains("o", "m"), "对象 → 标记 是 v3 的新连线");
        assert!(!contains("k", "m"), "类目 → 标记 在 v3 是硬错误，必须删掉");
        assert!(!contains("m", "o"), "标记 → 对象 的旧方向必须删掉");
        // 规则边重绑：e1 由 on 入边定源 → 改挂标记；e1.target 保持原值（on 边优先）。
        assert!(graph
            .edges
            .iter()
            .any(|e| e.edge_kind == EdgeKind::On && e.from == "m" && e.to == "e1"));
        assert!(
            !graph
                .edges
                .iter()
                .any(|e| e.edge_kind == EdgeKind::On && e.from == "o"),
            "对象的规则边必须已搬走"
        );
        assert_eq!(
            node("e1").target.as_deref(),
            Some("o"),
            "有 on 入边的事件不靠 target 定源，迁移不动它"
        );
        // 无 on 入边的 e2：兜底来源必须跟着搬到标记。
        assert_eq!(node("e2").target.as_deref(), Some("m"));
        // 迁移后必须零硬错误（这是迁移的全部意义）。
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
    }

    /// **v2 → v3 形态二：孤儿标记启发式**（用户库 2026-11-02 实测的真实形态）。
    ///
    /// `M.class = K` 有值但**一条 contains 边都没有**——用户手工搭到"类目 → 对象"
    /// 就卡住了（v2 的 `object.children = []` 让画布画不出「对象 → 标记」）。
    /// 同类目下对象**恰好只有一个**时，把它挂到该对象下；**不改触发行为**
    /// （旧文档里这个标记与任何对象都无关系，重绑规则边会凭空改变行为）。
    #[test]
    fn migrate_v2_orphan_mark_attaches_to_unique_object() {
        use crate::blueprint_migrate::migrate_document;
        use crate::blueprint_types::EdgeKind;

        // 用户真实文档的骨架：类目 → 对象 已连好，标记只有字段、没有边。
        let v2 = r#"{"schema_version":2,
            "layers":[{"key":"l_main","name":"主界面"}],
            "nodes":[
              {"key":"c_albums","type":"control","panel_id":"albums","layer":"l_main"},
              {"key":"c_albums_album","type":"class","control":"c_albums","media_type":"album","layer":"l_main"},
              {"key":"c_albums_album_media","type":"mark","class":"c_albums_album","mark":"image","layer":"l_main"},
              {"key":"o_1","type":"object","class":"c_albums_album","scope":"double_clicked","layer":"l_main"},
              {"key":"ev","type":"event","trigger":"click","layer":"l_main"},
              {"key":"ac","type":"action","op":"toggle","target":"c_albums","layer":"l_main"}
            ],
            "edges":[
              {"from":"c_albums","to":"c_albums_album","kind":"contains","order":45},
              {"from":"c_albums_album","to":"o_1","kind":"contains","order":50},
              {"from":"ev","to":"ac","kind":"fires","order":49}
            ]}"#;
        let migrated = migrate_document(v2).unwrap().expect("v2 应触发迁移");
        let graph = BlueprintGraph::from_json(&migrated.json).unwrap();
        let node = |key: &str| {
            graph
                .nodes
                .iter()
                .find(|n| n.key == key)
                .expect("节点必须存在")
        };

        assert_eq!(
            node("c_albums_album_media").object.as_deref(),
            Some("o_1"),
            "唯一候选对象 → 标记挂到它下面"
        );
        assert_eq!(node("c_albums_album_media").class, None, "旧字段 class 清掉");
        assert!(
            graph.edges.iter().any(|e| {
                e.edge_kind == EdgeKind::Contains && e.from == "o_1" && e.to == "c_albums_album_media"
            }),
            "必须补出「对象 → 标记」边"
        );
        // 用户原来连好的那条边**不能丢**。
        assert!(graph.edges.iter().any(|e| {
            e.edge_kind == EdgeKind::Contains
                && e.from == "c_albums_album"
                && e.to == "o_1"
        }));
        // 这是交付的核心承诺：用户真实文档迁移后**零硬错误**。
        assert!(
            graph.validate().is_empty(),
            "真实文档迁移后不得有硬错误：{:?}",
            graph.validate()
        );
        // 事件仍然没有来源（用户文档本来就缺）→ 只应是软告警。
        assert!(!graph.warnings().is_empty());
    }

    /// **孤儿启发式的边界**：候选对象 0 个或多个 → **只清 `class`**，
    /// 标记保持"未接通"（灰显、软告警），**绝不**硬错误。
    ///
    /// 宁可让用户手工连一次，也不能替他猜错触发对象。
    #[test]
    fn migrate_v2_orphan_mark_stays_unconnected_when_ambiguous() {
        use crate::blueprint_migrate::migrate_document;
        use crate::blueprint_types::EdgeKind;

        // `candidates` = 同类目 K 下的对象个数；0 个靠"对象挂到另一个类目"造出来。
        let make = |candidates: usize| {
            let mut nodes = vec![
                r#"{"key":"c","type":"control","panel_id":"media"}"#.to_string(),
                r#"{"key":"k","type":"class","control":"c","media_type":"image"}"#.to_string(),
                r#"{"key":"k2","type":"class","control":"c","media_type":"video"}"#.to_string(),
                r#"{"key":"m","type":"mark","class":"k","mark":"manga"}"#.to_string(),
            ];
            if candidates == 0 {
                // 类目 K 下一个对象都没有 → 无处可挂。
                nodes.push(
                    r#"{"key":"o_other","type":"object","class":"k2","scope":"click"}"#.to_string(),
                );
            } else {
                for i in 0..candidates {
                    nodes.push(format!(
                        r#"{{"key":"o{i}","type":"object","class":"k","scope":"click"}}"#
                    ));
                }
            }
            format!(
                r#"{{"schema_version":2,"nodes":[{}],"edges":[]}}"#,
                nodes.join(",")
            )
        };

        for candidates in [0usize, 2] {
            let migrated = migrate_document(&make(candidates)).unwrap().expect("应迁移");
            let graph = BlueprintGraph::from_json(&migrated.json).unwrap();
            let mark = graph.nodes.iter().find(|n| n.key == "m").expect("标记存在");
            assert_eq!(
                mark.object, None,
                "候选 {candidates} 个时不得替用户猜"
            );
            assert_eq!(mark.class, None, "旧字段仍要清掉");
            assert!(
                !graph
                    .edges
                    .iter()
                    .any(|e| e.edge_kind == EdgeKind::Contains && e.to == "m"),
                "不得凭空补「对象 → 标记」边（候选 {candidates} 个）"
            );
            assert!(
                graph.validate().is_empty(),
                "悬念状态只能是软告警：{:?}",
                graph.validate()
            );
            assert!(
                graph
                    .warnings()
                    .iter()
                    .any(|w| w.contains("缺少必要引用")),
                "应报未接通：{:?}",
                graph.warnings()
            );
        }
    }

    /// **迁移幂等**：第二次迁移不改写任何字节、也不重复补边。
    ///
    /// 幂等是"打开库就回写"这条链路的安全底线——非幂等会在每次启动时继续改文档。
    #[test]
    fn migrate_v2_to_v3_is_idempotent() {
        use crate::blueprint_migrate::migrate_document;

        let v2 = r#"{"schema_version":2,
            "nodes":[
              {"key":"c","type":"control","panel_id":"media"},
              {"key":"k","type":"class","control":"c","media_type":"image"},
              {"key":"m","type":"mark","class":"k","mark":"manga"},
              {"key":"o","type":"object","class":"k","scope":"click","layer":"l_a"},
              {"key":"e","type":"event","trigger":"click","target":"o"}
            ],
            "edges":[
              {"from":"c","to":"k","kind":"contains","order":1},
              {"from":"k","to":"m","kind":"contains","order":2},
              {"from":"k","to":"o","kind":"contains","order":3},
              {"from":"o","to":"e","kind":"on","order":4}
            ]}"#;
        let first = migrate_document(v2).unwrap().expect("首次应迁移");
        assert_eq!(first.schema_version, BLUEPRINT_SCHEMA_VERSION);
        // 迁移产物已是当前版本 → 不再触发。
        assert!(migrate_document(&first.json).unwrap().is_none());
        // 再走一次"仅读再写"的路径也必须一模一样。
        let again = migrate_document(&first.json).unwrap();
        assert!(again.is_none());
        let graph = BlueprintGraph::from_json(&first.json).unwrap();
        assert!(graph.validate().is_empty(), "{:?}", graph.validate());
        // 边数确定：c→k、k→o、o→m、m→e(on)、e→a 之类不能因重复迁移增长。
        let contains_count = graph
            .edges
            .iter()
            .filter(|e| e.edge_kind == crate::blueprint_types::EdgeKind::Contains)
            .count();
        assert_eq!(contains_count, 3, "结构边应为 c→k、k→o、o→m 三条");
    }
