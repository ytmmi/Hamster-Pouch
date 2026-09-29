// check-status.mjs：守护 docs/architecture/implementation-status.md 的**机械一致性**。
//
// 为什么需要它：这份总账是「规范出处 + 代码证据 + 状态」三要素表格，靠人工追赶代码。
// 2026-09 连续踩到三轮**分层滞后**（六阶段实现会话落地 → 原对账过期；本会话改契约 → §2.7 过期；
// 修 §2.7 又使 §1 计数失效）。本脚本把"能机械判定的部分"全部前置，人只负责判断对错。
//
// 断言四类（权威描述见 docs/architecture/implementation-status.md 第 6 节）：
//   A 结构可解析：§1 的两张表与 §2 的每个分节都能定位
//   B 状态取值合法：状态列只取 ✅ / 🟡 / ⬜ / ⚠️ / 🟦
//   C 计数自洽（§1 ↔ §2 双向）：分节表行内自洽、列和 == 汇总、§2 实际行数与状态分布 == §1 声明
//   D 引用可解析且在界内：`路径[:N[-M]]` 必须存在，且行号不得超出该文件实际行数
//
// D 是抓"代码移动了、行号过期"的关键：行号一旦越界，说明该行证据已失效，必须复核。
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DOC = "docs/architecture/implementation-status.md";
const ROOT = process.cwd();
const STATUSES = ["✅", "🟡", "⬜", "⚠️", "🟦"];
const SUMMARY = [
  ["✅", "✅ 已实现"],
  ["🟡", "🟡 部分实现"],
  ["⬜", "⬜ 未实现"],
  ["⚠️", "⚠️ 与规范不符"],
  ["🟦", "🟦 契约先行"],
];

// 简写路径的解析前缀（按优先级）。文档允许写 `commands/repo.rs:268` 这类简写，也允许写全路径；
// 解析出候选集合后取**最宽松**的行数上界，避免同一文件名落在多个 crate 时误报。
const PREFIXES = [
  "",
  "apps/desktop/src-tauri/src/",
  "apps/desktop/src/app_ui/shared/",
  "apps/desktop/src/app_ui/",
  "apps/desktop/src/",
  "crates/hp-core/src/",
  "crates/hp-store/src/",
  "crates/hp-plugin-host/src/",
  "crates/hp-media/src/",
  "packages/config/src/",
  "packages/ui/src/",
  "tools/",
];

// `路径[:N[-M]]`，以及紧随其后的 `-`M`` 形式（文档同时使用这两种写法）。
const REF_RE =
  /`([^`\s]*\/[^`\s]*?\.(?:rs|ts|tsx|mjs|cjs|json|jsonc|sql|md|toml|ya?ml))(?::(\d+)(?:[-–](\d+))?)?`(?:\s*[-–]\s*`(\d+)`)?/g;

let failed = false;
const fail = (m) => {
  console.error(`[check-status] ${m}`);
  failed = true;
};

// 本账（`implementation-status.md`）属**私人开发部分**：按 `.gitignore` 的「文档」段不入库
// （它含"本机索引库实测"这类私有证据，且引用的 `roadmap/` 行号在本机之外无意义）。
// 因此新克隆的仓库里没有这份文档——此时明确"跳过"而不是抛异常，避免崩栈。
//
// 注意与另外三条门禁的分工：`check-panels` / `check-settings` / `check-commands` 读取的是
// **必要文档**（`docs/spec/**`），那些**已入库**，所以它们在新克隆里必须能跑（不再有"缺 docs
// 就崩"的情况）；只有本门禁守护的这本账是私人的。
if (!existsSync(DOC)) {
  console.log(
    `[check-status] 跳过：${DOC} 不存在（本账属私人开发部分，未入库）。` +
      `本门禁只在持有本地 docs/ 的工作副本上有意义。`,
  );
  process.exit(0);
}

const text = readFileSync(DOC, "utf8");
const lines = text.split("\n");

// 表格单元格：按未转义的 `|` 切分（文档用 `\|` 表示字面竖线，如 `{ value \| null }`）。
function cells(line) {
  const parts = line.split(/(?<!\\)\|/);
  if (parts.length && parts[0].trim() === "") parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === "") parts.pop();
  return parts.map((c) => c.trim());
}
const isRow = (l) => l.startsWith("|") && !isSep(l);
const isSep = (l) => l.startsWith("|") && /^\|[\s:|-]+\|?$/.test(l);

// ── §1 汇总表（| 状态 | 条目数 |）────────────────────────────────────────────
const summaryIdx = lines.findIndex((l) => cells(l).join("|") === "状态|条目数");
if (summaryIdx < 0) fail("A：找不到 §1 汇总表（表头应为 `| 状态 | 条目数 |`）");
const summary = new Map();
let summaryTotal = null;
if (summaryIdx >= 0) {
  for (let i = summaryIdx + 1; i < lines.length && lines[i].startsWith("|"); i++) {
    if (isSep(lines[i])) continue;
    const c = cells(lines[i]);
    const hit = SUMMARY.find(([, label]) => c[0] === label);
    if (hit) {
      const n = Number(c[1]);
      if (!Number.isInteger(n)) fail(`C：汇总表「${c[0]}」的条目数不是整数：${c[1]}`);
      else summary.set(hit[0], n);
    } else if (c[0].includes("合计")) {
      summaryTotal = Number(String(c[1]).replace(/[*\s]/g, ""));
    }
  }
}
for (const [emoji, label] of SUMMARY) {
  if (!summary.has(emoji)) fail(`A：汇总表缺少行「${label}」`);
}

// ── §1 分节计数表（| 分节 | 条目 | ✅ | 🟡 | ⬜ | ⚠️ | 🟦 |）────────────────────
const sectionIdx = lines.findIndex(
  (l) => cells(l).join("|") === `分节|条目|${STATUSES.join("|")}`,
);
if (sectionIdx < 0) {
  fail("A：找不到 §1 分节计数表（表头应为 `| 分节 | 条目 | ✅ | 🟡 | ⬜ | ⚠️ | 🟦 |`）");
}
const declared = new Map(); // "2.3" -> { name, items, counts[] }
if (sectionIdx >= 0) {
  for (let i = sectionIdx + 1; i < lines.length && lines[i].startsWith("|"); i++) {
    if (isSep(lines[i])) continue;
    const c = cells(lines[i]);
    const key = (c[0].match(/^(2\.\d+)/) || [])[1];
    if (!key) continue;
    const nums = c.slice(1).map(Number);
    if (nums.length !== 6 || nums.some((n) => !Number.isInteger(n))) {
      fail(`C：分节表「${c[0]}」数值列异常：${c.slice(1).join(" / ")}`);
      continue;
    }
    declared.set(key, { name: c[0], items: nums[0], counts: nums.slice(1) });
  }
}

// 分节表 ←→ 汇总表
if (sectionIdx >= 0 && summaryIdx >= 0) {
  const colSum = STATUSES.map(() => 0);
  let itemSum = 0;
  for (const { items, counts } of declared.values()) {
    itemSum += items;
    counts.forEach((n, k) => (colSum[k] += n));
  }
  STATUSES.forEach((s, k) => {
    const n = summary.get(s);
    if (n !== undefined && n !== colSum[k]) {
      fail(`C：汇总表 ${s} 记 ${n}，分节表列和却是 ${colSum[k]}`);
    }
  });
  if (summaryTotal !== null && summaryTotal !== itemSum) {
    fail(`C：汇总表合计 ${summaryTotal}，分节表条目之和 ${itemSum}`);
  }
  for (const { name, items, counts } of declared.values()) {
    const s = counts.reduce((a, b) => a + b, 0);
    if (s !== items) fail(`C：分节表「${name}」条目 ${items} ≠ 各状态之和 ${s}`);
  }
}

// ── §2 各分节：实际行数与状态分布（状态列按表头「状态」定位）──────────────────
const actual = new Map(); // "2.3" -> { rows, counts:Map }
{
  let cur = null;
  let statusCol = -1;
  for (const line of lines) {
    const h = line.match(/^### (2\.\d+)\b/);
    if (h) {
      cur = { key: h[1], rows: 0, counts: new Map() };
      actual.set(h[1], cur);
      statusCol = -1;
      continue;
    }
    if (/^#{2,3} /.test(line)) {
      cur = null;
      continue;
    }
    if (!cur || !isRow(line)) continue;
    const c = cells(line);
    if (statusCol < 0) {
      statusCol = c.findIndex((x) => x === "状态");
      if (statusCol < 0) {
        fail(`A：§${cur.key} 的表格没有「状态」列`);
        cur = null;
      }
      continue;
    }
    cur.rows++;
    const v = (c[statusCol] || "").replace(/\*\*/g, "").trim();
    if (!STATUSES.includes(v)) {
      fail(`B：§${cur.key} 第 ${c[0]} 行状态取值非法：「${v}」（只允许 ${STATUSES.join(" ")}）`);
      continue;
    }
    cur.counts.set(v, (cur.counts.get(v) || 0) + 1);
  }
}

// §2 实际 ←→ §1 声明
for (const [key, info] of actual) {
  const d = declared.get(key);
  if (!d) {
    fail(`A：§${key} 在 §2 存在，但 §1 分节表没有对应行`);
    continue;
  }
  if (info.rows !== d.items) {
    fail(`C：§${key} 实际 ${info.rows} 行，§1 分节表声明 ${d.items} 条`);
  }
  STATUSES.forEach((s, k) => {
    const n = info.counts.get(s) || 0;
    if (n !== d.counts[k]) {
      fail(`C：§${key} 实际 ${s} 有 ${n} 行，§1 分节表声明 ${d.counts[k]}`);
    }
  });
}
for (const key of declared.keys()) {
  if (!actual.has(key)) fail(`A：§1 分节表有 ${key}，但 §2 找不到该分节`);
}

// ── D：路径:行号 引用必须可解析且在界内 ──────────────────────────────────────
const lineCountCache = new Map();
function lineCount(rel) {
  if (!lineCountCache.has(rel)) {
    const t = readFileSync(join(ROOT, rel), "utf8");
    const parts = t.split("\n");
    lineCountCache.set(rel, t.endsWith("\n") ? parts.length - 1 : parts.length);
  }
  return lineCountCache.get(rel);
}
function resolveCandidates(ref) {
  const out = [];
  for (const p of PREFIXES) {
    const rel = p + ref;
    const abs = join(ROOT, rel);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) out.push(rel);
    } catch {
      /* 忽略不可读项 */
    }
  }
  return out;
}

let inFence = false;
let refCount = 0;
for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  if (/^\s*```/.test(raw)) {
    inFence = !inFence;
    continue;
  }
  if (inFence) continue;
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(raw)) !== null) {
    const [, ref, n1, n2, n3] = m;
    refCount++;
    const cands = resolveCandidates(ref);
    if (cands.length === 0) {
      fail(`D：${DOC}:${i + 1} 引用无法解析为仓库内文件：\`${ref}\`（补全路径，或在脚本 PREFIXES 里加规则）`);
      continue;
    }
    const bound = Math.max(...cands.map(lineCount));
    for (const rawN of [n1, n2, n3]) {
      if (rawN === undefined) continue;
      const n = Number(rawN);
      if (n > bound) {
        fail(
          `D：${DOC}:${i + 1} \`${ref}\` 引用行 ${n} 超出文件行数 ${bound}` +
            `（候选：${cands.join(" / ")}）——该行证据很可能已失效`,
        );
      }
    }
  }
}

if (!failed) {
  console.log(
    `[check-status] OK：§1/§2 计数自洽（合计 ${summaryTotal ?? "?"} 条）、` +
      `${actual.size} 个分节状态合法、${refCount} 处路径引用可解析且在界内`,
  );
}
process.exit(failed ? 1 : 0);
