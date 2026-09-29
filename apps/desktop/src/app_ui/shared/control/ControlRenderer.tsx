/**
 * 控件渲染映射表：`kind` → 受信 React 组件（`docs/spec/control-standard.md` 第 8 节）。
 *
 * **受控渲染的核心边界**：插件只给 schema 与数据，宿主在这里把每种 `kind` 映射到
 * 自己实现的组件。因此：
 * - 缺一个 `kind` 的映射即类型错误（`Record<ControlKind, …>`），由 `pnpm check:controls` 断言；
 * - 外观只取设计 token（`controlTokens.ts`），不写死像素、不引入自定义配色；
 * - 组件不读全局状态、不直连命令：事件一律通过 `props.emit` 回传宿主。
 *
 * 文件职责边界：本文件只放**组件实现与映射表**（一个功能域）；求值/错误边界在
 * `ControlNodeView.tsx`，面板级入口在 `ControlPanelView.tsx`，数据在 `controlData.ts`，
 * 外观映射在 `controlTokens.ts`。接近 1000 行时必须按"框架无关 vs 依赖 React"再拆，
 * 不得靠内部嵌套规避。
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import {
  CONTROL_GAP_VALUES,
  controlSpec,
  isControlKind,
  type ControlEvent,
  type ControlKind,
  type ControlNode,
} from "@hamster-pouch/config";
import { COLORS, RADIUS, SPACE, type ThemeName } from "@hamster-pouch/ui";

import {
  booleanOf,
  numberOf,
  rowsOf,
  stringOf,
  type ControlDataRow,
  type ControlQueryResult,
} from "./controlData";
import { SwitchToggle } from "../SwitchToggle";
import {
  alignToken,
  baseTextStyle,
  boxStyle,
  buttonVariantStyle,
  gapToken,
  textVariantStyle,
  variantColor,
} from "./controlTokens";
import type { ControlRenderContext } from "./controlTypes";

/** 一个控件组件收到的**数据 props**：与 React 状态无关，全部由宿主推导。 */
export interface ControlRenderProps {
  node: ControlNode;
  /** 该节点的绑定查询结果（未绑定数据时为 `undefined`）。 */
  data?: ControlQueryResult;
  theme: ThemeName;
  /** 已解析过的文字（宿主返回 i18n 结果；缺失时用控件自身兜底文案）。 */
  text: string;
  /** 已解析的子节点（容器类型才有）。 */
  children: ReactNode;
  ctx: ControlRenderContext;
}

/** 控件组件类型：纯展示 + 通过 `ctx.emit` 回传事件。 */
export type ControlComponent = (props: ControlRenderProps) => ReactNode;

// ============================== 布局容器 ==============================

const row: ControlComponent = ({ node, children }) => (
  <div
    className="hp-control-row"
    style={{
      display: "flex",
      flexDirection: "row",
      gap: gapToken(node.gap),
      alignItems: alignToken(node.align),
      minWidth: 0,
      minHeight: 0,
    }}
  >
    {children}
  </div>
);

const column: ControlComponent = ({ node, children }) => (
  <div
    className="hp-control-column"
    style={{
      display: "flex",
      flexDirection: "column",
      gap: gapToken(node.gap),
      alignItems: alignToken(node.align),
      minWidth: 0,
      minHeight: 0,
    }}
  >
    {children}
  </div>
);

const panel: ControlComponent = ({ node, children, theme, text }) => {
  const palette = COLORS[theme];
  const boxed = booleanOf(node.bordered, true);
  return (
    <div
      className="hp-control-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: SPACE.sm,
        ...(boxed ? boxStyle(theme) : {}),
        background: boxed ? palette.panel : "transparent",
      }}
    >
      {text ? (
        <div style={{ ...baseTextStyle(theme), color: palette.textDim, fontSize: 11 }}>{text}</div>
      ) : null}
      {children}
    </div>
  );
};

const section: ControlComponent = ({ node, children, theme, text, ctx }) => {
  const [collapsed, setCollapsed] = useState(booleanOf(node.collapsed, false));
  const palette = COLORS[theme];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.xs }}>
      <button
        type="button"
        className="hp-control-section-header"
        onClick={() => {
          const next = !collapsed;
          setCollapsed(next);
          ctx.emit(node.id, "toggle", { value: next });
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: SPACE.xs,
          background: "transparent",
          border: "none",
          color: palette.text,
          cursor: "pointer",
          fontSize: 12,
          padding: 0,
          textAlign: "left",
        }}
      >
        <span aria-hidden>{collapsed ? "▸" : "▾"}</span>
        <span>{text}</span>
      </button>
      {collapsed ? null : children}
    </div>
  );
};

const spacer: ControlComponent = () => <div className="hp-control-spacer" style={{ flex: 1 }} />;

// ============================== 展示 ==============================

const textControl: ControlComponent = ({ node, theme, text }) => (
  <span className="hp-control-text" style={textVariantStyle(node.variant, theme)}>
    {text}
  </span>
);

const icon: ControlComponent = ({ node, theme }) => (
  <span
    className="hp-control-icon"
    aria-label={stringOf(node.icon)}
    style={{ color: COLORS[theme].textDim, fontSize: 14 }}
  >
    {stringOf(node.icon)}
  </span>
);

const image: ControlComponent = ({ node, theme, data, ctx }) => {
  const row = rowsOf(data)[0];
  const src = row?.image;
  if (!src) {
    return (
      <span style={{ color: COLORS[theme].textDim, fontSize: 11 }}>{ctx.t("control.empty")}</span>
    );
  }
  return (
    <img
      className="hp-control-image"
      src={src}
      alt={row?.text ?? ""}
      onClick={() => ctx.emit(node.id, "click")}
      style={{
        objectFit: node.fit === "cover" ? "cover" : "contain",
        maxWidth: "100%",
        borderRadius: RADIUS.sm,
      }}
    />
  );
};

const progress: ControlComponent = ({ node, theme, data }) => {
  const max = numberOf(node.max, 1);
  const raw = typeof data?.value === "number" ? data.value : 0;
  const ratio = max > 0 ? Math.min(1, Math.max(0, raw / max)) : 0;
  const palette = COLORS[theme];
  return (
    <div
      className="hp-control-progress"
      role="progressbar"
      aria-valuenow={raw}
      aria-valuemin={0}
      aria-valuemax={max}
      style={{
        height: 6,
        background: palette.border,
        borderRadius: RADIUS.sm,
        overflow: "hidden",
      }}
    >
      <div style={{ width: `${ratio * 100}%`, height: "100%", background: palette.accent }} />
    </div>
  );
};

const keyValue: ControlComponent = ({ data, theme, ctx }) => {
  const entries = data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <span style={{ color: COLORS[theme].textDim, fontSize: 11 }}>{ctx.t("control.boundEmpty")}</span>
    );
  }
  return (
    <dl
      className="hp-control-keyvalue"
      style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: `${SPACE.xs}px ${SPACE.md}px`, margin: 0 }}
    >
      {entries.map((entry) => (
        <div key={entry.key} style={{ display: "contents" }}>
          <dt style={{ color: COLORS[theme].textDim, fontSize: 11 }}>{entry.key}</dt>
          <dd style={{ margin: 0, ...baseTextStyle(theme) }}>{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
};

// ============================== 输入 ==============================

const button: ControlComponent = ({ node, theme, text, ctx }) => {
  const style = buttonVariantStyle(node.variant, theme);
  return (
    <button
      type="button"
      className="hp-control-button"
      onClick={() => ctx.emit(node.id, "click")}
      onDoubleClick={() => ctx.emit(node.id, "double_click")}
      style={{
        background: style.background,
        color: style.color,
        border: `1px solid ${style.border}`,
        borderRadius: RADIUS.md,
        padding: `${SPACE.xs}px ${SPACE.md}px`,
        cursor: "pointer",
        fontSize: 12,
      }}
    >
      {text}
    </button>
  );
};

/**
 * `switch` 控件：胶囊 + 圆形滑块（与「全部设置」的开关**同一组件**，形态只有一份）。
 *
 * 契约不变：`data.value` 是布尔，点击回传 `value_change`（`docs/spec/control-standard.md`
 * 第 5 节的事件表）；形态与取色从这里的实现搬到了 `shared/SwitchToggle.tsx`。
 */
const switchControl: ControlComponent = ({ node, theme, data, ctx }) => {
  const value = data?.value === undefined ? false : booleanOf(data.value, false);
  return (
    <SwitchToggle
      checked={value}
      theme={theme}
      onChange={(next) => ctx.emit(node.id, "value_change", { value: next })}
    />
  );
};

const textInput: ControlComponent = ({ node, theme, data, ctx }) => {
  const palette = COLORS[theme];
  const [value, setValue] = useState(stringOf(data?.value));
  useEffect(() => {
    setValue(stringOf(data?.value));
  }, [data?.value]);
  const placeholder = node.placeholder_key ? ctx.tKey(stringOf(node.placeholder_key)) : undefined;
  const common = {
    className: "hp-control-textinput",
    value,
    placeholder,
    onChange: (e: { target: { value: string } }) => {
      setValue(e.target.value);
      ctx.emit(node.id, "value_change", { value: e.target.value });
    },
    onBlur: () => ctx.emit(node.id, "submit", { value }),
    style: {
      background: palette.panel,
      color: palette.text,
      border: `1px solid ${palette.border}`,
      borderRadius: RADIUS.sm,
      padding: `${SPACE.xs}px ${SPACE.sm}px`,
      fontSize: 12,
      resize: "none" as const,
    },
  };
  return booleanOf(node.multiline, false) ? (
    <textarea rows={3} {...common} />
  ) : (
    <input type="text" {...common} />
  );
};

const numberInput: ControlComponent = ({ node, theme, data, ctx }) => {
  const palette = COLORS[theme];
  const value = typeof data?.value === "number" ? data.value : numberOf(node.min, 0);
  return (
    <input
      type="number"
      className="hp-control-numberinput"
      value={value}
      min={typeof node.min === "number" ? node.min : undefined}
      max={typeof node.max === "number" ? node.max : undefined}
      step={typeof node.step === "number" ? node.step : undefined}
      onChange={(e) => ctx.emit(node.id, "value_change", { value: e.target.valueAsNumber })}
      style={{
        background: palette.panel,
        color: palette.text,
        border: `1px solid ${palette.border}`,
        borderRadius: RADIUS.sm,
        padding: `${SPACE.xs}px ${SPACE.sm}px`,
        fontSize: 12,
        width: 72,
      }}
    />
  );
};

const select: ControlComponent = ({ node, theme, data, ctx }) => {
  const palette = COLORS[theme];
  const options = rowsOf(data);
  if (options.length === 0) {
    return (
      <select disabled className="hp-control-select">
        <option>{ctx.t("control.noOptions")}</option>
      </select>
    );
  }
  return (
    <select
      className="hp-control-select"
      value={String(data?.value ?? "")}
      onChange={(e) => ctx.emit(node.id, "value_change", { value: e.target.value })}
      style={{
        background: palette.panel,
        color: palette.text,
        border: `1px solid ${palette.border}`,
        borderRadius: RADIUS.sm,
        padding: `${SPACE.xs}px ${SPACE.sm}px`,
        fontSize: 12,
      }}
    >
      <option value="">{ctx.t("control.selectPlaceholder")}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.text ?? option.id}
        </option>
      ))}
    </select>
  );
};

const slider: ControlComponent = ({ node, data, ctx }) => {
  const min = numberOf(node.min, 0);
  const max = numberOf(node.max, 1);
  const step = numberOf(node.step, 0.01);
  const value = typeof data?.value === "number" ? data.value : min;
  return (
    <input
      type="range"
      className="hp-control-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => ctx.emit(node.id, "value_change", { value: e.target.valueAsNumber })}
    />
  );
};

/**
 * `checkbox` 控件：布尔值。
 *
 * **渲染形态与 `switch` 相同**（都走 `shared/SwitchToggle.tsx` 的胶囊开关）：
 * 宿主只有一种"勾选框"外观（用户口径：所有勾选框都是胶囊按钮）。两种 `kind` 的区别只在
 * 契约语义，不在长相——宿主不再为它维护第二套外观。
 * 契约不变：`data.value` 是布尔，点击回传 `value_change`。
 */
const checkbox: ControlComponent = ({ node, theme, data, ctx }) => (
  <SwitchToggle
    checked={data?.value === undefined ? false : booleanOf(data.value, false)}
    theme={theme}
    onChange={(next) => ctx.emit(node.id, "value_change", { value: next })}
  />
);

// ============================== 集合 ==============================

/** 集合类共用的行渲染（列表/树/缩略图网格共享选中与事件语义）。 */
function CollectionRow({
  node,
  row,
  theme,
  ctx,
  mode,
}: {
  node: ControlNode;
  row: ControlDataRow;
  theme: ThemeName;
  ctx: ControlRenderContext;
  mode: "list" | "tree" | "grid";
}): JSX.Element {
  const palette = COLORS[theme];
  const label = itemLabel(node, row);
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: SPACE.sm,
    padding: `${SPACE.xs}px ${SPACE.sm}px`,
    borderRadius: RADIUS.sm,
    cursor: "pointer",
    background: row.selected ? palette.bg : "transparent",
    color: palette.text,
    fontSize: 12,
  };
  return (
    <div
      role="option"
      aria-selected={row.selected ?? false}
      onClick={() => {
        ctx.emit(node.id, "click", { target: row.id });
        ctx.emit(node.id, "selection_change", { target: row.id });
      }}
      onDoubleClick={() => ctx.emit(node.id, "double_click", { target: row.id })}
      style={style}
    >
      {mode === "grid" && row.image ? (
        <img
          src={row.image}
          alt={label}
          style={{ width: 40, height: 40, objectFit: "cover", borderRadius: RADIUS.sm }}
        />
      ) : null}
      {label ? <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span> : null}
    </div>
  );
}

/** 集合项显示内容（`item_text`：none / name / hex）。 */
function itemLabel(node: ControlNode, row: ControlDataRow): string {
  switch (node.item_text) {
    case "none":
      return "";
    case "hex":
      return row.hex ?? row.text ?? "";
    case "name":
    default:
      return row.text ?? row.id;
  }
}

const list: ControlComponent = ({ node, data, theme, ctx }) => {
  const rows = rowsOf(data);
  if (rows.length === 0) {
    return <span style={{ color: COLORS[theme].textDim, fontSize: 11 }}>{ctx.t("control.empty")}</span>;
  }
  return (
    <div className="hp-control-list" role="listbox" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {rows.map((row) => (
        <CollectionRow key={row.id} node={node} row={row} theme={theme} ctx={ctx} mode="list" />
      ))}
    </div>
  );
};

const tree: ControlComponent = ({ node, data, theme, ctx }) => {
  const rows = rowsOf(data);
  if (rows.length === 0) {
    return <span style={{ color: COLORS[theme].textDim, fontSize: 11 }}>{ctx.t("control.empty")}</span>;
  }
  return (
    <div className="hp-control-tree" role="tree" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {rows.map((row) => (
        <div key={row.id} style={{ paddingLeft: SPACE.sm }}>
          <CollectionRow node={node} row={row} theme={theme} ctx={ctx} mode="tree" />
        </div>
      ))}
    </div>
  );
};

const table: ControlComponent = ({ node, data, theme, ctx }) => {
  const columns = Array.isArray(node.columns) ? (node.columns as string[]) : [];
  const rows = rowsOf(data);
  const palette = COLORS[theme];
  if (columns.length === 0 || rows.length === 0) {
    return <span style={{ color: palette.textDim, fontSize: 11 }}>{ctx.t("control.empty")}</span>;
  }
  return (
    <table
      className="hp-control-table"
      style={{ borderCollapse: "collapse", fontSize: 11, width: "100%" }}
    >
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column}
              style={{
                textAlign: "left",
                color: palette.textDim,
                borderBottom: `1px solid ${palette.border}`,
                padding: SPACE.xs,
                fontWeight: 500,
              }}
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            onClick={() => {
              ctx.emit(node.id, "click", { target: row.id });
              ctx.emit(node.id, "selection_change", { target: row.id });
            }}
            onDoubleClick={() => ctx.emit(node.id, "double_click", { target: row.id })}
            style={{ background: row.selected ? palette.bg : "transparent", cursor: "pointer" }}
          >
            {columns.map((column) => (
              <td key={column} style={{ padding: SPACE.xs, color: palette.text }}>
                {String(row.cells?.[column] ?? "")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const tagChain: ControlComponent = ({ data, theme, ctx }) => {
  const rows = rowsOf(data);
  const palette = COLORS[theme];
  if (rows.length === 0) {
    return <span style={{ color: palette.textDim, fontSize: 11 }}>{ctx.t("control.boundEmpty")}</span>;
  }
  return (
    <div className="hp-control-tagchain" style={{ display: "flex", flexWrap: "wrap", gap: SPACE.xs }}>
      {rows.map((row) => (
        <span
          key={row.id}
          style={{
            border: `1px solid ${palette.border}`,
            borderRadius: RADIUS.sm,
            padding: `0 ${SPACE.sm}px`,
            fontSize: 11,
            color: palette.text,
          }}
        >
          {row.text ?? row.id}
        </span>
      ))}
    </div>
  );
};

const thumbGrid: ControlComponent = ({ node, data, theme, ctx }) => {
  const rows = rowsOf(data);
  if (rows.length === 0) {
    return <span style={{ color: COLORS[theme].textDim, fontSize: 11 }}>{ctx.t("control.empty")}</span>;
  }
  return (
    <div
      className="hp-control-thumbgrid"
      role="listbox"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))",
        gap: SPACE.sm,
      }}
    >
      {rows.map((row) => (
        <CollectionRow key={row.id} node={node} row={row} theme={theme} ctx={ctx} mode="grid" />
      ))}
    </div>
  );
};

// ============================== 反馈 ==============================

const status: ControlComponent = ({ node, theme, text, ctx }) => (
  <div
    className="hp-control-status"
    style={{
      display: "flex",
      alignItems: "center",
      gap: SPACE.sm,
      color: variantColor(node.variant, theme),
      fontSize: 11,
    }}
  >
    <span aria-hidden>●</span>
    <span>{text || ctx.t("control.value")}</span>
  </div>
);

const notice: ControlComponent = ({ node, theme, text, children }) => {
  const color = variantColor(node.variant, theme);
  return (
    <div
      className="hp-control-notice"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: SPACE.xs,
        borderLeft: `3px solid ${color}`,
        background: COLORS[theme].bg,
        borderRadius: RADIUS.sm,
        padding: SPACE.sm,
      }}
    >
      {text ? <div style={{ ...baseTextStyle(theme), color }}>{text}</div> : null}
      {children}
    </div>
  );
};

const empty: ControlComponent = ({ node, theme, text, ctx }) => {
  const variant = node.variant ?? "empty";
  const message =
    text ||
    (variant === "loading" ? ctx.t("control.loading") : variant === "error" ? ctx.t("control.error") : ctx.t("control.empty"));
  return (
    <div
      className="hp-control-empty"
      onClick={() => ctx.emit(node.id, "click")}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: SPACE.sm,
        color: variantColor(variant === "error" ? "error" : variant === "loading" ? "info" : "info", theme),
        fontSize: 11,
        padding: SPACE.md,
      }}
    >
      {message}
    </div>
  );
};

const divider: ControlComponent = ({ theme }) => (
  <hr
    className="hp-control-divider"
    style={{ border: "none", borderTop: `1px solid ${COLORS[theme].border}`, margin: `${SPACE.xs}px 0`, width: "100%" }}
  />
);

/** `kind` → 组件（`Record` 保证不漏：缺一种即类型错误）。 */
export const CONTROL_RENDER_MAP: Record<ControlKind, ControlComponent> = {
  row,
  column,
  panel,
  section,
  spacer,
  text: textControl,
  icon,
  image,
  progress,
  keyValue,
  button,
  switch: switchControl,
  textInput,
  numberInput,
  select,
  slider,
  checkbox,
  list,
  tree,
  table,
  tagChain,
  thumbGrid,
  status,
  notice,
  empty,
  divider,
};

/** 事件名 → 该 `kind` 是否支持（渲染前由解析层保证，这里只做开发期断言）。 */
export function emitControlEvent(
  node: ControlNode,
  event: ControlEvent,
  ctx: ControlRenderContext,
  extras?: { value?: string | number | boolean; target?: string },
): void {
  if (!isControlKind(node.kind)) return;
  if (!controlSpec(node.kind).events.includes(event)) return;
  ctx.emit(node.id, event, extras);
}

/** 供自检脚本使用的档位白名单（与文档第 4 节一致）。 */
export const CONTROL_GAP_TOKEN_VALUES = CONTROL_GAP_VALUES;
