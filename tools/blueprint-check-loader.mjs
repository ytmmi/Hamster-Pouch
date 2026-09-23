/**
 * Node ESM 解析钩子（仅用于开发期自检脚本）。
 *
 * 目的：让 `tools/blueprint-runtime-check.mjs` 能直接 import 产品 TS 源码。
 * 产品源码里有两类 Node 原生解析不了的写法：
 * - 目录导入（`./api` → `./api/index.ts`，Vite/TS 支持、Node ESM 不支持）；
 * - 宿主专用依赖（`@tauri-apps/*`，只能在 WebView 里跑）。
 *
 * 本钩子把目录导入补成 `/index.ts`，并把宿主依赖替换为无害的空模块 stub，
 * 不改动产品源码。
 */

const HOST_PREFIXES = ["@tauri-apps/"];

export async function resolve(specifier, context, nextResolve) {
  if (HOST_PREFIXES.some((p) => specifier.startsWith(p))) {
    return { url: "hp-host-stub:", shortCircuit: true, format: "module" };
  }
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    // 目录导入 / 无扩展名导入：按 TS 习惯依次补 `index.ts`、`.ts`、`.tsx`。
    for (const suffix of ["/index.ts", ".ts", ".tsx", "/index.tsx"]) {
      try {
        return await nextResolve(`${specifier}${suffix}`, context);
      } catch {
        /* 试下一个后缀 */
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === "hp-host-stub:") {
    // 宿主依赖 stub：所有导出都是 no-op（自检只驱动装载/升级链路）。
    return {
      format: "module",
      shortCircuit: true,
      source: `const noop = () => undefined;
      export default noop;
      export const invoke = async () => undefined;
      export const convertFileSrc = (p) => p;
      export const listen = async () => () => {};
      export const emit = async () => undefined;
      export const getCurrentWindow = () => ({ show: async () => {} });
      export const WebviewWindow = class {};
      // 原生对话框（@tauri-apps/plugin-dialog）：「添加媒体源」选取文件夹入口；自检里等同"用户取消"。
      export const open = async () => null;
      `,
    };
  }
  return nextLoad(url, context);
}
