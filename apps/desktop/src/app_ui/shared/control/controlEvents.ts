/**
 * 控件 schema 的**事件映射**（`docs/spec/control-standard.md` 第 6 节）。
 *
 * `on` 是「事件名 → 插件声明的事件 id」的映射。宿主在回传前**必须**先把事件名解析成
 * 事件 id：插件侧方法名是 `plugin.{pluginId}.{eventId}`，**事件 id 由方法名承载**，
 * 不在回传载荷里（载荷与规范第 6 节逐字一致）。
 *
 * 纯数据 + 纯函数，不含 React（与 `controlData` 同口径）。
 */

import type { ControlEvent, ControlNode, ControlSchema } from "@hamster-pouch/config";

/** 控件 id → 该控件声明的事件映射。 */
export type ControlEventMap = Map<string, Partial<Record<ControlEvent, string>>>;

/** 遍历控件树（容器 + 叶子）收集每个控件的事件映射。 */
export function collectControlEventMap(schema: ControlSchema): ControlEventMap {
  const map: ControlEventMap = new Map();
  const walk = (node: ControlNode): void => {
    if (node.on) map.set(node.id, node.on);
    for (const child of node.children ?? []) walk(child);
  };
  walk(schema.root);
  return map;
}

/**
 * 解析某控件某事件对应的事件 id。
 *
 * 返回 `undefined` = 该事件**未声明在 `on` 里**，按规范第 6 节「不产生任何回传
 * （宿主记录一次忽略事件）」处理——调用方不要把它当成失败。
 */
export function controlEventIdOf(
  map: ControlEventMap,
  controlId: string,
  event: ControlEvent,
): string | undefined {
  return map.get(controlId)?.[event];
}
