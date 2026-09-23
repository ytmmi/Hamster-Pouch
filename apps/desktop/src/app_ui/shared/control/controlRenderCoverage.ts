/**
 * 宿主控件渲染的**覆盖清单**（`docs/spec/control-standard.md` 第 8 节）。
 *
 * 单独成文件的原因：`CONTROL_RENDER_MAP` 在 `.tsx` 里（含 JSX），开发期自检脚本
 * （纯 Node，不编译 TSX）无法导入；把"宿主已实现哪些 `kind`"这件事实抽成**纯数据**，
 * 自检脚本就能直接导入断言"白名单里的每一种都有渲染实现"（`pnpm check:controls`），
 * 也不会再出现"加了控件类型但宿主没实现渲染"的静默缺口。
 *
 * 维护规则：新增控件类型时**先**在这里登记，再在 `ControlRenderer.tsx` 里实现对应组件。
 */

import { CONTROL_KINDS, type ControlKind } from "@hamster-pouch/config";

/** 宿主已实现渲染的控件类型（必须与 `CONTROL_RENDER_MAP` 的键一致）。 */
export const CONTROL_RENDER_COVERAGE: readonly ControlKind[] = [
  // 布局容器
  "row",
  "column",
  "panel",
  "section",
  "spacer",
  // 展示
  "text",
  "icon",
  "image",
  "progress",
  "keyValue",
  // 输入
  "button",
  "switch",
  "textInput",
  "numberInput",
  "select",
  "slider",
  "checkbox",
  // 集合
  "list",
  "tree",
  "table",
  "tagChain",
  "thumbGrid",
  // 反馈
  "status",
  "notice",
  "empty",
  "divider",
];

/** 白名单里尚未实现渲染的控件类型（正常应为空）。 */
export const CONTROL_RENDER_MISSING: readonly ControlKind[] = CONTROL_KINDS.filter(
  (kind) => !CONTROL_RENDER_COVERAGE.includes(kind),
);
