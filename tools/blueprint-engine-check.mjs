/**
 * 蓝图引擎行为自检（开发期验证，不参与打包）。
 *
 * 直接驱动真实 `BlueprintEngine`，对**仓库库里的当前生效蓝图**跑一遍典型交互
 * （双击图像/视频/音频、单击图像），打印引擎推导出的 dockview 操作序列。
 * 用于回答"删掉规则后为什么还有联动"这类问题：分清是引擎仍推导出动作，
 * 还是引擎已无动作、联动来自别处（面板自身逻辑/未热更新）。
 *
 * 用法：node --no-warnings --import ./tools/blueprint-check-register.mjs \
 *         tools/blueprint-engine-check.mjs [仓库库路径] [蓝图id]
 */

import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const ROOT = "E:/Hamster Pouch";
const defaultDb =
  "C:/Users/wxlxt/AppData/Roaming/dev.hamsterpouch.desktop/repos/00c37ce8-8464-4808-8c51-c9af38e86516.sqlite3";
const dbPath = process.argv[2] ?? defaultDb;
const wantedId = process.argv[3] ?? null;

const { BlueprintEngine } = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/core/blueprintEngine.ts`).href
);

const db = new DatabaseSync(dbPath, { readOnly: true });
const row = wantedId
  ? db.prepare("SELECT * FROM blueprints WHERE id = ?").get(wantedId)
  : db.prepare("SELECT * FROM blueprints WHERE is_default = 1 LIMIT 1").get();
db.close();
if (!row) {
  console.error("找不到蓝图");
  process.exit(1);
}
const graph = JSON.parse(row.blueprint_json);
console.log(`蓝图: ${row.name} (id=${row.id})`);
console.log(
  `节点 ${graph.nodes.length} / 边 ${graph.edges.length} / default_version=${graph.default_version ?? "-"}`,
);
console.log(
  "事件节点:",
  graph.nodes
    .filter((n) => n.type === "event")
    .map((n) => `${n.key}(${n.trigger ?? "-"})`)
    .join(", ") || "（无）",
);

const engine = new BlueprintEngine();
engine.setGraph(graph);
const ops = [];
engine.setExecutor({
  showPanel: (id, floating) => ops.push(`show ${id}${floating ? " (floating)" : ""}`),
  hidePanel: (id) => ops.push(`hide ${id}`),
  togglePanel: (id, floating) => ops.push(`toggle ${id}${floating ? " (floating)" : ""}`),
  collapsePanels: (ids) => ops.push(`collapse [${ids.join(", ")}]`),
  expandPanels: (ids) => ops.push(`expand [${ids.join(", ")}]`),
  playFile: (fileId) => ops.push(`play ${fileId}`),
});

for (const [trigger, mediaType] of [
  ["double_click", "image"],
  ["double_click", "video"],
  ["double_click", "audio"],
  ["click", "image"],
  ["selection_change", "image"],
]) {
  ops.length = 0;
  engine.dispatch({ trigger, target: { mediaType, fileId: "file-1" } });
  console.log(
    `${trigger} / ${mediaType} → ${ops.length ? ops.join(" ; ") : "（无动作）"}`,
  );
}
