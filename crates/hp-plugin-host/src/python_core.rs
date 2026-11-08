//! Python 运行时：**Python 核心** system 插件的定位，与 `python` 形态插件的拉起
//! （RFC 0009「Python 核心」/ RFC 0004 决策 23）。
//!
//! 分工（这一层只做**定位**，不做解释器实现）：
//!   * 宿主认识**两个常量**：Python 核心的插件 id，以及拉起脚本的参数名；
//!   * 解释器在哪、怎么隔离、子进程怎么收尾，由 Python 核心插件自己负责
//!     （它按自身 exe 路径推包根 → `runtime/python.exe`）；
//!   * 于是"换解释器版本/换打包形态"只动插件包，宿主侧零改动。
//!
//! **不硬编码安装目录名**：安装目录由 `PluginInstaller` 按 `root/<plugin_id>/<version>/`
//! 组织，但这里是"插件 id → 注册表行 → `source_ref`"，与目录名规则解耦。

use std::path::{Path, PathBuf};

use hp_core::{HpError, HpResult, RuntimeKind};
use hp_store::GlobalDb;

use crate::channel::ExternalProcessQuery;
use crate::host::PanelOwner;
use crate::manifest::parse_manifest;

/// Python 核心插件的固定 id（宿主按 id 定位提供者，不按目录名）。
pub const PYTHON_CORE_PLUGIN_ID: &str = "dev.hamsterpouch.system.python_core";

/// 拉起 Python 脚本的参数：`<python-core.exe> --run <脚本绝对路径>`。
pub const PYTHON_RUN_FLAG: &str = "--run";

/// 定位 Python 核心插件的入口可执行文件（`bin/python-core.exe`，取自它自己的清单）。
///
/// 返回的错误都是 [`HpError::Plugin`]——调用方（面板 schema/取数通道）统一按
/// "插件通道失败"降级并广播 `plugin.error`，不需要区分"没装"与"入口缺失"。
pub fn find_python_core_launcher(db: &GlobalDb) -> HpResult<PathBuf> {
    for row in db.list_plugins()? {
        if row.id.as_str() != PYTHON_CORE_PLUGIN_ID {
            continue;
        }
        let manifest = parse_manifest(&row.manifest_json).map_err(|e| {
            HpError::Plugin(format!(
                "Python 核心插件（{PYTHON_CORE_PLUGIN_ID}）清单不可解析: {e}"
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
        return Ok(exe);
    }
    Err(HpError::Plugin(format!(
        "运行 python 形态的插件需要 Python 核心插件（{PYTHON_CORE_PLUGIN_ID}），但它尚未安装"
    )))
}

/// 按面板归属者的**运行形态**构造查询通道（`docs/spec/commands-events.md` §4）。
///
/// * `external-process` → 直接起插件入口；
/// * `python` → 起 Python 核心插件，把脚本交给它拉起（脚本本身不可执行）；
/// * `static-data` → 调用方在更早处就已分流（无入口、无查询），走不到这里；
/// * 其余形态（动态库/WASM）尚未接入，返回明确错误而不是"起一个空进程"。
pub fn query_for_owner(db: &GlobalDb, owner: &PanelOwner) -> HpResult<ExternalProcessQuery> {
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
