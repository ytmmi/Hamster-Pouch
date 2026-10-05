/**
 * 性能夹具的 Vite 配置：**别名把 Tauri 换成桩**，其余全部是生产代码。
 *
 * ## 为什么用别名而不是改生产代码
 *
 * `MediaPreviewPanel` 及其全部子模块原样参与构建——虚拟化、观察器、
 * `content-visibility`、`ratioCache` 重排都是真的。只有三个 Tauri 模块被替换：
 *
 * | 模块 | 桩 | 原因 |
 * | --- | --- | --- |
 * | `@tauri-apps/api/core` | `stubs/tauri-core-shim.ts` | `invoke` / `convertFileSrc` 需要后端 |
 * | `@tauri-apps/api/event` | `stubs/tauri-event.ts` | `listen` 需要后端事件总线 |
 * | `@tauri-apps/plugin-dialog` | `stubs/tauri-dialog.ts` | 原生对话框在夹具里不该弹 |
 *
 * **必须精确匹配到具体子路径**：`@tauri-apps/api/core` 与 `@tauri-apps/api/event`
 * 是两个不同入口，用 `^@tauri-apps/api$` 匹配不到（生产代码全部按子路径导入）。
 *
 * 用法：`node tools/perf/run.mjs`（内含起服务与驱动，见该文件）。
 */

import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const stub = (name: string) =>
  fileURLToPath(new URL(`./stubs/${name}`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: stub("tauri-core-shim.ts") },
      { find: /^@tauri-apps\/api\/event$/, replacement: stub("tauri-event.ts") },
      { find: /^@tauri-apps\/plugin-dialog$/, replacement: stub("tauri-dialog.ts") },
    ],
  },
  server: {
    // 夹具固定端口：驱动脚本要按 URL 连它。避开 dev 的 5173。
    port: 5199,
    strictPort: true,
  },
  // 夹具不进产物仓库；`dist/` 已被 .gitignore 覆盖（根规则）。
  build: { outDir: "dist" },
});
