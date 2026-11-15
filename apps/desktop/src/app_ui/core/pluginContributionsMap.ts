/**
 * 插件贡献点 → 注册表项的**纯映射**（RFC 0010 决策 3/4/5/7；D221）。
 *
 * 只做形状翻译：不碰三张注册表、不调 IPC，因此门禁可以`import` 之后用真实线上样本
 * 直接驱动（`tools/check-plugin-wire.mjs` 就是这么钉的）。副作用留在
 * `pluginRegistryHost.ts`（登记 / 注销 / 幂等）。
 *
 * **两层命名不是笔误**：`plugin.contributions` 的**桥接层视图**
 * (`PluginContributions` / `PanelContributionItem` / `SettingsSectionItem` /
 * `NodeContributionItem`) 按桥接层约定走驼峰——`pluginId` / `titleKey` / `hasClass` /
 * `blueprintNode` / `readOnly` / `nodeTypes` / `settingsSections`；而内嵌的**插件声明**
 * (`settings[]`、`mount`、蓝图节点声明的 `label_key` / `name_from_layer` …) 与
 * `docs/spec/plugin-standard.md` 第 3 节的 manifest 同形，保持蛇形。
 *
 * 这两层曾经被写反过：前端类型与消费方全按蛇形读，而线上是驼峰，
 * `contributions.node_types.map(...)` 在真机上抛 `TypeError`，**整批插件注册一次都没生效**
 * （D221 修复；与缺陷 0042 的 `nextCursor` 同族——夹具是手写驼峰字面量，只有真机能看见）。
 */

import type {
  BlueprintNodeSpec,
  PanelSpec,
  PluginSettingsSection,
  SettingCategory,
  SettingInputKind,
  SettingValue,
} from "@hamster-pouch/config";

import type { BlueprintNodeDeclDto, PluginContributions } from "../shared/types";

/** 把一条面板声明转成注册表项（宿主填充 `origin`，插件不得自称）。 */
export function toPanelSpec(item: PluginContributions["panels"][number]): PanelSpec | null {
  if (!item.id.startsWith(`plugin.${item.pluginId}.`)) return null;
  return {
    id: item.id,
    titleKey: item.titleKey,
    category: toPanelCategory(item.category),
    hasClass: item.hasClass,
    blueprintNode: item.blueprintNode,
    settings: (item.settings ?? []).map((s) => ({
      key: s.key,
      kind: toSettingKind(s.kind),
      title_key: s.title_key,
      default: s.default as SettingValue | undefined,
      ...(s.scope === "app" || s.scope === "repo" ? { scope: s.scope } : {}),
      ...(s.requires_capability ? { requires_capability: s.requires_capability } : {}),
    })),
    mount: item.mount,
    readOnly: item.readOnly,
    origin: { kind: "plugin", plugin_id: item.pluginId },
  };
}

/** 把一条节点类型声明转成注册表项（纯声明；不含代码/样式）。 */
export function toNodeSpec(item: BlueprintNodeDeclDto): BlueprintNodeSpec | null {
  if (!item.type.startsWith("plugin.") || !item.pluginId) return null;
  if (!item.type.startsWith(`plugin.${item.pluginId}.`)) return null;
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
            fieldIssue: item.severity.fieldIssue === "soft" ? ("soft" as const) : ("hard" as const),
            missingRef: item.severity.missingRef === "hard" ? ("hard" as const) : ("soft" as const),
          },
        }
      : {}),
    ...(item.evaluation_role ? { evaluationRole: toEvaluationRole(item.evaluation_role) } : {}),
    origin: { kind: "plugin", plugin_id: item.pluginId },
  };
}

export function toPanelCategory(raw: string): PanelSpec["category"] {
  return raw === "source" || raw === "media" || raw === "info" || raw === "system"
    ? raw
    : "other";
}

export function toSettingKind(raw: string): SettingInputKind {
  const allowed: readonly SettingInputKind[] = [
    "switch",
    "textInput",
    "numberInput",
    "select",
    "slider",
    "checkbox",
  ];
  return (allowed as readonly string[]).includes(raw) ? (raw as SettingInputKind) : "textInput";
}

export function toNodeRole(raw: string): BlueprintNodeSpec["role"] {
  return raw === "root" || raw === "container" || raw === "logic" ? raw : "structural";
}

export function toEvaluationRole(
  raw: string,
): NonNullable<BlueprintNodeSpec["evaluationRole"]> {
  return raw === "trigger" || raw === "condition" || raw === "action" ? raw : "structural";
}

/** 把一条设置分节声明转成注册表项（`plugin_id` 由宿主填写）。 */
export function toSettingsSection(
  section: PluginContributions["settingsSections"][number],
): PluginSettingsSection {
  return {
    plugin_id: section.pluginId,
    title_key: section.titleKey,
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
