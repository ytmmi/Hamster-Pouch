//! Python 运行时：**Python 核心** system 插件的定位、开关与自检
//! （RFC 0009「Python 核心」/ RFC 0004 决策 23 / issues/0039）。
//!
//! 分工（这一层只做**定位**，不做解释器实现）：
//!   * 宿主认识**两个常量**：Python 核心的插件 id，以及拉起脚本的参数名；
//!   * 解释器在哪、怎么隔离、子进程怎么收尾，由 Python 核心插件自己负责
//!     （它按自身 exe 路径推包根 → `runtime/python.exe`）；
//!   * 于是"换解释器版本/换打包形态"只动插件包，宿主侧零改动。
//!
//! **不硬编码安装目录名**：安装目录由 `PluginInstaller` 按 `root/<plugin_id>/<version>/`
//! 组织，但这里是"插件 id → 注册表行 → `source_ref`"，与目录名规则解耦。
//!
//! **开关语义（0039）**：Python 核心是宿主按固定 id 取用的**内部 provider**，随包播种
//! 时只有注册表行、没有 `plugin_repo_state` 行。若把"无状态行"当成未启用，随包的
//! `python` 形态插件会全部拉不起来。因此约定：
//!   * **无状态行 = 默认启用**（`python_core_enabled` 返回 `true`）；
//!   * 只有用户显式禁用（状态行 `enabled = false`）才停用；
//!   * 停用时 `query_for_owner` 拒绝构造 python 查询通道，`python_core_selftest`
//!     也不再拉起解释器 —— 开关由此产生**实际**效果，而不是显示层的假开关。

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use hp_core::{HpError, HpResult, PluginManifest, PluginRegistryRow, RuntimeKind};
use hp_store::GlobalDb;

use crate::channel::ExternalProcessQuery;
use crate::host::PanelOwner;
use crate::manifest::parse_manifest;

/// Python 核心插件的固定 id（宿主按 id 定位提供者，不按目录名）。
pub const PYTHON_CORE_PLUGIN_ID: &str = "dev.hamsterpouch.system.python_core";

/// 拉起 Python 脚本的参数：`<python-core.exe> --run <脚本绝对路径>`。
pub const PYTHON_RUN_FLAG: &str = "--run";

/// 自检参数：`<python-core.exe> --selftest`（实际拉起解释器打印版本，见 bin）。
pub const PYTHON_SELFTEST_FLAG: &str = "--selftest";

/// 自检进程的最长等待时间（秒）；超时即放弃并在结果里报 `plugin` 错误。
pub const SELFTEST_TIMEOUT_SECS: u64 = 10;

/// Python 核心的**状态快照**（供 `plugin.pythonRuntimeStatus` / MCP 工具使用）。
///
/// 字段刻意用 `String` 而非枚举/DTO：这一层不依赖 Tauri/serde，桥接层再决定序列化口径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PythonCoreStatus {
    pub plugin_id: String,
    /// 注册表里有没有这个随包插件。
    pub installed: bool,
    pub version: String,
    pub trust_level: String,
    pub runtime_kind: String,
    /// 该仓库的有效启用状态（无状态行按默认启用算）。
    pub enabled: bool,
    /// 启动器绝对路径（未安装时为空串）。
    pub launcher: String,
    /// 启动器文件是否真实存在（缺失 = 打包/构建不完整）。
    pub launcher_exists: bool,
}

/// 在注册表里定位 Python 核心的**行 + 解析后的清单**（不查启用状态）。
///
/// 与 `find_python_core_launcher` 的区别：后者在缺行/清单坏/入口缺失时返回错误，
/// 这里返回 `Option`，让状态查询能以"未安装"这种**正常结果**上报而不是报错。
fn python_core_row(db: &GlobalDb) -> HpResult<Option<(PluginRegistryRow, PluginManifest)>> {
    for row in db.list_plugins()? {
        if row.id.as_str() != PYTHON_CORE_PLUGIN_ID {
            continue;
        }
        let manifest = parse_manifest(&row.manifest_json).map_err(|e| {
            HpError::Plugin(format!(
                "Python 核心插件（{PYTHON_CORE_PLUGIN_ID}）清单不可解析: {e}"
            ))
        })?;
        return Ok(Some((row, manifest)));
    }
    Ok(None)
}

/// 定位 Python 核心插件的入口可执行文件（`bin/python-core.exe`，取自它自己的清单）。
///
/// 返回的错误都是 [`HpError::Plugin`]——调用方（面板 schema/取数通道）统一按
/// "插件通道失败"降级并广播 `plugin.error`，不需要区分"没装"与"入口缺失"。
///
/// 注意：这里**只定位**，不检查启用状态；启用闸门在 [`python_core_enabled`] 与
/// [`query_for_owner`]，供状态查询与诊断复用。
pub fn find_python_core_launcher(db: &GlobalDb) -> HpResult<PathBuf> {
    let (row, manifest) = python_core_row(db)?.ok_or_else(|| {
        HpError::Plugin(format!(
            "运行 python 形态的插件需要 Python 核心插件（{PYTHON_CORE_PLUGIN_ID}），但它尚未安装"
        ))
    })?;
    let dir = row.source_ref.as_deref().ok_or_else(|| {
        HpError::Plugin(format!(
            "Python 核心插件（{PYTHON_CORE_PLUGIN_ID}）缺少安装目录（source_ref）"
        ))
    })?;
    // 入口名取自**它自己的清单**（尊重 manifest，不硬编码 exe 名）。
    let exe = Path::new(dir).join(&manifest.entry);
    if !exe.is_file() {
        return Err(HpError::Plugin(format!(
            "Python 核心插件入口不存在: {}（随包分发缺失或未构建）",
            exe.display()
        )));
    }
    Ok(exe)
}

/// 该仓库里 Python 核心是否**有效启用**。
///
/// 内部 provider 的默认态是"可用"：随包播种不写 `plugin_repo_state` 行，
/// 没有状态行就按启用处理；只有显式 `enabled = false` 才停用。
/// 其它插件不走这条路径（它们仍按"无状态行 = 未启用"的安全口径）。
pub fn python_core_enabled(db: &GlobalDb, repo_id: &str) -> HpResult<bool> {
    Ok(db
        .get_plugin_repo_state(PYTHON_CORE_PLUGIN_ID, repo_id)?
        .map(|s| s.enabled)
        .unwrap_or(true))
}

/// 汇总 Python 核心的安装 / 启用 / 启动器状态（供状态命令与 MCP 工具）。
pub fn python_core_status(db: &GlobalDb, repo_id: &str) -> HpResult<PythonCoreStatus> {
    let enabled = python_core_enabled(db, repo_id)?;
    let Some((row, manifest)) = python_core_row(db)? else {
        return Ok(PythonCoreStatus {
            plugin_id: PYTHON_CORE_PLUGIN_ID.to_string(),
            installed: false,
            version: String::new(),
            trust_level: String::new(),
            runtime_kind: String::new(),
            enabled,
            launcher: String::new(),
            launcher_exists: false,
        });
    };
    let launcher = row
        .source_ref
        .as_deref()
        .map(|dir| Path::new(dir).join(&manifest.entry))
        .unwrap_or_default();
    Ok(PythonCoreStatus {
        plugin_id: PYTHON_CORE_PLUGIN_ID.to_string(),
        installed: true,
        version: row.version.clone(),
        trust_level: row.trust_level.as_str().to_string(),
        runtime_kind: row.runtime_kind.as_str().to_string(),
        enabled,
        launcher_exists: launcher.is_file(),
        launcher: launcher.to_string_lossy().to_string(),
    })
}

/// 真正拉起 `python-core.exe --selftest`，返回它打印的自检文本。
///
/// 这是**会执行解释器**的探针（bin 的 `--selftest` 会起 `python.exe -c ...`）：
/// 桥接层在调用前先查 [`python_core_enabled`]，停用时不走到这里。
/// 用工作线程 + `recv_timeout` 兜底：解释器卡住时不会把调用方（MCP 请求）永久挂起。
pub fn python_core_selftest(launcher: &Path) -> HpResult<String> {
    if !launcher.is_file() {
        return Err(HpError::Plugin(format!(
            "Python 核心插件入口不存在: {}（随包分发缺失或未构建）",
            launcher.display()
        )));
    }
    let mut command = crate::channel::hidden_command(launcher);
    command.arg(PYTHON_SELFTEST_FLAG);
    // `Command::output()` 自带 stdout/stderr 管道；不必再显式设置。
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = command;
        let _ = tx.send(cmd.output());
    });
    let timeout = Duration::from_secs(SELFTEST_TIMEOUT_SECS);
    let output = rx
        .recv_timeout(timeout)
        .map_err(|_| HpError::Plugin(format!("Python 核心自检超时（>{SELFTEST_TIMEOUT_SECS}s）")))?
        .map_err(|e| HpError::Plugin(format!("Python 核心自检进程启动失败: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(HpError::Plugin(format!(
            "Python 核心自检失败（退出码 {:?}）: {}",
            output.status.code(),
            if stderr.is_empty() { &stdout } else { &stderr }
        )));
    }
    if stdout.is_empty() {
        return Err(HpError::Plugin(format!(
            "Python 核心自检无输出: {}",
            if stderr.is_empty() {
                "（stderr 也为空）"
            } else {
                &stderr
            }
        )));
    }
    Ok(stdout)
}

/// 按面板归属者的**运行形态**构造查询通道（`docs/spec/commands-events.md` §4）。
///
/// * `external-process` → 直接起插件入口；
/// * `python` → **先查 Python 核心开关**，停用即拒绝；启用则起 Python 核心插件，
///   把脚本交给它拉起（脚本本身不可执行）；
/// * `static-data` → 调用方在更早处就已分流（无入口、无查询），走不到这里；
/// * 其余形态（动态库/WASM）尚未接入，返回明确错误而不是"起一个空进程"。
pub fn query_for_owner(
    db: &GlobalDb,
    owner: &PanelOwner,
    repo_id: &str,
) -> HpResult<ExternalProcessQuery> {
    let entry = owner.entry_path.clone().ok_or_else(|| {
        HpError::Plugin("注册表缺少插件安装目录（source_ref），无法定位入口".into())
    })?;
    match owner.runtime_kind {
        RuntimeKind::ExternalProcess => {
            if !entry.is_file() {
                return Err(HpError::Plugin(format!(
                    "插件入口不存在: {}",
                    entry.display()
                )));
            }
            Ok(ExternalProcessQuery::for_entry(entry))
        }
        RuntimeKind::Python => {
            // 开关闸门：显式停用后，任何 python 插件都不再被拉起（0039）。
            if !python_core_enabled(db, repo_id)? {
                return Err(HpError::Permission(format!(
                    "Python 运行时已停用：请在「扩展」菜单或 MCP 工具中启用 {PYTHON_CORE_PLUGIN_ID}"
                )));
            }
            if !entry.is_file() {
                return Err(HpError::Plugin(format!(
                    "插件入口不存在: {}",
                    entry.display()
                )));
            }
            let launcher = find_python_core_launcher(db)?;
            // 经 `hidden_command` 构造：与插件子进程同一条"不弹控制台窗口"不变式。
            let mut command = crate::channel::hidden_command(launcher);
            command.arg(PYTHON_RUN_FLAG).arg(&entry);
            Ok(ExternalProcessQuery::for_host_command(command))
        }
        other => Err(HpError::Plugin(format!(
            "运行形态 {} 的查询通道尚未接入",
            other.as_str()
        ))),
    }
}
