/**
 * 蓝图节点添加面板（编辑器调色板，RFC 0007 决策 7）。
 *
 * 一个域：列出可新增的节点类型，点击即在当前层落一个新节点。
 * 类型清单与顺序就是画布上可搭出的节点种类（显示名走 `blueprintLabels` 的本地化层）。
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
