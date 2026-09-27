/**
 * 面板级控件渲染入口（`docs/spec/control-standard.md` 第 2/7/8 节）。
 *
 * 宿主拿到插件面板的 schema 文本后，**先解析层校验、再业务级校验**，通过才渲染：
 * - 解析层失败（结构不对 / `kind` 越界）→ 渲染错误态（不把异常抛给面板容器）；
 * - 业务级硬错误 → 同样渲染错误态，并把错误交给 `onRejected` 记录事件（宿主广播 `plugin.error`）；
 * - 软告警 → 正常渲染，交给 `onWarnings` 提示。
 *
 * 这里**不做网络/命令调用**：查询与事件回传由调用方通过 `ctx` 注入，保持渲染器纯粹。
 */

import { useEffect, useMemo, type ReactNode } from "react";

import {
  CONTROL_API_VERSION,
  parseControlSchema,
  validateControlSchema,
  type ControlSchema,
  type ControlValidateCtx,
  type ControlValidateResult,
} from "@hamster-pouch/config";
import { COLORS, type ThemeName } from "@hamster-pouch/ui";

import { ControlSchemaView } from "./ControlNodeView";
import type { ControlRenderContext } from "./controlTypes";

/** 面板控件渲染的宿主入参。 */
export interface ControlPanelViewProps {
  /** 插件返回的 schema JSON 文本（运行时通道）。 */
  schemaJson: string | null;
  /** 校验上下文（面板 id + 插件声明的查询/事件）。 */
  validateCtx: ControlValidateCtx;
  /** 渲染上下文（主题/i18n/数据/事件/状态）。 */
  ctx: ControlRenderContext;
  /**
   * **业务级复算结果**（Rust `plugin.validateControl`，控件标准第 7 节）。
   *
   * 解析层（本文件）与业务级（宿主命令）是两道独立闸门：两者结论**合并**后才决定渲染，
   * 任一道报硬错误即渲染错误态。`null` / 缺省表示"尚未取到"，此时只按解析层判定。
   */
  serverResult?: ControlValidateResult | null;
  /** 硬错误（解析或校验失败）时的回调：宿主记录并广播 `plugin.error`。 */
  onRejected?: (errors: string[]) => void;
  /** 软告警回调（不阻塞渲染）。 */
  onWarnings?: (warnings: string[]) => void;
}

/** 合并两道闸门的结论（去重，保持各自顺序）。 */
function mergeUnique(...groups: readonly (readonly string[] | undefined)[]): string[] {
  const out: string[] = [];
  for (const group of groups) {
    for (const item of group ?? []) {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

/** 解析 + 校验（纯函数，便于自检脚本直接断言）。 */
export function inspectPanelSchema(
  schemaJson: string | null,
  validateCtx: ControlValidateCtx,
): { schema: ControlSchema | null; errors: string[]; warnings: string[] } {
  if (schemaJson === null || schemaJson.trim() === "") {
    return { schema: null, errors: ["插件未返回面板 schema"], warnings: [] };
  }
  let schema: ControlSchema;
  try {
    schema = parseControlSchema(schemaJson);
  } catch (e) {
    return { schema: null, errors: [(e as Error).message], warnings: [] };
  }
  const result: ControlValidateResult = validateControlSchema(schema, validateCtx);
  return { schema, errors: result.errors, warnings: result.warnings };
}

/** 控件面板渲染（宿主映射 schema → 受信组件集合）。 */
export function ControlPanelView({
  schemaJson,
  validateCtx,
  ctx,
  serverResult,
  onRejected,
  onWarnings,
}: ControlPanelViewProps): ReactNode {
  const inspected = useMemo(() => {
    const local = inspectPanelSchema(schemaJson, validateCtx);
    return {
      schema: local.schema,
      errors: mergeUnique(serverResult?.errors, local.errors),
      warnings: mergeUnique(local.warnings, serverResult?.warnings),
    };
  }, [schemaJson, validateCtx, serverResult]);

  // 回调一律放在 effect 里：渲染期调用回调会让宿主在 render 阶段 setState。
  useEffect(() => {
    if (inspected.errors.length > 0) onRejected?.(inspected.errors);
  }, [inspected, onRejected]);
  useEffect(() => {
    if (inspected.errors.length === 0 && inspected.warnings.length > 0) {
      onWarnings?.(inspected.warnings);
    }
  }, [inspected, onWarnings]);

  if (inspected.errors.length > 0) {
    // 错误态由宿主组件承担（不走控件渲染映射，避免"用一个控件渲染另一个控件的错误"）。
    return <ControlSchemaRejected theme={ctx.theme} errors={inspected.errors} />;
  }
  if (!inspected.schema) return null;
  return <ControlSchemaView root={inspected.schema.root} ctx={ctx} />;
}

/** 错误态视图（复用 empty 语义的观感，但不经控件映射）。 */
function ControlSchemaRejected({
  theme,
  errors,
}: {
  theme: ThemeName;
  errors: string[];
}): JSX.Element {
  const palette = COLORS[theme];
  return (
    <div
      className="hp-control-rejected"
      title={errors.join("\n")}
      style={{
        border: `1px solid ${palette.danger}`,
        borderRadius: 4,
        padding: 8,
        color: palette.danger,
        fontSize: 11,
      }}
    >
      ⚠ 控件 schema 被拒绝（{errors.length} 项）：{errors[0]}
    </div>
  );
}

/** 当前控件 schema 版本（供面板与自检脚本显示/断言）。 */
export const CURRENT_CONTROL_API_VERSION = CONTROL_API_VERSION;
