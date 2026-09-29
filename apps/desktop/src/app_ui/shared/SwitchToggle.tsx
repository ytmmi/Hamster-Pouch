/**
 * 胶囊开关（宿主统一形态）。
 *
 * **为什么要有这个文件**：`switch` 这个语义在宿主里出现在两个界面——
 * ① 「全部设置」的设置项（`SettingsApp` 的 `SettingRow`）；
 * ② 面板内控件标准的 `switch` 控件（`ControlRenderer` 的 `switchControl`）。
 * 两者原先各写一份：设置项渲染成原生 `<input type="checkbox">`，控件标准渲染成胶囊按钮——
 * **同一个"开关"在同一个应用里长得不一样**。这里收敛成一处，两边都渲染这一个组件。
 *
 * 形态与取值来自控件标准既有的那个实现（32×16 胶囊 + 12×12 滑块），保证视觉零变化；
 * 几何写在样式表 `.hp-switch`（可被主题/全局样式统一调整），**颜色取自 `@hamster-pouch/ui`
 * 的 token 表**（`COLORS[theme]`）——宿主既有的胶囊开关用的就是这套 token，
 * 换成 CSS 变量会得到另一套近似但不相同的色值（`styles.css` 与 token 表是两套平行调色板）。
 *
 * 无障碍：`role="switch"` + `aria-checked`，`<button>` 天然可聚焦、空格/回车可切换。
 * 文案一律由调用方传入（`label` 是已翻译的字符串，组件内不内联文字，D27）。
 */

import { COLORS, type ThemeName } from "@hamster-pouch/ui";

export interface SwitchToggleProps {
  checked: boolean;
  /** 主题（token 表按主题取色）。 */
  theme: ThemeName;
  /** 变更为新值（调用方决定怎么落库/回传事件）。 */
  onChange: (next: boolean) => void;
  /**
   * 无障碍名（已翻译文案）。
   *
   * 可省略：控件标准的 `switch` 由面板/插件的控件 schema 决定有无标题，
   * 强制要求会改动它的既有契约。
   */
  label?: string;
  disabled?: boolean;
}

/** 胶囊开关。 */
export function SwitchToggle({
  checked,
  theme,
  onChange,
  label,
  disabled = false,
}: SwitchToggleProps): JSX.Element {
  const palette = COLORS[theme];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="hp-switch"
      onClick={() => onChange(!checked)}
      style={{
        border: `1px solid ${palette.border}`,
        background: checked ? palette.accent : palette.bg,
      }}
    >
      <span
        className="hp-switch-knob"
        style={{
          left: checked ? 17 : 1,
          background: palette.panel,
        }}
      />
    </button>
  );
}
