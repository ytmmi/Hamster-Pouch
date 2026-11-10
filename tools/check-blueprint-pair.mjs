#!/usr/bin/env node
/**
 * 门禁：随包「演示布局」与内置默认蓝图必须同源（D155）。
 *
 * 比对两侧：
 *   - 蓝图侧：`crates/hp-store/tests/default_blueprint.json`（由 `generate:blueprint-fixture`
 *     从 `packages/config/src/blueprintDefault.ts` 生成，另有 `check:blueprint-fixture`
 *     守住"代码 ↔ 夹具"）；
 *   - 布局侧：全局库 `layout_presets` 里 `layout.default` 指向的那一行（发布包会把它改名为
 *     「演示布局」并清空蓝图绑定，见 `tools/package-build.mjs`）。
 *
 * 没有全局库（全新克隆 / CI）时**跳过并视为通过**：CI 产物本来就不带全局库，布局在目标机
 * 首次运行自建；此时"代码 ↔ 夹具"由 `check:blueprint-fixture` 守。
 *
 * 用法：`node tools/check-blueprint-pair.mjs [--db <全局库路径>]`
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareBlueprintWithLayout } from "./blueprint-pair.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(root, "crates", "hp-store", "tests", "default_blueprint.json");
const defaultDb = join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
  "data",
  "system",
  "hamster-pouch-global.sqlite3",
);

const dbIndex = process.argv.indexOf("--db");
const dbPath = dbIndex >= 0 ? resolve(process.argv[dbIndex + 1] ?? "") : defaultDb;

if (!existsSync(dbPath)) {
  console.log(`[blueprint-pair] 跳过：没有全局库（${dbPath}）；本机无演示布局可比对`);
  process.exit(0);
}

const graph = JSON.parse(readFileSync(fixturePath, "utf8"));
const rows = execFileSync(
  "sqlite3",
  [
    dbPath,
    "SELECT layers_json FROM layout_presets " +
      "WHERE id = (SELECT value FROM app_settings WHERE key = 'layout.default');",
  ],
  { encoding: "utf8" },
).trim();

if (!rows) {
  console.log("[blueprint-pair] 跳过：全局库里没有 layout.default 指向的布局预设");
  process.exit(0);
}

const problems = compareBlueprintWithLayout(graph, JSON.parse(rows));
if (problems.length > 0) {
  console.error("[blueprint-pair] 演示布局与内置默认蓝图不同源：");
  for (const p of problems) console.error(`[blueprint-pair]   - ${p}`);
  console.error(
    "[blueprint-pair] 同步方式：改 `packages/config/src/blueprintDefault.ts` 后跑 " +
      "`pnpm generate:blueprint-fixture`；布局改动则在同一份编辑里同步蓝图。",
  );
  process.exit(1);
}
console.log(
  `[blueprint-pair] 同源：${graph.layers.length} 层 / ${graph.nodes.length} 节点与演示布局一致`,
);
