/**
 * 控件数据快照与谓词求值（`docs/spec/control-standard.md` 第 5 节）。
 *
 * 控件的数据**只能**来自宿主 API 的受控查询（`bind.kind` = `panel` / `selection`）：
 * 宿主把查询结果整理成 `ControlDataSnapshot` 交给渲染器，插件不接触仓库数据本身。
 * 纯数据 + 纯函数，不含 React。
 */

import type { ControlBind, ControlPredicate } from "@hamster-pouch/config";

/** 一行数据（集合类控件渲染用）。 */
export interface ControlDataRow {
  id: string;
  /** 主显示文本（`item_text = name`）。 */
  text?: string;
  /** 图像/缩略图句柄（宿主转换后的可显示地址，不是文件绝对路径）。 */
  image?: string;
  /** `item_text = hex` 时使用（调色板类）。 */
  hex?: string;
  /** 选中态。 */
  selected?: boolean;
  /** 表格列值（键为 `columns` 声明的列名）。 */
  cells?: Record<string, string | number | boolean>;
}

/** 一次查询的结果（标量 / 对象 / 行集合，与 manifest 的 `data_queries.returns` 对应）。 */
export interface ControlQueryResult {
  kind: "rows" | "object" | "scalar";
  rows?: ControlDataRow[];
  value?: string | number | boolean | null;
  /** `object` 形态的键值对（`keyValue` 控件渲染用）。 */
  entries?: { key: string; value: string }[];
}

/** 控件数据快照：`"<bind.kind>:<name>"` → 查询结果。 */
export interface ControlDataSnapshot {
  get(bind: ControlBind): ControlQueryResult | undefined;
}

/** 由普通对象构造快照（宿主侧接线用；键形如 `panel:colors`）。 */
export function makeControlDataSnapshot(
  results: Record<string, ControlQueryResult>,
): ControlDataSnapshot {
  return {
    get(bind) {
      return results[`${bind.kind}:${bind.name}`];
    },
  };
}

/** 谓词求值：`zero` / `empty` / `truthy` / `exists`。 */
export function evalPredicate(
  predicate: ControlPredicate,
  snapshot: ControlDataSnapshot,
): boolean {
  const result = snapshot.get({ kind: predicate.kind, name: predicate.name });
  switch (predicate.test) {
    case "exists":
      return result !== undefined;
    case "zero":
      return scalarOf(result) === 0;
    case "empty":
      return isEmptyResult(result);
    case "truthy":
    default:
      return Boolean(scalarOf(result)) || (result?.rows?.length ?? 0) > 0;
  }
}

/** 取标量值（标量结果直接取，行集合取行数）。 */
export function scalarOf(result: ControlQueryResult | undefined): number | string | boolean | null {
  if (!result) return null;
  if (result.kind === "rows") return result.rows?.length ?? 0;
  return result.value ?? null;
}

/** 结果是否为空。 */
export function isEmptyResult(result: ControlQueryResult | undefined): boolean {
  if (!result) return true;
  if (result.kind === "rows") return (result.rows?.length ?? 0) === 0;
  if (result.kind === "object") return (result.entries?.length ?? 0) === 0;
  return result.value === null || result.value === undefined || result.value === "";
}

/** 取行集合（非行集合返回空数组，调用方据此渲染空态）。 */
export function rowsOf(result: ControlQueryResult | undefined): ControlDataRow[] {
  return result?.rows ?? [];
}

/** 取数值（进度条/滑块/数值输入用）。 */
export function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 取字符串。 */
export function stringOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** 取布尔。 */
export function booleanOf(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}
