/**
 * 命令面一致性自检（D76 迁移进度 / D79 前端封装缺口）。
 *
 * 为什么需要它：D76 是**分批**迁移，最容易出的错是两种"半迁移态"——
 * ① 契约已标 `已包装`，桥接层却还裸返回（文档说谎）；
 * ② 契约仍标 `裸返回`，桥接层却已包装（前端拿不到 `data`，调用方静默失效）。
 * 两者都是"单批做完但状态没同步"，靠人眼查 100 多条命令不现实。
 *
 * 断言：
 * 1. **文档 → 代码（已包装）**：`docs/spec/commands-events.md` 第 3 节里每条
 *    `迁移状态 = 已包装` 的命令，桥接层的 `fn <domain>_<action>` 必须返回
 *    `ApiResponse<…>` 或 `ApiAsync<…>`；
 * 2. **文档 → 代码（裸返回）**：标 `裸返回` 的命令**不得**已经包装（防"代码先行、文档没跟"）；
 * 3. **前端封装口径**：已包装的命令在 `api/*.ts` 里必须经 `unwrapApi` 解包
 *    （否则调用方会把 `{ ok, data }` 当领域值用）；
 * 4. **D79**：6 条 tag 关系/摘挂命令的前端封装都在（见
 *    `docs/architecture/implementation-status.md` §2.7 #16）。
 *
 * 用法：pnpm check:commands
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, "docs/spec/commands-events.md");
const BRIDGE_DIR = join(ROOT, "apps/desktop/src-tauri/src/commands");
const API_DIR = join(ROOT, "apps/desktop/src/app_ui/shared/api");

// 契约表格里的字面量（用转义写，避免工具链编码差异把源码弄坏）。
const STATUS_HEADER = "\u8fc1\u79fb\u72b6\u6001"; // 「迁移状态」
const WRAPPED = "\u5df2\u5305\u88c5"; // 「已包装」
const BARE = "\u88f8\u8fd4\u56de"; // 「裸返回」

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// 契约里的命令表（只取第 3 节那些带「迁移状态」列的表）。
const docLines = readFileSync(DOC, "utf8").split("\n");
const contracted = [];
let statusCol = -1;
for (const line of docLines) {
  if (!line.startsWith("|")) {
    statusCol = -1;
    continue;
  }
  const cells = line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim());
  if (statusCol < 0) {
    statusCol = cells.findIndex((c) => c === STATUS_HEADER);
    continue;
  }
  if (/^\|[\s:|-]+\|?$/.test(line)) continue;
  const rawName = (cells[0] ?? "").replace(/\*\*/g, "").trim();
  const name = rawName.replace(/^~~|~~$/g, "").replace(/`/g, "").trim();
  const status = (cells[statusCol] ?? "").replace(/\*\*/g, "").trim();
  // 只认 `domain.action` 形状的行（跳过说明行/空行）。
  if (!/^[a-z][a-z0-9]*\.[a-zA-Z.]+$/.test(name)) continue;
  contracted.push({ name, status, struck: rawName.startsWith("~~") });
}

// 桥接层源码（按文件聚合，便于定位）。
const bridgeFiles = readdirSync(BRIDGE_DIR)
  .filter((f) => f.endsWith(".rs"))
  .map((f) => ({ file: f, src: readFileSync(join(BRIDGE_DIR, f), "utf8") }));

/**
 * 命令名 → Rust 桥接函数名（Tauri 的 `domain.action` ↔ `domain_action` 口径）。
 *
 * 多段域与小驼峰动作都要处理：`album.setMediaType` → `album_set_media_type`、
 * `blueprint.currentLayer.get` → `blueprint_current_layer_get`。
 */
const fnNameOf = (name) =>
  name
    .replace(/\./g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

/** 找 `fn <name>(` 的返回类型片段（到 `{` 为止）。 */
function rustReturnType(name) {
  for (const { file, src } of bridgeFiles) {
    const re = new RegExp(`fn\\s+${name}\\s*\\(`, "g");
    let m;
    while ((m = re.exec(src)) !== null) {
      const rest = src.slice(m.index, m.index + 2000);
      const stop = rest.search(/\{/);
      const head = stop >= 0 ? rest.slice(0, stop) : rest.slice(0, 400);
      const arrow = head.lastIndexOf("->");
      const ret = arrow >= 0 ? head.slice(arrow + 2).trim() : "";
      if (ret) return { file, ret };
    }
  }
  return null;
}

const wrapped = contracted.filter((c) => c.status.includes(WRAPPED) && !c.struck);
const bare = contracted.filter((c) => c.status.includes(BARE) && !c.struck);

const missing = [];
const wronglyWrapped = [];
for (const c of wrapped) {
  const found = rustReturnType(fnNameOf(c.name));
  if (!found || !/Api(Response|Async)</.test(found.ret)) {
    missing.push(
      `${c.name}${found ? ` → ${found.file}: ${found.ret.slice(0, 40)}` : " → 找不到桥接函数"}`,
    );
  }
}
for (const c of bare) {
  const found = rustReturnType(fnNameOf(c.name));
  if (found && /Api(Response|Async)</.test(found.ret)) {
    wronglyWrapped.push(`${c.name}（${found.file}）`);
  }
}

check(
  "契约标 `已包装` 的命令，桥接层确实返回 ApiResponse/ApiAsync",
  missing.length === 0,
  missing.length ? `未落地: ${missing.join(" | ")}` : `共 ${wrapped.length} 条`,
);
check(
  "契约标 `裸返回` 的命令尚未包装（防半迁移态）",
  wronglyWrapped.length === 0,
  wronglyWrapped.length ? `已包装但文档没跟: ${wronglyWrapped.join(" | ")}` : `共 ${bare.length} 条`,
);

// 前端封装口径：已包装的命令必须在 api/*.ts 里解包。
const apiSrc = readdirSync(API_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(join(API_DIR, f), "utf8"))
  .join("\n");

const unwrappedCallers = [];
for (const c of wrapped) {
  const snake = fnNameOf(c.name);
  const idx = apiSrc.indexOf(`"${snake}"`);
  if (idx < 0) continue; // 没有前端封装：属于另一类缺口，不算解包缺失
  if (!apiSrc.slice(idx, idx + 400).includes("unwrapApi")) {
    unwrappedCallers.push(`${c.name}（${snake}）`);
  }
}
check(
  "已包装命令的前端封装经 unwrapApi 解包",
  unwrappedCallers.length === 0,
  unwrappedCallers.length ? `缺解包: ${unwrappedCallers.join(" | ")}` : "",
);

// D79：tag 关系/摘挂命令的前端封装。
const d79 = [
  "tagRelationAdd",
  "tagRelationRemove",
  "tagRelationList",
  "tagRelationParents",
  "tagRelationChildren",
  "tagDetach",
];
const tagApi = readFileSync(join(API_DIR, "tag.ts"), "utf8");
const missingD79 = d79.filter((fn) => !new RegExp(`export function ${fn}\\b`).test(tagApi));
check(
  "D79：tag 关系与摘挂命令的前端封装齐备（6 条，含 add）",
  missingD79.length === 0,
  missingD79.length ? `缺: ${missingD79.join(", ")}` : "",
);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
