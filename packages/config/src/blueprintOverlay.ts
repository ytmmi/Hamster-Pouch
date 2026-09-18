/**
 * 蓝图**浮层（overlay）**的外观档位与相对定位纯函数（RFC 0007 浮层节点 / D50 修订）。
 *
 * RFC 0007 明确这类纯函数落在 `packages/config`：`resolveOverlayPosition` /
 * `overlayOffsetToPx` / `anchorAxis` / `resolveOverlaySize`（由 `pnpm check:blueprint-nodes` 断言）。
 * 单独成文件的原因：它属**几何与取值域**问题，与图文档类型、分层工具、解析层校验无关，
 * 但被画布、属性面板、宿主执行器与自检脚本共同依赖。
 *
 * 计算口径（与控件标准一致）：锚点对齐 → 叠加偏移 → **越界贴边收拢**；
 * 偏移双模式：`|v| ≤ 1` 为参照系尺寸比例，`|v| > 1` 为像素（可为负）。
 */

/**
 * 浮层外观档位可选值（D50 修订 / D44）：只允许取**宿主设计 token 档位**，
 * 像素由 `packages/ui` 的设计 token 决定，蓝图不写死像素（保证浅色/深色一致）。
 */
export const TOKEN_LEVELS = ["none", "sm", "md", "lg"] as const;
export type TokenLevel = (typeof TOKEN_LEVELS)[number];

/**
 * 浮层锚点（3×3 井字，D50 修订）：浮层相对**界面（宿主内容区）**的对齐位置。
 *
 * `top_*` 表示浮层上边贴界面上边、`*_center` 表示水平居中、`bottom_*` 表示下边贴界面下边
 * …… 依此类推。默认 `center`（居中）。
 */
export const OVERLAY_ANCHORS = [
  "top_left",
  "top_center",
  "top_right",
  "middle_left",
  "center",
  "middle_right",
  "bottom_left",
  "bottom_center",
  "bottom_right",
] as const;
export type OverlayAnchor = (typeof OVERLAY_ANCHORS)[number];

/** 缺省锚点（未写 `anchor` 时按居中处理）。 */
export const DEFAULT_OVERLAY_ANCHOR: OverlayAnchor = "center";

/**
 * 浮层**默认最小尺寸**（px，2026-09 用户规定）：未指定尺寸时按此值，
 * 指定值小于它时按此值夹紧（不阻塞保存，宿主按最小尺寸显示）。
 */
export const OVERLAY_MIN_SIZE = { width: 240, height: 160 } as const;

/** 浮层尺寸上限（px）：超过即后端硬错误。 */
export const OVERLAY_MAX_SIZE = 10000;

/**
 * 解析浮层的实际框体尺寸：缺省取**默认最小尺寸**，不足最小值时夹紧到最小值。
 * （与 `height` 区分：`height` 是叠放高度参数 1–10，不是像素。）
 */
export function resolveOverlaySize(size?: {
  width?: number;
  height?: number;
}): { width: number; height: number } {
  const width = Number.isFinite(size?.width) ? (size!.width as number) : 0;
  const height = Number.isFinite(size?.height) ? (size!.height as number) : 0;
  return {
    width: Math.max(OVERLAY_MIN_SIZE.width, Math.round(width)),
    height: Math.max(OVERLAY_MIN_SIZE.height, Math.round(height)),
  };
}

/** 尺寸展示文案（如 `420×300`）。 */
export function overlaySizeLabel(size?: { width?: number; height?: number }): string {
  if (!size || (!Number.isFinite(size.width) && !Number.isFinite(size.height))) {
    return `${OVERLAY_MIN_SIZE.width}×${OVERLAY_MIN_SIZE.height}`;
  }
  const resolved = resolveOverlaySize(size);
  return `${resolved.width}×${resolved.height}`;
}

/** 锚点的水平/垂直分量：起 / 中 / 末。 */
export function anchorAxis(
  anchor: OverlayAnchor,
): { horizontal: "start" | "middle" | "end"; vertical: "start" | "middle" | "end" } {
  const horizontal = anchor.endsWith("_left")
    ? "start"
    : anchor.endsWith("_right")
      ? "end"
      : "middle";
  const vertical = anchor.startsWith("top_")
    ? "start"
    : anchor.startsWith("bottom_")
      ? "end"
      : "middle";
  return { horizontal, vertical };
}

/**
 * 偏移量 → 像素（**双模式**，用户规定的口径）：
 * - `|value| ≤ 1` → 视为**参照系尺寸的比例**（0.25 = 25% 宽/高，可为负）；
 * - `|value| > 1` → 视为**像素**（24 = 24px，可为负）。
 */
export function overlayOffsetToPx(value: number, span: number): number {
  return Math.abs(value) <= 1 ? value * span : value;
}

/** 偏移量的展示文案（比例显示为百分比，像素显示为 `Npx`）。 */
export function overlayOffsetLabel(value: number | undefined): string {
  if (value === undefined || value === 0) {
    return "0";
  }
  return Math.abs(value) <= 1
    ? `${Math.round(value * 100)}%`
    : `${Math.round(value)}px`;
}

/**
 * 按锚点 + 偏移算出浮层在界面内容区里的**左上角坐标**（px）。
 *
 * 计算顺序：先按锚点对齐（起=0、中=居中、末=贴另一侧），再叠加偏移
 * （比例偏移相对**界面内容区**的宽 / 高换算），最后**贴边收拢**——浮层不得溢出界面。
 * 浮层自身尺寸由宿主按内容与设计 token 决定，因此作为入参传入。
 */
export function resolveOverlayPosition(input: {
  anchor?: OverlayAnchor;
  offsetX?: number;
  offsetY?: number;
  /** 参照系（界面内容区）尺寸，px。 */
  area: { width: number; height: number };
  /** 浮层自身尺寸，px。 */
  size: { width: number; height: number };
}): { x: number; y: number } {
  const { area, size } = input;
  const { horizontal, vertical } = anchorAxis(input.anchor ?? DEFAULT_OVERLAY_ANCHOR);
  const baseX =
    horizontal === "start"
      ? 0
      : horizontal === "middle"
        ? (area.width - size.width) / 2
        : area.width - size.width;
  const baseY =
    vertical === "start"
      ? 0
      : vertical === "middle"
        ? (area.height - size.height) / 2
        : area.height - size.height;
  const x = baseX + overlayOffsetToPx(input.offsetX ?? 0, area.width);
  const y = baseY + overlayOffsetToPx(input.offsetY ?? 0, area.height);
  // 越界贴边收拢（控件标准：浮层不得溢出宿主窗口）。
  const maxX = Math.max(0, area.width - size.width);
  const maxY = Math.max(0, area.height - size.height);
  return {
    x: Math.round(Math.min(maxX, Math.max(0, x))),
    y: Math.round(Math.min(maxY, Math.max(0, y))),
  };
}
