//! 内置 MCP（Model Context Protocol）服务（D119）。
//!
//! ## 形态
//!
//! 随桌面应用一起启动的**本机 HTTP 服务**，只绑 `127.0.0.1`，由设置项 `mcp.*`
//! 控制启停。传输是 **Streamable HTTP**：单一端点 `/mcp`
//! （`POST` 收发 JSON-RPC 2.0、`GET` 打开 SSE 通道、`DELETE` 结束会话），
//! 另有一个不需要鉴权的 `/health` 供排查用。
//!
//! ## 安全边界（D119）
//!
//! - **默认关闭**（`mcp.enabled` 缺省 `false`）；
//! - 只监听回环地址，不绑 `0.0.0.0`——局域网内其它机器连不上；
//! - 除 `/health` 与 `OPTIONS` 外每个请求都要 `Authorization: Bearer <token>`
//!   （token 落在 `data/system/mcp.token`，首次启用时生成）；
//! - 写操作（复制 / 移动 / 重命名 / 移入回收站 / 打标）另受 `mcp.allowWrite`
//!   二次开关约束，缺省关闭——只读工具不需要它。
//!
//! ## 为什么不用 axum / hyper
//!
//! 见 D20 与 D119：根 workspace 连 tokio 都没有，桥接层已有的 tokio 只是
//! tauri 的运行时内部依赖。这个服务只处理单端点、请求体有上限、并发数是个位数，
//! 用**标准库 TcpListener + 每连接一线程**足够，也省掉为一层 web 框架
//! 新增依赖的代价（`tools/check-hidden-console.mjs` 一类门禁也更好守）。
//!
//! JSON-RPC 编解码在 [`jsonrpc`]，协议方法分发在 [`protocol`]，
//! 工具实现在 [`tools`]，传输在 [`http`]。

pub(crate) mod http;
pub(crate) mod jsonrpc;
pub(crate) mod protocol;
pub(crate) mod tools;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::Manager;

use crate::AppState;
use crate::commands::shared::{app_data_root, diag_log, ensure_global};

/// 默认监听端口（与 `packages/config/src/settings.ts` 的 `DEFAULT_MCP_PORT` 一致）。
pub(crate) const DEFAULT_PORT: u16 = 57321;
/// 端口下界：1024 以下需要特权，普通用户绑不上，直接拒绝。
pub(crate) const MIN_PORT: u16 = 1024;
/// 端口上界。
pub(crate) const MAX_PORT: u16 = 65535;

/// 服务配置（三项设置项的**解析后**形态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ServerConfig {
    pub(crate) enabled: bool,
    pub(crate) port: u16,
    pub(crate) allow_write: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            allow_write: false,
        }
    }
}

/// 解析设置项原始串（`app_settings` 是 TEXT 表）。
///
/// 越界/非数字端口一律回落缺省值而不是报错：设置项本身由注册表校验，
/// 这里只是"读到脏值时不至于把服务起在奇怪端口上"的兜底。
pub(crate) fn parse_config(
    enabled: Option<&str>,
    port: Option<&str>,
    allow_write: Option<&str>,
) -> ServerConfig {
    let flag = |raw: Option<&str>| raw.map(|v| v.trim() == "true").unwrap_or(false);
    let port = port
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|p| (MIN_PORT..=MAX_PORT).contains(p))
        .unwrap_or(DEFAULT_PORT);
    ServerConfig {
        enabled: flag(enabled),
        port,
        allow_write: flag(allow_write),
    }
}

/// 从全局库读当前配置。
///
/// 读不到（全局库未初始化 / 键未设置）时按缺省值处理：**缺省是关闭**，
/// 因此任何读取失败都不会意外把服务打开。
pub(crate) fn read_config(app: &tauri::AppHandle) -> ServerConfig {
    let state = app.state::<AppState>();
    let read = |key: &str| -> Option<String> {
        ensure_global(&state, app).ok()?;
        let guard = state.global_db.lock().ok()?;
        let g = guard.as_ref()?;
        g.get_setting(key).ok().flatten()
    };
    let enabled = read("mcp.enabled");
    let port = read("mcp.port");
    let allow_write = read("mcp.allowWrite");
    parse_config(enabled.as_deref(), port.as_deref(), allow_write.as_deref())
}

/// token 文件路径：`<exe 同目录>\data\system\mcp.token`。
///
/// 与全局库同目录（`data\system\`，见 `commands/shared.rs` 的 `app_data_root`），
/// 因此整体复制/备份 `data\` 时 token 跟着走，MCP 客户端配置不用改。
fn token_path() -> Result<PathBuf, String> {
    Ok(app_data_root()?.join("system").join("mcp.token"))
}

/// 一个正在运行的实例。
struct Running {
    port: u16,
    allow_write: bool,
    /// 置 `true` 即让监听循环与 SSE 连接退出。
    shutdown: Arc<AtomicBool>,
}

/// 内置 MCP 服务的生命周期（放在 [`AppState`] 上，随应用存活）。
pub(crate) struct McpRuntime {
    /// 当前运行实例；`None` = 未运行。
    running: Mutex<Option<Running>>,
    /// 缓存的 token（首次取用时从文件读或生成）。
    token: Mutex<Option<String>>,
}

impl McpRuntime {
    pub(crate) fn new() -> Self {
        Self {
            running: Mutex::new(None),
            token: Mutex::new(None),
        }
    }

    fn lock_running(&self) -> MutexGuard<'_, Option<Running>> {
        // 锁中毒不该让整个 MCP 功能永久失效：取回内部值继续用。
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 当前是否在运行，以及（端口, 是否允许写）。
    pub(crate) fn status(&self) -> Option<(u16, bool)> {
        self.lock_running()
            .as_ref()
            .map(|r| (r.port, r.allow_write))
    }

    /// 取 token：优先内存缓存，其次读文件，最后生成并落盘。
    ///
    /// 生成 64 位十六进制（两个 UUIDv4 拼接）——本机服务的防误连强度足够，
    /// 也不需要为此引入新的随机数依赖。
    fn ensure_token(&self) -> String {
        if let Ok(guard) = self.token.lock() {
            if let Some(existing) = guard.as_ref() {
                return existing.clone();
            }
        }
        let path = token_path().ok();
        let existing = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let token = existing.unwrap_or_else(|| {
            let fresh = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            if let Some(p) = path.as_ref() {
                if let Some(dir) = p.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(p, format!("{fresh}\n"));
            }
            fresh
        });
        if let Ok(mut guard) = self.token.lock() {
            *guard = Some(token.clone());
        }
        token
    }

    /// 供界面展示 / 复制的 token（首次调用时生成并落盘）。
    ///
    /// 服务未启用时也允许取：用户往往要先把 token 填进客户端配置、
    /// 再回来打开开关。
    pub(crate) fn token_for_client(&self) -> String {
        self.ensure_token()
    }

    /// 停止当前实例（幂等）。
    pub(crate) fn stop(&self) {
        let taken = self.lock_running().take();
        if let Some(run) = taken {
            run.shutdown
                .store(true, std::sync::atomic::Ordering::SeqCst);
            diag_log(&format!("[mcp] 已停止（原端口 {}）", run.port));
        }
    }

    /// 按当前设置项应用：该开就开、该关就关、端口/写权限变了就重启。
    ///
    /// **幂等**：设置项每次写入都会调到这里，配置没变时不做任何事
    /// （否则改一个无关设置也会把服务重启一遍）。
    pub(crate) fn apply(&self, app: &tauri::AppHandle) {
        let cfg = read_config(app);
        if !cfg.enabled {
            self.stop();
            return;
        }
        {
            let guard = self.lock_running();
            if let Some(run) = guard.as_ref() {
                if run.port == cfg.port && run.allow_write == cfg.allow_write {
                    return;
                }
            }
        }
        self.stop();
        match self.start(app, cfg) {
            Ok(port) => diag_log(&format!(
                "[mcp] 已启动：http://127.0.0.1:{port}/mcp（写操作{}）",
                if cfg.allow_write {
                    "已允许"
                } else {
                    "已禁用"
                }
            )),
            Err(message) => diag_log(&format!("[mcp] 启动失败：{message}")),
        }
    }

    /// 绑定端口并起后台线程。
    fn start(&self, app: &tauri::AppHandle, cfg: ServerConfig) -> Result<u16, String> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", cfg.port))
            .map_err(|e| format!("绑定 127.0.0.1:{} 失败：{e}", cfg.port))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("设置非阻塞失败：{e}"))?;

        let token = self.ensure_token();
        let shutdown = Arc::new(AtomicBool::new(false));
        let handler: Arc<dyn http::Handler> =
            Arc::new(http::TauriHandler::new(app.clone(), cfg.allow_write));
        let port = cfg.port;
        let stop_flag = Arc::clone(&shutdown);
        std::thread::Builder::new()
            .name("hp-mcp-server".into())
            .spawn(move || {
                http::serve(handler, listener, port, token, stop_flag);
            })
            .map_err(|e| format!("创建 MCP 线程失败：{e}"))?;

        *self.lock_running() = Some(Running {
            port,
            allow_write: cfg.allow_write,
            shutdown,
        });
        Ok(port)
    }
}

impl Default for McpRuntime {
    fn default() -> Self {
        Self::new()
    }
}

/// 按当前设置项重新应用服务状态（设置项 `mcp.*` 变更、应用启动时各调一次）。
pub(crate) fn reload(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.mcp.apply(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 三项设置全缺省 → 服务**关闭**。
    ///
    /// 这是安全边界的第一道：任何读取失败、任何没配过的机器，都不能意外开门。
    #[test]
    fn defaults_to_disabled() {
        let cfg = parse_config(None, None, None);
        assert_eq!(cfg, ServerConfig::default());
        assert!(!cfg.enabled, "缺省必须关闭");
        assert!(!cfg.allow_write, "缺省不得允许写操作");
        assert_eq!(cfg.port, DEFAULT_PORT);
    }

    /// 开关只认 `"true"`（`app_settings` 是 TEXT 表，编码由桥接层决定）。
    #[test]
    fn booleans_require_the_literal_true() {
        assert!(parse_config(Some("true"), None, None).enabled);
        assert!(
            parse_config(Some(" true "), None, None).enabled,
            "两侧空白应忽略"
        );
        for value in ["false", "1", "TRUE", "yes", ""] {
            assert!(
                !parse_config(Some(value), None, None).enabled,
                "{value:?} 不应被当成 true"
            );
        }
        assert!(parse_config(None, None, Some("true")).allow_write);
    }

    /// 端口越界 / 非数字 / 特权端口一律回落缺省值，而不是把服务起在奇怪端口上。
    #[test]
    fn invalid_ports_fall_back_to_default() {
        assert_eq!(parse_config(None, Some("60000"), None).port, 60000);
        assert_eq!(parse_config(None, Some("1024"), None).port, 1024, "下界含");
        assert_eq!(
            parse_config(None, Some("65535"), None).port,
            65535,
            "上界含"
        );
        for value in ["1023", "65536", "0", "-1", "abc", "", "8080.5"] {
            assert_eq!(
                parse_config(None, Some(value), None).port,
                DEFAULT_PORT,
                "{value:?} 应回落缺省端口"
            );
        }
    }

    /// 三项设置互相独立：打开写操作不会顺手把服务也打开。
    #[test]
    fn settings_are_independent() {
        let cfg = parse_config(Some("false"), Some("58000"), Some("true"));
        assert!(!cfg.enabled, "写操作开关不得打开服务");
        assert_eq!(cfg.port, 58000);
        assert!(cfg.allow_write);
    }

    /// 生命周期：未启动时状态为空，stop 幂等（连调两次不 panic、不改变状态）。
    #[test]
    fn runtime_starts_stopped_and_stop_is_idempotent() {
        let runtime = McpRuntime::new();
        assert_eq!(runtime.status(), None, "新建时不应在运行");
        runtime.stop();
        runtime.stop();
        assert_eq!(runtime.status(), None);
    }
}
