/**
 * 库存布局体检（开发期自检，不参与打包）：`pnpm check:layouts [全局库路径]`。
 *
 * 目的：把 **dockview 布局 JSON 的结构不变量** 变成可执行门禁——这类错误不会在
 * 编译期暴露，只会在运行时抛异常（真实案例：给某一层生成的布局把网格根写成单个
 * `leaf`，套用布局时报 `dockview: root must be of type branch`，直接卡住切层）。
 *
 * 断言（对每条 `panel_layouts` 行与 `app_settings` 里的 `layout.*` 预设）：
 * 1. `grid.root` 存在且 **type 必须是 `branch`**（dockview 硬约束，单面板也要包一层 branch）；
 * 2. `grid.root` 递归下去：每个 `branch` 的 `data` 是非空数组；
 * 3. 每个 `leaf` 的 `data.views` 非空、`data.id` 存在、`activeView` ∈ `views`；
 * 4. `leaf.data.views` 里的面板 id 必须在顶层 `panels` 中登记；
 * 5. 每个 `panels` 条目必须有 `id` / `contentComponent` / `title`，且 `id` 与键一致；
 * 6. 所有 `size` 为正数；`panels` 不能为空。
 *
 * 用法：`pnpm check:layouts`（默认读应用数据目录的全局库）。
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DB = join(
  process.env.APPDATA ?? "",
  "dev.hamsterpouch.desktop",
  "hamster-pouch-global.sqlite3",
);
const dbPath = process.argv[2] ?? DEFAULT_DB;

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** 收集待检查的布局：panel_layouts 各行 + app_settings 的 layout.* 预设。 */
function collectLayouts(db) {
  const out = [];
  const json = (sql) => JSON.parse(execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8", maxBuffer: 256e6 }));
  for (const row of json("select repo_id, workspace, layer_key, layout_json from panel_layouts;")) {
    out.push({
      label: `panel_layouts ${row.workspace}/${row.layer_key || "(层无关)"}`,
      json: row.layout_json,
    });
  }
  for (const row of json(
    "select key, value from app_settings where key like 'layout.%' and key <> 'layout.names' and key <> 'layout.default.%';",
  )) {
    if (typeof row.value === "string" && row.value.trim().startsWith("{")) {
      out.push({ label: `app_settings ${row.key}`, json: row.value });
    }
  }
  return out;
}

/** 校验一条布局 JSON，返回问题列表。 */
function validateLayout(layout) {
  const problems = [];
  const grid = layout?.grid;
  if (!grid || typeof grid !== "object") {
    return ["缺少 grid"];
  }
  const root = grid.root;
  if (!root || typeof root !== "object") {
    return ["grid.root 缺失"];
  }
  // 1. 根必须是 branch（dockview 硬约束）。
  if (root.type !== "branch") {
    problems.push(`grid.root.type=${String(root.type)}（必须是 branch）`);
  }

  const panels = layout.panels;
  if (!panels || typeof panels !== "object" || Object.keys(panels).length === 0) {
    problems.push("panels 为空");
    return problems;
  }
  for (const [key, panel] of Object.entries(panels)) {
    if (!panel || typeof panel !== "object") {
      problems.push(`panels.${key} 不是对象`);
      continue;
    }
    if (panel.id !== key) problems.push(`panels.${key}.id=${String(panel.id)}（应与键一致）`);
    for (const field of ["contentComponent", "title"]) {
      if (typeof panel[field] !== "string" || panel[field] === "") {
        problems.push(`panels.${key} 缺少 ${field}`);
      }
    }
  }

  const seenViews = new Set();
  const walk = (node, path) => {
    if (!node || typeof node !== "object") {
      problems.push(`${path} 不是对象`);
      return;
    }
    if (node.size !== undefined && !(typeof node.size === "number" && node.size > 0)) {
      problems.push(`${path}.size=${String(node.size)}（必须为正数）`);
    }
    if (node.type === "branch") {
      if (!Array.isArray(node.data) || node.data.length === 0) {
        problems.push(`${path}.data 必须是非空数组`);
        return;
      }
      node.data.forEach((child, i) => walk(child, `${path}.data[${i}]`));
      return;
    }
    if (node.type === "leaf") {
      const data = node.data;
      if (!data || typeof data !== "object") {
        problems.push(`${path}.data 缺失`);
        return;
      }
      if (!Array.isArray(data.views) || data.views.length === 0) {
        problems.push(`${path}.data.views 必须是非空数组`);
        return;
      }
      if (typeof data.id !== "string" || data.id === "") {
        problems.push(`${path}.data.id 缺失`);
      }
      if (!data.views.includes(data.activeView)) {
        problems.push(`${path}.data.activeView=${String(data.activeView)} 不在 views 内`);
      }
      for (const view of data.views) {
        seenViews.add(view);
        if (!panels[view]) problems.push(`${path} 引用了未登记的面板 ${view}`);
      }
      return;
    }
    problems.push(`${path}.type=${String(node.type)}（只允许 branch / leaf）`);
  };
  walk(root, "grid.root");

  for (const key of Object.keys(panels)) {
    if (!seenViews.has(key)) problems.push(`面板 ${key} 没有被任何 leaf 引用`);
  }
  return problems;
}

if (!existsSync(dbPath)) {
  console.error(`[check:layouts] 找不到全局库：${dbPath}`);
  process.exit(1);
}

const layouts = collectLayouts(dbPath);
check("找到待检查的布局行", layouts.length > 0, `${layouts.length} 条`);

let bad = 0;
for (const item of layouts) {
  let parsed;
  try {
    parsed = JSON.parse(item.json);
  } catch (e) {
    check(`${item.label} 可解析`, false, String(e));
    bad += 1;
    continue;
  }
  const problems = validateLayout(parsed);
  if (problems.length > 0) bad += 1;
  check(`${item.label} 结构合法`, problems.length === 0, problems.slice(0, 3).join("; "));
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过${bad > 0 ? `（${bad} 条布局有问题）` : ""}`);
process.exit(passed === results.length ? 0 : 1);
