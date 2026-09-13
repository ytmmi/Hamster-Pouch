/**
 * 共享基础类型。
 */

export type StatusType = "error" | "ok" | "info";

/** 状态栏消息回调。 */
export type StatusHandler = (message: string, type?: StatusType) => void;
