/**
 * 修数据：给**缺布局的层**补一份该层专属布局（开发期一次性工具，不参与打包）。
 *
 * 背景（真实缺陷）：切层 = 套用「该层那份布局」（D53）。层的布局行缺失时，
 * `layout.get` 回退到**层无关行**（`layer_key=''`）→ 套用的是别的页面那套面板，
 * 于是"跳转到界面 2"看起来什么都没发生（面板集合与排布完全一样）。
 *
 * 本工具：读取仓库默认蓝图 → 找出**没有任何布局行**的层 → 以基准布局（层无关行）为底：
 *   1. 把该层蓝图里声明的面板控件补进去（蓝图声明的面板应当在该层布局里）；
 *   2. 写入该层专属布局行（`layer_key = 层 key`）。
 * 只补缺失的层，已有专属布局的层**不动**。
 *
 * 用法：
 *   node tools/fix-layer-layout.mjs            # dry-run（只打印将要写入的内容）
 *   node tools/fix-layer-layout.mjs --apply    # 写库（先备份全局库）
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

const REPO_ID = "c07f28d2-57dc-4d73-a9e5-3d943fa9e4f2";
const REPO_DB = join(
  process.env.APPDATA,
  "dev.hamsterpouch.desktop",
  "repos",
  "00c37ce8-8464-4808-8c51-c9af38e86516.sqlite3",
);
const GLOBAL_DB = join(process.env.APPDATA, "dev.hamsterpouch.desktop", "hamster-pouch-global.sqlite3");

const run = (db, sql, opts = {}) =>
  execFileSync("sqlite3", [db], { input: sql, encoding: "utf8", maxBuffer: 64e6, ...opts });
const query = (db, sql) =>
  execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8", maxBuffer: 64e6 });

// ---------- 1. 读蓝图与布局行 ----------
const bpDoc = JSON.parse(
  query(REPO_DB, "select blueprint_json from blueprints where is_default=1;"),
)[0].blueprint_json;
const doc = JSON.parse(bpDoc);

const rows = JSON.parse(
  query(
    GLOBAL_DB,
    `select layout_json from panel_layouts where repo_id='${REPO_ID}' and layer_key='';`,
  ),
)[0].layout_json;
const baseLayout = JSON.parse(rows);

const layerRows = JSON.parse(
  query(
    GLOBAL_DB,
    `select layer_key from panel_layouts where repo_id='${REPO_ID}';`,
  ),
).map((r) => r.layer_key);

const layers = (doc.layers ?? []).map((l) => l.key);
const missing = layers.filter((key) => !layerRows.includes(key));

console.log(`蓝图层: [${layers.join(", ")}]  已有布局行的层: [${layerRows.filter(Boolean).join(", ") || "（只有层无关行）"}]`);
console.log(`缺布局的层: [${missing.join(", ")}]`);
if (missing.length === 0) {
  console.log("没有缺布局的层，无需处理。");
  process.exit(0);
}

// ---------- 2. 为每个缺布局的层构造布局 ----------
/** 蓝图在该层声明的面板控件 id（含经标签组/浮层间接包含的）。 */
function declaredPanels(layerKey) {
  const ids = new Set();
  for (const n of doc.nodes) {
    if (n.type === "control" && n.layer === layerKey && n.panel_id) {
      ids.add(n.panel_id);
    }
  }
  return [...ids];
}

/** 在布局网格里找一个放新面板的位置：复用最靠左的叶子（追加为同组标签页）。 */
function appendPanels(layout, panelIds) {
  const next = JSON.parse(JSON.stringify(layout));
  const leaves = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === "leaf") leaves.push(n);
    else (n.data ?? []).forEach(walk);
  };
  walk(next.grid.root);
  const host = leaves[0];
  if (!host) return { layout: next, added: [] };
  const added = [];
  for (const id of panelIds) {
    if (next.panels[id]) continue;
    next.panels[id] = { id, contentComponent: id, title: id };
    host.data.views.push(id);
    added.push(id);
  }
  return { layout: next, added };
}

/**
 * 只保留给定面板的布局。
 *
 * **dockview 的硬约束：网格根必须是 `branch`，不能是单个 `leaf`**（否则
 * `fromJSON` 直接抛 `dockview: root must be of type branch`）。因此单面板也要包一层
 * 只含一个孩子的 branch —— 这是本工具第一版踩过的坑。
 */
function declaredOnlyLayout(layout, panelIds) {
  const next = JSON.parse(JSON.stringify(layout));
  const kept = panelIds.filter((id) => next.panels[id]);
  next.panels = Object.fromEntries(kept.map((id) => [id, next.panels[id]]));
  const leaf = { type: "leaf", data: { views: [...kept], activeView: kept[0], id: "1" }, size: 100 };
  next.grid.root = {
    type: "branch",
    data: [leaf],
    size: next.grid.root?.size ?? next.grid.width ?? 100,
  };
  next.activeGroup = "1";
  return { layout: next, added: [] };
}

const planned = [];
for (const key of missing) {
  const declared = declaredPanels(key);
  // 取舍：若该层蓝图声明的面板**全都是基准布局已有**的（例如只有 `sources`），
  // 就直接以该层自己声明的面板构成布局——否则套用基准布局会让"切到这一页"
  // 与上一页看起来完全一样（用户真实反馈："闭环了也没有跳转"）。
  // 只有当蓝图声明的面板多于基准布局时（如 l_main 多了 tasks），才以基准布局为底补齐。
  const declaredNotInBase = declared.filter((id) => !baseLayout.panels[id]);
  const useDeclaredOnly = declared.length > 0 && declaredNotInBase.length === 0;
  const { layout, added } = useDeclaredOnly
    ? declaredOnlyLayout(baseLayout, declared)
    : appendPanels(baseLayout, declared);
  planned.push({ layerKey: key, layout, added, declared, mode: useDeclaredOnly ? "按本层声明" : "基准+补齐" });
  console.log(
    `层 ${key}: 蓝图声明面板=[${declared.join(", ") || "无"}]  方式=${useDeclaredOnly ? "按本层声明重建" : "基准布局补齐"}  候选增补=[${added.join(", ") || "无"}]`,
  );
}

if (!APPLY) {
  console.log("\ndry-run：未写库。加 --apply 才会写入。");
  process.exit(0);
}

// ---------- 3. 备份并写库 ----------
const backupDir = join(ROOT, "backups");
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const suffix of ["", "-wal", "-shm"]) {
  const src = `${GLOBAL_DB}${suffix}`;
  if (existsSync(src)) copyFileSync(src, join(backupDir, `global-${stamp}${suffix}`));
}
console.log(`已备份全局库到 backups/global-${stamp}*`);

const now = new Date().toISOString();
for (const { layerKey, layout } of planned) {
  const json = JSON.stringify(layout);
  const stmt =
    `insert into panel_layouts (id, repo_id, workspace, layer_key, layout_json, blueprint_ids_json, updated_at) ` +
    `values (lower(hex(randomblob(16))), '${REPO_ID}', '媒体-测试', '${layerKey}', '${json.replace(/'/g, "''")}', '[]', '${now}') ` +
    `on conflict(repo_id, workspace, layer_key) do update set layout_json = excluded.layout_json, updated_at = excluded.updated_at;`;
  run(GLOBAL_DB, stmt);
  console.log(`已写入层布局：${layerKey}`);
}

// ---------- 4. 回读复核 ----------
const after = JSON.parse(
  query(GLOBAL_DB, `select layer_key, length(layout_json) as len from panel_layouts where repo_id='${REPO_ID}';`),
);
console.log("回读 panel_layouts:", after.map((r) => `${r.layer_key || "''"}=${r.len}B`).join(", "));
process.exit(0);
