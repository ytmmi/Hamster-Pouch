/**
 * 单个控件节点的渲染（`docs/spec/control-standard.md` 第 8 节）。
 *
 * 职责：
 * 1. 求值 `visible` / `visible_when`（谓词为假则**不渲染**）；
 * 2. 解析文字（`text_key` 优先走 i18n，其次控件自带的 `text`）；
 * 3. 递归渲染子节点，并给**每个节点**包一层错误边界：单节点失败只降级该节点为
 *    `empty('error')`，不影响同面板其余节点。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

import { type ControlNode } from "@hamster-pouch/config";
import { COLORS } from "@hamster-pouch/ui";

import { evalPredicate, makeControlDataSnapshot } from "./controlData";
import { CONTROL_RENDER_MAP } from "./ControlRenderer";
import type { ControlRenderContext } from "./controlTypes";

/** 单节点渲染失败时的降级视图。 */
function ControlErrorView({ reason }: { reason: string }): JSX.Element {
  return (
    <div
      className="hp-control-error"
      title={reason}
      style={{
        border: `1px solid ${COLORS.light.danger}`,
        borderRadius: 4,
        padding: 4,
        fontSize: 11,
        color: COLORS.light.danger,
      }}
    >
      ⚠ {reason}
    </div>
  );
}

/** 节点级错误边界（class 组件：React 18 只有类组件能捕获渲染异常）。 */
class ControlNodeBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 诊断通道由宿主统一处理；这里只保留最小信息，避免控件把堆栈渲染进界面。
    void info;
    void error;
  }

  render(): ReactNode {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}

/** 解析节点文字：`text_key` 优先，其次控件自带的 `text`。 */
function resolveText(node: ControlNode, ctx: ControlRenderContext): string {
  if (typeof node.text_key === "string" && node.text_key.trim() !== "") {
    return ctx.tKey(node.text_key);
  }
  return typeof node.text === "string" ? node.text : "";
}

/** 节点是否应当显示（`visible` 与 `visible_when` 都满足才显示）。 */
export function isControlNodeVisible(node: ControlNode, ctx: ControlRenderContext): boolean {
  if (node.visible === false) return false;
  if (!node.visible_when) return true;
  return evalPredicate(node.visible_when, ctx.data ?? makeControlDataSnapshot({}));
}

/** 渲染一个控件节点及其子树。 */
export function ControlNodeView({
  node,
  ctx,
}: {
  node: ControlNode;
  ctx: ControlRenderContext;
}): JSX.Element | null {
  if (!isControlNodeVisible(node, ctx)) return null;

  const component = CONTROL_RENDER_MAP[node.kind];
  const children = node.children
    ? node.children.map((child) => <ControlNodeView key={child.id} node={child} ctx={ctx} />)
    : null;
  const data = node.bind ? ctx.data.get(node.bind) : undefined;

  return (
    <ControlNodeBoundary fallback={<ControlErrorView reason={ctx.t("control.error")} />}>
      {component({
        node,
        data,
        theme: ctx.theme,
        text: resolveText(node, ctx),
        children,
        ctx,
      })}
    </ControlNodeBoundary>
  );
}

/** 渲染整份面板 schema（面板容器调用；根节点失败时整面板降级）。 */
export function ControlSchemaView({
  root,
  ctx,
}: {
  root: ControlNode;
  ctx: ControlRenderContext;
}): JSX.Element {
  return (
    <ControlNodeBoundary fallback={<ControlErrorView reason={ctx.t("control.error")} />}>
      <ControlNodeView node={root} ctx={ctx} />
    </ControlNodeBoundary>
  );
}
