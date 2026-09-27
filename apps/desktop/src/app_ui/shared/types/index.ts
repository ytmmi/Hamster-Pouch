/**
 * app_ui 共享类型聚合入口 — 按域拆分后统一重导出。
 *
 * 规则：
 * - 命令参数键使用 camelCase（Tauri v2 自动映射）。
 * - 返回值 / 事件负载字段使用 snake_case（serde 默认序列化，无 rename_all）。
 */

export * from "./common";
export * from "./events";
export * from "./repo";
export * from "./source";
export * from "./album";
export * from "./file";
export * from "./media";
export * from "./color";
export * from "./tag";
export * from "./rating";
export * from "./layout";
export * from "./blueprint";
export * from "./plugin";
