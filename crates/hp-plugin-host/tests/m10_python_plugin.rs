//! Python 运行形态的**端到端**回归（RFC 0009 决策 2 / D39「Python 核心」）。
//!
//! 这条用例证明的是运行形态的关键不变式，而不是某个函数：
//!
//! 1. 宿主**不直连** `<包根>/runtime/python.exe`——`python` 形态的面板查询由宿主拉起
//!    **随包 python-core**（`bin/python-core.exe --run <脚本>`），解释器的定位、
//!    工作目录与 stdio 代理都是 python-core 的职责。否则 python-core 只是个空壳，
//!    而"解释器从哪来"会散落进宿主（RFC 0004「Python 核心」一节正是禁止这一点）。
//! 2. 插件脚本是**源码**（`main.py`），走 `PluginInstaller` 正常安装、`PluginHost` 正常注册，
//!    与 external-process 插件共用同一条 JSON-RPC 一行进一行出的通道。
//! 3. 脚本缺失时 fail-closed（不静默略过，也不去起一个空进程）。
//!
//! **跳过条件**：`bin/python-core.exe` 与 `runtime/python.exe` 都是构建产物（不入库，
//! 见 `plugins/system/python-core/README.md`）。新克隆上没跑过
//! `node tools/fetch-python-runtime.mjs` 与 `cargo build -p hp-plugin-host --bin python_core`
//! 时整条用例跳过——门禁 `check:bundled-runtime` 负责在**打包**时把这两样变成必需项，
//! 所以"跳过"不会让缺失悄悄溜进发布包。

use std::path::{Path, PathBuf};

use hp_core::RuntimeKind;
use hp_plugin_host::{
    InstallSource, MANIFEST_FILE, PYTHON_CORE_PLUGIN_ID, PanelSchemaParams, PluginHost,
    PluginInstaller, SCHEMA_MAX_BYTES, SCHEMA_QUERY_TIMEOUT, python_core_enabled,
    python_core_status, query_for_owner,
};
use hp_store::GlobalDb;

const INSTALLED_AT: &str = "2026-01-01T00:00:00Z";
/// 查询通道的仓库上下文（0039：Python 核心开关按仓库生效）。
const REPO: &str = "repo-1";
/// 测试插件 id。面板 id 必须带 `plugin.<plugin_id>.` 前缀（贡献点命名空间化）。
const PLUGIN_ID: &str = "dev.hamsterpouch.test.pyhello";
const PANEL_ID: &str = "plugin.dev.hamsterpouch.test.pyhello.py.panel";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn temp_root(tag: &str) -> PathBuf {
    let dir = tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(tag);
    // 目录必须先存在：`GlobalDb::open` 不会替我们建父目录。
    std::fs::create_dir_all(&dir).expect("建临时目录失败");
    dir
}

/// 随包 python-core 的启动器与解释器都在位？（两者都是构建产物）
fn python_core_available() -> bool {
    let core = repo_root().join("plugins/system/python-core");
    core.join("bin").join("python-core.exe").is_file()
        && core.join("runtime").join("python.exe").is_file()
}

/// Python 插件脚本：一行进一行出，与 `bin/fake_panel_plugin.rs` 是同一条协议。
///
/// `result` 里塞一个只有解释器跑起来才会出现的标记（`py.fired`），
/// 断言里据此区分"脚本真的执行了"与"宿主回落到别的路径"。
const SCRIPT: &str = r#"import json
import sys

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    rid = req.get("id", 1)
    method = req.get("method", "")
    if method == "ui.panel.schema":
        result = {
            "api_version": 1,
            "panel_id": req["params"]["panel_id"],
            "root": {"id": "root", "kind": "text", "text_key": "py.fired"},
        }
        resp = {"jsonrpc": "2.0", "id": rid, "result": result}
    elif method.startswith("plugin."):
        resp = {"jsonrpc": "2.0", "id": rid, "result": {"ok": True}}
    else:
        resp = {
            "jsonrpc": "2.0",
            "id": rid,
            "error": {"code": -32601, "message": "夹具未实现 " + method},
        }
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
"#;

fn manifest_json() -> String {
    format!(
        r#"{{
            "id": "{PLUGIN_ID}",
            "name": "Python 测试插件",
            "version": "0.1.0",
            "min_host_version": 1,
            "api_version": 1,
            "runtime": {{ "kind": "python" }},
            "entry": "main.py",
            "capabilities": ["ui.panel", "repo.read"],
            "contributions": [
                {{
                    "kind": "panel",
                    "id": "{PANEL_ID}",
                    "title_key": "py.panel",
                    "category": "media",
                    "has_class": false,
                    "blueprint_node": "control",
                    "read_only": true
                }}
            ],
            "trust": {{ "requested": "local-dev" }}
        }}"#
    )
}

/// 造一个 Python 插件包；`with_script = false` 时**故意不写** `main.py`（入口缺失路径）。
fn write_python_package(root: &Path, with_script: bool) -> PathBuf {
    let dir = root.join(format!("src-{PLUGIN_ID}"));
    std::fs::create_dir_all(&dir).expect("建目录失败");
    std::fs::write(dir.join(MANIFEST_FILE), manifest_json()).expect("写清单失败");
    if with_script {
        std::fs::write(dir.join("main.py"), SCRIPT).expect("写脚本失败");
    }
    dir
}

/// 把随包 python-core 与测试插件装进**同一个**全局库：宿主按 id 定位提供者，
/// 这也是生产路径（`ensure_global` 播种 + 用户安装插件）的形状。
fn install_pair(root: &Path) -> (PluginInstaller, GlobalDb) {
    let installer = PluginInstaller::new(root.join("store"));
    let mut db = GlobalDb::open(root.join("global.sqlite3")).expect("打开全局库失败");

    let core_row = installer
        .install_registry_row(
            &InstallSource::Bundled(repo_root().join("plugins/system/python-core")),
            INSTALLED_AT,
        )
        .expect("随包安装 python-core 失败");
    PluginHost
        .register(&mut db, &core_row)
        .expect("注册 python-core 失败");

    let package = write_python_package(root, true);
    let row = installer
        .install_registry_row(&InstallSource::LocalPath(package), INSTALLED_AT)
        .expect("安装 Python 插件失败");
    PluginHost
        .register(&mut db, &row)
        .expect("注册 Python 插件失败");

    (installer, db)
}

#[test]
fn python_plugin_is_launched_through_the_bundled_python_core() {
    if !python_core_available() {
        eprintln!(
            "跳过：随包 python-core 尚未构建（先跑 tools/fetch-python-runtime.mjs 与 \
             cargo build -p hp-plugin-host --bin python_core --release）"
        );
        return;
    }

    let root = temp_root("py-channel");
    let (_installer, db) = install_pair(&root);

    let owner = PluginHost
        .find_panel_owner(&db, PANEL_ID)
        .expect("反查面板归属失败")
        .expect("应能反查到面板归属");
    assert_eq!(owner.runtime_kind, RuntimeKind::Python);

    let entry = owner.entry_path.clone().expect("python 形态必须有入口");
    assert!(
        entry.to_string_lossy().ends_with("main.py"),
        "入口应指向 .py 源码: {}",
        entry.display()
    );
    assert!(
        !entry.to_string_lossy().contains("python.exe"),
        "宿主不得把解释器当成插件入口: {}",
        entry.display()
    );

    let mut query = query_for_owner(&db, &owner, REPO).expect("构造 python 形态查询通道失败");
    let schema = query
        .query(
            &PanelSchemaParams::new(PANEL_ID, 1),
            SCHEMA_QUERY_TIMEOUT,
            SCHEMA_MAX_BYTES,
        )
        .expect("python 形态的面板 schema 查询失败");

    assert!(
        schema.contains("py.fired"),
        "schema 必须由 Python 脚本产生（说明 python-core 真的拉起了解释器）: {schema}"
    );
    assert!(
        schema.contains(PANEL_ID),
        "脚本应收到宿主发来的 panel_id: {schema}"
    );
}

#[test]
fn python_plugin_without_its_script_fails_closed() {
    if !python_core_available() {
        eprintln!("跳过：随包 python-core 尚未构建");
        return;
    }

    let root = temp_root("py-missing");
    let installer = PluginInstaller::new(root.join("store"));
    let mut db = GlobalDb::open(root.join("global.sqlite3")).expect("打开全局库失败");

    let core_row = installer
        .install_registry_row(
            &InstallSource::Bundled(repo_root().join("plugins/system/python-core")),
            INSTALLED_AT,
        )
        .expect("随包安装 python-core 失败");
    PluginHost
        .register(&mut db, &core_row)
        .expect("注册 python-core 失败");

    // 清单声明 `entry = main.py`，但包里没有这个文件。
    let package = write_python_package(&root, false);
    let row = installer
        .install_registry_row(&InstallSource::LocalPath(package), INSTALLED_AT)
        .expect("安装 Python 插件失败");
    PluginHost
        .register(&mut db, &row)
        .expect("注册 Python 插件失败");

    let owner = PluginHost
        .find_panel_owner(&db, PANEL_ID)
        .expect("反查面板归属失败")
        .expect("应能反查到面板归属");
    // `ExternalProcessQuery` 没实现 `Debug`（它持有 `Command`），所以不用 `expect_err`。
    let err = match query_for_owner(&db, &owner, REPO) {
        Ok(_) => panic!("脚本缺失必须失败，不得静默略过"),
        Err(e) => e,
    };
    let text = err.to_string();
    assert!(
        text.contains("插件入口不存在"),
        "错误应指出入口缺失，实际: {text}"
    );
}

/// 0039：Python 核心的开关必须**真的**挡住 python 形态的插件，而不是显示层的假开关。
///
/// 覆盖三种状态：随包播种（无 `plugin_repo_state` 行）默认可用 → 显式禁用后
/// `query_for_owner` 拒绝 → 重新启用后恢复。状态快照与 catalog 也走同一谓词。
#[test]
fn python_core_toggle_really_gates_the_runtime() {
    if !python_core_available() {
        eprintln!("跳过：随包 python-core 尚未构建");
        return;
    }

    let root = temp_root("py-toggle");
    let (_installer, mut db) = install_pair(&root);
    let owner = PluginHost
        .find_panel_owner(&db, PANEL_ID)
        .expect("反查面板归属失败")
        .expect("应能反查到面板归属");

    // 1) 默认态：播种只写注册表、不写状态行 → 运行时视为启用。
    assert!(
        python_core_enabled(&db, REPO).expect("查默认启用失败"),
        "随包 Python 核心默认必须可用，否则 python 插件全部拉不起来"
    );
    let status = python_core_status(&db, REPO).expect("查状态失败");
    assert!(status.installed, "python-core 应已安装");
    assert!(status.enabled, "默认状态快照应为启用");
    assert!(status.launcher_exists, "启动器应存在: {}", status.launcher);
    assert_eq!(status.plugin_id, PYTHON_CORE_PLUGIN_ID);
    query_for_owner(&db, &owner, REPO).expect("默认态应能构造查询通道");
    let catalog = PluginHost.plugin_catalog(&db, REPO).expect("查目录失败");
    let core = catalog
        .iter()
        .find(|e| e.plugin_id == PYTHON_CORE_PLUGIN_ID)
        .expect("目录里应列出 python-core");
    assert!(core.enabled, "目录里的开关应与运行时同一谓词");

    // 2) 显式禁用 → python 形态查询通道被拒；external-process 不受影响（本夹具没有）。
    PluginHost
        .disable_for_repo(&mut db, PYTHON_CORE_PLUGIN_ID, REPO)
        .expect("禁用失败");
    assert!(!python_core_enabled(&db, REPO).expect("查禁用失败"));
    let err = match query_for_owner(&db, &owner, REPO) {
        Ok(_) => panic!("停用后不得再拉起 python 插件"),
        Err(e) => e,
    };
    let text = err.to_string();
    assert!(
        text.contains("Python 运行时已停用"),
        "应给出明确的停用提示，实际: {text}"
    );
    assert!(
        !python_core_status(&db, REPO).expect("查状态失败").enabled,
        "状态快照应反映停用"
    );

    // 3) 重新启用（空 grants：python-core 只声明 native.code，无需也不应请求它）→ 恢复。
    PluginHost
        .enable_for_repo(&mut db, PYTHON_CORE_PLUGIN_ID, REPO, &[])
        .expect("重新启用失败");
    assert!(python_core_enabled(&db, REPO).expect("查重新启用失败"));
    query_for_owner(&db, &owner, REPO).expect("重新启用后应恢复查询通道");
}
