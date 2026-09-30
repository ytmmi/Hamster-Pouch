/**
 * 长任务浮窗的宿主接线：把最新的 status / refresh / t 绑给模块级 store，并启动一次事件订阅。
 *
 * 进度本身不进 context（`taskStore.ts` 已说明原因）；本模块只声明"宿主渲染后绑定最新
 * 动作"与"启动订阅各一次"这两条生命周期规则。
 */

import { useEffect } from "react";

import type { Translate } from "../i18n";
import type { StatusType } from "../shared/types";
import { bindTaskActions, startTaskEvents } from "./taskStore";

/** 绑定长任务动作并提供订阅。 */
export function useTaskWiring(input: {
  status: (message: string, type?: StatusType) => void;
  refresh: () => void;
  t: Translate;
}): void {
  const { status, refresh, t } = input;

  // 长任务（扫描/卸载）事件：模块级 store，进度不进 context（否则每次进度都会重渲染所有面板）
  useEffect(() => {
    bindTaskActions({ status, refresh, t });
  }, [status, refresh, t]);

  useEffect(() => startTaskEvents(), []);
}
