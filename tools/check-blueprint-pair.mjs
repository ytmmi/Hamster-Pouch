#!/usr/bin/env node
/**
 * 门禁：随包「演示布局」与内置默认蓝图必须同源（D155）。
 *
 * 比对两组对：
 *   - **代码侧**（CI 也跑）：`packages/config/src/layoutDefault.ts` 的 `DEFAULT_LAYOUT_LAYERS`
 *     ←→ `crates/hp-store/tests/default_blueprint.json`（后者由 `generate:blueprint-fixture`
 *     从 `blueprintDefault.ts` 生成）。这是 D158 之后"全新安装开箱即一体"的那一对：
 *     出厂播种用的就是这份布局，蓝图补种用的是那份蓝图。
 *   - **本机演示布局**（仅维护机）：全局库 `layout_presets` 里 `layout.default` 指向的那一行
 *     （发布包会把它改名为「演示布局」并清空蓝图绑定，见 `tools/package-build.mjs`）。
 *
 * 没有全局库（全新克隆 / CI）时只跑代码侧那一对——正是 CI 需要的那一半（D157 的缺口就是
 * 它没被守住：CI 包不带全局库，旧门禁直接跳过）。
 *
 * 用法：`node tools/check-blueprint-pair.mjs [--db <全局库路径>]`
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareBlueprintWithLayout } from "./blueprint-pair.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codeLayoutPath = join(root, "packages", "config", "src", "layoutDefault.ts");
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

const graph = JSON.parse(readFileSync(fixturePath, "utf8"));

// 第一组：代码里的出厂布局 ←→ 内置默认蓝图（CI 也跑）。
let failed = false;
try {
  const { DEFAULT_LAYOUT_LAYERS } = await import(pathToFileURL(codeLayoutPath).href);
  const problems = compareBlueprintWithLayout(graph, DEFAULT_LAYOUT_LAYERS);
  if (problems.length > 0) {
    console.error("[blueprint-pair] 出厂默认布局与内置默认蓝图不同源：");
    for (const p of problems) console.error(`[blueprint-pair]   - ${p}`);
    console.error(
      "[blueprint-pair] 同步方式：同一份编辑里同时改 `packages/config/src/layoutDefault.ts` " +
        "与 `blueprintDefault.ts`（后者改完跑 `pnpm generate:blueprint-fixture`）。",
    );
    failed = true;
  } else {
    console.log(
      `[blueprint-pair] 出厂布局同源：${graph.layers.length} 层 / ${graph.nodes.length} 节点`,
    );
  }
} catch (e) {
  console.error(`[blueprint-pair] 读取出厂默认布局失败：${String(e)}`);
  failed = true;
}
if (failed) process.exit(1);

const dbIndex = process.argv.indexOf("--db");
const dbPath = dbIndex >= 0 ? resolve(process.argv[dbIndex + 1] ?? "") : defaultDb;

if (!existsSync(dbPath)) {
  console.log(`[blueprint-pair] 跳过演示布局比对：没有全局库（${dbPath}）；出厂布局已在上一步比对`);
  process.exit(0);
}

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
  console.log("[blueprint-pair] 跳过演示布局比对：全局库里没有 layout.default 指向的布局预设");
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
