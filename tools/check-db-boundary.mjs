// check-db-boundary.mjs：SQLite 的「连接配置」只能写在 hp-db 里（D185 护航门禁）。
//
// 为什么需要它：D185 之前，WAL / busy_timeout / foreign_keys / wal_checkpoint 这套开库收库流程
// 被四个句柄（RepoDb / GlobalDb / TagDictDb / TagLibDb）各抄一遍，8 处 pragma 散在 4 个文件里，
// 于是「哪个库有没有 busy_timeout」「关库要不要 checkpoint」只能靠人肉比对，且新增第五个库时
// 一定会再抄第六份。把流程收进 hp-db 之后，本门禁把「不许再抄回去」变成一条断言：
// 在 crates/hp-db/src 之外，任何 .rs 都不许出现 pragma_update / busy_timeout / wal_checkpoint /
// journal_mode 这几个连接级调用。
//
// 另外几条守住拆分后的边界本身（D185 → D186 → D187 一路拆下来，每一步都补一条反向断言，
// 否则下一个人只要复制一段旧代码就能把拆分悄悄退回去）：
//   · hp-db 不许依赖 hp-store，也不许内联 schema/迁移清单；
//   · hp-repo / hp-global 不许依赖 hp-store（依赖方向单向：领域层 → 库 crate）；
//   · hp-pathrule 只放纯函数，不许沾 SQLite（不依赖 rusqlite / hp-db / hp-store）；
//   · 每个句柄的定义与它的迁移清单只能在自己那个 crate 里，hp-store 不许回填。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const DB_SRC = join(ROOT, "crates", "hp-db", "src");
const SCAN_ROOTS = [join(ROOT, "crates"), join(ROOT, "apps", "desktop", "src-tauri", "src")];
/// 连接级配置调用：只允许出现在 hp-db。
const FORBIDDEN = ["pragma_update(", ".busy_timeout(", "wal_checkpoint", "\"journal_mode\""];
/// 每个库句柄：文件、必须出现的开库调用、句柄是否允许定义在这个文件所属的 crate。
const HANDLES = [
  ["crates/hp-repo/src/repo_db.rs", "hp_db::Db::open"],
  ["crates/hp-global/src/global_db.rs", "hp_db::Db::open"],
  ["crates/hp-store/src/dict/dict_db.rs", "hp_db::Db::open"],
  ["crates/hp-store/src/dict/tag_lib_db.rs", "hp_db::Db::open"],
];

let total = 0;
let passed = 0;
function report(ok, label, detail) {
  total += 1;
  if (ok) {
    passed += 1;
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    for (const d of detail ?? []) console.error(`        ${d}`);
  }
  return ok;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/\s.*$/gm, "");
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

function manifestOf(crate) {
  return readFileSync(join(ROOT, "crates", crate, "Cargo.toml"), "utf8");
}

// ① hp-db 不许依赖 hp-store（依赖方向：领域层 → hp-db，永不反向）
report(
  !/hp-store/.test(manifestOf("hp-db")),
  "hp-db 不依赖 hp-store（依赖方向单向）",
  ["crates/hp-db/Cargo.toml 里出现了 hp-store"],
);

// ② hp-db 不许内联 schema / 迁移清单（那是各库 crate 的事）
const dbFiles = walk(DB_SRC, []);
const inlineSql = dbFiles.filter((f) => stripComments(readFileSync(f, "utf8")).includes("include_str!"));
report(
  inlineSql.length === 0,
  `hp-db 只放连接骨架，不含内联 SQL/迁移（${dbFiles.length} 个文件）`,
  inlineSql.map((f) => relative(ROOT, f)),
);

// ③ 连接级配置只允许在 crates/hp-db/src
const scanned = [];
for (const dir of SCAN_ROOTS) walk(dir, scanned);
const offenders = [];
for (const file of scanned) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (rel.startsWith("crates/hp-db/src/")) continue;
  const body = stripComments(readFileSync(file, "utf8"));
  const rows = body.split(/\r?\n/);
  for (let i = 0; i < rows.length; i += 1) {
    for (const token of FORBIDDEN) {
      if (rows[i].includes(token)) offenders.push(`${rel}:${i + 1}  ${token}`);
    }
  }
}
report(
  offenders.length === 0,
  `pragma / 检查点调用只出现在 crates/hp-db/src（扫描 ${scanned.length} 个 .rs）`,
  offenders.slice(0, 20),
);

// ④ 四个句柄都经 hp_db::Db 打开，不再自己开 Connection
const badHandles = [];
for (const [rel, needle] of HANDLES) {
  const body = stripComments(readFileSync(join(ROOT, rel), "utf8"));
  if (!body.includes(needle)) badHandles.push(`${rel}  未找到 ${needle}`);
  if (body.includes("Connection::open(")) badHandles.push(`${rel}  仍自行 Connection::open(`);
}
report(badHandles.length === 0, `四个库句柄均经 hp-db 打开（${HANDLES.length} 个句柄）`, badHandles);

// ⑤ hp-repo / hp-global 都不许依赖 hp-store（拆出来了又被依赖回去就成环）
const reverseDeps = [];
for (const crate of ["hp-repo", "hp-global"]) {
  if (/hp-store/.test(manifestOf(crate))) reverseDeps.push(`crates/${crate}/Cargo.toml 里出现了 hp-store`);
}
report(reverseDeps.length === 0, "hp-repo / hp-global 不依赖 hp-store（依赖方向单向）", reverseDeps);

// ⑥ hp-pathrule 只放纯函数：不许沾 SQLite，也不许反向依赖库 crate
const pathruleManifest = manifestOf("hp-pathrule");
const dirtyPathrule = ["rusqlite", "hp-db", "hp-store", "hp-repo"]
  .filter((needle) => new RegExp(`^${needle} =`, "m").test(pathruleManifest))
  .map((needle) => `crates/hp-pathrule/Cargo.toml 依赖了 ${needle}`);
report(dirtyPathrule.length === 0, "hp-pathrule 不含 SQLite 依赖（纯路径规则）", dirtyPathrule);

// ⑦ 句柄的定义只能在自己那个 crate：hp-store 不许回填 repo/global（防回填）
const storeSrc = walk(join(ROOT, "crates", "hp-store", "src"), []);
const backfill = [];
for (const file of storeSrc) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const body = stripComments(readFileSync(file, "utf8"));
  for (const handle of ["RepoDb", "GlobalDb"]) {
    if (new RegExp(`pub struct ${handle}\\b`).test(body)) backfill.push(`${rel}  又定义了 ${handle}`);
  }
  if (body.includes("include_str!(\"../../migrations/repo/")) backfill.push(`${rel}  又内联了仓库库迁移`);
  if (body.includes("include_str!(\"../../migrations/global/")) backfill.push(`${rel}  又内联了全局库迁移`);
}
report(
  backfill.length === 0,
  `仓库库/全局库句柄与迁移不在 hp-store（扫描 hp-store/src ${storeSrc.length} 个 .rs）`,
  backfill,
);

// ⑧ 反向：句柄必须真的在自己那个 crate（拆完不许两边都没有）
const missing = [];
const expected = [
  ["hp-repo", "RepoDb"],
  ["hp-global", "GlobalDb"],
];
for (const [crate, handle] of expected) {
  const files = walk(join(ROOT, "crates", crate, "src"), []);
  const found = files.some((f) => new RegExp(`pub struct ${handle}\\b`).test(stripComments(readFileSync(f, "utf8"))));
  if (!found) missing.push(`crates/${crate}/src 里找不到 pub struct ${handle}`);
}
report(missing.length === 0, "仓库库/全局库句柄各自落在 hp-repo / hp-global", missing);

// ⑨ 迁移清单随 crate 走：每个库 crate 的 migrations 目录必须非空且版本号连续
const migrationDirs = [
  ["hp-repo", "repo"],
  ["hp-global", "global"],
  ["hp-store", "dict"],
  ["hp-store", "dict_lib"],
];
const badMigrations = [];
for (const [crate, sub] of migrationDirs) {
  const dir = join(ROOT, "crates", crate, "migrations", sub);
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  } catch {
    badMigrations.push(`crates/${crate}/migrations/${sub} 不存在`);
    continue;
  }
  if (names.length === 0) badMigrations.push(`crates/${crate}/migrations/${sub} 里没有 .sql`);
  const versions = names.map((n) => Number(n.slice(0, 4)));
  versions.forEach((v, i) => {
    if (v !== i + 1) badMigrations.push(`crates/${crate}/migrations/${sub} 版本号不连续：${names[i]}`);
  });
}
report(
  badMigrations.length === 0,
  `迁移清单随各自 crate 走（${migrationDirs.length} 个目录，版本号连续）`,
  badMigrations,
);

console.log(`\n[check-db-boundary] ${passed}/${total} 通过`);
process.exit(passed === total ? 0 : 1);
