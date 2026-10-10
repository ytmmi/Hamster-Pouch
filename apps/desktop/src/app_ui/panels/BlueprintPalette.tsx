/**
 * 蓝图节点添加面板（编辑器调色板，RFC 0007 决策 7）。
 *
 * 一个域：列出可新增的节点类型，点击即在当前层落一个新节点。
 * 类型清单与顺序就是画布上可搭出的节点种类（显示名走 `blueprintLabels` 的本地化层）。
 *
 * **所有类型都可随意创建**（用户口径 2026-10-10）：编辑器只规定**连接方式与层级**，
 * 不限制"能不能建"。因此这里**没有任何置灰**——缺结构父的节点照样能落下来，
 * 在画布上灰显「未接通」，由使用者拖线或在属性面板补上。
 *
 * 早前版本曾把**子类 / 标记**在"层内无可用父级"时置灰（连创建都拦住），那是把
 * "层级约束"误当成"创建许可"：层级约束管的是**连线与引用的合法性**，不是创建许可。
 *
 * 纯展示 + 回调：落点与引用推导在 `useBlueprintGraphEdits`（`blueprintNodeFactory`）。
 */

import type { BlueprintNodeType } from "@hamster-pouch/config";

import type { Translate } from "../i18n";
import { nodeTypeLabel } from "./blueprintLabels";

/** 可从调色板新增的节点类型（顺序即按钮顺序）。 */
const PALETTE_TYPES: readonly BlueprintNodeType[] = [
  "interface",
  "layout_block",
  "overlay",
  "control",
  "class",
  // 两条正交的细分轴（D102）：子类挂在类目下，标记与类目树平行。
  "subclass",
  "mark",
  "object",
  "group",
  "event",
  "condition",
  "action",
];

export interface BlueprintPaletteProps {
  onAdd: (type: BlueprintNodeType) => void;
  t: Translate;
}

export function BlueprintPalette({ onAdd, t }: BlueprintPaletteProps): JSX.Element {
  return (
    <div className="bp-palette">
      {PALETTE_TYPES.map((type) => (
        <button
          key={type}
          className="bp-palette-btn"
          onClick={() => onAdd(type)}
        >
          {nodeTypeLabel(type, t)}
        </button>
      ))}
    </div>
  );
}
