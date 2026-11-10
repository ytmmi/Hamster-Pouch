/**
 * 生成 Rust 侧内置默认蓝图夹具（crates/hp-store/tests/default_blueprint.json）。
 *
 * 背景：内置默认蓝图常量只有唯一权威来源 `packages/config/src/blueprintDefault.ts`；
 * Rust 测试（`m6_blueprint.rs::default_blueprint_fixture_validates`）需要一个
 * 可 `include_str!` 的 JSON 夹具。本脚本直接读取该 TS 常量并落盘夹具，
 * 避免同一份图在两侧手工维护而漂移。
 *
 * 用法：`pnpm generate:blueprint-fixture`
 *       `pnpm check:blueprint-fixture`（`--check`：只比对不写盘，夹具落后即失败退出）
 * （依赖 Node 原生 TypeScript 类型擦除，Node >= 22.16，见 package.json engines。）
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const sourcePath = join(root, "packages", "config", "src", "blueprintDefault.ts");
const fixturePath = join(root, "crates", "hp-store", "tests", "default_blueprint.json");

const mod = await import(pathToFileURL(sourcePath).href);
const { DEFAULT_BLUEPRINT } = mod;
if (!DEFAULT_BLUEPRINT || !Array.isArray(DEFAULT_BLUEPRINT.nodes)) {
  throw new Error(`未从 ${sourcePath} 读到 DEFAULT_BLUEPRINT`);
}
if (DEFAULT_BLUEPRINT.default_version === undefined) {
  throw new Error("DEFAULT_BLUEPRINT 缺少 default_version：内置默认图必须携带该标记");
}

// 与 hp-core 的序列化风格一致：紧凑 JSON（字段顺序按对象字面量顺序）。
const json = JSON.stringify(DEFAULT_BLUEPRINT);
const expected = `${json}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(fixturePath, "utf8").catch(() => "");
  if (current !== expected) {
    console.error(
      `[blueprint-fixture] 夹具与 DEFAULT_BLUEPRINT 不一致：${fixturePath}\n` +
        "[blueprint-fixture] 跑 `pnpm generate:blueprint-fixture` 重新生成" +
        "（改动内置默认蓝图后必须同步）。",
    );
    process.exit(1);
  }
  console.log(
    `[blueprint-fixture] 夹具与 DEFAULT_BLUEPRINT 一致` +
      `（${DEFAULT_BLUEPRINT.nodes.length} 节点 / ${DEFAULT_BLUEPRINT.edges.length} 边）`,
  );
} else {
  await writeFile(fixturePath, expected, "utf8");
  const written = await readFile(fixturePath, "utf8");
  console.log(
    `默认蓝图夹具已写入 ${fixturePath}（${DEFAULT_BLUEPRINT.nodes.length} 节点 / ${DEFAULT_BLUEPRINT.edges.length} 边，${written.length} 字节）`,
  );
}
