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

// D77：事件 DTO 一律 `rename_all = "camelCase"`（与前端 `events.ts` 的驼峰声明同源）。
//
// **DTO 按"桥接层"查找，不按单个文件**：事件 DTO 可以跨命令模块复用（例如 `file.rs` 的
// 单文件分析复用 `source.rs` 的 `scan.progress|completed|error` 三个 DTO —— "同款浮窗"就是
// 靠复用同一条事件实现的）。只要该结构体在桥接层里定义且带 camelCase 属性即通过。
const bridgeAllSrc = bridgeFiles.map((f) => f.src).join("\n");
const snakeEventFields = [];
const missingEventAttr = [];
for (const { file, src } of bridgeFiles) {
  const emitRe = /\.emit_hp\(\s*"([a-z][a-z0-9.]*)",\s*([A-Z][A-Za-z0-9_]*)\s*\{/g;
  let m;
  while ((m = emitRe.exec(src)) !== null) {
    const [, eventName, dto] = m;
    // 该 DTO 的结构体定义必须带 camelCase 属性（属性在 struct 行上方）。
    const structIdx = bridgeAllSrc.search(new RegExp(`struct\\s+${dto}\\b`));
    if (structIdx < 0) {
      missingEventAttr.push(`${eventName} → 找不到 ${dto}`);
      continue;
    }
    const head = bridgeAllSrc.slice(Math.max(0, structIdx - 200), structIdx);
    if (!/rename_all\s*=\s*"camelCase"/.test(head)) {
      missingEventAttr.push(`${eventName}（${dto} @ ${file}）`);
    }
  }
}
check(
  "D77：全部事件 DTO 带 rename_all = camelCase",
  missingEventAttr.length === 0,
  missingEventAttr.length ? `缺: ${missingEventAttr.join(" | ")}` : "",
);

const eventsTs = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/types/events.ts"),
  "utf8",
);
const snakeDecls = [...eventsTs.matchAll(/^\s{2}([a-z]+_[a-z_]+)\??:/gm)].map((x) => x[1]);
check(
  "D77：前端事件类型同样声明为驼峰（无蛇形字段）",
  snakeDecls.length === 0,
  snakeDecls.length ? `蛇形字段: ${[...new Set(snakeDecls)].join(", ")}` : "",
);

// ==================== 单文件分析 = 与源扫描同款的后台任务（2026-09） ====================
//
// 用户口径："右键分析文件，分析时要和源全量时同款弹窗。" 实现方式就是**复用同一族事件**：
// 前端浮窗（`core/taskStore.ts`）只认事件、不认命令，因此这里断言的是"事件族与任务语义一致"，
// 而不是"又写了一个弹窗组件"。

const fileBridgeSrc = readFileSync(
  join(ROOT, "apps/desktop/src-tauri/src/commands/file.rs"),
  "utf8",
);
const tasksSrc = readFileSync(join(ROOT, "apps/desktop/src-tauri/src/tasks.rs"), "utf8");
const scannerSrc = readFileSync(join(ROOT, "crates/hp-scanner/src/scanner.rs"), "utf8");
const taskStoreSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/core/taskStore.ts"),
  "utf8",
);
const mediaPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/MediaPreviewPanel.tsx"),
  "utf8",
);
// 媒体预览面板家族（2026-09 第四轮拆分：工具条 / 会话 / 动作 / 菜单 / 选区各自成文件）。
// **反向断言读整个家族**——拆分不得成为逃离断言的后门（与 `check-panels` 同口径）。
const mediaPanelFamilySrc = [
  "apps/desktop/src/app_ui/panels/MediaPreviewPanel.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewData.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewSession.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewToolbar.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewActions.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewMenu.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewSelection.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewCell.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewDropdown.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewView.ts",
]
  .map((p) => readFileSync(join(ROOT, p), "utf8"))
  .join("\n");
const fileApiSrc = readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/api/file.ts"), "utf8");

check(
  "file.reanalyze 是**后台任务**：登记 TaskKind::Analyze + 独立连接 + 必定发终止事件",
  /pub\(crate\) async fn file_reanalyze\(/.test(fileBridgeSrc) &&
    /ApiAsync<String>/.test(fileBridgeSrc) &&
    /tasks\s*\.start\(&task_id, TaskKind::Analyze\)/.test(fileBridgeSrc) &&
    // 独立仓库库连接：不持有 open_repo 锁（分析大视频时界面别的命令不排队）。
    /RepoDb::open\(repo_path\)/.test(fileBridgeSrc) &&
    // panic 也要收敛成终止事件，否则浮窗永远停在原地。
    /catch_unwind\(std::panic::AssertUnwindSafe/.test(fileBridgeSrc) &&
    /st\.tasks\.finish\(&emit_task_id\);/.test(fileBridgeSrc),
);
check(
  "分析任务复用 scan.* 事件族（= 与源全量同款浮窗），且进度帧标 `pausable: false`",
  /emit_hp\(\s*"scan\.progress"/.test(fileBridgeSrc) &&
    /emit_hp\(\s*"scan\.completed"/.test(fileBridgeSrc) &&
    /emit_hp\(\s*"scan\.error"/.test(fileBridgeSrc) &&
    // 单文件分析没有暂停点：不能发出"可暂停"的信号，否则浮窗会留一个按不动的暂停键。
    /pausable: false,/.test(fileBridgeSrc) &&
    // 总数未知 → 不定进度条（单文件没有"百分比"可言）。
    /processed: 0,\s*\n\s*total: 0,/.test(fileBridgeSrc) &&
    // 整源扫描才是可暂停的那个。
    /pausable: true,/.test(readFileSync(join(ROOT, "apps/desktop/src-tauri/src/commands/source.rs"), "utf8")),
);
check(
  "暂停能力由**事件载荷**决定，不是前端写死（`pausable` 必须在 DTO 与 store 两侧对上）",
  /pausable: bool,/.test(
    readFileSync(join(ROOT, "apps/desktop/src-tauri/src/commands/source.rs"), "utf8"),
  ) &&
    /pausable: boolean;/.test(eventsTs) &&
    /pausable: p\.pausable,/.test(taskStoreSrc) &&
    // 浮窗只在可暂停时渲染暂停/恢复按钮。
    /task\.cancellable && task\.pausable/.test(
      readFileSync(join(ROOT, "apps/desktop/src/app_ui/core/TaskOverlay.tsx"), "utf8"),
    ),
);
check(
  "分析任务有取消（`task.cancel` 命中即受理）但**明确报不可暂停**",
  /TaskKind::Analyze => "analyze"/.test(tasksSrc) &&
    /!TaskKind::Analyze\.is_pausable\(\)/.test(tasksSrc) &&
    // 取消只在开工前生效：不能假装能中途停下（与源扫描"每文件之间检查"同款）。
    /if self\.is_cancelled\(cancel\) \{\s*\n\s*outcome\.cancelled = true;\s*\n\s*return Ok\(outcome\);/.test(
      scannerSrc,
    ),
);
check(
  "前端调用方不重复弹状态/刷新（任务结束由 scan.completed 统一收口）",
  /export function fileReanalyze\(args: FileReanalyzeArgs\): Promise<string>/.test(fileApiSrc) &&
    // 反向：面板（整个面板家族）不得再自己 toast "已重新分析" 或立刻 refresh（否则与浮窗收尾对撞）。
    !/media\.reanalyzed/.test(mediaPanelFamilySrc) &&
    !/app\.refresh\(\);\s*\n\s*\} catch \(e\) \{\s*\n\s*app\.status\(app\.t\("media\.reanalyzeFailed"/.test(
      mediaPanelFamilySrc,
    ),
);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
