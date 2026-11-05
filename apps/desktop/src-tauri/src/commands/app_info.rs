//! 「关于」页所需的**运行时事实**命令（D140）。
//!
//! 与设置项的分工：设置项是"用户可写的声明"（`ui.autoCheckUpdate` 走
//! `setting.get/_set`），而**版本号 / 构建时间 / 提交哈希 / 许可证**是构建时
//! 烙进二进制的事实，用户既不能写也不该写，因此不放进设置注册表，走这里。
//!
//! 为什么事实在 Rust 而不是前端常量：`tauri build` 打出来的包用的是
//! `apps/desktop/src-tauri/Cargo.toml` 的 `version`，前端 `package.json` 的版本
//! 与它没有强制同步关系；只有 `env!("CARGO_PKG_VERSION")` 才**必然**等于
//! 安装包自己的版本，这正是更新比较要用的那一个。
//!
//! 形状遵循 **D76**（`{ ok, data?, error? }`，全部**已包装**），见
//! `docs/spec/commands-events.md` §3.19。

use tauri::State;

use crate::AppState;
use crate::commands::shared::{ApiError, ApiResponse, api_err, api_ok};

/// 许可证标识（SPDX）：与仓库 `LICENSE` 一致（GPL-3.0-or-later）。
const LICENSE: &str = "GPL-3.0-or-later";

/// 允许 `app.openUrl` 打开的目标**唯一前缀**。
///
/// 只放 GitHub：这条命令的存在意义就是"把用户送到项目的 GitHub 页面"，
/// 把边界收成一个前缀常量，就不必担心拼出 `file://` 或带 `&` 的怪 URL。
const OPEN_URL_PREFIX: &str = "https://github.com/";

/// 「关于」页的事实区。
#[derive(serde::Serialize)]
pub(crate) struct AppInfoResult {
    /// 安装包版本（= `Cargo.toml` 的 `version`，形如 `0.1.0-Alpha`）。
    version: String,
    /// 构建时间（本地时间，形如 `2026/11/05 23:10:42`）；本地构建取不到时为空串。
    build_time: String,
    /// 构建时 HEAD 短哈希；本地构建取不到时为空串。
    commit: String,
    /// 许可证（SPDX 标识）。
    license: String,
    /// 项目仓库地址（更新检查与「去 GitHub 点赞」共用）。
    repo_url: String,
}

/// 构建期注入的字符串；未注入（旧构建产物 / 直接 cargo run）时给空串。
///
/// 用 `option_env!` 而不是 `env!`：缺了它整个 crate 编不过，而"构建时间未知"
/// 只是显示降级，不该让编译失败。
fn build_env(name: &str) -> String {
    match name {
        "HP_BUILD_TIME" => option_env!("HP_BUILD_TIME").unwrap_or("").to_string(),
        "HP_BUILD_COMMIT" => option_env!("HP_BUILD_COMMIT").unwrap_or("").to_string(),
        _ => String::new(),
    }
}

/// `app.info`：返回「关于」页展示的版本 / 构建时间 / 提交哈希 / 许可证 / 仓库地址。
#[tauri::command]
pub(crate) fn app_info(_state: State<AppState>) -> ApiResponse<AppInfoResult> {
    api_ok(AppInfoResult {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_time: build_env("HP_BUILD_TIME"),
        commit: build_env("HP_BUILD_COMMIT"),
        license: LICENSE.to_string(),
        repo_url: "https://github.com/ytmmi/Hamster-Pouch".to_string(),
    })
}

/// `app.openUrl`：用系统默认浏览器打开一个**GitHub** 链接。
///
/// 为什么必须有这条命令：WebView2 里 `window.open` 默认被拦（Tauri 未开
/// `dangerousUseHttpScheme`，也没有 shell 插件），"点击更新跳转 GitHub"在
/// 纯前端做不到。
///
/// 安全边界：只接受 `https://github.com/` 前缀，其余一律 `validation` 错误。
/// 这既是防注入（URL 会进 `cmd /C start`），也顺带保证这条命令不会变成
/// "打开任意本地文件"的通道。
#[tauri::command]
pub(crate) fn app_open_url(url: String) -> ApiResponse<()> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return api_err(ApiError::new("validation", "url 不能为空"));
    }
    if !trimmed.starts_with(OPEN_URL_PREFIX) {
        return api_err(ApiError::new(
            "validation",
            format!("只允许打开 {OPEN_URL_PREFIX} 开头的链接：{trimmed}"),
        ));
    }

    match open_in_browser(trimmed) {
        Ok(()) => api_ok(()),
        Err(message) => api_err(ApiError::new("io", message)),
    }
}

/// 用系统默认浏览器打开（Windows）。
///
/// 走 `cmd /C start "" <url>` 而不是 ShellExecuteW：后者要给 `windows` crate
/// 补 `Win32_UI_Shell` feature，而这里只需要"把 URL 交给默认浏览器"这一件事。
/// `start` 的第一个带引号参数会被当成窗口标题，所以先给一个空标题占位。
///
/// 命令经 `hp_media::hidden_command` 构造而不是裸 `std::process::Command::new`：
/// 桌面壳是 GUI 子系统，裸 spawn 会在 `cmd` 退出前闪一个黑色控制台窗口，
/// 且 `check:hidden-console` 明令白名单以外零裸 `Command::new`。
#[cfg(target_os = "windows")]
fn open_in_browser(url: &str) -> Result<(), String> {
    hp_media::hidden_command("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开浏览器：{e}"))
}

#[cfg(not(target_os = "windows"))]
fn open_in_browser(url: &str) -> Result<(), String> {
    hp_media::hidden_command("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开浏览器：{e}"))
}
