/**
 * 控件 schema：类型、解析层校验与事件载荷（`docs/spec/control-standard.md`）。
 *
 * - 取值域在 `controlKinds.ts`，**类型注册表**在 `controlRegistry.ts`（两者与 Rust 对齐）；
 * - 本文件承载结构类型、`parseControlSchema`（装载路径的解析层闸门）与
 *   `validateControlSchema`（与 Rust `ControlSchema::validate` 同口径的业务级校验）；
 * - 事件载荷由**宿主**统一构造：`buildControlEventPayload`。
 *
 * 校验分级见控件标准第 7 节：解析层拒绝渲染，业务级返回 `{ errors, warnings }`
 * （软告警只提示，不阻塞渲染）。
 */

import {
  CONTROL_API_VERSION,
  CONTROL_BIND_KINDS,
  CONTROL_EVENTS,
  CONTROL_NODE_SOFT_LIMIT,
  CONTROL_PREDICATE_TESTS,
  TABLE_COLUMN_MAX,
  type ControlEvent,
  type ControlKind,
} from "./controlKinds";
import { controlAllowsEvent, controlSpec, isControlKind } from "./controlRegistry";

/** 控件 schema 文档（一次 panel schema 查询的返回体）。 */
export interface ControlSchema {
  /** schema 的 API 版本；必须 `<= CONTROL_API_VERSION`。 */
  api_version: number;
  /** 面板 id；必须与请求的面板一致。 */
  panel_id: string;
  root: ControlNode;
}

/**
 * 控件节点。专属字段（按 `kind` 取注册表白名单）通过索引签名保留，
 * 渲染时按 `controlSpec(kind)` 读取，不做字段拆分。
 */
export interface ControlNode {
  /** 面板内唯一 id（`^[a-z][a-z0-9_]{0,63}$`）。 */
  id: string;
  kind: ControlKind;
  /** i18n 键（D27：文字必须走键，禁止内联系统文字）。 */
  text_key?: string;
  visible?: boolean;
  enabled?: boolean;
  /** 数据绑定（受控查询；不允许内联大块数据）。 */
  bind?: ControlBind;
  /** 显隐谓词（第一版仅四个固定谓词）。 */
  visible_when?: ControlPredicate;
  /** 事件名 → 插件声明的事件 id。 */
  on?: Partial<Record<ControlEvent, string>>;
  children?: ControlNode[];
  /** 专属字段（如 `variant`/`icon`/`columns`/`gap`…）。 */
  [prop: string]: unknown;
}

/** 数据绑定（控件标准第 5 节）。 */
export interface ControlBind {
  kind: "panel" | "selection";
  /** 查询名；必须在 manifest 的 `data_queries` 中声明。 */
  name: string;
  /** 可选标量参数。 */
  args?: Record<string, string | number | boolean>;
}

/** 显隐谓词。 */
export interface ControlPredicate {
  kind: "panel" | "selection";
  name: string;
  test: (typeof CONTROL_PREDICATE_TESTS)[number];
}

/** 校验上下文：宿主侧已知的事实（插件声明 + 面板身份）。 */
export interface ControlValidateCtx {
  /** 期望的面板 id（不传 = 不比对）。 */
  expectedPanelId?: string;
  /** 插件 manifest 声明的数据查询名。 */
  declaredQueries?: readonly string[];
  /** 插件 manifest 声明的事件 id。 */
  declaredEvents?: readonly string[];
}

/** 校验结果：`errors` 为空即可渲染。 */
export interface ControlValidateResult {
  errors: string[];
  warnings: string[];
}

/** 控件交互回传载荷（**由宿主构造**，插件不得自定义结构）。 */
export interface ControlEventPayload {
  panel_id: string;
  control_id: string;
  event: ControlEvent;
  /** 控件当前值（输入类）。 */
  value?: string | number | boolean;
  /** 集合类控件的选中项 id。 */
  target?: string;
}

/** 控件 id 规则：`^[a-z][a-z0-9_]{0,63}$`（与 Rust `is_valid_id` 一致）。 */
export function isValidControlId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(id);
}

const COMMON_FIELDS = new Set([
  "id",
  "kind",
  "text_key",
  "visible",
  "enabled",
  "bind",
  "visible_when",
  "on",
  "children",
]);

/**
 * 解析层闸门：结构不对即抛出（装载路径用）。
 *
 * 取值域与字段合法性（能一次收齐的部分）由 `validateControlSchema` 判定；
 * 但 `kind` 是**强类型字段**：白名单外取值在此直接拒绝（与 Rust 解析同口径）。
 */
export function parseControlSchema(json: string): ControlSchema {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`解析控件 schema 失败: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error("控件 schema 必须是对象");
  if (typeof raw.api_version !== "number") throw new Error("控件 schema 缺少 api_version");
  if (typeof raw.panel_id !== "string" || raw.panel_id.trim() === "") {
    throw new Error("控件 schema 缺少 panel_id");
  }
  if (!isRecord(raw.root)) throw new Error("控件 schema 缺少 root");
  assertNodeParsable(raw.root, "root");
  return raw as unknown as ControlSchema;
}

/** 递归断言节点可解析（结构 + `kind` 白名单）。 */
function assertNodeParsable(node: Record<string, unknown>, path: string): void {
  if (!isControlKind(node.kind)) {
    throw new Error(`${path}: 未知控件类型 ${JSON.stringify(node.kind)}`);
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) throw new Error(`${path}: children 必须是数组`);
    node.children.forEach((child, i) => {
      if (!isRecord(child)) throw new Error(`${path}.children[${i}]: 必须是对象`);
      assertNodeParsable(child, `${path}.children[${i}]`);
    });
  }
}

/**
 * 业务级校验（与 Rust `ControlSchema::validate` 同口径）。
 * 硬错误写 `errors`，软告警写 `warnings`（不阻塞渲染）。
 */
export function validateControlSchema(
  schema: ControlSchema,
  ctx: ControlValidateCtx = {},
): ControlValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const queries = new Set(ctx.declaredQueries ?? []);
  const events = new Set(ctx.declaredEvents ?? []);

  if (schema.api_version > CONTROL_API_VERSION) {
    errors.push(
      `不支持的控件 schema 版本: ${schema.api_version}（当前为 ${CONTROL_API_VERSION}）`,
    );
  }
  if (ctx.expectedPanelId !== undefined && schema.panel_id !== ctx.expectedPanelId) {
    errors.push(`面板 id 不一致: schema=${schema.panel_id} 期望=${ctx.expectedPanelId}`);
  }
  if (schema.panel_id.trim() === "") errors.push("面板 id 不能为空");

  const seenIds = new Set<string>();
  let count = 0;
  walkControlNodes(schema.root, (node) => {
    count += 1;
    validateNode(node, queries, events, seenIds, errors, warnings);
  });
  if (count > CONTROL_NODE_SOFT_LIMIT) {
    warnings.push(`控件节点数 ${count} 超过建议上限 ${CONTROL_NODE_SOFT_LIMIT}（不阻塞，仅提示）`);
  }
  return { errors, warnings };
}

/** 深度优先遍历（自身在前；`children` 顺序即渲染顺序）。 */
export function walkControlNodes(node: ControlNode, visit: (node: ControlNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkControlNodes(child, visit);
}

/** 单节点校验（与 Rust `validate_node` 逐项对应）。 */
function validateNode(
  node: ControlNode,
  queries: ReadonlySet<string>,
  events: ReadonlySet<string>,
  seenIds: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  const id = node.id;
  if (!isValidControlId(id)) {
    errors.push(`控件 id 非法（要求 ^[a-z][a-z0-9_]{0,63}$）: ${JSON.stringify(id)}`);
  }
  if (seenIds.has(id)) errors.push(`控件 id 重复: ${id}`);
  seenIds.add(id);

  const spec = controlSpec(node.kind);

  // 容器 / 叶子 与 children。
  if (node.children !== undefined && !spec.container) {
    errors.push(`控件 ${id}（${node.kind}）不是容器，不能带 children`);
  } else if (spec.container && (node.children === undefined || node.children.length === 0)) {
    warnings.push(`容器 ${id}（${node.kind}）没有任何子节点`);
  }

  // 专属字段。
  for (const [name, value] of Object.entries(node)) {
    if (COMMON_FIELDS.has(name)) continue;
    const prop = spec.props.find((p) => p.name === name);
    if (!prop) {
      errors.push(`控件 ${id}（${node.kind}）不支持字段 ${name}`);
      continue;
    }
    checkPropValue(id, node.kind, prop, value, errors);
  }
  for (const prop of spec.props) {
    if (prop.required && !(prop.name in node)) {
      errors.push(`控件 ${id}（${node.kind}）缺少必需字段 ${prop.name}`);
    }
  }

  // 文字：需要文字的类型必须有 text_key 或 text。
  if (requiresText(node.kind)) {
    const hasText =
      (typeof node.text_key === "string" && node.text_key.trim() !== "") ||
      (typeof node["text"] === "string" && (node["text"] as string).trim() !== "");
    if (!hasText) errors.push(`控件 ${id}（${node.kind}）缺少 text_key 或 text`);
  }

  // 绑定。
  if (node.bind) {
    if (!(CONTROL_BIND_KINDS as readonly string[]).includes(node.bind.kind)) {
      errors.push(`控件 ${id} 的 bind.kind 非法: ${node.bind.kind}（允许 panel / selection）`);
    }
    if (!node.bind.name || node.bind.name.trim() === "") {
      errors.push(`控件 ${id} 的 bind.name 不能为空`);
    } else if (!queries.has(node.bind.name)) {
      errors.push(`控件 ${id} 的 bind.name「${node.bind.name}」未在 manifest 的 data_queries 中声明`);
    }
    for (const [key, value] of Object.entries(node.bind.args ?? {})) {
      const scalar = ["string", "number", "boolean"].includes(typeof value);
      if (!scalar) errors.push(`控件 ${id} 的 bind.args.${key} 必须是标量（string/number/bool）`);
    }
  }

  // 显隐谓词。
  const pred = node.visible_when;
  if (pred) {
    if (!(CONTROL_BIND_KINDS as readonly string[]).includes(pred.kind)) {
      errors.push(`控件 ${id} 的 visible_when.kind 非法: ${pred.kind}`);
    }
    if (!(CONTROL_PREDICATE_TESTS as readonly string[]).includes(pred.test)) {
      errors.push(
        `控件 ${id} 的 visible_when.test 非法: ${pred.test}（允许 zero / empty / truthy / exists）`,
      );
    }
    if (pred.name && !queries.has(pred.name)) {
      errors.push(`控件 ${id} 的 visible_when.name「${pred.name}」未在 manifest 的 data_queries 中声明`);
    }
  }

  // 事件。
  for (const [eventName, eventId] of Object.entries(node.on ?? {})) {
    if (!(CONTROL_EVENTS as readonly string[]).includes(eventName)) {
      errors.push(`控件 ${id} 的事件名非法: ${eventName}（固定谓词表外）`);
    } else if (!controlAllowsEvent(node.kind, eventName as ControlEvent)) {
      errors.push(`控件 ${id}（${node.kind}）不支持事件 ${eventName}`);
    }
    if (typeof eventId !== "string" || !events.has(eventId)) {
      errors.push(`控件 ${id} 的事件 ${eventName} 指向未声明的事件 id: ${String(eventId)}`);
    }
  }

  // 集合类必须绑定数据源。
  if (requiresBind(node.kind) && !node.bind) {
    errors.push(`控件 ${id}（${node.kind}）必须声明 bind（集合类控件的数据只能来自受控查询）`);
  }

  // 数值范围自洽。
  const num = (key: string): number | undefined =>
    typeof node[key] === "number" ? (node[key] as number) : undefined;
  const [min, max, step] = [num("min"), num("max"), num("step")];
  if (min !== undefined && max !== undefined && min > max) {
    errors.push(`控件 ${id} 的 min(${min}) 大于 max(${max})`);
  }
  if (step !== undefined && step <= 0) {
    errors.push(`控件 ${id} 的 step 必须为正数（当前 ${step}）`);
  }
  if (node.kind === "progress" && max !== undefined && max <= 0) {
    errors.push(`控件 ${id}（progress）的 max 必须为正数（当前 ${max}）`);
  }
}

/** 检查一个专属字段的取值。 */
function checkPropValue(
  id: string,
  kind: ControlKind,
  prop: { name: string; type: string; values?: readonly string[] },
  value: unknown,
  errors: string[],
): void {
  const bad = (expected: string) =>
    errors.push(`控件 ${id}（${kind}）的字段 ${prop.name} 必须是${expected}`);
  switch (prop.type) {
    case "string":
      if (typeof value !== "string") bad("字符串");
      break;
    case "boolean":
      if (typeof value !== "boolean") bad("布尔");
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) bad("有限数值");
      break;
    case "enum":
      if (typeof value !== "string") bad("字符串枚举");
      else if (!(prop.values ?? []).includes(value)) {
        errors.push(
          `控件 ${id}（${kind}）的字段 ${prop.name} 取值非法: ${value}（允许 ${(prop.values ?? []).join(" / ")}）`,
        );
      }
      break;
    case "stringArray": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        bad("字符串数组");
        break;
      }
      if (prop.name === "columns" && (value.length === 0 || value.length > TABLE_COLUMN_MAX)) {
        errors.push(
          `控件 ${id}（${kind}）的 columns 数量必须在 1..=${TABLE_COLUMN_MAX}（当前 ${value.length}）`,
        );
      }
      break;
    }
    default:
      errors.push(`控件 ${id}（${kind}）的字段 ${prop.name} 类型未定义: ${prop.type}`);
  }
}

/** 该类型是否必须有可见文字。 */
function requiresText(kind: ControlKind): boolean {
  return kind === "text" || kind === "button" || kind === "notice" || kind === "empty";
}

/** 该类型是否必须声明数据绑定。 */
function requiresBind(kind: ControlKind): boolean {
  return [
    "image",
    "list",
    "tree",
    "table",
    "tagChain",
    "thumbGrid",
    "keyValue",
  ].includes(kind);
}

/** 宿主构造控件事件载荷（插件不得自定义结构，控件标准第 6 节）。 */
export function buildControlEventPayload(
  panelId: string,
  controlId: string,
  event: ControlEvent,
  extras: { value?: string | number | boolean; target?: string } = {},
): ControlEventPayload {
  const payload: ControlEventPayload = { panel_id: panelId, control_id: controlId, event };
  if (extras.value !== undefined) payload.value = extras.value;
  if (extras.target !== undefined) payload.target = extras.target;
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
