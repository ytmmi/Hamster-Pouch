// 插件领域测试夹具（RFC 0004 / RFC 0010 决策 4-7 / D27 / D40+）。
//
// 本文件由 `plugin.rs` 的 `mod tests` 以 `include!` 展开：拆的是**文件**不是模块，
// 因此 `super::*`（清单/取值域/存储行）与私有校验项照旧可见。
// 注：用 `include!` 内联展开，故本文件不使用内层文档注释（`//!`）。

fn manifest() -> PluginManifest {
    PluginManifest {
        id: PluginId::from_raw("dev.hamsterpouch.example"),
        name: "示例插件".into(),
        version: "0.1.0".into(),
        min_host_version: 1,
        api_version: 1,
        runtime_kind: RuntimeKind::ExternalProcess,
        entry: "bin/example.exe".into(),
        capabilities: vec![Capability::UiPanel, Capability::RepoRead],
        contributions: vec![{
            let mut panel = Contribution::new(
                ContributionKind::Panel,
                "plugin.dev.hamsterpouch.example.example.panel",
            );
            panel.title_key = Some("panel.example".into());
            panel.read_only = Some(true);
            panel.category = Some("system".into());
            panel.has_class = Some(false);
            panel.blueprint_node = Some("control".into());
            panel
        }],
        data_queries: vec![PluginDataQueryDecl {
            name: "rows".into(),
            returns: "rows".into(),
        }],
        events: vec![PluginEventDecl {
            id: "apply".into(),
            title_key: None,
        }],
        native_dependencies: vec![],
        trust_requested: TrustLevel::LocalDev,
    }
}

/// **纯数据扩展包（`static-data`）必须能通过校验**。
///
/// 回归测试：解析层对 StaticData 把 `entry` 置为空串，而 `validate_structure`
/// 曾无条件要求 `entry` 非空 → 所有 tag 词典/关系扩展都在校验阶段被拒
/// （「装不上」）。纯数据包没有可执行入口，`entry` 空是**正确形态**。
#[test]
fn static_data_package_validates_without_entry() {
    let mut m = manifest();
    m.runtime_kind = RuntimeKind::StaticData;
    m.entry = String::new(); // 解析层对 StaticData 就是这么置的
    m.capabilities = vec![];
    m.contributions = vec![];
    m.data_queries = vec![];
    m.events = vec![];
    m.validate()
        .expect("纯数据扩展包应通过校验（entry 允许为空）");

    // 其它形态仍必须要求 entry 非空（不能把规则整体放宽）
    let mut exe = manifest();
    exe.entry = String::new();
    assert!(
        exe.validate().is_err(),
        "非 StaticData 形态仍必须要求 entry 非空"
    );
}

#[test]
fn trust_level_roundtrip_and_dynamic_library_rule() {
    for v in [
        TrustLevel::System,
        TrustLevel::Trusted,
        TrustLevel::Community,
        TrustLevel::LocalDev,
    ] {
        assert_eq!(TrustLevel::from_str(v.as_str()), Some(v));
    }
    assert_eq!(TrustLevel::from_str("unknown"), None);
    assert!(TrustLevel::System.allows_dynamic_library());
    assert!(TrustLevel::Trusted.allows_dynamic_library());
    assert!(!TrustLevel::Community.allows_dynamic_library());
    assert!(!TrustLevel::LocalDev.allows_dynamic_library());
}

#[test]
fn source_kind_roundtrip() {
    for v in [SourceKind::System, SourceKind::Git, SourceKind::LocalPath] {
        assert_eq!(SourceKind::from_str(v.as_str()), Some(v));
    }
    assert_eq!(SourceKind::from_str("unknown"), None);
}

#[test]
fn runtime_kind_roundtrip() {
    for v in [
        RuntimeKind::ExternalProcess,
        RuntimeKind::DynamicLibrary,
        RuntimeKind::Wasm,
        RuntimeKind::StaticData,
    ] {
        assert_eq!(RuntimeKind::from_str(v.as_str()), Some(v));
    }
    assert_eq!(RuntimeKind::from_str("unknown"), None);
}

#[test]
fn capability_roundtrip_and_risk_flags() {
    let all = [
        Capability::UiPanel,
        Capability::RepoRead,
        Capability::RepoWrite,
        Capability::FsRead,
        Capability::FsWrite,
        Capability::Network,
        Capability::AiInfer,
        Capability::NativeCode,
    ];
    for v in all {
        assert_eq!(Capability::from_str(v.as_str()), Some(v));
    }
    assert_eq!(Capability::from_str("unknown"), None);
    assert!(Capability::NativeCode.is_high_risk());
    assert!(Capability::FsWrite.is_high_risk());
    assert!(Capability::Network.is_high_risk());
    assert!(!Capability::RepoRead.is_high_risk());
    assert!(Capability::UiPanel.is_read_only_panel());
    assert!(!Capability::RepoRead.is_read_only_panel());
}

#[test]
fn host_api_version_compatibility() {
    let host = HostApiVersion::current();
    assert!(host.is_compatible(1));
    assert!(!host.is_compatible(HOST_API_VERSION + 1));
    assert_eq!(host.value(), HOST_API_VERSION);
}

#[test]
fn manifest_validate_accepts_valid_external_process() {
    assert!(manifest().validate().is_ok());
}

#[test]
fn manifest_validate_rejects_empty_fields() {
    let mut m = manifest();
    m.name = "  ".into();
    assert!(m.validate().is_err());
}

#[test]
fn manifest_validate_rejects_dynamic_library_without_native_code() {
    let mut m = manifest();
    m.runtime_kind = RuntimeKind::DynamicLibrary;
    m.trust_requested = TrustLevel::System;
    assert!(m.validate().is_err());

    m.capabilities.push(Capability::NativeCode);
    assert!(m.validate().is_ok());
}

#[test]
fn manifest_validate_rejects_dynamic_library_untrusted() {
    let mut m = manifest();
    m.runtime_kind = RuntimeKind::DynamicLibrary;
    m.capabilities.push(Capability::NativeCode);
    m.trust_requested = TrustLevel::Community;
    assert!(m.validate().is_err());
}

#[test]
fn manifest_validate_rejects_incompatible_host_version() {
    let mut m = manifest();
    m.min_host_version = HOST_API_VERSION + 1;
    assert!(m.validate().is_err());
}

#[test]
fn capabilities_granted_requires_all() {
    let m = manifest();
    assert!(m.capabilities_granted(&[Capability::UiPanel, Capability::RepoRead]));
    assert!(!m.capabilities_granted(&[Capability::UiPanel]));
}

#[test]
fn plugin_id_is_displayable() {
    let id = PluginId::from_raw("a.b.c");
    assert_eq!(id.to_string(), "a.b.c");
    assert_eq!(id.as_str(), "a.b.c");
}

/// RFC 0010 决策 4：面板贡献点的必需声明参数（`category`/`has_class`/`blueprint_node`）
/// 与 `plugin.<plugin_id>.<local_id>` 命名空间。
#[test]
fn panel_contribution_requires_full_declaration_and_namespace() {
    let mut m = manifest();
    m.contributions[0].category = None;
    assert!(m.validate().is_err(), "缺 category 应拒绝");

    let mut m = manifest();
    m.contributions[0].has_class = None;
    assert!(m.validate().is_err(), "缺 has_class 应拒绝");

    let mut m = manifest();
    m.contributions[0].blueprint_node = None;
    assert!(m.validate().is_err(), "缺 blueprint_node 应拒绝");

    let mut m = manifest();
    m.contributions[0].blueprint_node = Some("ghost".into());
    assert!(m.validate().is_err(), "blueprint_node 未命中已注册类型应拒绝");

    let mut m = manifest();
    m.contributions[0].id = "example.panel".into();
    assert!(m.validate().is_err(), "面板 id 未用插件命名空间应拒绝");
}

/// 取值域非法在**解析路径**（`validate_structure`）就报硬错误，不静默降级。
#[test]
fn panel_contribution_rejects_invalid_value_domains_at_parse_time() {
    let mut m = manifest();
    m.contributions[0].category = Some("bogus".into());
    assert!(m.validate_structure().is_err());

    let mut m = manifest();
    m.contributions[0].capabilities = vec!["bogus.cap".into()];
    assert!(m.validate_structure().is_err());

    let mut m = manifest();
    m.contributions[0].settings = vec![crate::panel_types::PanelSettingDecl {
        key: "size".into(),
        kind: "button".into(),
        title_key: "panel.example.size".into(),
        default: None,
        scope: None,
        requires_capability: None,
    }];
    assert!(m.validate_structure().is_err(), "button 不是合法的设置项控件");
}

/// RFC 0010 决策 6：插件注册的蓝图节点类型必须是纯声明 + 命名空间正确。
#[test]
fn blueprint_node_contribution_is_pure_declaration() {
    let node_type = "plugin.dev.hamsterpouch.example.waveform";
    let mut decl = crate::blueprint_registry::BlueprintNodeDecl {
        node_type: node_type.into(),
        label_key: "example.waveform".into(),
        role: "logic".into(),
        name_from_layer: false,
        provides_name: true,
        fields: vec![crate::blueprint_registry::NodeFieldDecl {
            name: "target".into(),
            field_type: "ref".into(),
            required: false,
            soft_when_missing: true,
            values: vec!["control".into()],
        }],
        parents: vec![],
        children: vec![],
        events: vec![],
        ports: vec![],
        severity: None,
        evaluation_role: Some("condition".into()),
    };

    let mut m = manifest();
    let mut contribution =
        Contribution::new(ContributionKind::BlueprintNode, format!("{node_type}.node"));
    contribution.title_key = Some("example.waveform".into());
    contribution.node = Some(decl.clone());
    m.contributions.push(contribution);
    assert!(m.validate().is_ok(), "{:?}", m.validate());

    // 插件注册项**暂不能参与结构边**（文档开放点）。
    let mut m2 = manifest();
    decl.parents = vec!["layout_block".into()];
    let mut c2 = Contribution::new(
        ContributionKind::BlueprintNode,
        format!("{node_type}.node"),
    );
    c2.title_key = Some("example.waveform".into());
    c2.node = Some(decl.clone());
    m2.contributions.push(c2);
    assert!(m2.validate().is_err());

    // 不得注册到别的插件的命名空间里。
    let mut m3 = manifest();
    decl.parents = vec![];
    decl.node_type = "plugin.other.plugin.waveform".into();
    let mut c3 = Contribution::new(
        ContributionKind::BlueprintNode,
        "plugin.other.plugin.waveform.node",
    );
    c3.title_key = Some("example.waveform".into());
    c3.node = Some(decl);
    m3.contributions.push(c3);
    assert!(m3.validate().is_err());
}

/// RFC 0010 决策 7：设置分节只能归入既有大类，落库键强制 `plugin.<plugin_id>.` 前缀。
#[test]
fn settings_section_uses_existing_category_and_forced_prefix() {
    let setting = |key: &str| crate::panel_types::PanelSettingDecl {
        key: key.into(),
        kind: "numberInput".into(),
        title_key: format!("example.{key}"),
        default: Some(serde_json::json!(4)),
        scope: None,
        requires_capability: None,
    };

    let mut m = manifest();
    let mut section =
        Contribution::new(ContributionKind::SettingsSection, "example.settings");
    section.title_key = Some("example.settings.title".into());
    section.category = Some("plugin".into());
    section.settings = vec![setting("grid_size")];
    m.contributions.push(section);
    assert!(m.validate().is_ok(), "{:?}", m.validate());
    assert_eq!(
        m.contributions[1].settings[0].key,
        "grid_size",
        "插件自带的前缀无效：落库键由宿主强制加 plugin.<plugin_id>. 前缀"
    );

    // 插件不能新增/改名大类。
    let mut m2 = manifest();
    let mut bad = Contribution::new(ContributionKind::SettingsSection, "example.settings");
    bad.title_key = Some("example.settings.title".into());
    bad.category = Some("controls".into());
    bad.settings = vec![setting("grid_size")];
    m2.contributions.push(bad);
    assert!(m2.validate().is_err());

    // 同一分节内的重复设置键 = 硬错误（不覆盖、不合并）。
    let mut m3 = manifest();
    let mut dup = Contribution::new(ContributionKind::SettingsSection, "example.settings");
    dup.title_key = Some("example.settings.title".into());
    dup.category = Some("plugin".into());
    dup.settings = vec![setting("grid_size"), setting("grid_size")];
    m3.contributions.push(dup);
    assert!(m3.validate().is_err());
}

/// 注册权边界：插件**不能**注册控件 `kind`（26 种是宿主内置白名单，D62）。
#[test]
fn plugin_cannot_register_control_kinds() {
    assert_eq!(ContributionKind::from_str("control"), None);
    assert_eq!(ContributionKind::from_str("controlKind"), None);
    // 合法的贡献点类型里没有"控件"。
    for kind in [
        ContributionKind::Panel,
        ContributionKind::Command,
        ContributionKind::Viewer,
        ContributionKind::AiProvider,
        ContributionKind::MetadataField,
        ContributionKind::DataQuery,
        ContributionKind::BlueprintNode,
        ContributionKind::SettingsSection,
    ] {
        assert_ne!(kind.as_str(), "control");
        assert_eq!(ContributionKind::from_str(kind.as_str()), Some(kind));
    }
}
