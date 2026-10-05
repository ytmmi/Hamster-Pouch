/**
 * `@tauri-apps/api/core` 的桩：转发到 `tauri-core.ts` 的 `invoke` / `convertFileSrc`。
 *
 * 生产代码里 `@tauri-apps/api/core` 同时导出这两者（`api/*.ts` 用 `invoke`，
 * `mediaPreviewData.ts` / `thumbUrl.ts` 用 `convertFileSrc`），因此这里一并转发。
 */

export { invoke, convertFileSrc } from "./tauri-core";
