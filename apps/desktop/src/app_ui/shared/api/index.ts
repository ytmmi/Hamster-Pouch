/**
 * app_ui API 层聚合入口 — 包装所有 Tauri invoke 调用，按域拆分后统一重导出。
 *
 * 命令名 snake_case；参数键 camelCase（Tauri v2 自动映射）。
 */

export * from "./repo";
export * from "./source";
export * from "./album";
export * from "./file";
export * from "./media";
export * from "./color";
export * from "./tag";
export * from "./rating";
export * from "./layout";
