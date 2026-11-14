// check-db-boundary.mjs：SQLite 的「连接配置」只能写在 hp-db 里（D185 护航门禁）。
//
// 为什么需要它：D185 之前，WAL / busy_timeout / foreign_keys / wal_checkpoint 这套开库收库流程
// 被四个句柄（RepoDb / GlobalDb / TagDictDb / TagLibDb）各抄一遍，8 处 pragma 散在 4 个文件里，
// 于是「哪个库有没有 busy_timeout」「关库要不要 checkpoint」只能靠人肉比对，且新增第五个库时
// 一定会再抄第六份。把流程收进 hp-db 之后，本门禁把「不许再抄回去」变成一条断言：
// 在 crates/hp-db/src 之外，任何 .rs 都不许出现 pragma_update / busy_timeout / wal_checkpoint /
// journal_mode 这几个连接级调用。
//
// 另外两条守住这条边界本身的方向：hp-db **不许**依赖 hp-store（否则又是环），
// 也不许把 schema 内联进来（include_str! 意味着迁移清单又下沉了一层——那是 S2 的事）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const DB_SRC = join(ROOT, "crates", "hp-db", "src");
const SCAN_ROOTS = [join(ROOT, "crates"), join(ROOT, "apps", "desktop", "src-tauri", "src")];
/// 连接级配置调用：只允许出现在 hp-db。
const FORBIDDEN = ["pragma_update(", ".busy_timeout(", "wal_checkpoint", "\"journal_mode\""];
/// 四个句柄必须走 hp_db::Db（不许自己开 Connection）。
const HANDLES = [
  ["crates/hp-repo/src/repo_db.rs", "hp_db::Db::open"],
  ["crates/hp-store/src/global/global_db.rs", "hp_db::Db::open"],
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

// ① hp-db 不许依赖 hp-store（依赖方向：领域层 → hp-db，永不反向）
const dbManifest = readFileSync(join(ROOT, "crates", "hp-db", "Cargo.toml"), "utf8");
report(
  !/hp-store/.test(dbManifest),
  "hp-db 不依赖 hp-store（依赖方向单向）",
  ["crates/hp-db/Cargo.toml 里出现了 hp-store"],
);

// ② hp-db 不许内联 schema / 迁移清单（那是 S2 的事）
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

// ⑤ hp-repo 不许依赖 hp-store（仓库库已从 hp-store 拆出，反向依赖又会成环）
const repoManifest = readFileSync(join(ROOT, "crates", "hp-repo", "Cargo.toml"), "utf8");
report(
  !/hp-store/.test(repoManifest),
  "hp-repo 不依赖 hp-store（依赖方向单向）",
  ["crates/hp-repo/Cargo.toml 里出现了 hp-store"],
);

// ⑥ 仓库库的句柄与迁移清单只在 hp-repo：hp-store 不许再长出 repo 模块（防回填）
const storeSrc = walk(join(ROOT, "crates", "hp-store", "src"), []);
const backfill = [];
for (const file of storeSrc) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const body = stripComments(readFileSync(file, "utf8"));
  if (/pub struct RepoDb\b/.test(body)) backfill.push(`${rel}  又定义了 RepoDb`);
  if (body.includes("include_str!(\"../../migrations/repo/")) backfill.push(`${rel}  又内联了仓库库迁移`);
}
report(
  backfill.length === 0,
  `仓库库句柄与迁移只在 hp-repo（扫描 hp-store/src ${storeSrc.length} 个 .rs）`,
  backfill,
);
console.log(`\n[check-db-boundary] ${passed}/${total} 通过`);
process.exit(passed === total ? 0 : 1);