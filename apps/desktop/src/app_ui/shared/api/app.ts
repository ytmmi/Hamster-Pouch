/**
 * 「关于」页的桥接命令（D140）。
 *
 * **D76 迁移状态：已包装**（`app.*` 属契约 §3.19）。
 *
 * 只有两条：
 * - `app.info`：版本 / 构建时间 / 提交哈希 / 许可证 / 仓库地址（构建期事实）；
 * - `app.openUrl`：用系统浏览器打开 GitHub（WebView 里 `window.open` 不可用）。
 *
 * 更新**检查**本身就是一次普通 `fetch`（GitHub 公开 API），没有对应的命令：
 * 它不改任何状态，走 Rust 只是多一层无意义的 IPC。
 */

import { invoke } from "@tauri-apps/api/core";

import type { ApiResponse } from "./response";
import { unwrapApi } from "./response";
import type { AppInfo } from "../types/app";

/** app.info：读取构建期烙进二进制的版本事实。 */
export function appInfo(): Promise<AppInfo> {
  return invoke<ApiResponse<AppInfo>>("app_info").then(unwrapApi);
}

/** app.openUrl：用系统默认浏览器打开一个 GitHub 链接（后端只放行 github.com）。 */
export function appOpenUrl(url: string): Promise<void> {
  return invoke<ApiResponse<void>>("app_open_url", { url }).then(unwrapApi);
}
