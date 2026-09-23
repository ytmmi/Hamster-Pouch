/**
 * 控件渲染的宿主上下文与状态（`docs/spec/control-standard.md` 第 8 节）。
 *
 * 渲染器是**纯函数式**的：`(schema, 数据快照, 上下文) → React 元素`；
 * 不读全局状态、不直连命令——事件与数据都经这里的回调交给宿主。
 */

import type { ControlEvent } from "@hamster-pouch/config";
import type { ThemeName } from "@hamster-pouch/ui";

import type { TranslationKey } from "../../i18n";
import type { ControlDataSnapshot } from "./controlData";

/** 控件状态键（`kind:name` 或 `"local"`），宿主可据此记住控件当前值。 */
export type ControlStateKey = string;

/** 宿主注入的控件渲染上下文。 */
export interface ControlRenderContext {
  /** 当前主题（浅色/深色）。 */
  theme: ThemeName;
  /** 当前语言下的翻译函数（宿主保证 `text_key` 走 i18n，D27）。 */
  t: (key: TranslationKey) => string;
  /** 按**字符串键**取翻译（插件声明的 `text_key` 不在宿主字典的联合类型内）。 */
  tKey: (key: string) => string;
  /** 数据快照（受控查询结果）。 */
  data: ControlDataSnapshot;
  /** 事件回传：宿主据此前置校验后转发给插件命令并上报蓝图事件源。 */
  emit: (
    controlId: string,
    event: ControlEvent,
    extras?: { value?: string | number | boolean; target?: string },
  ) => void;
  /** 读取控件当前值（缺省回落到绑定数据）。 */
  getState: (key: ControlStateKey) => unknown;
  /** 写入控件当前值。 */
  setState: (key: ControlStateKey, value: unknown) => void;
}
