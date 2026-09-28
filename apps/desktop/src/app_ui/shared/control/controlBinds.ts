/**
 * 控件 schema 的**取数需求收集**（`docs/spec/control-standard.md` 第 5 节）。
 *
 * `bind` 与 `visible_when` **都要数据**——谓词是拿查询结果求值的（`evalPredicate`），
 * 因此两者都要收；否则带 `visible_when` 的控件会永远按"结果不存在"求值。
 *
 * 按快照键 `"{kind}:{name}"` **去重**：同一查询被多个控件引用时只问一次
 * （宿主侧每次取数都要起一个插件进程，重复问是纯浪费）。
 *
 * 纯数据 + 纯函数，不含 React（与 `controlData` / `controlEvents` 同口径）。
 */

import type { ControlBind, ControlNode, ControlSchema } from "@hamster-pouch/config";

/** 一条取数请求项（与宿主 `plugin.panel_data` 的入参逐字一致）。 */
export interface ControlBindRequest {
  kind: ControlBind["kind"];
  name: string;
  /** 可选**标量**参数（规范不接受嵌套表达式）。 */
  args?: Record<string, string | number | boolean>;
}

/**
 * 快照键口径：`"{kind}:{name}"`。
 *
 * **必须与两处逐字一致**：前端 `makeControlDataSnapshot` 的查键，
 * 与宿主 `PanelQuerySpec::snapshot_key` 的构造。任何一处改了都会让插件的回填
 * **全部落空**（面板表现为永远空态），而且不会有任何编译错误——`check:controls`
 * 对此有断言。
 */
export function controlBindKey(bind: { kind: string; name: string }): string {
  return `${bind.kind}:${bind.name}`;
}

/** 收集 schema 里全部取数需求（`bind` + `visible_when`），按快照键去重并保持出现顺序。 */
export function collectControlBinds(schema: ControlSchema): ControlBindRequest[] {
  const out: ControlBindRequest[] = [];
  const seen = new Set<string>();

  const add = (bind: { kind: ControlBind["kind"]; name: string; args?: ControlBind["args"] }): void => {
    const key = controlBindKey(bind);
    if (seen.has(key)) return;
    seen.add(key);
    const request: ControlBindRequest = { kind: bind.kind, name: bind.name };
    if (bind.args) request.args = bind.args;
    out.push(request);
  };

  const walk = (node: ControlNode): void => {
    if (node.bind) add(node.bind);
    if (node.visible_when) add({ kind: node.visible_when.kind, name: node.visible_when.name });
    for (const child of node.children ?? []) walk(child);
  };

  walk(schema.root);
  return out;
}
