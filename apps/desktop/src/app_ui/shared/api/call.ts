/**
 * 命令调用的**唯一出口**（D204）。
 *
 * 前端此前在每个 API 模块里手抄同一段解包仪式：
 *
 * ```ts
 * return invoke<ApiResponse<BookMetaResult>>("book_meta", { repoId, fileId }).then(unwrapApi);
 * ```
 *
 * 25 个 API 文件共 163 处（`app_ui/shared/api/*` 141 + `test_ui/api/*` 22）。抄多次的代价不是字数，
 * 而是**契约靠记忆维持**：泛型里少写一层 `ApiResponse`、忘了 `.then(unwrapApi)`，
 * 拿到的就是信封本身——类型检查当场失真，`HpApiFailure` 的结构化 `code` 也不会抛出来。
 *
 * 现在只有这里知道「命令回的是信封、调用方要的是值」：[`invokeApi`] 把两者接起来，
 * 其余模块只写 `invokeApi<T>(command, args)`。`unwrapApi` 仍是解包的实现，
 * 但**调用点只剩本文件一处**（`tools/check-commands.mjs` 反向断言钉住）。
 */

import { invoke } from "@tauri-apps/api/core";

import { unwrapApi, type ApiResponse } from "./response";

/**
 * 调一条 D76 命令并解包：成功拿 `T`，失败抛带 `code` 的 [`HpApiFailure`]。
 *
 * `args` 省略时等价于「无参命令」——Tauri 的 `invoke` 对 `undefined` 与 `{}` 一视同仁，
 * 这里保持可选以免调用点写空对象。
 */
export function invokeApi<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<ApiResponse<T>>(command, args).then(unwrapApi);
}
