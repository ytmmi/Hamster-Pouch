//! 命令桥接层共享工具与类型（供各 `*_commands` 模块复用）。

//!
//! **D201（2026-11-15）**：这里原本是 1095 行的单文件，拆成六个职责文件（events / response /
//! paths / taglib / locks / repo）加一个 files。拆分只搬不改：所有 pub(crate) 名字照旧从
//! commands::shared 再导出，调用点一行未动；门禁侧把「只允许在 commands/shared.rs 里出现」
//! 的断言改成对**整个 shared 目录**求并集，语义不变（还是「只在这个模块里」）。

mod events;
mod files;
mod locks;
mod paths;
mod repo;
mod repo_blob;
mod response;
mod taglib;

mod prelude;

pub(crate) use events::*;
pub(crate) use files::*;
pub(crate) use locks::*;
pub(crate) use paths::*;
pub(crate) use repo::*;
pub(crate) use repo_blob::*;
pub(crate) use response::*;
pub(crate) use taglib::*;

#[cfg(test)]
mod tests {
    use super::paths::{find_upwards, find_upwards_dir};
    use super::prelude::*;
    use super::taglib::find_tag_lib_data;
    use super::*;

    /// 事件名映射必须产出 **Tauri 自己认**的名字（缺陷 0022）。
    ///
    /// 判定口径抄自 Tauri 2.11.5 的 `tauri/src/event/event_name.rs::is_event_name_valid`：
    /// 全部字符必须是字母数字或 `-` `/` `:` `_`——**点号不在其中**，这正是当时
    /// `emit("scan.progress", …)` 报 `IllegalEventName` 的原因。
    fn tauri_accepts_event_name(name: &str) -> bool {
        name.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '/' | ':' | '_'))
    }

    #[test]
    fn wire_event_produces_tauri_legal_names() {
        // 前提：点分名确实被 Tauri 拒绝（若哪天 Tauri 放宽了，这条会红，提醒复核本层是否还需要）。
        assert!(
            !tauri_accepts_event_name("scan.progress"),
            "点分事件名应被 Tauri 拒绝——缺陷 0022 的根因前提"
        );
        // 契约里出现过的**全部**逻辑事件名：映射后必须合法。
        for logical in [
            "scan.progress",
            "scan.completed",
            "scan.error",
            "source.unmount.progress",
            "source.unmount.completed",
            "source.unmount.error",
            "album.sync.progress",
            "album.sync.conflict",
            "album.sync.failed",
            "plugin.changed",
            "plugin.loaded",
            "plugin.error",
            "setting.changed",
            "blueprint.changed",
            "color.extracted",
            // 缺陷 0045：实时监听接线时新增的三条（此前一直漏在这张清单外）。
            "file.changed",
            "file.missing",
            "file.restored",
            "repo.changed",
            "panel.restore",
        ] {
            let wire = wire_event(logical);
            assert_eq!(wire, logical.replace('.', ":"), "映射规则必须是 `.` → `:`");
            assert!(
                tauri_accepts_event_name(&wire),
                "{logical} → {wire} 必须是 Tauri 合法事件名"
            );
        }
    }

    /// 同一套查找也要能命中 ffmpeg/ffprobe（旧实现同样只按 cwd 拼相对路径）。
    #[test]
    fn find_upwards_finds_ffmpeg() {
        let found = find_upwards("external-cli/ffmpeg/bin/ffmpeg.exe")
            .expect("应从祖先目录找到 external-cli/ffmpeg/bin/ffmpeg.exe");
        assert!(found.is_file());
    }

    #[test]
    fn find_upwards_returns_none_for_unknown_relative_path() {
        assert!(find_upwards("external-cli/definitely-missing/nope.exe").is_none());
    }

    /// 随包插件根是**目录**：必须用目录判据，文件判据永远找不到它。
    #[test]
    fn find_upwards_dir_finds_the_bundled_plugin_root() {
        let found =
            find_upwards_dir("plugins/system").expect("应从祖先目录找到仓库内的 plugins/system");
        assert!(found.is_dir());
        // f7457a2 起随包系统插件换代为 python-core；palette 已删除，
        // 断言改为当前唯一随包系统插件的清单（git ls-files 可查，新克隆也在）。
        assert!(found.join("python-core").join("plugin.manifest").is_file());
        let normalized = found.to_string_lossy().replace('\\', "/");
        assert!(
            normalized.ends_with("plugins/system"),
            "意外路径: {normalized}"
        );
    }

    /// 同一条相对路径上，文件判据与目录判据结论相反——这正是"随包插件用错判据"的形态。
    #[test]
    fn file_and_dir_lookups_disagree_on_a_directory() {
        assert!(find_upwards("plugins/system").is_none());
        assert!(find_upwards_dir("plugins/system").is_some());
    }

    /// 显式环境变量覆盖优先于自动查找（且不做存在性回退）。
    #[test]
    fn env_override_wins_over_lookup() {
        let key = "HP_TEST_EXTERNAL_BIN_OVERRIDE";
        // edition 2024：`std::env::set_var` / `remove_var` 是 `unsafe`（进程级可变全局
        // 状态，多线程下可能撕裂）。本用例独占一条测试专用键，且写入后立刻读取、立刻
        // 清掉，因此不会与其它用例的读取并发。
        unsafe { std::env::set_var(key, "Z:/explicit/override.exe") };
        let got = external_bin_path(key, "external-cli/ffmpeg/bin/ffmpeg.exe");
        unsafe { std::env::remove_var(key) };
        assert_eq!(got, Some(PathBuf::from("Z:/explicit/override.exe")));
    }

    /// 随包插件根同样支持环境变量覆盖，且同样是"设置了就原样采信"。
    #[test]
    fn bundled_plugins_dir_honours_env_override() {
        let key = "HP_BUNDLED_PLUGINS_DIR";
        // 同上：独占测试键，写入 → 读取 → 清理，无并发读者。
        unsafe { std::env::set_var(key, "Z:/explicit/bundled") };
        let got = bundled_plugins_dir();
        unsafe { std::env::remove_var(key) };
        assert_eq!(got, Some(PathBuf::from("Z:/explicit/bundled")));
    }

    /// 同一插件有**多个版本目录**（更新时保留旧版本以便回滚）时，只装配**一个**
    /// 版本的数据。
    ///
    /// 回归背景：安装目录的装配循环曾对每个版本目录各装配一次（注释写的是"取字典序
    /// 最后一个"，代码却循环了全部），于是同一扩展在聚合层里出现多次——层数虚高
    /// （用户看到的「N 层」不对），且 128/161MB 的词库被打开多遍。
    #[test]
    fn only_newest_version_of_a_plugin_is_attached() {
        // 产物缺失时**跳过**而不是 panic：本用例考察的是"安装目录的版本循环"，
        // 词库产物只是它借用的一个真实 sqlite 夹具。`tools/tagdict/output/` 不入库
        // （见 `.gitignore`），因此新克隆与 CI 上必然没有它——这与同文件里
        // `base_plus_three_extensions_attach_as_four_queryable_layers` 及
        // `crates/hp-dict/tests/tag_lib_artifacts.rs` 的既有口径一致
        // （"CI 无产物时跳过"）。此前这里写的是 `expect(...)`，单把这一条变成
        // "新克隆必红"，与仓库自己登记的 CI 口径相悖。
        let Some(base) = find_upwards("tools/tagdict/output/tag_lib_base.sqlite3") else {
            eprintln!("跳过：未找到词库基底产物（先运行 tools/tagdict/build_base_lib.py）");
            return;
        };
        let tmp = std::env::temp_dir().join(format!("hp-taglib-vers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        // 用一个**仓库 `plugins-dist/` 里不存在**的插件 id，让本用例只考察
        // "安装目录的版本循环"，不与真实扩展包互相干扰。
        let pid = "dev.hamsterpouch.extension.tagdict.versionprobe";
        let pdir = tmp.join(pid);
        for v in ["0.1.0", "0.2.0"] {
            let d = pdir.join(v).join("data");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::copy(&base, d.join("tag_lib.sqlite")).unwrap();
            std::fs::write(
                pdir.join(v).join("plugin.manifest"),
                format!(r#"{{"id":"{pid}"}}"#),
            )
            .unwrap();
        }

        let mut set = hp_dict::TagLibSet::new();
        let n = attach_tag_lib_extensions(&mut set, &tmp);

        let chosen = find_tag_lib_data(&pdir.join("0.2.0")).expect("最新版本应有数据文件");
        assert!(chosen.is_file(), "应选中字典序最后的版本目录");

        let _ = std::fs::remove_dir_all(&tmp);
        // 安装目录里只有这一个插件（两个版本目录），因此恰好装配 1 层。
        assert_eq!(n, 1, "两个版本目录只应装配 1 层，实际 {n}");
        assert_eq!(set.len(), 1, "聚合层只应有 1 层，实际 {}", set.len());
    }

    /// **分发目录不是装配来源**：`plugins-dist/` 里放了包，但一个都没**安装**时，
    /// 聚合层**不得**多出任何一层。
    ///
    /// 回归背景（用户实际反馈）：开发包会把三个扩展包一并放进 `plugins-dist/`，
    /// 而装配层曾把该目录当回退来源 → **未安装的扩展也进词库**，状态行报
    /// 「4 层 / 304575 个 tag」，比插件面板实际列出的扩展数还多（自相矛盾）。
    /// 按 D36「按需安装」，没安装就不该有数据。
    #[test]
    fn distribution_dir_is_not_an_assembly_source() {
        let Some(dist) = find_upwards_dir("plugins-dist") else {
            eprintln!("跳过：未找到 plugins-dist/");
            return;
        };
        // 前提：仓库内真有**解包好的**扩展包目录（否则本用例没有意义）。
        // D122 起 `plugins-dist/*.zip` 入库分发、解包目录仍不入库——全新 checkout
        // 里只有 zip，此时无法构造"已分发但未安装"的现场，直接跳过；本机生成过
        // 包（package_extensions.py）时照常断言。
        let has_package = ["tagdict-pixiv", "tagdict-danbooru", "tagrel-games"]
            .iter()
            .any(|id| dist.join(id).join("data").join("tag_lib.sqlite").is_file());
        if !has_package {
            eprintln!("跳过：plugins-dist/ 下没有解包好的扩展（只有 zip 分发件）");
            return;
        }

        // 安装目录为空 = 一个扩展都没装。
        let empty = std::env::temp_dir().join(format!("hp-taglib-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&empty);
        std::fs::create_dir_all(&empty).unwrap();
        let mut set = hp_dict::TagLibSet::new();
        let n = attach_tag_lib_extensions(&mut set, &empty);
        let _ = std::fs::remove_dir_all(&empty);

        assert_eq!(n, 0, "未安装任何扩展时不应装配出扩展层，实际 {n}");
        assert_eq!(set.len(), 0, "聚合层应为空，实际 {}", set.len());
    }

    /// **P0 运行时验收 / 端到端（真实安装器 + 真实产物）**：走用户实际点击的路径——
    /// `PluginInstaller` 把三个扩展包安装到 `<plugin_root>/<id>/<version>/`，
    /// 再让装配层从**安装目录**读取 → 聚合层为 4 层，且**扩展里的 tag 立即可被查到**
    /// （不只是层数对）。
    ///
    /// 回归背景（用户实际反馈过三次）：
    /// - 装配读错目录（读分发目录而非安装目录）→ 装完启用后数据根本不生效；
    /// - 跨来源去重键口径不一致 → 同一扩展被装配两次，层数虚高成 7；
    /// - **分发目录被当装配来源** → 未安装的扩展也进词库，状态行比插件面板多算。
    ///
    /// 因此本用例同时断言「层数恰为 4」与「只在扩展包里的概念可命中」——
    /// 前者防层数虚高/漏装，后者防"层数对但数据没进去"。
    ///
    /// 注意：这里**必须真的安装**，而不是把 `plugins-dist/` 当装配来源——后者正是
    /// 被修掉的缺陷（其"未安装就不该有数据"由 `distribution_dir_is_not_an_assembly_source`
    /// 单独覆盖）。产物缺失时跳过（CI 无 `plugins-dist/` 与词库产物）。
    #[test]
    fn base_plus_three_extensions_attach_as_four_queryable_layers() {
        let Some(base_path) = find_upwards("tools/tagdict/output/tag_lib_base.sqlite3") else {
            eprintln!("跳过：未找到词库基底产物（先运行 tools/tagdict/build_base_lib.py）");
            return;
        };
        let Some(dist) = find_upwards_dir("plugins-dist") else {
            eprintln!("跳过：未找到 plugins-dist/（先运行 tools/tagdict/package_extensions.py）");
            return;
        };
        // 三个扩展包的数据文件都要在，否则本用例的层数断言不成立。
        let exts = ["tagdict-pixiv", "tagdict-danbooru", "tagrel-games"];
        if !exts
            .iter()
            .all(|n| dist.join(n).join("data").join("tag_lib.sqlite").is_file())
        {
            eprintln!("跳过：plugins-dist/ 下缺少扩展包数据文件");
            return;
        }

        // **必须真的安装**（而不是把 plugins-dist 当装配来源）——那正是被修掉的缺陷。
        let tmp = std::env::temp_dir().join(format!("hp-taglib-p0-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let installer = hp_plugin_host::PluginInstaller::new(tmp.clone());
        for name in exts {
            installer
                .install(&hp_plugin_host::InstallSource::LocalPath(dist.join(name)))
                .unwrap_or_else(|e| panic!("安装 {name} 失败: {e}"));
        }

        let mut set = hp_dict::TagLibSet::new();
        set.add(
            hp_dict::TagLibDb::open_readonly(&base_path, hp_core::LibLayer::Base)
                .expect("只读打开基底库"),
        );
        let attached = attach_tag_lib_extensions(&mut set, &tmp);
        let _ = std::fs::remove_dir_all(&tmp);

        assert_eq!(attached, 3, "应装配三个已安装扩展包，实际 {attached}");
        assert_eq!(
            set.len(),
            4,
            "层数应为 1 基底 + 3 扩展 = 4，实际 {}",
            set.len()
        );

        set.refresh_merge().expect("构建归并索引");

        // 只在扩展包里的概念（danbooru 高热度画师，基底库不含）必须能查到：
        // 这是"装完立刻可用"的判据——层数对但数据没进去时这里会失败。
        let hits = set.find("Sciamano240", 10).expect("查询扩展专属 tag");
        assert!(
            !hits.is_empty(),
            "扩展包里的 tag 装配后应立即可查（说明数据真的进了聚合层）"
        );
        assert!(
            hits.iter()
                .any(|d| d.concept.kind == hp_core::TagKind::Artist),
            "该名字应命中 artist 概念，实际 {:?}",
            hits.iter().map(|d| d.concept.kind).collect::<Vec<_>>()
        );
    }
}
