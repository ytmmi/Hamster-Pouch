/**
 * 媒体预览面板：**工具条下拉**（右上角的「视图」/「排序」）。
 *
 * 从 `MediaPreviewPanel.tsx` 拆出来的（单文件 1200 行硬上限，`pnpm check:line-count`）。
 *
 * 弹出层复用 `ContextMenu`（**portal 到 `document.body`**）：面板内自行绝对定位会被
 * dockview 动画期的 `transform` 俘获、再被 `.dv-groupview { overflow: hidden }` 裁掉
 * ——这是本项目已经踩过并登记过的缺陷（见 `ContextMenu.tsx` 头部注释与
 * `tools/check-panels.mjs` 的守护断言），所以这里不再引入第二种做法。
 */

import { useEffect, useRef, useState } from "react";

import { ContextMenu } from "../menu/ContextMenu";
import type { Translate, TranslationKey } from "../i18n";
import { shouldCloseDropdown } from "./mediaPreviewView";

/**
 * 下拉里的一项。
 *
 * - `ruleBefore`：该项**之前**画一条横线（把下拉分成两组——排序键 / 正序倒序）；
 * - `selected`：当前生效的项（以 `●` 标出）。排序下拉里**两项同时**为真
 *   （一个排序键 + 一个方向），因为它们是两个独立的取值。
 */
export interface DropdownOption {
  value: string;
  label: string;
  ruleBefore?: boolean;
  selected?: boolean;
}

/** 工具条下拉（按钮 + portal 弹出层）。 */
export function ToolbarDropdown({
  labelKey,
  currentLabel,
  options,
  disabled,
  disabledHint,
  t,
  onSelect,
}: {
  labelKey: TranslationKey;
  /** 按钮上显示的**当前取值**（视图名 / 排序键·方向）。 */
  currentLabel: string;
  options: DropdownOption[];
  disabled?: boolean;
  disabledHint?: string;
  t: Translate;
  onSelect: (value: string) => void;
}): JSX.Element {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!anchor) return;
    /**
     * 关闭条件：**在按钮与弹出层之外**按下。
     *
     * 两条排除缺一不可（这是修过的缺陷，别再退回去）：
     *
     * 1. **按钮自身**：打开它的那一次 `click` 之前已经发过 `mousedown`，若那时监听器
     *    已在（React 对离散事件会同步冲刷副作用），菜单会被自己关掉。
     * 2. **弹出层**：它由 `ContextMenu` **portal 到 `document.body`**，DOM 上**不在按钮里**。
     *    只排除按钮的话，按在选项上的 `mousedown` 会先把下拉关掉并卸载弹出层，
     *    选项的 `click` 根本不会发生 —— 表现为"下拉能开、选了什么都没反应"。
     *    用 `click` 代替 `mousedown` 也不可靠：`click` 在选项的 `onClick` **之后**才冒到
     *    document，顺序同样是错的。
     */
    const onDown = (e: MouseEvent) => {
      const target = e.target;
      const inButton = target instanceof Node && Boolean(btnRef.current?.contains(target));
      const inPopup = target instanceof Element && Boolean(target.closest(".context-menu"));
      if (!shouldCloseDropdown(inButton, inPopup)) return;
      setAnchor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAnchor(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="mp-dd"
        disabled={disabled}
        title={disabled ? disabledHint : t(labelKey)}
        aria-haspopup="menu"
        aria-expanded={anchor ? "true" : "false"}
        onClick={() => {
          const rect = btnRef.current?.getBoundingClientRect();
          if (!rect) return;
          // 锚在按钮**右下角**：右越界时 `ContextMenu` 会翻到该点的左侧，
          // 正好与按钮右边缘对齐（右上角的面板按钮必然贴着右边界）。
          setAnchor((prev) => (prev ? null : { x: rect.right, y: rect.bottom + 2 }));
        }}
      >
        <span className="mp-dd-label">{t(labelKey)}</span>
        <span className="mp-dd-value">{currentLabel}</span>
        <span className="mp-dd-caret">▾</span>
      </button>
      {anchor && (
        <ContextMenu x={anchor.x} y={anchor.y}>
          {options.map((option) => (
            <div key={option.value}>
              {option.ruleBefore && <div className="menu-sep" />}
              <button
                type="button"
                className={`menu-item ${option.selected ? "first" : ""}`}
                onClick={() => {
                  setAnchor(null);
                  onSelect(option.value);
                }}
              >
                {option.selected ? "● " : "　"}
                {option.label}
              </button>
            </div>
          ))}
        </ContextMenu>
      )}
    </>
  );
}
