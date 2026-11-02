/**
 * 画布「?」帮助面板的**纯数据 / 纯函数**（D136-B）——不含 React、不读 DOM。
 *
 * 用户需求（原话）：「蓝图右下角增加"?"，点击显示**所有节点的包含关系**」。
 * 裁决的呈现形式：**缩进层级树 + 包含关系表 + 边类型说明**。
 *
 * ## 为什么一切都从定义表派生，而不是在这里写一份常量表
 *
 * 包含层级（`界面 ⊃ 布局块 ⊃ … ⊃ 对象`）的**唯一事实来源**是
 * `packages/config/src/blueprintNodes.ts` 的 `BLUEPRINT_NODE_REGISTRY`
 * （每项的 `parents` / `children`）。本文件**不重抄**任何父子关系：
 *
 * - 手写第二份常量表会立刻与定义表漂移——D136 把「标记」从「面板下」改挂到
 *   「类目下」（`control ⊃ mark` → `class ⊃ mark`），v3 又把它从「类目下」改挂到
 *   「对象下」（`class ⊃ mark` → `object ⊃ mark`）；两次帮助面板都必须**零改动**地
 *   跟着变，否则用户会看到"帮助里说标记挂面板、画布上却只能连到对象"的自相矛盾；
 * - 门禁（`tools/blueprint-node-check.mjs`）直接 import 本模块，断言
 *   「帮助面板层级树 == 定义表」——手写表会在那里立刻变红。
 *
 * 因此本模块只做**投影**：`children` / `parents` 逐项从 `nodeSpecOrNull(type)` 取，
 * 包含关系表从画布自己的 `CONTAINMENT` 取，规则边从 `RULE_EDGE_SOURCES` /
 * `RULE_EDGE_TARGETS` 取。
 *
 * ## 规则三节点为什么不特判
 *
 * `event` / `condition` / `action` 在定义表里 `parents: []` 且 `children: []`，
 * 于是它们**自然**不会成为层级树的根（根要求"有子"），也不会成为任何节点的子
 * （任何 `children` 清单里都没有它们）。本文件**没有任何** `type === "event"`
 * 之类的特判——"规则节点不参与包含"是定义表的结构事实，不是帮助面板的约定。
 */

import {
  allNodeSpecs,
  containmentAllows,
  nodeSpecOrNull,
  type BlueprintNodeSpec,
  type BlueprintNodeType,
} from "@hamster-pouch/config";

import {
  CONTAINMENT,
  RULE_EDGE_SOURCES,
  RULE_EDGE_TARGETS,
} from "./blueprintPorts";

/** 层级树的一个节点：自身类型 + 它**在定义表里**声明的子类型（递归同形）。 */
export interface HelpTreeNode {
  type: BlueprintNodeType;
  children: HelpTreeNode[];
}

/** 一条包含关系（`父 --contains--> 子`，边类型固定 `contains`）。 */
export interface HelpContainmentRule {
  parent: BlueprintNodeType;
  child: BlueprintNodeType;
  /** 结构关系只有一种边（`contains`）；保留字段让展示层不必假定。 */
  edge: "contains";
}

/** 一种**规则边**（非结构边）的允许来源与目标（从端口表派生，不手抄）。 */
export interface HelpRuleEdge {
  kind: string;
  /** 允许作为**起点**的节点类型（`RULE_EDGE_SOURCES`）。 */
  sources: readonly BlueprintNodeType[];
  /** 允许作为**终点**的节点类型（`RULE_EDGE_TARGETS`）。 */
  targets: readonly BlueprintNodeType[];
}

/** 排除 `contains` 后剩下的规则边类型（顺序 = `RULE_EDGE_SOURCES` 的声明顺序）。 */
const RULE_EDGE_KIND_ORDER: readonly string[] = Object.keys(RULE_EDGE_SOURCES).filter(
  (kind) => kind !== "contains",
);

/** 某类型的**结构子清单**（定义表 `children`；未注册 = 无子）。 */
export function childTypesOf(type: BlueprintNodeType): readonly BlueprintNodeType[] {
  return nodeSpecOrNull(type)?.children ?? [];
}

/**
 * 某类型的**结构父清单**（定义表 `parents`；未注册 = 无父）。
 *
 * 这是树的反向信息：一个类型在树里可能出现多次（可挂在多个父下），
 * 「哪个父可以包含它」由这一份清单回答（展示层在行尾用 `←` 列出来）。
 */
export function parentsOf(type: BlueprintNodeType): readonly BlueprintNodeType[] {
  return nodeSpecOrNull(type)?.parents ?? [];
}

/**
 * 层级树的**根类型**：有子、且**没有**结构父的类型。
 *
 * 不硬编码 `"interface"`：内置 12 种里它自然就是唯一的根
 * （`layout_block` / `overlay` 都声明了 `parents: ["interface"]`），而规则三节点
 * 没有子，所以不会因为 `parents: []` 被误当成根。
 */
export function hierarchyRootTypes(): BlueprintNodeType[] {
  return allNodeSpecs()
    .filter((spec) => spec.parents.length === 0 && spec.children.length > 0)
    .map((spec) => spec.type);
}

/**
 * 构建**层级树**（森林；内置 12 种下只有一个根 = 界面）。
 *
 * 逐项规则：
 * - 子清单直接取定义表 `children`，再用 `containmentAllows(parent, child)` 过滤：
 *   保证"帮助里画出来的每一对父子，画布与后端都真的允许"（定义表与端口表若哪天
 *   不一致，帮助面板不会替它们撒谎）；
 * - 用 `path` 做**防御性防环**：定义表里出现环（例如插件类型自指）时截断而不是
 *   栈溢出。内置 12 种无环，这个集合只是护栏，不影响展示。
 */
export function buildHierarchyTree(): HelpTreeNode[] {
  return hierarchyRootTypes().map((type) =>
    expandNode(type, new Set<BlueprintNodeType>()),
  );
}

/** 递归展开一个类型（`path` = 当前分支已展开的类型，用于防环）。 */
function expandNode(
  type: BlueprintNodeType,
  path: ReadonlySet<BlueprintNodeType>,
): HelpTreeNode {
  const branch = new Set(path);
  branch.add(type);
  const children = childTypesOf(type)
    .filter((child) => !branch.has(child))
    .map((child) => expandNode(child, branch));
  return { type, children };
}

/**
 * 层级树的**扁平父子对**（顺序 = 深度优先、从左到右）。
 *
 * 它是树的"可断言视图"：门禁不必自己递归就能验证
 * 「类目 ⊃ {子类, 对象}」「对象 ⊃ 标记」「面板 ⊃ 类目」
 * 「树里不存在 面板 ⊃ 标记 / 类目 ⊃ 标记」
 * 以及「每一对都满足 `containmentAllows`」。
 */
export function hierarchyPairs(): HelpContainmentRule[] {
  const pairs: HelpContainmentRule[] = [];
  const walk = (node: HelpTreeNode): void => {
    for (const child of node.children) {
      pairs.push({ parent: node.type, child: child.type, edge: "contains" });
      walk(child);
    }
  };
  for (const root of buildHierarchyTree()) walk(root);
  return pairs;
}

/**
 * **包含关系表**（`父 → 子`），由画布端口表 `CONTAINMENT` 投影。
 *
 * `CONTAINMENT` 本身就从定义表派生（`blueprintPorts.ts` 逐项读
 * `nodeSpecOrNull(type).children`），因此这里同样不含第二份父子常量。
 * 仍然再过一道 `containmentAllows`：`CONTAINMENT` 若与定义表漂移，
 * 宁可少展示一条，也不展示一条画布上连不出来的关系。
 */
export function buildEdgeRules(): HelpContainmentRule[] {
  const rules: HelpContainmentRule[] = [];
  for (const { parent, children } of CONTAINMENT) {
    for (const child of children) {
      if (!containmentAllows(parent, child)) continue;
      rules.push({ parent, child, edge: "contains" });
    }
  }
  return rules;
}

/**
 * **规则边表**（`memberOf` / `on` / `fires` / `guards`）——从端口表的
 * `RULE_EDGE_SOURCES` / `RULE_EDGE_TARGETS` 投影，**不手抄**允许组合。
 */
export function buildRuleEdges(): HelpRuleEdge[] {
  return RULE_EDGE_KIND_ORDER.map((kind) => ({
    kind,
    sources: RULE_EDGE_SOURCES[kind] ?? [],
    targets: RULE_EDGE_TARGETS[kind] ?? [],
  }));
}

/**
 * **规则三节点**的类型清单（`role === "logic"`），从定义表派生。
 *
 * 用途仅是展示层那句「它们不参与包含」——为什么成立见文件头注释：
 * 这些类型在定义表里 `parents: []` / `children: []`，所以树里根本没有它们。
 */
export function logicNodeTypes(): BlueprintNodeType[] {
  return allNodeSpecs()
    .filter((spec) => spec.role === "logic")
    .map((spec) => spec.type);
}

/** 某类型是否真是"注册项存在且不参与包含"（规则三节点口径；未注册也返回 false）。 */
export function isLogicNodeType(type: BlueprintNodeType): boolean {
  const spec: BlueprintNodeSpec | undefined = nodeSpecOrNull(type);
  return spec?.role === "logic";
}

/**
 * 层级树的**导入期快照**（`BLUEPRINT_HIERARCHY`）。
 *
 * 存在的唯一理由是**名字**：任务书与门禁把它当"层级树"的公开入口引用。值本身仍由
 * [`buildHierarchyTree`] 派生（**不是**手写常量），因此与定义表同源。
 *
 * 与函数的区别只在**时机**：快照在模块导入时算一次，此后插件若在运行中注册节点类型，
 * 快照不跟着变。**展示层一律调函数**（画布每次打开浮层都会重新派生）；
 * 自检脚本用它没有问题（脚本的整个生命周期里注册表不变）。
 */
export const BLUEPRINT_HIERARCHY: readonly HelpTreeNode[] = buildHierarchyTree();

/**
 * 包含关系表的**导入期快照**（`BLUEPRINT_EDGE_RULES`）；值由 [`buildEdgeRules`] 派生。
 * 时机差异与 [`BLUEPRINT_HIERARCHY`] 相同：运行时注册的插件类型只进函数结果。
 */
export const BLUEPRINT_EDGE_RULES: readonly HelpContainmentRule[] = buildEdgeRules();

/**
 * 规则边表的**导入期快照**（`BLUEPRINT_RULE_EDGE_RULES`）；值由 [`buildRuleEdges`] 派生。
 */
export const BLUEPRINT_RULE_EDGE_RULES: readonly HelpRuleEdge[] = buildRuleEdges();
