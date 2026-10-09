//! 命令桥接层共享工具与类型（供各 `*_commands` 模块复用）。

use std::path::PathBuf;

use hp_core::{FileIndexRow, HpError, HpResult};
use hp_store::{GlobalDb, RepoDb};
use serde::Serialize;
use tauri::Emitter;

use crate::AppState;

/// 逻辑事件名 → **线上事件名**：`.` 映射为 `:`。
///
/// **为什么必须有这一层（缺陷 0022）**：Tauri 2 的事件名只允许
/// `[A-Za-z0-9\-/:_]`，**不接受点号**——`emit("scan.progress", …)` 会直接报
/// `only alphanumeric, '-', '/', ':', '_' permitted for event names`。
/// 而本项目的事件名在契约与代码里沿用点分（与命令的 `domain.action` 同款），
/// 命令侧早有等价映射（`domain.action` ↔ `domain_action`），**事件侧此前漏了**，
/// 于是整族事件被 `let _ = emit(..)` 静默丢弃：扫描浮窗、插件/设置/蓝图/调色板刷新
/// 全部无声失效。事件一律经 [`EmitHp::emit_hp`] 发出，前端一律经 `listenHp` 接收。
pub(crate) fn wire_event(logical: &str) -> String {
    logical.replace('.', ":")
}

/// 追加一行诊断日志到 `<exe 同目录>\data\debug.log`。
///
/// 只用于**不该无声无息**的问题（目前是事件发送失败）。诊断通道本身不参与业务。
pub(crate) fn diag_log(message: &str) {
    use std::io::Write;
    let Ok(dir) = app_data_root() else { return };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("debug.log"))
    {
        let _ = writeln!(f, "{message}");
    }
}

/// 发事件的**唯一入口**：逻辑名 → 线上名，且失败**留痕**（不再 `let _ =` 吞掉）。
///
/// 用法与 `tauri::Emitter::emit` 完全同形：调用点只差方法名（`emit` → `emit_hp`），
/// 逻辑名照旧点分，例如 `app.emit_hp("scan.progress", ev)`。
pub(crate) trait EmitHp<R: tauri::Runtime>: Emitter<R> {
    fn emit_hp<S: Serialize + Clone>(&self, logical: &str, payload: S) {
        let name = wire_event(logical);
        if let Err(e) = self.emit(&name, payload) {
            diag_log(&format!(
                "[event] 发送失败 {logical}（线上名 {name}）: {e}"
            ));
        }
    }
}

impl<R: tauri::Runtime, T: Emitter<R>> EmitHp<R> for T {}

/// **D76 迁移已完成（2026-09）**：桥接层不再需要"把领域错误压成 String"的转换函数。
///
/// 历史上这里是 `hp_err_to_string(e)`，D76 让每条命令都返回 `{ ok, data?, error? }`
/// 并携带 `HpError::code()` 的闭集错误码，因此该函数在 2026-09 最后一批
/// （`repo` / `layout` / `debug.log`）迁移完成后**已无调用方**并删除。
/// 新增命令一律走 [`api_from_hp`] / [`api_async`]；错误文案由前端按 `code` 走 i18n（D27）。

/// **D76 统一响应包装**：`{ ok, data?, error? }`（`docs/spec/commands-events.md` 第 2 节）。
///
/// 全部命令**必须**用这个形状（2026-09 起已全量迁移，无一例外）。
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ApiResponse<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiError>,
}

/// **D76 结构化错误**。
///
/// `code` 取闭集 `validation` / `not_found` / `permission` / `plugin` / `io` / `conflict`
/// （来源是 `HpError::code()`）。`message` **仅作诊断**：前端不得直接显示，
/// 必须按 `code` 渲染 i18n 文案（D27：三套语言）。
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ApiError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ApiError {
    /// 直接以码 + 诊断串构造（用于**不是** `HpError` 来源的失败，例如桥接层的
    /// 前置条件检查；领域错误一律走 [`ApiError::from_hp`]）。
    #[allow(dead_code)]
    pub(crate) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    /// 领域错误 → 结构化错误（`code` 由 `HpError::code()` 统一给出）。
    pub(crate) fn from_hp(e: HpError) -> Self {
        Self {
            code: e.code().to_string(),
            message: e.to_string(),
            details: None,
        }
    }
}

/// 成功响应。
pub(crate) fn api_ok<T>(data: T) -> ApiResponse<T> {
    ApiResponse {
        ok: true,
        data: Some(data),
        error: None,
    }
}

/// 失败响应。
pub(crate) fn api_err<T>(error: ApiError) -> ApiResponse<T> {
    ApiResponse {
        ok: false,
        data: None,
        error: Some(error),
    }
}

/// `HpResult<T>` → 统一响应包装。
pub(crate) fn api_from_hp<T>(result: HpResult<T>) -> ApiResponse<T> {
    match result {
        Ok(value) => api_ok(value),
        Err(e) => api_err(ApiError::from_hp(e)),
    }
}

/// **异步命令**的返回包装。
///
/// Tauri 的 `#[tauri::command]` 对**含引用的 `async` 命令**（例如带 `State<'_, T>`）
/// 强制要求返回 `Result`（tauri-macros 的 `AsyncCommandMustReturnResult`）。
///
/// 但 D76 的包装必须落在**成功值**里：失败也是"已解析的响应"，而不是 IPC 层拒绝——
/// 这样前端只需一套 `unwrapApi`，错误码（`validation`/`not_found`/…）不会在
/// IPC 边界被压成字符串。因此本类型**恒为 `Ok(..)`**，失败信息放在
/// `ApiResponse.error` 里（`Err` 分支仅为满足宏约束而存在，不被构造）。
pub(crate) type ApiAsync<T> = Result<ApiResponse<T>, ApiResponse<T>>;

/// 把统一响应装进异步命令的返回类型（见 [`ApiAsync`]）。
pub(crate) fn api_async<T>(response: ApiResponse<T>) -> ApiAsync<T> {
    Ok(response)
}

/// 应用数据根目录（便携布局）：可执行文件同目录下的 `data` 子文件夹。
///
/// 全部数据集中在这里，按三类区分（2026-09 用户裁定）：
/// - **系统数据库**：`data\system\`——全局配置库（`hamster-pouch-global.sqlite3`）与内置
///   tag 库（RFC 0008 四库，内置基底 `data\system\tag_lib_base.sqlite3`，
///   完整词库为按需安装的 `plugins-dist/tagdict-*` / `tagrel-*` 扩展包，D36.5）；
///   应用自身数据，随版本/可重建。
/// - **用户数据库**：`data\user\repos\`——每仓库一个库，用户 tag / 评分 / 相册等，需备份。
/// - **插件扩展**：`data\plugins\`——插件包安装目录；插件自持的扩展数据库落在各自
///   `<plugin_id>\` 包目录内，不入全局库/仓库库。
/// - 缓存与日志：`data\thumbnails\`（可重建）、`data\debug.log`。
///
/// **不使用** `%APPDATA%`（Roaming：域/漫游环境会随登录同步，对 WAL SQLite 有损坏风险，
/// 见 `docs/issues/0012`）与 `%LOCALAPPDATA%`；旧位置数据由用户验证后手动处理。
pub(crate) fn app_data_root() -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .ok_or_else(|| "无法确定可执行文件目录".to_string())?;
    Ok(exe_dir.join("data"))
}

/// 开发期诊断日志：追加一行到 `<exe 同目录>\data\debug.log`。
///
/// 用途：在**打包运行**（无 devtools）时定位前端链路问题；文件位置固定、可直接查看，
/// 不属于业务数据。仅诊断场景由前端调用。
///
/// **D76**：本命令是**新增/新增式**诊断通道，按新口径返回 `{ ok, data?, error? }`
/// （`data` 为 `null`）。它不属于业务命令，不进 `commands-events.md` §3 的业务表。
#[tauri::command]
pub(crate) fn debug_log(message: String) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        use std::io::Write;
        let dir = app_data_root().map_err(HpError::Io)?;
        std::fs::create_dir_all(&dir)
            .map_err(|e| HpError::Io(format!("创建应用数据目录失败: {e}")))?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("debug.log"))
            .map_err(|e| HpError::Io(format!("打开诊断日志失败: {e}")))?;
        writeln!(file, "{message}").map_err(|e| HpError::Io(format!("写入诊断日志失败: {e}")))
    })();
    api_from_hp(outcome)
}

/// 系统数据库：全局配置库文件路径（`<exe 同目录>\data\system\` 下）。
pub(crate) fn global_db_path() -> Result<PathBuf, String> {
    let dir = app_data_root()?.join("system");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建系统数据库目录失败: {e}"))?;
    Ok(dir.join("hamster-pouch-global.sqlite3"))
}

/// 内置 tag 基底库文件路径（`<exe 同目录>\data\system\` 下）。
///
/// 由 `tools/tagdict/build_base_lib.py` 生成（RFC 0008 / D36 第一层，约 12MB），
/// 随发布包/开发包分发。**完整词库不随应用分发**，按需安装 `plugins-dist/` 下的
/// 细分扩展包（`tagdict-pixiv` / `tagdict-danbooru` / `tagrel-games`）。
pub(crate) fn tag_lib_base_path() -> Result<PathBuf, String> {
    let dir = app_data_root()?.join("system");
    Ok(dir.join("tag_lib_base.sqlite3"))
}

/// 构建 tag 库聚合集：内置基底库（D36 第一层）+ 已安装扩展包（第二层），
/// 并建立**重复概念归并索引**（D36.3）。
///
/// 启动时调用一次；**插件安装/启用/禁用后必须重新调用**并替换 `AppState.tag_lib`，
/// 否则扩展数据不会生效（用户会看到「装完启用后界面毫无变化」）。
///
/// 返回 `None` = 无内置基底库（首次运行尚未分发）或打开失败——调用方应保持原状。
pub(crate) fn build_tag_lib_set(plugin_root: &std::path::Path) -> Option<hp_store::TagLibSet> {
    let path = tag_lib_base_path().ok()?;
    if !path.is_file() {
        return None;
    }
    let db = hp_store::TagLibDb::open_readonly(&path, hp_core::LibLayer::Base).ok()?;
    let mut set = hp_store::TagLibSet::new();
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
    set: &mut hp_store::TagLibSet,
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
            if let Some((vdir, db_path)) = chosen {
                if attach_one(set, &db_path) {
                    attached += 1;
                    seen.insert(manifest_plugin_id(&vdir).unwrap_or(dir_name.clone()));
                }
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
    plugin_id.contains(".tagdict.") || plugin_id.contains(".tagrel.")
        || local == "tagdict"
        || local == "tagrel"
}

/// 在包目录里定位四库数据文件：固定名 `data/tag_lib.sqlite`；
/// 不存在时回退接受 `data/` 下**唯一**的 `tag_lib*.sqlite`（历史命名兼容）。
fn find_tag_lib_data(dir: &std::path::Path) -> Option<PathBuf> {
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
fn attach_one(set: &mut hp_store::TagLibSet, db_path: &std::path::Path) -> bool {
    match hp_store::TagLibDb::open_readonly(db_path, hp_core::LibLayer::Extension) {
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

/// 用户数据库：默认仓库库目录（`<exe 同目录>\data\user\repos\`）。
pub(crate) fn default_repo_dir() -> Result<PathBuf, String> {
    let dir = app_data_root()?.join("user").join("repos");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建仓库目录失败: {e}"))?;
    Ok(dir)
}

/// 用户**自定义封面**目录（`<exe 同目录>\data\user\covers\`）。
///
/// 为什么放 `user\`：这是**用户数据**（用户自己挑的图片），不是可重建的缓存——
/// 放 `thumbnails\` 会被当缓存清掉，放 `system\` 又会进发布包（那是应用自身数据）。
/// 按 `data\user\` 的既定口径，它随开发包整体带走、**不进发布包**
/// （`tools/package-build.mjs` 排除整个 `user\`）。
pub(crate) fn user_covers_dir() -> Result<PathBuf, String> {
    let dir = app_data_root()?.join("user").join("covers");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建封面目录失败: {e}"))?;
    Ok(dir)
}

/// 从工作目录与可执行文件目录出发，逐级向上查找仓库内相对路径（如 `external-cli/...`）。
///
/// 为什么必须向上找：开发期 `tauri dev` 以 `apps/desktop/src-tauri` 为工作目录运行二进制，
/// 打包后通常以 exe 所在目录为工作目录，而 `external-cli/` 位于仓库根 / exe 同级。
/// 只按 cwd 拼一次相对路径会让两种布局**都**解析失败（表现为「未找到 mpv 可执行文件」）。
fn find_upwards(relative: &str) -> Option<PathBuf> {
    find_upwards_matching(relative, |p| p.is_file())
}

/// 同 [`find_upwards`]，但判据是**目录**（随包插件是目录，用文件判据永远找不到）。
fn find_upwards_dir(relative: &str) -> Option<PathBuf> {
    find_upwards_matching(relative, |p| p.is_dir())
}

/// 逐级向上查找的公共实现：`roots` 依次为工作目录与可执行文件目录，各自向上遍历祖先。
fn find_upwards_matching(
    relative: &str,
    matches: impl Fn(&std::path::Path) -> bool,
) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
        }
    }
    for root in roots {
        for dir in root.ancestors() {
            let candidate = dir.join(relative);
            if matches(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// 随应用分发的 **system 插件包根目录**（仓库内是 `plugins/system`）。
///
/// 解析顺序与 [`external_bin_path`] 一致：环境变量 `HP_BUNDLED_PLUGINS_DIR` 优先
/// （一旦设置即原样采信，不因目录不存在而静默回退——"路径写错"应在使用处如实报错），
/// 否则自工作目录 / 可执行文件目录逐级向上查找。
///
/// **打包边界（本轮未落地）**：`apps/desktop/src-tauri/tauri.conf.json` 目前**没有**
/// `bundle.resources` 声明，打包产物里**不包含** `plugins/system`。因此本函数只解析
/// 开发期/仓库内布局；随包分发需另补 `bundle.resources`，见
/// `docs/spec/commands-events.md` §3.11 `plugin.installBundled` 的备注。
pub(crate) fn bundled_plugins_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HP_BUNDLED_PLUGINS_DIR") {
        return Some(PathBuf::from(p));
    }
    find_upwards_dir("plugins/system")
}

/// 解析随应用发布的外部 CLI 路径：环境变量优先，其次按 `relative` 向上查找。
///
/// 环境变量一旦设置即**原样采信**（不因文件不存在而静默回退），
/// 这样「路径写错」会在使用处如实报错，而不是悄悄换用另一个二进制。
pub(crate) fn external_bin_path(env_key: &str, relative: &str) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(env_key) {
        return Some(PathBuf::from(p));
    }
    find_upwards(relative)
}

/// 解析外部 CLI 可执行文件路径：环境变量优先，其次项目内 `external-cli/`。
pub(crate) fn external_bin(name: &str) -> Option<PathBuf> {
    let env_key = if name == "ffmpeg" {
        "HP_FFMPEG_BIN"
    } else {
        "HP_FFPROBE_BIN"
    };
    external_bin_path(env_key, &format!("external-cli/ffmpeg/bin/{name}.exe"))
}

/// 懒加载全局配置库。
pub(crate) fn ensure_global(state: &AppState, _app: &tauri::AppHandle) -> HpResult<()> {
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
    if guard.is_none() {
        let path = global_db_path().map_err(HpError::Io)?;
        *guard = Some(GlobalDb::open(&path)?);
    }
    Ok(())
}

/// 锁住全局库（毒锁 → `Store`）。调用前先 `ensure_global`。
pub(crate) fn lock_global(
    state: &AppState,
) -> HpResult<std::sync::MutexGuard<'_, Option<GlobalDb>>> {
    state
        .global_db
        .lock()
        .map_err(|_| HpError::Store("全局库锁中毒".into()))
}

/// 取全局库（未初始化 → `not_found`：全局库还没打开）。
pub(crate) fn global<'g, 'a>(
    guard: &'g std::sync::MutexGuard<'a, Option<GlobalDb>>,
) -> HpResult<&'g GlobalDb> {
    guard
        .as_ref()
        .ok_or_else(|| HpError::NotFound("全局库未初始化".into()))
}

/// 同 [`global`]，可变借用（写操作）。
pub(crate) fn global_mut<'g, 'a>(
    guard: &'g mut std::sync::MutexGuard<'a, Option<GlobalDb>>,
) -> HpResult<&'g mut GlobalDb> {
    guard
        .as_mut()
        .ok_or_else(|| HpError::NotFound("全局库未初始化".into()))
}

/// 解析文件绝对路径：源本地路径 + 相对路径。
pub(crate) fn resolve_file_path(db: &RepoDb, file: &FileIndexRow) -> HpResult<PathBuf> {
    let source = db
        .get_source(file.source_id.as_str())?
        .ok_or_else(|| HpError::NotFound(format!("媒体源不存在: {}", file.source_id.as_str())))?;
    Ok(PathBuf::from(source.local_path).join(&file.relative_path))
}

// ===== 打开的仓库库：批次迁移共用的取用/加锁助手（D76）=====

/// 未打开仓库 → `HpError::NotFound`（"目标上下文不存在"）。
///
/// `HpError::code()` 的闭集里没有"前置条件"这一类，最贴近的是 `not_found`：
/// 请求要作用的仓库上下文不存在。**不要**把它写成 `Store`/`Io`——那会把
/// "用户还没打开仓库"误报成读写故障。
pub(crate) fn open_repo<'g, 'a>(
    guard: &'g std::sync::MutexGuard<'a, Option<RepoDb>>,
) -> HpResult<&'g RepoDb> {
    guard
        .as_ref()
        .ok_or_else(|| HpError::NotFound("未打开仓库".into()))
}

/// 同 [`open_repo`]，可变借用（写操作）。
pub(crate) fn open_repo_mut<'g, 'a>(
    guard: &'g mut std::sync::MutexGuard<'a, Option<RepoDb>>,
) -> HpResult<&'g mut RepoDb> {
    guard
        .as_mut()
        .ok_or_else(|| HpError::NotFound("未打开仓库".into()))
}

/// 锁住 `open_repo`（毒锁 → `Store`）。
pub(crate) fn lock_repo(
    state: &AppState,
) -> HpResult<std::sync::MutexGuard<'_, Option<RepoDb>>> {
    state
        .open_repo
        .lock()
        .map_err(|_| HpError::Store("仓库锁中毒".into()))
}

/// 相册成员 / 文件查询返回项。
#[derive(Serialize)]
pub(crate) struct AlbumFileItem {
    pub(crate) id: String,
    pub(crate) source_id: String,
    pub(crate) relative_path: String,
    pub(crate) media_type: String,
    /// 媒体类型之下的**子类型**（当前只有文本类有值：`book` / `document`）。
    ///
    /// 与 `media_type` 的分工见 `hp_core::FileSubtype`：`media_type` 是扫描判定的类型，
    /// 子类型是**可编辑标记**。前端据此决定"这本书要不要去取内嵌封面"。
    pub(crate) subtype: Option<String>,
    pub(crate) size: i64,
    pub(crate) mtime: String,
}

/// 文件索引行 → 返回项。
pub(crate) fn file_to_item(f: FileIndexRow) -> AlbumFileItem {
    AlbumFileItem {
        id: f.id.as_str().to_string(),
        source_id: f.source_id.as_str().to_string(),
        relative_path: f.relative_path,
        media_type: f.media_type.as_str().to_string(),
        subtype: f.subtype.map(|s| s.as_str().to_string()),
        size: f.size,
        mtime: f.mtime,
    }
}

#[cfg(test)]
mod tests {
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
            "media.surface.click",
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

    /// 开发期的工作目录就是本 crate（`cargo test` 与 `tauri dev` 都是
    /// `apps/desktop/src-tauri`）——正是旧实现只按 cwd 拼相对路径时解析失败的目录。
    ///
    /// **缺失即跳过**：`external-cli/mpv/` 因体积过大**不入库**（见根 `README.md`
    /// 「外部依赖」），因此全新克隆上该文件必然不存在——此处不能硬断言。
    /// 判据与 `crates/hp-media/tests/player_lifecycle.rs` 同口径（缺失时打印跳过）。
    /// 查找逻辑本身的覆盖不依赖本用例：同模块的 `find_upwards_finds_ffmpeg` 用
    /// **随仓库分发**的 ffmpeg 覆盖同一条代码路径。
    #[test]
    fn find_upwards_finds_repo_relative_mpv() {
        let Some(found) = find_upwards("external-cli/mpv/mpv.exe") else {
            eprintln!("跳过：未找到 external-cli/mpv/mpv.exe（该目录不入库，见根 README「外部依赖」）");
            return;
        };
        assert!(found.is_file());
        let normalized = found.to_string_lossy().replace('\\', "/");
        assert!(
            normalized.ends_with("external-cli/mpv/mpv.exe"),
            "意外路径: {normalized}"
        );
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
        assert!(found.join("palette").join("plugin.manifest").is_file());
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
        std::env::set_var(key, "Z:/explicit/override.exe");
        let got = external_bin_path(key, "external-cli/ffmpeg/bin/ffmpeg.exe");
        std::env::remove_var(key);
        assert_eq!(got, Some(PathBuf::from("Z:/explicit/override.exe")));
    }

    /// 随包插件根同样支持环境变量覆盖，且同样是"设置了就原样采信"。
    #[test]
    fn bundled_plugins_dir_honours_env_override() {
        let key = "HP_BUNDLED_PLUGINS_DIR";
        std::env::set_var(key, "Z:/explicit/bundled");
        let got = bundled_plugins_dir();
        std::env::remove_var(key);
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
        let base = find_upwards("tools/tagdict/output/tag_lib_base.sqlite3")
            .expect("需要基底库产物（先运行 tools/tagdict/build_base_lib.py）");
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

        let mut set = hp_store::TagLibSet::new();
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
        // 仓库内确实有可供安装的包（否则本用例没有意义）。
        assert!(
            dist.join("tagdict-pixiv").join("data").join("tag_lib.sqlite").is_file(),
            "前提：plugins-dist/ 下应有包（先运行 package_extensions.py）"
        );

        // 安装目录为空 = 一个扩展都没装。
        let empty = std::env::temp_dir().join(format!("hp-taglib-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&empty);
        std::fs::create_dir_all(&empty).unwrap();
        let mut set = hp_store::TagLibSet::new();
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

        let mut set = hp_store::TagLibSet::new();
        set.add(
            hp_store::TagLibDb::open_readonly(&base_path, hp_core::LibLayer::Base)
                .expect("只读打开基底库"),
        );
        let attached = attach_tag_lib_extensions(&mut set, &tmp);
        let _ = std::fs::remove_dir_all(&tmp);

        assert_eq!(attached, 3, "应装配三个已安装扩展包，实际 {attached}");
        assert_eq!(set.len(), 4, "层数应为 1 基底 + 3 扩展 = 4，实际 {}", set.len());

        set.refresh_merge().expect("构建归并索引");

        // 只在扩展包里的概念（danbooru 高热度画师，基底库不含）必须能查到：
        // 这是"装完立刻可用"的判据——层数对但数据没进去时这里会失败。
        let hits = set.find("Sciamano240", 10).expect("查询扩展专属 tag");
        assert!(
            !hits.is_empty(),
            "扩展包里的 tag 装配后应立即可查（说明数据真的进了聚合层）"
        );
        assert!(
            hits.iter().any(|d| d.concept.kind == hp_core::TagKind::Artist),
            "该名字应命中 artist 概念，实际 {:?}",
            hits.iter().map(|d| d.concept.kind).collect::<Vec<_>>()
        );
    }
}
