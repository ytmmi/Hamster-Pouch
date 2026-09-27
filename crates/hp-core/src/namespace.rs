//! 注册项**命名空间**规则（RFC 0010「命名空间」）。
//!
//! 三张注册表（控件 / 面板 / 蓝图节点类型）共用同一套 id 形式：
//!
//! | 注册对象 | 宿主内置 id | 插件注册 id |
//! | --- | --- | --- |
//! | 面板 | 裸 id（`repo` / `media` / `viewer` …） | **必须** `plugin.<plugin_id>.<local_id>` |
//! | 蓝图节点类型 | 裸 `type`（`interface` / `control` / `class` …） | **必须** `plugin.<plugin_id>.<local_id>` |
//! | 控件 `kind` | 裸 `kind`（`row` / `text` …） | —（插件不可注册） |
//!
//! `plugin_id` 即 manifest 的 `id`（`^[a-z0-9][a-z0-9._-]{2,63}$`）。**形式本身保证**
//! 宿主内置项与插件注册项不可能冲突，因此宿主**不提供**任何"加前缀消歧"或覆盖内置项的
//! 路径（RFC 0010 决策 2/3）。该形式与既有插件命令命名空间 `plugin.{pluginId}.{action}` 同源。
//!
//! 纯函数、无依赖；面板侧与蓝图侧的 id 规则都从这里取，避免两处各写一遍。

/// 裸 id 规则（宿主内置注册项）：`^[a-z][a-z0-9._-]{0,63}$`，且不得用**保留前缀**。
///
/// `plugin.` 是保留前缀：以它开头的 id 只有完全符合 `plugin.<plugin_id>.<local_id>`
/// 才算合法。否则 `plugin.palette` / `plugin..panel` 这类**半截**形式会被裸 id 规则
/// 接受，使"插件注册项必须用命名空间"的约束形同虚设，并与宿主裸 id 产生歧义。
pub fn is_bare_id(id: &str) -> bool {
    if id.starts_with("plugin.") {
        return false;
    }
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    id.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.' || c == '-')
}

/// 插件 id 规则（manifest `id`）：`^[a-z0-9][a-z0-9._-]{2,63}$`。
pub fn is_valid_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    (3..=64).contains(&id.len())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.' || c == '-')
}

/// 注册项 id 是否用了插件命名空间 `plugin.<plugin_id>.<local_id>`。
pub fn is_plugin_namespaced_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("plugin.") else {
        return false;
    };
    // 其余部分必须能切成 `<plugin_id>.<local_id>`：逐位置试切，任一成立即合法。
    rest.char_indices()
        .filter(|(_, c)| *c == '.')
        .any(|(i, _)| is_valid_plugin_id(&rest[..i]) && is_bare_id(&rest[i + 1..]))
}

/// 注册项 id 是否符合命名规则（宿主裸 id，或插件命名空间 id）。
pub fn is_valid_namespaced_id(id: &str) -> bool {
    is_bare_id(id) || is_plugin_namespaced_id(id)
}

/// `id` 是否落在某个具体插件的命名空间里（校正 `plugin.<plugin_id>.` 前缀）。
pub fn is_id_in_plugin_namespace(id: &str, plugin_id: &str) -> bool {
    is_valid_plugin_id(plugin_id)
        && id.starts_with(&format!("plugin.{plugin_id}."))
        && is_plugin_namespaced_id(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_and_plugin_ids() {
        assert!(is_bare_id("media"));
        assert!(is_bare_id("layout_block"));
        assert!(!is_bare_id("Media"));
        assert!(!is_bare_id(""));
        assert!(!is_bare_id("_x"));
        // `plugin.` 是保留前缀：半截形式既不是裸 id，也不是合法的插件命名空间 id。
        assert!(!is_bare_id("plugin.palette"));
        assert!(!is_bare_id("plugin..panel"));
        assert!(!is_valid_namespaced_id("plugin.palette"));
        assert!(!is_valid_namespaced_id("plugin.x.y"));
        assert!(!is_valid_namespaced_id("plugin..panel"));

        assert!(is_plugin_namespaced_id("plugin.dev.hamsterpouch.palette.palette"));
        assert!(!is_plugin_namespaced_id("plugin.palette"));
        assert!(!is_plugin_namespaced_id("plugin.x.y"));
        assert!(!is_plugin_namespaced_id("palette"));
        // 宿主裸 id 永远不会被当成插件项，反之亦然（形式保证，不靠消歧）。
        assert!(!is_plugin_namespaced_id("control"));
        assert!(is_valid_namespaced_id("control"));
        assert!(is_valid_namespaced_id("plugin.dev.hamsterpouch.music.waveform"));
    }

    #[test]
    fn plugin_namespace_prefix_check() {
        assert!(is_id_in_plugin_namespace(
            "plugin.dev.hamsterpouch.palette.palette",
            "dev.hamsterpouch.palette"
        ));
        assert!(!is_id_in_plugin_namespace("media", "dev.hamsterpouch.palette"));
        assert!(!is_id_in_plugin_namespace(
            "plugin.other.plugin.palette",
            "dev.hamsterpouch.palette"
        ));
    }
}
