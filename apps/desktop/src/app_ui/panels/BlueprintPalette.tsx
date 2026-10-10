/**
 * 蓝图节点添加面板（编辑器调色板，RFC 0007 决策 7）。
 *
 * 一个域：列出可新增的节点类型，点击即在当前层落一个新节点。
 * 类型清单与顺序就是画布上可搭出的节点种类（显示名走 `blueprintLabels` 的本地化层）。
 *
 * **补充节点的挂载约束**（用户口径 2026-10-10）：**子类**必须挂在类目下、
 * **标记**必须挂在面板下——两者都是功能链路的**补充节点**（可以完全没有），
 * 但一旦要有就必须挂在它该挂的父级下。当前层里没有可用父级时，对应按钮**置灰**
 * 并给出原因，而不是让用户点出一个"无父的灰节点"。
 *
 * 纯展示 + 回调：落点与引用推导在 `useBlueprintGraphEdits`（`blueprintNodeFactory`）。
 */

import type { BlueprintGraph, BlueprintNodeType } from "@hamster-pouch/config";

import type { Translate, TranslationKey } from "../i18n";
import { nodeTypeLabel } from "./blueprintLabels";
import { mountParentTypeOf, unmountableTypes } from "./blueprintNodeFactory";

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
  /** 当前文档与层：用于判定"补充节点"是否有可挂载的父级。 */
  doc: BlueprintGraph;
  layerKey: string | null;
  t: Translate;
}

export function BlueprintPalette({
  onAdd,
  doc,
  layerKey,
  t,
}: BlueprintPaletteProps): JSX.Element {
  const blocked = unmountableTypes(doc, layerKey);
  return (
    <div className="bp-palette">
      {PALETTE_TYPES.map((type) => {
        const missingParent = blocked.has(type);
        const parentType = mountParentTypeOf(type);
        const title = missingParent
          ? t("blueprint.mountRequired", {
              type: nodeTypeLabel(type, t),
              parent: parentType
                ? t(`blueprint.type.${parentType}` as TranslationKey)
                : "",
            })
          : undefined;
        return (
          <button
            key={type}
            className="bp-palette-btn"
            disabled={missingParent}
            title={title}
            onClick={() => onAdd(type)}
          >
            {nodeTypeLabel(type, t)}
          </button>
        );
      })}
    </div>
  );
}
