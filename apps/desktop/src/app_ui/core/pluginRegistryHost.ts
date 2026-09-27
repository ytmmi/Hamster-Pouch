/**
 * 插件注册表**宿主侧登记**（RFC 0010 决策 3/4/5/7）。
 *
 * 职责单一：把 `plugin.contributions` 返回的**声明**登记进三张注册表
 * （面板 / 蓝图节点类型 / 设置）。
 *
 * 三条铁律在这里落地：
 *
 * 1. **注册项不落库**：每次按当前安装 + 启用状态重建；插件缺失/未启用/宿主 API 不兼容
 *    时其注册项**缺席** → 蓝图里对它的引用按「未接通」处理（软告警 + 灰显 + **允许保存**
 *    + 原样保留 + 恢复后自动恢复，RFC 0010 决策 6），**不是**硬错误；
 * 2. **命名空间强制**：`plugin.<plugin_id>.<local_id>`，宿主不接受不合形式的声明，
 *    也**没有**覆盖宿主内置项的路径（决策 2/3）；
 * 3. **声明是纯数据**：登记时只读取声明字段，不执行任何插件代码。
 *
 * 幂等：登记前先按插件 id 注销一遍，因此重复调用不会残留上一轮的注册项。
 */

import {
  registerBlueprintNodeSpecs,
  registerBlueprintNodeTypes,
  registerPluginPanels,
  registerPluginSettingsSections,
  unregisterBlueprintNodeSpecs,
  unregisterBlueprintNodeTypes,
  unregisterPluginPanels,
  unregisterPluginSettingsSections,
  type BlueprintNodeSpec,
  type PanelSpec,
  type PluginSettingsSection,
  type SettingCategory,
  type SettingInputKind,
  type SettingValue,
} from "@hamster-pouch/config";

import * as api from "../shared/api";
import type { BlueprintNodeDeclDto, PluginContributions } from "../shared/types";

/** 登记结果（供诊断与界面展示）。 */
export interface PluginRegistrationResult {
  repoId: string;
  pluginIds: string[];
  panelCount: number;
  nodeTypeCount: number;
  settingsSectionCount: number;
}

/** 把一条面板声明转成注册表项（宿主填充 `origin`，插件不得自称）。 */
function toPanelSpec(item: PluginContributions["panels"][number]): PanelSpec | null {
  if (!item.id.startsWith(`plugin.${item.plugin_id}.`)) return null;
  return {
    id: item.id,
    titleKey: item.title_key,
    category: toPanelCategory(item.category),
    hasClass: item.has_class,
    blueprintNode: item.blueprint_node,
    settings: (item.settings ?? []).map((s) => ({
      key: s.key,
      kind: toSettingKind(s.kind),
      title_key: s.title_key,
      default: s.default as SettingValue | undefined,
      ...(s.scope === "app" || s.scope === "repo" ? { scope: s.scope } : {}),
      ...(s.requires_capability ? { requires_capability: s.requires_capability } : {}),
    })),
    mount: item.mount,
    readOnly: item.read_only,
    origin: { kind: "plugin", plugin_id: item.plugin_id },
  };
}

/** 把一条节点类型声明转成注册表项（纯声明；不含代码/样式）。 */
function toNodeSpec(item: BlueprintNodeDeclDto): BlueprintNodeSpec | null {
  if (!item.type.startsWith("plugin.") || !item.plugin_id) return null;
  if (!item.type.startsWith(`plugin.${item.plugin_id}.`)) return null;
  return {
    type: item.type,
    label: item.label_key,
    labelKey: item.label_key,
    role: toNodeRole(item.role),
    nameFromLayer: item.name_from_layer,
    providesName: item.provides_name,
    fields: (item.fields ?? []).map((f) => ({
      name: f.name,
      type: f.type as BlueprintNodeSpec["fields"][number]["type"],
      required: f.required,
      softWhenMissing: f.softWhenMissing,
      values: f.values,
    })),
    parents: item.parents ?? [],
    children: item.children ?? [],
    events: (item.events ?? []) as BlueprintNodeSpec["events"],
    ports: (item.ports ?? []).map((p) => ({
      id: p.id,
      side: p.side === "out" ? ("out" as const) : ("in" as const),
      edge: p.edge as NonNullable<BlueprintNodeSpec["ports"]>[number]["edge"],
    })),
    ...(item.severity
      ? {
          severity: {
            fieldIssue:
              item.severity.fieldIssue === "soft" ? ("soft" as const) : ("hard" as const),
            missingRef:
              item.severity.missingRef === "hard" ? ("hard" as const) : ("soft" as const),
          },
        }
      : {}),
    ...(item.evaluation_role ? { evaluationRole: toEvaluationRole(item.evaluation_role) } : {}),
    origin: { kind: "plugin", plugin_id: item.plugin_id },
  };
}

function toPanelCategory(raw: string): PanelSpec["category"] {
  return raw === "source" || raw === "media" || raw === "info" || raw === "system"
    ? raw
    : "other";
}

function toSettingKind(raw: string): SettingInputKind {
  const allowed: readonly SettingInputKind[] = [
    "switch",
    "textInput",
    "numberInput",
    "select",
    "slider",
    "checkbox",
  ];
  return (allowed as readonly string[]).includes(raw)
    ? (raw as SettingInputKind)
    : "textInput";
}

function toNodeRole(raw: string): BlueprintNodeSpec["role"] {
  return raw === "root" || raw === "container" || raw === "logic" ? raw : "structural";
}

function toEvaluationRole(raw: string): NonNullable<BlueprintNodeSpec["evaluationRole"]> {
  return raw === "trigger" || raw === "condition" || raw === "action" ? raw : "structural";
}

function toSettingsSection(
  section: PluginContributions["settings_sections"][number],
): PluginSettingsSection {
  return {
    plugin_id: section.plugin_id,
    title_key: section.title_key,
    category: section.category as SettingCategory,
    settings: (section.settings ?? []).map((s) => ({
      key: s.key,
      kind: toSettingKind(s.kind),
      title_key: s.title_key,
      ...(s.default !== undefined ? { default: s.default as SettingValue } : {}),
      ...(s.scope === "app" || s.scope === "repo" ? { scope: s.scope } : {}),
      ...(s.requires_capability ? { requires_capability: s.requires_capability } : {}),
    })),
  };
}

/** 插件 id 集合（用于"本轮不再出现的插件"逐个注销）。 */
let registeredPlugins: string[] = [];

/**
 * 重建三张注册表的插件部分（宿主在打开仓库、启用/禁用插件后调用）。
 *
 * 返回登记摘要；**任何一步失败都不抛**——插件注册表不可用不应该阻断用户操作，
 * 最坏情况是注册项缺席（蓝图按"未接通"处理）。
 */
export async function refreshPluginRegistrations(
  repoId: string | null,
): Promise<PluginRegistrationResult> {
  const empty: PluginRegistrationResult = {
    repoId: repoId ?? "",
    pluginIds: [],
    panelCount: 0,
    nodeTypeCount: 0,
    settingsSectionCount: 0,
  };
  // 先清空上一轮：插件缺失/仓库切换时注册项必须真的消失（否则会留下"幽灵注册项"）。
  unregisterAll();

  if (!repoId) return empty;
  let contributions: PluginContributions;
  try {
    contributions = await api.pluginContributions(repoId);
  } catch {
    return empty;
  }

  const panels = contributions.panels.map(toPanelSpec).filter((p): p is PanelSpec => p !== null);
  const nodes = contributions.node_types
    .map((item) => ({ spec: toNodeSpec(item), pluginId: item.plugin_id }))
    .filter(
      (n): n is { spec: BlueprintNodeSpec; pluginId: string } => n.spec !== null && !!n.pluginId,
    );
  const sections = contributions.settings_sections.map(toSettingsSection);

  registerPluginPanels(panels);
  registerBlueprintNodeSpecs(nodes.map((n) => n.spec));
  registerBlueprintNodeTypes(nodes.map((n) => ({ type: n.spec.type, plugin_id: n.pluginId })));
  registerPluginSettingsSections(sections);

  registeredPlugins = [
    ...new Set([
      ...panels.map((p) => p.origin.plugin_id ?? ""),
      ...nodes.map((n) => n.pluginId),
      ...sections.map((s) => s.plugin_id),
    ]),
  ].filter(Boolean);

  return {
    repoId,
    pluginIds: registeredPlugins,
    panelCount: panels.length,
    nodeTypeCount: nodes.length,
    settingsSectionCount: sections.length,
  };
}

/** 注销全部插件注册项（仓库切换 / 插件表不可用时的兜底）。 */
export function unregisterAll(): void {
  for (const pluginId of registeredPlugins) {
    unregisterPluginPanels(pluginId);
    unregisterBlueprintNodeSpecs(pluginId);
    unregisterBlueprintNodeTypes(pluginId);
    unregisterPluginSettingsSections(pluginId);
  }
  // 兜底清空：即使 `registeredPlugins` 为空（例如上一个进程状态），也保证注册表干净。
  unregisterPluginPanels();
  unregisterBlueprintNodeSpecs();
  unregisterBlueprintNodeTypes();
  unregisterPluginSettingsSections();
  registeredPlugins = [];
}

/** 当前已登记的插件 id（诊断用）。 */
export function registeredPluginIds(): readonly string[] {
  return registeredPlugins;
}
