/**
 * 库存布局体检（开发期自检，不参与打包）：`pnpm check:layouts [全局库路径]`。
 *
 * 目的：把 **dockview 布局 JSON 的结构不变量** 变成可执行门禁——这类错误不会在
 * 编译期暴露，只会在运行时抛异常（真实案例：给某一层生成的布局把网格根写成单个
 * `leaf`，套用布局时报 `dockview: root must be of type branch`，直接卡住切层）。
 *
 * RFC 0011：布局存放在 `layout_presets`（一份布局 = 一行，各层在 `layers_json` 内），
 * 仓库覆盖在 `layout_bindings`；不再有 `panel_layouts` 与 `layout.<名>` 旧通道。
 *
 * 断言（对每份预设的每一层，外加默认指针 / 绑定 / 旧键关系）：
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
  "E:/Hamster Pouch/apps/desktop/src-tauri/target/release/data/system",
  "hamster-pouch-global.sqlite3",
);
const dbPath = process.argv[2] ?? DEFAULT_DB;

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** 查询辅助：sqlite3 -json。 */
function query(db, sql) {
  const out = execFileSync("sqlite3", ["-json", db, sql], {
    encoding: "utf8",
    maxBuffer: 256e6,
  }).trim();
  // 空结果集时 sqlite3 -json 输出空字符串（不是 `[]`）。
  return out ? JSON.parse(out) : [];
}

/**
 * 收集待检查的布局：`layout_presets` 每条预设的每一层（RFC 0011 决策 2/3）。
 * 一份布局 = 一行，各层装在 `layers_json` 内；层 key `""` = 层无关快照。
 */
function collectLayouts(db) {
  const out = [];
  for (const row of query(db, "select name, layers_json from layout_presets order by name;")) {
    let layers = null;
    try {
      layers = JSON.parse(row.layers_json);
    } catch (e) {
      out.parseErrors = [...(out.parseErrors ?? []), `预设「${row.name}」layers_json 不是合法 JSON: ${e}`];
      continue;
    }
    const keys = layers && typeof layers === "object" ? Object.keys(layers) : [];
    if (keys.length === 0) {
      out.parseErrors = [...(out.parseErrors ?? []), `预设「${row.name}」不含任何层`];
      continue;
    }
    for (const key of keys) {
      out.push({
        label: `预设「${row.name}」/ 层 ${key || "(层无关)"}`,
        json: JSON.stringify(layers[key]),
      });
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

const presets = query(
  dbPath,
  "select id, name, layers_json, blueprint_ids_json, origin from layout_presets order by name;",
);
check("存在布局预设（layout_presets 非空）", presets.length > 0, `${presets.length} 条`);

for (const row of presets) {
  check(
    `预设「${row.name}」origin 合法（user / seeded）`,
    row.origin === "user" || row.origin === "seeded",
    String(row.origin),
  );
  let bindings = null;
  try {
    bindings = JSON.parse(row.blueprint_ids_json);
  } catch {
    /* 下面按非数组处理 */
  }
  check(
    `预设「${row.name}」blueprint_ids_json 是字符串数组`,
    Array.isArray(bindings) && bindings.every((x) => typeof x === "string"),
  );
}

const layouts = collectLayouts(dbPath);
for (const message of layouts.parseErrors ?? []) {
  check(message, false);
}
check("找到待检查的布局层", layouts.length > 0, `${layouts.length} 层`);

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

// 关系检查（RFC 0011 决策 4/9）：默认指针与绑定必须指向存在的预设，旧键不得残留。
const presetIds = new Set(presets.map((row) => row.id));
const defRow = query(dbPath, "select value from app_settings where key = 'layout.default';")[0];
check(
  "app_settings['layout.default'] 指向存在的预设",
  !defRow || presetIds.has(defRow.value),
  defRow ? defRow.value : "未设置（走内建形状）",
);

const bindings = query(dbPath, "select repo_id, preset_id from layout_bindings;");
const dangling = bindings.filter((row) => !presetIds.has(row.preset_id));
check(
  "layout_bindings 全部指向存在的预设",
  dangling.length === 0,
  dangling.map((row) => `${row.repo_id}→${row.preset_id}`).join(", "),
);

const legacyKeys = query(dbPath, "select key from app_settings where key like 'layout.%';")
  .map((row) => row.key)
  .filter((key) => key !== "layout.default" && key !== "layout.syncBlueprint");
check(
  "无旧版布局键残留（layout.names / layout.<名> / layout.default.<repo>）",
  legacyKeys.length === 0,
  legacyKeys.join(", "),
);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过${bad > 0 ? `（${bad} 条布局有问题）` : ""}`);
process.exit(passed === results.length ? 0 : 1);
