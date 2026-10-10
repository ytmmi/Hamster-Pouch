/**
 * 蓝图连线落库（RFC 0007 决策 7 / D103 / D109）——**纯函数**：把一条边落进文档，
 * 并把**子节点的引用字段**一起写对。
 *
 * 为什么单独成文件：
 * - **原子性**（缺陷 0031 的教训）：画布早前"先 `onChange` 加边、再回调 `onConnect` 改引用"，
 *   两处各自从**同一份调用前的 `doc`** 派生新文档 → 后一次把刚加的边覆盖掉，表现为
 *   "连完线节点状态没刷新"。现在边与引用字段在**一份文档**上一次算完。
 * - **接线是唯一的引用落定时机**（D109）：新增节点不再自动挂父级（那会让画布上看不出
 *   绑定的节点"不灰显"），因此"拖一条线"必须同时把边与字段都落好——这条规则只此一处。
 * - 纯函数 → 可脱离宿主门禁（`pnpm check:blueprint-nodes`）：断言"连线后该节点不再未接通"
 *   这类**跨模块**结论（`applyConnect` × `blueprintLint.analyzeUnlinked`）。
 */

import type { BlueprintEdge, BlueprintGraph, BlueprintNode } from "@hamster-pouch/config";
import { defaultSubclassFormatFor } from "@hamster-pouch/config";

/** 一条待落的边（画布放开时给出）。 */
export interface ConnectInput {
  from: string;
  to: string;
  kind: BlueprintEdge["kind"];
}

/** 落库结果：是否真的落了（重复边 = `false`）、以及被写了哪些字段（可观察）。 */
export interface ConnectResult {
  doc: BlueprintGraph;
  /** 新落的边（`null` = 同 `(from,to,kind)` 已存在，未改动文档）。 */
  edge: BlueprintEdge | null;
  /** 本次写进子节点的字段（空对象 = 这条边不携带字段语义）。 */
  patch: Partial<BlueprintNode>;
}

/**
 * 一条边应当在**子节点**上写哪些字段。
 *
 * 判据是"父节点类型 + 子节点类型"（与节点标准第 2 节的字段定义表一一对应）：
 * | 边 | 子节点 | 字段 |
 * | --- | --- | --- |
 * | 面板 → 类目 | `class` | `control` |
 * | 类目 → 子类 | `subclass` | `subclass`（同名不同义：子类节点上指**所属类目**）+ 缺省 `format` |
 * | 面板 → 标记 | `mark` | `control`（标记与类目树平行，挂在**面板**下） |
 * | 类目 → 对象 | `object` | `class` |
 * | 子类 → 对象 | `object` | `subclass` |
 * | 标记 → 对象 | `object` | `mark_ref` |
 * | 面板/类目/子类/标记/对象 → 操作 | `event` | `target`（兼容旧图；正常来源是 `on` 入边） |
 * | 面板/标签组 → 状态 | `action` | `target`（仅当它还没有目标时） |
 *
 * 已经写好同一个值时返回空补丁（**不产生无意义的新文档对象**）；字段为空时才写，
 * 不会清掉使用者在属性面板里填的其它轴字段（三条轴互斥由后端硬错误守住）。
 */
export function connectPatch(
  child: BlueprintNode,
  parent: BlueprintNode,
): Partial<BlueprintNode> {
  const patch: Partial<BlueprintNode> = {};
  if (child.type === "class" && parent.type === "control" && child.control !== parent.key) {
    patch.control = parent.key;
  } else if (child.type === "subclass" && parent.type === "class") {
    if (child.subclass !== parent.key) {
      patch.subclass = parent.key;
    }
    // 子类光有归属还不算接通（规范第 6 节第 8 条：**缺 `format` = 未接通**）——
    // 一条线应当把它接成"能用"的状态，因此这里补上**所属类目分域的第一项**
    // （与属性面板下拉的缺省、以及旧工厂的 `defaultSubclassFormatFor` 同一口径）；
    // 使用者可在属性面板改成别的细分。该类目没有分域（如 image）时不写，节点保持灰显。
    if (!child.format) {
      const format = defaultSubclassFormatFor(parent.media_type);
      if (format) {
        patch.format = format;
      }
    }
  } else if (child.type === "mark" && parent.type === "control" && child.control !== parent.key) {
    patch.control = parent.key;
  } else if (child.type === "object" && parent.type === "class" && child.class !== parent.key) {
    patch.class = parent.key;
  } else if (
    child.type === "object" &&
    parent.type === "subclass" &&
    child.subclass !== parent.key
  ) {
    patch.subclass = parent.key;
  } else if (
    child.type === "object" &&
    parent.type === "mark" &&
    child.mark_ref !== parent.key
  ) {
    patch.mark_ref = parent.key;
  } else if (
    child.type === "event" &&
    ["object", "class", "subclass", "mark", "control"].includes(parent.type) &&
    child.target !== parent.key
  ) {
    patch.target = parent.key;
  } else if (child.type === "action" && child.target === undefined) {
    // 状态的目标只由属性面板指定；连线只提供**缺省候选**（面板/标签组）。
    if (parent.type === "control" || parent.type === "group") {
      patch.target = parent.key;
    }
  }
  return patch;
}

/**
 * 把一条边落进文档：**边 + 子节点引用字段**一次算好（原子）。
 *
 * 重复边（同 `from`/`to`/`kind`）直接原样返回（`edge: null`）——与画布的落点判定
 * （`blueprintPorts.connectTargets` 的去重）同判据，因此"亮着绿圈"与"放开真能连上"
 * 不会互相矛盾。
 */
export function applyConnect(doc: BlueprintGraph, input: ConnectInput): ConnectResult {
  const child = doc.nodes.find((n) => n.key === input.to);
  const parent = doc.nodes.find((n) => n.key === input.from);
  if (!child || !parent) {
    return { doc, edge: null, patch: {} };
  }
  if (
    doc.edges.some(
      (e) => e.from === input.from && e.to === input.to && e.kind === input.kind,
    )
  ) {
    return { doc, edge: null, patch: {} };
  }
  const patch = connectPatch(child, parent);
  const order = Math.max(0, ...doc.edges.map((e) => e.order)) + 1;
  const edge: BlueprintEdge = {
    from: input.from,
    to: input.to,
    kind: input.kind,
    order,
  };
  return {
    doc: {
      ...doc,
      nodes: Object.keys(patch).length
        ? doc.nodes.map((n) => (n.key === child.key ? { ...n, ...patch } : n))
        : doc.nodes,
      edges: [...doc.edges, edge],
    },
    edge,
    patch,
  };
}
