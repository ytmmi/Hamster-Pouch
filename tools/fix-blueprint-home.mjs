/**
 * 修数据：把某仓库默认蓝图的某一层设为**主界面**（D67），并清掉"上次所在层"记录。
 *
 * 用途：旧蓝图没有 `is_home` 标记时，应用进入仓库显示哪一页只能靠"第一个层"隐式回退，
 * 且 `blueprint.currentLayer` 会一直停在历史上某次切换的层（真实反馈："默认进去是界面 2
 * 而不是主界面"）。本工具把它显式化。
 *
 * 用法：
 *   node tools/fix-blueprint-home.mjs                       # dry-run：主界面取第一个层
 *   node tools/fix-blueprint-home.mjs --layer l_main
 *   node tools/fix-blueprint-home.mjs --apply
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");
const layerArgIndex = process.argv.indexOf("--layer");
const WANTED_LAYER = layerArgIndex >= 0 ? process.argv[layerArgIndex + 1] : null;

const REPO_ID = "c07f28d2-57dc-4d73-a9e5-3d943fa9e4f2";
const REPO_DB = join(
  process.env.APPDATA,
  "dev.hamsterpouch.desktop",
  "repos",
  "00c37ce8-8464-4808-8c51-c9af38e86516.sqlite3",
);
const GLOBAL_DB = join(process.env.APPDATA, "dev.hamsterpouch.desktop", "hamster-pouch-global.sqlite3");

const queryRepo = (sql) => execFileSync("sqlite3", ["-json", REPO_DB, sql], { encoding: "utf8", maxBuffer: 64e6 });
const queryGlobal = (sql) => execFileSync("sqlite3", ["-json", GLOBAL_DB, sql], { encoding: "utf8", maxBuffer: 64e6 });

const doc = JSON.parse(JSON.parse(queryRepo("select blueprint_json from blueprints where is_default=1;"))[0].blueprint_json);
const layers = doc.layers ?? [];
if (layers.length === 0) {
  console.error("该蓝图没有显式分层（layers 为空），无需处理。");
  process.exit(1);
}

const home = WANTED_LAYER ?? layers[0].key;
if (!layers.some((l) => l.key === home)) {
  console.error(`层 ${home} 不存在；可选：${layers.map((l) => l.key).join(", ")}`);
  process.exit(1);
}

console.log("层清单:");
for (const l of layers) {
  console.log(`  ${l.key}（${l.name}）${l.key === home ? " ← 设为主界面" : ""}  当前 is_home=${String(l.is_home)}`);
}
doc.layers = layers.map((l) => ({ ...l, is_home: l.key === home }));

// 用真实校验器复核（stdin 喂 JSON；有硬错误时退出码非 0，需捕获后解析输出）。
let report = "";
try {
  report = execFileSync("cargo", ["run", "-q", "-p", "hp-core", "--example", "check-blueprint"], {
    cwd: ROOT,
    input: JSON.stringify(doc),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (e) {
  report = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
}
const hardErrors = Number(/硬错误 \(([0-9]+)\)/.exec(String(report).replace(/\u001b\[[0-9;]*m/g, ""))?.[1] ?? "-1");
console.log(`\n校验：硬错误 ${hardErrors} 条`);
if (hardErrors !== 0) {
  console.error(report);
  console.error("校验未通过，拒绝写库。");
  process.exit(1);
}

const persisted = JSON.parse(
  queryGlobal(`select key, value from app_settings where key='blueprint.currentLayer.${REPO_ID}';`),
);
console.log(`当前持久化的当前层：${persisted[0]?.value ?? "（无记录）"}`);

if (!APPLY) {
  console.log("\ndry-run：加 --apply 才写库。");
  process.exit(0);
}

const backupDir = join(ROOT, "backups");
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const suffix of ["", "-wal", "-shm"]) {
  const src = `${REPO_DB}${suffix}`;
  if (existsSync(src)) copyFileSync(src, join(backupDir, `repo-${stamp}${suffix}`));
}
console.log(`已备份仓库库到 backups/repo-${stamp}*`);

const json = JSON.stringify(doc);
execFileSync("sqlite3", [REPO_DB], {
  input: `update blueprints set blueprint_json = '${json.replace(/'/g, "''")}', updated_at = '${new Date().toISOString()}' where is_default = 1;`,
  encoding: "utf8",
});
// 清掉"上次所在层"：下次进入仓库回退到主界面（否则仍会停在历史层）。
execFileSync("sqlite3", [GLOBAL_DB], {
  input: `delete from app_settings where key='blueprint.currentLayer.${REPO_ID}';`,
  encoding: "utf8",
});

const after = JSON.parse(JSON.parse(queryRepo("select blueprint_json from blueprints where is_default=1;"))[0].blueprint_json);
const homeAfter = (after.layers ?? []).find((l) => l.is_home === true);
const stillPersisted = JSON.parse(
  queryGlobal(`select value from app_settings where key='blueprint.currentLayer.${REPO_ID}';`),
);
console.log(`回读：主界面 = ${homeAfter ? `${homeAfter.key}（${homeAfter.name}）` : "无"}`);
console.log(`回读：currentLayer 记录 = ${stillPersisted[0]?.value ?? "已清除"}`);
process.exit(homeAfter?.key === home ? 0 : 1);
