// check-db-boundary.mjs：SQLite 的「连接配置」只能写在 hp-db 里（D185 护航门禁）。
//
// 为什么需要它：D185 之前，WAL / busy_timeout / foreign_keys / wal_checkpoint 这套开库收库流程
// 被四个句柄（RepoDb / GlobalDb / TagDictDb / TagLibDb）各抄一遍，8 处 pragma 散在 4 个文件里，
// 于是「哪个库有没有 busy_timeout」「关库要不要 checkpoint」只能靠人肉比对，且新增第五个库时
// 一定会再抄第六份。把流程收进 hp-db 之后，本门禁把「不许再抄回去」变成一条断言：
// 在 crates/hp-db/src 之外，任何 .rs 都不许出现 pragma_update / busy_timeout / wal_checkpoint /
// journal_mode 这几个连接级调用。
//
// 另外几条守住拆分后的边界本身（D185 → D186 → D187 → D188 一路拆下来，每一步都补一条反向断言，
// 否则下一个人只要复制一段旧代码就能把拆分悄悄退回去）：
//   · hp-db 不许依赖任何领域 crate（依赖方向单向：领域层 → hp-db）；
//   · hp-store 已经不存在了（D188 拆完删除），任何 crate 都不许再依赖它，也不许把目录加回来；
//   · hp-pathrule 只放纯函数，不许沾 SQLite；
//   · 每个句柄的定义与它的迁移清单只能在自己那个 crate 里，别的 crate 不许回填。
//   · 桥接层的仓库句柄（id / 路径 / 连接）是一个值（D192），装卸只走 commands/shared.rs。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const DB_SRC = join(ROOT, "crates", "hp-db", "src");
const SCAN_ROOTS = [join(ROOT, "crates"), join(ROOT, "apps", "desktop", "src-tauri", "src")];
/// 领域库 crate（拆分后各自的归处）。
const DOMAIN_CRATES = ["hp-repo", "hp-global", "hp-dict"];
/// 连接级配置调用：只允许出现在 hp-db。
const FORBIDDEN = ["pragma_update(", ".busy_timeout(", "wal_checkpoint", "\"journal_mode\""];
/// 每个库句柄：文件、必须出现的开库调用。
const HANDLES = [
  ["crates/hp-repo/src/repo_db.rs", "hp_db::Db::open"],
  ["crates/hp-global/src/global_db.rs", "hp_db::Db::open"],
  ["crates/hp-dict/src/dict_db.rs", "hp_db::Db::open"],
  ["crates/hp-dict/src/tag_lib_db.rs", "hp_db::Db::open"],
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

// ① hp-db 不许依赖任何领域 crate（依赖方向：领域层 → hp-db，永不反向）
const dbManifest = manifestOf("hp-db");
const dbReverse = DOMAIN_CRATES.filter((c) => new RegExp(`^${c} =`, "m").test(dbManifest)).map(
  (c) => `crates/hp-db/Cargo.toml 里出现了 ${c}`,
);
report(dbReverse.length === 0, "hp-db 不依赖任何领域 crate（依赖方向单向）", dbReverse);

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

// ⑤ hp-store 已删除（D188）：目录不许回来，任何 manifest 也不许再依赖它
const storeDirs = [join(ROOT, "crates", "hp-store")].filter((p) => existsSync(p));
const storeRefs = [];
for (const crate of DOMAIN_CRATES.concat(["hp-db", "hp-pathrule", "hp-scanner", "hp-album", "hp-fsops", "hp-ai", "hp-plugin-host"])) {
  if (/^hp-store =/m.test(manifestOf(crate))) storeRefs.push(`crates/${crate}/Cargo.toml 仍依赖 hp-store`);
}
const bridgeManifest = readFileSync(join(ROOT, "apps", "desktop", "src-tauri", "Cargo.toml"), "utf8");
if (/^hp-store =/m.test(bridgeManifest)) storeRefs.push("桥接层 Cargo.toml 仍依赖 hp-store");
report(
  storeDirs.length === 0 && storeRefs.length === 0,
  "hp-store 已删除且无人再依赖（拆完不许复活）",
  storeDirs.map((p) => relative(ROOT, p) + " 目录又出现了").concat(storeRefs),
);

// ⑥ hp-pathrule 只放纯函数：不许沾 SQLite，也不许反向依赖库 crate
const pathruleManifest = manifestOf("hp-pathrule");
const dirtyPathrule = ["rusqlite", "hp-db", "hp-repo", "hp-global", "hp-dict"]
  .filter((needle) => new RegExp(`^${needle} =`, "m").test(pathruleManifest))
  .map((needle) => `crates/hp-pathrule/Cargo.toml 依赖了 ${needle}`);
report(dirtyPathrule.length === 0, "hp-pathrule 不含 SQLite 依赖（纯路径规则）", dirtyPathrule);

// ⑦ 句柄的定义只能在自己那个 crate：别人不许回填（防回填）
const OWNER = [
  ["hp-repo", "RepoDb"],
  ["hp-global", "GlobalDb"],
  ["hp-dict", "TagDictDb"],
  ["hp-dict", "TagLibDb"],
];
const backfill = [];
for (const crate of DOMAIN_CRATES) {
  const files = walk(join(ROOT, "crates", crate, "src"), []);
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const body = stripComments(readFileSync(file, "utf8"));
    for (const [owner, handle] of OWNER) {
      if (owner !== crate && new RegExp(`pub struct ${handle}\\b`).test(body)) {
        backfill.push(`${rel}  又定义了 ${handle}（应在 ${owner}）`);
      }
    }
  }
}
report(backfill.length === 0, `句柄只在各自 crate 定义（扫描 ${DOMAIN_CRATES.length} 个领域 crate）`, backfill);

// ⑧ 反向：句柄必须真的在自己那个 crate（拆完不许两边都没有）
const missing = [];
for (const [crate, handle] of OWNER) {
  const files = walk(join(ROOT, "crates", crate, "src"), []);
  const found = files.some((f) => new RegExp(`pub struct ${handle}\\b`).test(stripComments(readFileSync(f, "utf8"))));
  if (!found) missing.push(`crates/${crate}/src 里找不到 pub struct ${handle}`);
}
report(missing.length === 0, "四个库句柄各自落在 hp-repo / hp-global / hp-dict", missing);

// ⑨ 迁移清单随 crate 走：每个库 crate 的 migrations 目录必须非空且版本号连续
const migrationDirs = [
  ["hp-repo", "repo"],
  ["hp-global", "global"],
  ["hp-dict", "dict"],
  ["hp-dict", "dict_lib"],
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

// ⑩ 仓库句柄单真值（D192）：id / 库文件路径 / 连接在同一个 Option 里，装/卸只走 shared.rs 的助手
//
// 拆分前的写法是三个独立 Mutex（open_repo / current_repo_id / current_repo_path），开库要连加三次锁，
// 且用 `if let Ok(mut cur) = ...` 吞掉毒化错误——于是"库开了但 id/路径还是旧仓库"可观察。这条断言
// 同时钉住两头：不许把字段拆回去，也不许在助手之外直接 `.repo.lock()`（那样又能绕过装卸顺序）。
const BRIDGE_SRC = join(ROOT, "apps", "desktop", "src-tauri", "src");
// D201 起 commands/shared.rs 拆成 commands/shared/*.rs，断言对**整个 shared 目录**求并集：
// 语义不变（「只在这个模块里」），而不是「只在同一个文件里」。
const SHARED_DIR = join(BRIDGE_SRC, "commands", "shared");
const isSharedSource = (rel) =>
  rel.endsWith("commands/shared.rs") || rel.includes("commands/shared/");
// 命令层源码（含子目录）：rel 以 `commands/` 开头，供「取用面」类断言逐个文件扫。
const commandSources = () =>
  walk(join(BRIDGE_SRC, "commands"), []).map((abs) => ({
    abs,
    rel: relative(BRIDGE_SRC, abs).replace(/\\/g, "/"),
  }));
const bridgeFiles = walk(BRIDGE_SRC, []);
const handleOffenders = [];
let repoFieldCount = 0;
for (const file of bridgeFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const body = stripComments(readFileSync(file, "utf8"));
  if (/state\.current_repo_(id|path)\b/.test(body)) {
    handleOffenders.push(`${rel}  仍在读拆分前的 current_repo_id / current_repo_path 字段`);
  }
  if (/current_repo_(id|path)\s*:\s*Arc</.test(body)) {
    handleOffenders.push(`${rel}  又把仓库状态拆成了独立 Mutex`);
  }
  const direct = body.match(/\.repo\s*\.\s*lock\(\)/g) ?? [];
  if (direct.length > 0 && !isSharedSource(rel)) {
    handleOffenders.push(`${rel}  绕过 shared.rs 直接锁 repo（${direct.length} 处）`);
  }
  if (rel.endsWith("/main.rs")) {
    repoFieldCount += (body.match(/pub\(crate\)\s+repo\s*:/g) ?? []).length;
  }
}
if (repoFieldCount !== 1) {
  handleOffenders.push(`main.rs 的 AppState 里 repo 字段数量 = ${repoFieldCount}（应为 1）`);
}
const sharedBody = stripComments(
  readdirSync(SHARED_DIR)
    .filter((n) => n.endsWith(".rs"))
    .sort()
    .map((n) => readFileSync(join(SHARED_DIR, n), "utf8"))
    .join("\n"),
);
for (const needle of [
  "pub(crate) struct OpenRepo",
  "pub(crate) fn set_open_repo",
  "pub(crate) fn take_open_repo",
]) {
  if (!sharedBody.includes(needle)) handleOffenders.push(`commands/shared.rs 缺少 ${needle}`);
}
report(
  handleOffenders.length === 0,
  `仓库句柄只在 commands/shared.rs 装卸（扫描 ${bridgeFiles.length} 个桥接 .rs）`,
  handleOffenders,
);
// ⑪ 其它宿主级状态（D194）：五个互斥量的加锁入口只在 commands/shared.rs
//
// D194 之前，这五个字段的加锁策略散在 4 个文件里、写法有四种：`.ok()?` 静默降级、
// `let Ok(..) else { fallback }`、`if let Ok(..)` 静默跳过、`match ... Err => eprintln!`。
// 最后两种最伤：schema 缓存写不进去、tag 库装配失败，界面看起来「什么都没发生」。
// 统一收进 shared.rs 之后，毒锁文案与锁序（state 级先、repo 后、state 级不嵌套）只有一处定义。
const HOST_STATE_FIELDS = ["global_db", "panel_schema_cache", "supervision", "ai", "tag_lib"];
const HOST_STATE_HELPERS = [
  "pub(crate) fn lock_panel_schema",
  "pub(crate) fn lock_supervision",
  "pub(crate) fn lock_ai",
  "pub(crate) fn lock_tag_lib",
  "pub(crate) fn set_tag_lib",
  "pub(crate) fn try_global",
];
const stateOffenders = [];
const hostLockRe = new RegExp("\\.(" + HOST_STATE_FIELDS.join("|") + ")\\s*\\.\\s*lock\\s*\\(", "g");
for (const file of bridgeFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (isSharedSource(rel)) continue;
  const body = stripComments(readFileSync(file, "utf8"));
  const hits = body.match(hostLockRe) ?? [];
  if (hits.length > 0) {
    stateOffenders.push(`${rel}  绕过 shared.rs 直接加锁（${hits.join(" / ")}）`);
  }
}
for (const needle of HOST_STATE_HELPERS) {
  if (!sharedBody.includes(needle)) stateOffenders.push(`commands/shared.rs 缺少 ${needle}`);
}
report(
  stateOffenders.length === 0,
  `宿主级状态只在 commands/shared.rs 加锁（${HOST_STATE_FIELDS.length} 个互斥量）`,
  stateOffenders,
);
// ⑫ 全局库句柄只有一个入口（D195）：先 ensure 再 lock 的顺序写死在 global_guard 里
//
// 拆分前每个命令都手抄三行（ensure_global → lock_global → global），顺序是**记出来的**：
// 先锁后 ensure 会得到「全局库未初始化」的 not_found，而 repo.rs 的六处又把它写成 Store
// （同一前提、两种错误分类）。D195 把三行合成一次调用，并顺手删掉 ensure_global 的僵尸
// `AppHandle` 参数（它从未被用到，却让 43 个命令白拿一个句柄）。
const globalOffenders = [];
let globalGuardFiles = 0;
for (const file of bridgeFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (isSharedSource(rel)) continue;
  const body = stripComments(readFileSync(file, "utf8"));
  if (/\block_global\s*\(/.test(body)) {
    globalOffenders.push(`${rel}  绕过 global_guard 直接加锁`);
  }
  if (/HpError::(Store|NotFound)\("全局库未初始化"/.test(body)) {
    globalOffenders.push(`${rel}  手抄「全局库未初始化」的错误映射（应走 global()）`);
  }
  const reads = (body.match(/\bglobal(_mut)?\s*\(&/g) ?? []).length;
  if (reads > 0 && !/\bglobal_guard\s*\(/.test(body)) {
    globalOffenders.push(`${rel}  取了全局库句柄却没用 global_guard（${reads} 处 global 调用）`);
  }
  if (/\bglobal_guard\s*\(/.test(body)) globalGuardFiles++;
}
for (const needle of [
  "pub(crate) fn global_guard",
  "pub(crate) fn ensure_global(state: &AppState)",
]) {
  if (!sharedBody.includes(needle)) globalOffenders.push(`commands/shared.rs 缺少 ${needle}`);
}
report(
  globalOffenders.length === 0,
  `全局库句柄只经 global_guard 取（${globalGuardFiles} 个文件）`,
  globalOffenders,
);

// ⑬ 布局命令只在一次持锁内跑完（D198）
//
// 12 个 layout 命令原先各抄一遍「global_guard(&state)? → global/global_mut(&guard)?」再包一层
// IIFE，读命令与写命令只靠 `mut` 二字区分；更隐蔽的是 `layout.export` 把 `std::fs::write`
// 放在持锁的临界区里——写盘慢一点，整个全局库（其它所有命令）都被挡住。
// 现在统一走 `with_global` / `with_global_mut`：闭包一出作用域 guard 就落，落盘留在锁外。
const layoutPath = join(BRIDGE_SRC, "commands", "layout.rs");
const layoutBody = stripComments(readFileSync(layoutPath, "utf8"));
const layoutOffenders = [];
for (const needle of ["pub(crate) fn with_global", "pub(crate) fn with_global_mut"]) {
  if (!sharedBody.includes(needle)) layoutOffenders.push(`commands/shared.rs 缺少 ${needle}`);
}
for (const [re, label] of [
  [/\bglobal_guard\s*\(/, "仍直接取 global_guard"],
  [/\bglobal(_mut)?\s*\(&/, "仍直接调 global / global_mut"],
]) {
  const hits = (layoutBody.match(re) ?? []).length;
  if (hits > 0) layoutOffenders.push(`commands/layout.rs  ${label}（${hits} 处，应走 with_global*）`);
}
const withGlobalCalls = (layoutBody.match(/\bwith_global(_mut)?\s*\(&state/g) ?? []).length;
if (withGlobalCalls < 12) {
  layoutOffenders.push(`commands/layout.rs  只有 ${withGlobalCalls} 处 with_global* 调用（12 个命令应各一处）`);
}
const writeAt = layoutBody.indexOf("std::fs::write");
const lockAt = layoutBody.indexOf("with_global(&state");
if (writeAt < 0) {
  layoutOffenders.push("commands/layout.rs  找不到导出落盘的 std::fs::write");
} else if (lockAt < 0 || writeAt < lockAt) {
  layoutOffenders.push("commands/layout.rs  导出落盘仍在持锁临界区内（应在 with_global 之后）");
}
report(
  layoutOffenders.length === 0,
  `布局命令只在一次持锁内跑完（${withGlobalCalls} 处 with_global*，落盘在锁外）`,
  layoutOffenders,
);

// ⑭ 装卸仓库句柄按 id 匹配（D199）
//
// `repo.delete` 与 `repo.rename` 原先都是「先读 `current_repo_id` 判断，再单独持锁装卸」。
// 两步之间被别的命令换库，这一刀就切在别人身上：delete 会关掉另一个库（并把它的文件删掉），
// rename 会把名字写进另一个库的 meta。现在判断与动作在同一次持锁内（`take_open_repo_if` /
// `with_open_repo_mut`），且只有 `repo_close`（关的是「当前」这个语义）还能用无条件 `take_open_repo`。
// 同一条断言顺手钉住「删除库文件不许静默失败」：`let _ = std::fs::remove_file` 会把
// 占用 / 权限失败吞掉，注册行删了、库文件还留在盘上。
const repoCmdPath = join(BRIDGE_SRC, "commands", "repo.rs");
const repoCmdBody = stripComments(readFileSync(repoCmdPath, "utf8"));
const repoHandleOffenders = [];
for (const needle of ["pub(crate) fn take_open_repo_if", "pub(crate) fn with_open_repo_mut"]) {
  if (!sharedBody.includes(needle)) repoHandleOffenders.push(`commands/shared.rs 缺少 ${needle}`);
}
const unconditionalTakes = (repoCmdBody.match(/\btake_open_repo\s*\(/g) ?? []).length;
if (unconditionalTakes > 1) {
  repoHandleOffenders.push(`commands/repo.rs  仍有 ${unconditionalTakes} 处无条件 take_open_repo（只允许 repo.close 一处）`);
}
if (!/\btake_open_repo_if\s*\(/.test(repoCmdBody)) {
  repoHandleOffenders.push("commands/repo.rs  repo.delete 没有按 id 卸句柄（take_open_repo_if）");
}
if (!/\bwith_open_repo_mut\s*\(/.test(repoCmdBody)) {
  repoHandleOffenders.push("commands/repo.rs  repo.rename 没有按 id 改句柄（with_open_repo_mut）");
}
// 只钉 `repo.delete`：封面清理（`commands/book/cover.rs`）是 best-effort 的孤儿文件回收，
// 删不掉不影响正确性；而仓库库文件删不掉会让「已删除的仓库」继续占着磁盘。
if (/let\s+_\s*=\s*std::fs::remove_file/.test(repoCmdBody)) {
  repoHandleOffenders.push(
    "commands/repo.rs  静默忽略 remove_file 失败（只允许忽略 NotFound）",
  );
}
report(
  repoHandleOffenders.length === 0,
  "仓库句柄的装卸按 id 匹配，删除失败不静默（repo.delete / repo.rename）",
  repoHandleOffenders,
);

// ⑮ 仓库库取用只有一个入口（D200）
//
// 拆分前每个命令都手抄 `lock_repo(&state)? → open_repo(&guard)?` 两行，而签名上的 `repo_id`
// 一律被 `let _ = repo_id;` 丢掉（file.rs 9 处、source.rs 6 处）：前端拿旧快照再来一次，
// 要么查空（`list_mounted_sources(旧 id)` 静默返回空列表），要么把结果写进当前库。
// 现在统一走 `with_repo` / `with_repo_mut`：id 与当前句柄不一致时返回 not_found，
// 后台任务则在起线程之前用 `ensure_repo_binding` 校验掉。
const repoEntryOffenders = [];
for (const needle of [
  "pub(crate) fn with_repo<T>",
  "pub(crate) fn with_repo_mut<T>",
  "pub(crate) fn ensure_repo_binding",
  "fn check_repo_id",
]) {
  if (!sharedBody.includes(needle)) repoEntryOffenders.push(`commands/shared.rs 缺少 ${needle}`);
}
let repoEntryFiles = 0;
for (const file of commandSources()) {
  if (isSharedSource(file.rel)) continue;
  const body = stripComments(readFileSync(file.abs, "utf8"));
  const usesRepo = /\bwith_repo(_mut)?\s*\(/.test(body) || /\bRepoDb\b/.test(body);
  if (!usesRepo) continue;
  repoEntryFiles++;
  const legacy = (body.match(/\b(lock_repo|open_repo|open_repo_mut)\s*\(/g) ?? []).length;
  if (legacy > 0) {
    repoEntryOffenders.push(`${file.rel}  仍手抄仓库取用（${legacy} 处，应走 with_repo*）`);
  }
  if (/let\s+_\s*=\s*repo_id\s*;/.test(body)) {
    repoEntryOffenders.push(`${file.rel}  把 repo_id 丢掉（let _ = repo_id），应传给 with_repo* 校验`);
  }
  // `commands/repo.rs` 装卸句柄本身（open/close/delete/rename），不取库；其余一律要有一个取用口。
  if (file.rel !== "commands/repo.rs") {
    const calls = (body.match(/\b(with_repo|with_repo_mut|ensure_repo_binding)\s*\(&state/g) ?? []).length;
    if (calls === 0) repoEntryOffenders.push(`${file.rel}  没有一处 with_repo* 调用`);
  }
}
report(
  repoEntryOffenders.length === 0,
  `仓库库取用只经 with_repo*（${repoEntryFiles} 个命令文件）`,
  repoEntryOffenders,
);

console.log(`\n[check-db-boundary] ${passed}/${total} 通过`);
process.exit(passed === total ? 0 : 1);
