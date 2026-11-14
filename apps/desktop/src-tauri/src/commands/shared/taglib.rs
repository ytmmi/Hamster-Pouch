//! tag 词库的装配与插件扩展挂载。

use super::paths::tag_lib_base_path;
use super::prelude::*;

/// 构建 tag 库聚合集：内置基底库（D36 第一层）+ 已安装扩展包（第二层），
/// 并建立**重复概念归并索引**（D36.3）。
///
/// 启动时调用一次；**插件安装/启用/禁用后必须重新调用**并替换 `AppState.tag_lib`，
/// 否则扩展数据不会生效（用户会看到「装完启用后界面毫无变化」）。
///
/// 返回 `None` = 无内置基底库（首次运行尚未分发）或打开失败——调用方应保持原状。
pub(crate) fn build_tag_lib_set(plugin_root: &std::path::Path) -> Option<hp_dict::TagLibSet> {
    let path = tag_lib_base_path().ok()?;
    if !path.is_file() {
        return None;
    }
    let db = hp_dict::TagLibDb::open_readonly(&path, hp_core::LibLayer::Base).ok()?;
    let mut set = hp_dict::TagLibSet::new();
    set.add(db);
    // 扩展包：tag 数据是**应用级共享参考数据**（D34/D36），因此装配**全部已安装**的
    // 扩展，不按仓库启用状态过滤——这与「启用是仓库级」的插件语义冲突，属 D36.1
    // 登记的未结案项；此处按 RFC 已有的「应用级共享」结论落地。
    let _ext = attach_tag_lib_extensions(&mut set, plugin_root);
    // 归并索引失败不应阻塞：查询仍可用（退化为仅按 tag_id 去重）
    if let Err(e) = set.refresh_merge() {
        eprintln!("[taglib] 构建重复概念归并索引失败（查询仍可用）: {e}");
    }
    Some(set)
}

/// 装配已安装的 tag 扩展包（RFC 0008 / D36 第二层）。
///
/// 扩展包分两类（按插件 id 前缀区分，见 RFC 0008 D36.5）：
/// - **词典扩展** `tagdict-*`：词库内容（概念 / 多语言名称 / 分类 / 别名）
/// - **关系扩展** `tagrel-*`：库 2 关系映射（概念之间的层级/关联边）
///
/// 两类都是**同构四库 schema**，装配方式完全相同——都进聚合层，查询层不区分
/// 数据来自哪一类。分类只用于**命名与展示**（让用户看得出装了什么）。
///
/// **装配来源只有一个：插件的真实安装目录** `<plugin_root>/<plugin_id>/<version>/`
/// （`data/plugins/…`，由 `plugin.installLocal` 安装到那里）。
///
/// **分发目录 `<exe>/plugins-dist/` 不是装配来源**——它只是「可供安装的包」的存放处
/// （用户在插件面板里选中它来安装）。曾经把它当回退装配来源，导致**未安装的扩展也被
/// 装进词库**：开发包会把三个扩展包一并放进 `plugins-dist/`，于是哪怕一个扩展都没装，
/// 状态行也报「4 层 / 304575 个 tag」，且比插件面板实际列出的扩展数多——用户可见的
/// 自相矛盾。按 D36「完整词库不随应用分发、按需安装」，**没安装就不该有数据**。
///
/// 同一 plugin_id 只装配一次（多版本目录取最新，见下）。
///
/// 以**只读**方式逐个打开并加入聚合层。单个包损坏/缺失数据文件时**跳过该包**并继续
/// （不因一个坏包让整个词库不可用）。返回成功装配的扩展包数量。
pub(crate) fn attach_tag_lib_extensions(
    set: &mut hp_dict::TagLibSet,
    plugin_root: &std::path::Path,
) -> usize {
    let mut attached = 0usize;
    // 去重键用**插件 id**（取自 `plugin.manifest`），不能用目录名：
    // 安装目录名是插件 id（`dev.hamsterpouch.extension.tagdict.pixiv`），
    // 而分发目录名是包名（`tagdict-pixiv`）——两者不同，按目录名去重会漏判，
    // 同一扩展被装配两次（161MB 的库被打开两遍，层数也虚高）。
    let mut seen: std::collections::HashSet<String> = Default::default();

    // ---- 来源 1（权威）：插件安装目录 <plugin_root>/<plugin_id>/<version>/ ----
    if let Ok(entries) = std::fs::read_dir(plugin_root) {
        let mut plugin_dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        plugin_dirs.sort();
        for pdir in plugin_dirs {
            let dir_name = pdir
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            if !is_tag_extension_id(&dir_name) {
                continue;
            }
            // 一个插件可能有多个版本目录（更新时保留旧版本以便回滚），但**词库只装配
            // 一个版本**：装配全部版本会让同一扩展在聚合层里出现多次（层数虚高、
            // 100+MB 的库被打开多遍）。取**字典序最后一个**（版本号升序的近似），
            // 与上一段注释一致——此前这里写的是注释却循环装配了每一个版本目录。
            let Ok(vers) = std::fs::read_dir(&pdir) else {
                continue;
            };
            let mut vdirs: Vec<PathBuf> = vers
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            vdirs.sort();
            // 从最新版本往前找，取第一个真正带数据文件的版本目录。
            let chosen = vdirs
                .iter()
                .rev()
                .find_map(|vdir| find_tag_lib_data(vdir).map(|db| (vdir.clone(), db)));
            if let Some((vdir, db_path)) = chosen
                && attach_one(set, &db_path)
            {
                attached += 1;
                seen.insert(manifest_plugin_id(&vdir).unwrap_or(dir_name.clone()));
            }
        }
    }

    // 注意：**没有**「分发目录 `<exe>/plugins-dist/`」这个装配来源。
    //
    // 曾经有过（作为回退），但它是错的：`plugins-dist/` 只是**可供安装的包**的存放处，
    // 把它当装配来源会让**未安装**的扩展也进词库。开发包会把三个扩展包都放进
    // `plugins-dist/`，于是"一个都没装"也报 4 层 / 304575，且与插件面板实际列出的
    // 扩展数矛盾（用户实际反馈）。按 D36「按需安装」，没安装就不该有数据。

    attached
}

/// 读取包目录 `plugin.manifest` 里的插件 id。
///
/// 用于**跨来源去重**：安装目录名是插件 id，分发目录名是包名，两者不同；
/// 只有 manifest 里的 id 才是同一插件的稳定身份。读不到时返回 `None`
/// （调用方按"无法判定"处理，不因此丢弃整个包）。
fn manifest_plugin_id(dir: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("plugin.manifest")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("id")?.as_str().map(str::to_string)
}

/// 插件 id 是否属于 tag 扩展两类之一（`tagdict.*` / `tagrel.*`）。
fn is_tag_extension_id(plugin_id: &str) -> bool {
    let local = plugin_id.rsplit('.').next().unwrap_or(plugin_id);
    // 插件 id 形如 `dev.hamsterpouch.extension.tagdict.pixiv`；
    // 取完整 id 里是否含类型段，避免只比对末段（末段是 pixiv/danbooru/games）。
    plugin_id.contains(".tagdict.")
        || plugin_id.contains(".tagrel.")
        || local == "tagdict"
        || local == "tagrel"
}

/// 在包目录里定位四库数据文件：固定名 `data/tag_lib.sqlite`；
/// 不存在时回退接受 `data/` 下**唯一**的 `tag_lib*.sqlite`（历史命名兼容）。
pub(super) fn find_tag_lib_data(dir: &std::path::Path) -> Option<PathBuf> {
    let data_dir = dir.join("data");
    let fixed = data_dir.join("tag_lib.sqlite");
    if fixed.is_file() {
        return Some(fixed);
    }
    let rd = std::fs::read_dir(&data_dir).ok()?;
    let mut found: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.starts_with("tag_lib") && s.ends_with(".sqlite"))
        })
        .collect();
    found.sort();
    match found.len() {
        1 => Some(found.remove(0)),
        // 0 个：不是数据包；>1 个：无法判断，跳过并提示（不猜）
        n => {
            if n > 1 {
                eprintln!(
                    "[taglib] 跳过 {}：data/ 下有多个 tag_lib*.sqlite，无法判断用哪个",
                    dir.display()
                );
            }
            None
        }
    }
}

/// 打开并加入聚合层；成功返回 true。
fn attach_one(set: &mut hp_dict::TagLibSet, db_path: &std::path::Path) -> bool {
    match hp_dict::TagLibDb::open_readonly(db_path, hp_core::LibLayer::Extension) {
        Ok(db) => {
            set.add(db);
            true
        }
        Err(e) => {
            eprintln!("[taglib] 跳过扩展包 {}（打开失败）: {e}", db_path.display());
            false
        }
    }
}
