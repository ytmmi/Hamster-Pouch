#!/usr/bin/env node
/**
 * D221：`plugin.contributions` 的线上键名与前端读取必须对得上。
 *
 * 缺陷形态（真机 2026-11-15）：桥接层结构体带 `#[serde(rename_all = "camelCase")]`，
 * 前端类型与消费方却全按蛇形读，`contributions.node_types.map(...)` 直接抛
 * `TypeError: Cannot read properties of undefined (reading 'map')`——错误发生在登记之前，
 * **整批插件注册（面板 / 蓝图节点 / 设置分节）一次都没生效**。夹具是手写驼峰字面量，
 * 所以只有真机能看见（与缺陷 0042 的 `nextCursor` 同族）。
 *
 * 五条：① 四个桥接层结构体都带 camelCase；② 后端有用例把序列化键名钉死；
 * ③ 前端类型用驼峰（内嵌声明保持蛇形）；④ 纯映射模块用**真实线上样本**驱动；
 * ⑤ 消费方按驼峰读、且不再自己解析声明。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const RUST = "apps/desktop/src-tauri/src/commands/plugin_contributions.rs";
const TYPES = "apps/desktop/src/app_ui/shared/types/plugin.ts";
const MAPPER = "apps/desktop/src/app_ui/core/pluginContributionsMap.ts";
const HOST = "apps/desktop/src/app_ui/core/pluginRegistryHost.ts";

let passed = 0;
let total = 0;
function report(label, ok, detail = "") {
  total += 1;
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const rustSrc = read(RUST);
const typesSrc = read(TYPES);
const hostSrc = read(HOST);

// ① 四个桥接层结构体都要 camelCase
const STRUCTS = [
  "PluginContributions",
  "PanelContributionItem",
  "SettingsSectionItem",
  "NodeContributionItem",
];
const rustLines = rustSrc.split("\n");
const missingAttr = STRUCTS.filter((name) => {
  const idx = rustLines.findIndex((line) => line.includes(`struct ${name} {`));
  if (idx < 0) return true;
  const window = rustLines.slice(Math.max(0, idx - 3), idx).join("\n");
  return !window.includes('rename_all = "camelCase"');
});
report(
  "plugin.contributions 的四个桥接层结构体都声明 rename_all = camelCase",
  missingAttr.length === 0,
  missingAttr.length ? `缺 rename_all：${missingAttr.join("、")}` : "",
);

// ② 后端有用例把序列化键名钉死
report(
  "后端有用例断言序列化键名（nodeTypes / panels / settingsSections）",
  rustSrc.includes("fn contributions_view_serializes_camel_case_keys(") &&
    rustSrc.includes('vec!["nodeTypes", "panels", "settingsSections"]'),
);

// ③ 前端类型：桥接层驼峰、内嵌声明保持蛇形
const CAMEL_KEYS = ["nodeTypes", "settingsSections", "pluginId", "titleKey", "hasClass", "blueprintNode", "readOnly"];
const missingCamel = CAMEL_KEYS.filter((key) => !typesSrc.includes(`${key}:`));
const SNAKE_LEAKS = ["node_types:", "settings_sections:", "plugin_id:"];
const leaked = SNAKE_LEAKS.filter((key) => typesSrc.includes(key));
report(
  "前端类型按线上键名声明（桥接层驼峰、内嵌声明蛇形）",
  missingCamel.length === 0 && leaked.length === 0,
  [
    missingCamel.length ? `缺驼峰字段：${missingCamel.join("、")}` : "",
    leaked.length ? `仍按蛇形读桥接层字段：${leaked.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("；"),
);

// ④ 纯映射模块用真实线上样本驱动（驼峰外壳 + 蛇形内嵌）
const mapper = await import(pathToFileURL(join(ROOT, MAPPER)).href);
const PANEL = {
  pluginId: "dev.hamsterpouch.palette",
  id: "plugin.dev.hamsterpouch.palette.palette",
  titleKey: "panel.palette",
  category: "system",
  hasClass: true,
  blueprintNode: "control",
  settings: [
    {
      key: "grid_size",
      kind: "numberInput",
      title_key: "palette.gridSize",
      default: 4,
      scope: "repo",
      requires_capability: "repo.write",
    },
  ],
  readOnly: false,
  mount: { overlay_content: false, blueprint_ref: true, multiple_per_interface: false },
};
const NODE = {
  pluginId: "dev.hamsterpouch.palette",
  type: "plugin.dev.hamsterpouch.palette.swatch",
  label_key: "palette.node.swatch",
  role: "structural",
  name_from_layer: true,
  provides_name: false,
  fields: [{ name: "name", type: "string", required: true, softWhenMissing: false, values: [] }],
  parents: ["layout_block"],
  children: [],
  events: ["fires"],
  ports: [{ id: "out", side: "out", edge: "fires" }],
  severity: { fieldIssue: "soft", missingRef: "hard" },
  evaluation_role: "action",
};
const SECTION = {
  pluginId: "dev.hamsterpouch.palette",
  titleKey: "palette.settings.title",
  category: "plugin",
  settings: [{ key: "sort", kind: "select", title_key: "palette.sort", default: "hue" }],
};

const panelSpec = mapper.toPanelSpec(PANEL);
const nodeSpec = mapper.toNodeSpec(NODE);
const section = mapper.toSettingsSection(SECTION);
const wiring = [
  panelSpec?.titleKey === "panel.palette",
  panelSpec?.hasClass === true,
  panelSpec?.blueprintNode === "control",
  panelSpec?.readOnly === false,
  panelSpec?.origin?.plugin_id === "dev.hamsterpouch.palette",
  panelSpec?.settings?.[0]?.title_key === "palette.gridSize",
  panelSpec?.settings?.[0]?.requires_capability === "repo.write",
  panelSpec?.mount?.overlay_content === false,
  nodeSpec?.labelKey === "palette.node.swatch",
  nodeSpec?.nameFromLayer === true,
  nodeSpec?.providesName === false,
  nodeSpec?.fields?.[0]?.softWhenMissing === false,
  nodeSpec?.severity?.fieldIssue === "soft",
  nodeSpec?.severity?.missingRef === "hard",
  nodeSpec?.evaluationRole === "action",
  nodeSpec?.origin?.plugin_id === "dev.hamsterpouch.palette",
  section.plugin_id === "dev.hamsterpouch.palette",
  section.title_key === "palette.settings.title",
  section.settings?.[0]?.title_key === "palette.sort",
  mapper.toPanelSpec({ ...PANEL, id: "palette" }) === null,
  mapper.toNodeSpec({ ...NODE, type: "palette.swatch" }) === null,
];
report(
  "纯映射模块按真实线上样本（驼峰外壳 + 蛇形内嵌）译出注册表项",
  wiring.every(Boolean),
  wiring.every(Boolean) ? "" : `第 ${wiring.indexOf(false) + 1} 条断言不成立`,
);

// ⑤ 消费方按驼峰读、且不再自己解析声明
const HOST_NEEDLES = ["from \"./pluginContributionsMap\"", "contributions.nodeTypes", "contributions.settingsSections"];
const HOST_SNAKE = [
  "node_types",
  "settings_sections",
  "item.plugin_id",
  "item.title_key",
  "item.has_class",
  "item.blueprint_node",
  "item.read_only",
  "section.plugin_id",
  "section.title_key",
];
const hostMissing = HOST_NEEDLES.filter((needle) => !hostSrc.includes(needle));
const hostLeaks = HOST_SNAKE.filter((needle) => hostSrc.includes(needle));
report(
  "宿主登记层从纯映射模块取项、按驼峰读、不再自带一份解析",
  hostMissing.length === 0 && hostLeaks.length === 0,
  [
    hostMissing.length ? `缺：${hostMissing.join("、")}` : "",
    hostLeaks.length ? `仍读蛇形：${hostLeaks.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("；"),
);

console.log(`\n[check-plugin-wire] ${passed}/${total} 通过`);
process.exit(passed === total ? 0 : 1);
