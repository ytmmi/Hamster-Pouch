/**
 * 图像渲染后端纯逻辑自检（RFC 0013 §11，`pnpm check:render`）。
 *
 * 断言：
 * 1. **阶梯决策表** 8 组输入 → 输出逐条（含强制档与 `auto` 的四条分支）；
 * 2. **`tileGrid` 边界**：9000/1024 → 9×9；1023 → 1×1；0 → 0×0（空网格）；
 * 3. **`viewportImageRect`** 在 4 组 zoom/offset 下与手算一致（含与图像求交后的裁剪）；
 * 4. **`visibleTiles`** 行主序升序、不重复、两次调用稳定；`margin` 只扩不缩；
 * 5. **滞回方向**：`> 1.15` 才进、`< 0.85` 才出（两条阈值各自生效，不共用）；
 * 6. **上传预算换算**：32 MiB / 4 MiB = 8 块，且预算极小时仍至少 1 块；
 * 7. **设置键已注册**（`ui.imageBackend` / `ui.imageUploadBudgetMB`）——三套 i18n 的文本一致性
 *    归 `check:settings` 管，这里**不重复**断言，只确认键确实进了注册表；
 * 8. **唯一绘图入口**：`<canvas>` / `getContext("2d")` / `getContext("webgpu")` /
 *    `createElement("canvas")` 只允许出现在 `app_ui/render/`（别处一律 FAIL）；
 * 9. **不引第三方渲染库**：`apps/desktop/package.json` 的依赖里不得出现 three/pixi/regl/babylon；
 * 10. **设备丢失有兜底**：`surfaceWebGpu.ts` 必须含 `device.lost` 与重试上限常量
 *     `MAX_DEVICE_REBUILDS`；文件尚未落地（未实现，或已按 §12.1 止损回滚）时，
 *     改为断言没有任何文件 import 它；
 * 11. **降级链收口**：`decideBackends` 的任何返回值都必须以 `"dom"` 结尾；
 * 12. **LOD0 阈值两侧**：`shouldPrefetchLowRes` 在 4096 为 `false`、4097 为 `true`，且
 *     9000×6000 与 6000×9000 同为 `true`（判据是长边，不是宽或高）。
 *
 * 环境限制（不是漏测）：无头环境没有 WebGPU（headless 默认关闭，仓内两支截图工具还显式
 * `--disable-gpu`），所以 WebGPU 的**正确性**只在真机上验（`tools/render-probe.mjs` 与
 * `apps/desktop/perf/run.mjs`）；本门禁只验纯逻辑、静态结构与降级决策。
 *
 * 用法：pnpm check:render
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RENDER_DIR = join(ROOT, "apps/desktop/src/app_ui/render");
const SRC_DIR = join(ROOT, "apps/desktop/src");

const tiles = await import(pathToFileURL(join(RENDER_DIR, "tiles.ts")).href);
const caps = await import(pathToFileURL(join(RENDER_DIR, "capabilities.ts")).href);
const config = await import(pathToFileURL(join(ROOT, "packages/config/src/index.ts")).href);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const eqList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
const eqRect = (a, b) =>
  near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
const fmtList = (list) => `[${list.join(", ")}]`;
const fmtRect = (r) => `{${r.x},${r.y},${r.width}×${r.height}}`;

// ============================== 1. 阶梯决策表 ==============================

/** 造一份探测报告；`over` 只覆盖顶层字段，`core`/`compat` 由调用处整体给出。 */
const report = (over = {}) => ({
  hasGpu: true,
  core: { ok: true },
  compat: { ok: true },
  canary: "pass",
  slow: false,
  probedAt: 0,
  ...over,
});

const LADDER_CASES = [
  ["dom 强制", report(), "dom", ["dom"]],
  ["canvas2d 强制", report(), "canvas2d", ["canvas2d", "dom"]],
  [
    "webgpu 强制但无 GPU",
    report({ hasGpu: false, core: { ok: false, reason: "no-api" }, compat: { ok: false } }),
    "webgpu",
    ["canvas2d", "dom"],
  ],
  ["webgpu 强制且两档都能构造", report(), "webgpu", ["webgpu", "webgpu-compat", "canvas2d", "dom"]],
  ["auto 正常", report(), "auto", ["webgpu", "canvas2d", "dom"]],
  // `slow` 只挡 core 档：compat 走 GLES/D3D11，是另一条路径，不受 D3D12 微基准限制。
  ["auto 微基准慢（core 跳过，compat 仍可选）", report({ slow: true }), "auto", ["webgpu-compat", "canvas2d", "dom"]],
  [
    "auto core 不可用且 canary 失败（compat 也不可选）",
    report({ core: { ok: false, reason: "no-adapter" }, canary: "fail" }),
    "auto",
    ["canvas2d", "dom"],
  ],
  [
    "auto core 不可用、canary 未跑",
    report({ core: { ok: false, reason: "no-adapter" }, canary: "skip" }),
    "auto",
    ["webgpu-compat", "canvas2d", "dom"],
  ],
];

let ladderOk = true;
for (const [label, input, preference, expected] of LADDER_CASES) {
  const actual = caps.decideBackends(input, preference);
  const ok = eqList(actual, expected);
  ladderOk = ladderOk && ok;
  if (!ok) console.log(`  ✗ ${label}: 期望 ${fmtList(expected)}，实得 ${fmtList(actual)}`);
}
check(`① 阶梯决策表 ${LADDER_CASES.length} 组`, ladderOk);

// ============================== 2. tileGrid 边界 ==============================

const big = tiles.tileGrid({ width: 9000, height: 9000 }, 1024);
const small = tiles.tileGrid({ width: 1023, height: 1023 }, 1024);
const empty = tiles.tileGrid({ width: 0, height: 0 }, 1024);
check(
  "② tileGrid 边界（9000→9×9，1023→1×1，0→0×0）",
  big.cols === 9 && big.rows === 9 && small.cols === 1 && small.rows === 1 && empty.cols === 0 && empty.rows === 0,
  `9000→${big.cols}×${big.rows}，1023→${small.cols}×${small.rows}，0→${empty.cols}×${empty.rows}`,
);

// 末尾块必须按原图边界裁掉（多带的 width/height 字段就是为这个）：
// 9000 的最后一块只有 808 宽，不是 1024。
const lastTile = tiles.tileImageRect(big, big.cols * big.rows - 1);
check(
  "②b 末尾块按原图裁边（9000 的最后一块 808×808）",
  lastTile.width === 808 && lastTile.height === 808 && lastTile.x === 8192 && lastTile.y === 8192,
  `${fmtRect(lastTile)} @ (${lastTile.x},${lastTile.y})`,
);

// ============================== 3. viewportImageRect ==============================

const NATURAL = { width: 1000, height: 800 };
const VIEWPORT = { width: 500, height: 400 };
const RECT_CASES = [
  // zoom=1、无偏移：视口正好覆盖图像中心 500×400。
  [{ zoom: 1, offset: { x: 0, y: 0 } }, { x: 250, y: 200, width: 500, height: 400 }],
  // zoom=2：同样一块舞台面积只覆盖图像的四分之一。
  [{ zoom: 2, offset: { x: 0, y: 0 } }, { x: 375, y: 300, width: 250, height: 200 }],
  // zoom=0.5 且向左上偏：算出左 -200、上 100、右 800、下 900，与图像求交后裁成 800×700。
  [{ zoom: 0.5, offset: { x: 100, y: -50 } }, { x: 0, y: 100, width: 800, height: 700 }],
  // zoom=4：小数坐标必须原样保留（1 px 偏移就是这么来的）。
  [{ zoom: 4, offset: { x: 0, y: 0 } }, { x: 437.5, y: 350, width: 125, height: 100 }],
];

let rectOk = true;
for (const [view, expected] of RECT_CASES) {
  const actual = tiles.viewportImageRect(NATURAL, view, VIEWPORT);
  const ok = eqRect(actual, expected);
  rectOk = rectOk && ok;
  if (!ok) {
    console.log(
      `  ✗ zoom=${view.zoom} offset=(${view.offset.x},${view.offset.y}): 期望 ${fmtRect(expected)}，实得 ${fmtRect(actual)}`,
    );
  }
}
check(`③ viewportImageRect ${RECT_CASES.length} 组（与手算一致）`, rectOk);

// ============================== 4. visibleTiles ==============================

const GRID = tiles.tileGrid({ width: 3000, height: 2000 }, 1024);
const VIEW = { zoom: 1, offset: { x: 0, y: 0 } };
const visible = tiles.visibleTiles(GRID, { width: 3000, height: 2000 }, VIEW, { width: 800, height: 600 });
const visibleAgain = tiles.visibleTiles(GRID, { width: 3000, height: 2000 }, VIEW, { width: 800, height: 600 });
const padded = tiles.visibleTiles(
  GRID,
  { width: 3000, height: 2000 },
  VIEW,
  { width: 800, height: 600 },
  200,
);
const strictlyAscending = visible.every((v, i) => i === 0 || v > visible[i - 1]);
const withinRange = visible.every((v) => Number.isInteger(v) && v >= 0 && v < GRID.cols * GRID.rows);
const superset = visible.every((v) => padded.includes(v));
check(
  "④ visibleTiles 升序、不重复、稳定、margin 只扩不缩",
  visible.length > 0 &&
    strictlyAscending &&
    new Set(visible).size === visible.length &&
    eqList(visible, visibleAgain) &&
    withinRange &&
    superset &&
    padded.length >= visible.length,
  `${visible.length} 块（margin 200 → ${padded.length} 块）`,
);

// ============================== 5. 滞回方向 ==============================

const hysteresis =
  tiles.nextLod1State(false, 1.15) === false &&
  tiles.nextLod1State(false, 1.16) === true &&
  tiles.nextLod1State(true, 0.85) === true &&
  tiles.nextLod1State(true, 0.84) === false &&
  // 已经在 LOD1 时，比值掉到"进档线"附近不得退出（否则阈值上抖动会闪）。
  tiles.nextLod1State(true, 1.0) === true &&
  // 比值不是有限数（视口尚未测量）时不切档。
  tiles.nextLod1State(false, Number.NaN) === false &&
  tiles.nextLod1State(true, Number.POSITIVE_INFINITY) === true;
check("⑤ 滞回方向（>1.15 进 / <0.85 出，两条阈值不共用）", hysteresis);

// ============================== 6. 上传预算换算 ==============================

const perFrame = tiles.tilesPerFrame(32 * tiles.MIB, 1024);
const tileBytes = tiles.tileBytes(1024);
check(
  "⑥ 上传预算换算（32 MiB / 4 MiB = 8 块，极小预算仍 ≥ 1 块）",
  perFrame === 8 && tileBytes === 4 * tiles.MIB && tiles.tilesPerFrame(0, 1024) === 1,
  `tileBytes=${tileBytes}，perFrame=${perFrame}`,
);

// ============================== 7. 设置键已注册 ==============================

const backendDecl = config.settingDeclByKey("ui.imageBackend");
const budgetDecl = config.settingDeclByKey("ui.imageUploadBudgetMB");
const keysRegistered =
  config.SETTING_KEYS.imageBackend === "ui.imageBackend" &&
  config.SETTING_KEYS.imageUploadBudgetMB === "ui.imageUploadBudgetMB" &&
  backendDecl?.kind === "select" &&
  eqList(
    (backendDecl?.options ?? []).map((o) => o.value),
    [...config.IMAGE_BACKENDS],
  ) &&
  budgetDecl?.kind === "numberInput" &&
  // 出厂默认与裁决一致：auto / 32 MiB。
  backendDecl?.default === "auto" &&
  budgetDecl?.default === 32;
check(
  "⑦ 设置键已注册（文本/i18n 归 check:settings，不重复断言）",
  keysRegistered,
  `backend=${backendDecl?.kind}/${backendDecl?.default}，budget=${budgetDecl?.kind}/${budgetDecl?.default}`,
);

// ============================== 8. 唯一绘图入口 ==============================

/** 去掉注释但保留字符串字面量：否则 `// <canvas>` 这类注释会被误判成真绘图。 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function walkSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSources(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const DRAW_ENTRY = [
  { label: "<canvas>", re: /<canvas\b/ },
  { label: 'getContext("2d")', re: /getContext\(\s*["'`]2d["'`]/ },
  { label: 'getContext("webgpu")', re: /getContext\(\s*["'`]webgpu["'`]/ },
  { label: 'createElement("canvas")', re: /createElement\(\s*["'`]canvas["'`]/ },
];

const renderPrefix = relative(ROOT, RENDER_DIR) + sep;
const offenders = [];
for (const file of walkSources(SRC_DIR)) {
  const rel = relative(ROOT, file);
  if (rel.startsWith(renderPrefix)) continue;
  const code = stripComments(readFileSync(file, "utf8"));
  for (const { label, re } of DRAW_ENTRY) {
    if (re.test(code)) offenders.push(`${rel}（${label}）`);
  }
}
check(
  "⑧ 唯一绘图入口：canvas / getContext 只在 app_ui/render/",
  offenders.length === 0,
  offenders.length === 0 ? "" : offenders.slice(0, 5).join("；"),
);

// ============================== 9. 不引第三方渲染库 ==============================

const desktopPkg = JSON.parse(readFileSync(join(ROOT, "apps/desktop/package.json"), "utf8"));
const depNames = [
  ...Object.keys(desktopPkg.dependencies ?? {}),
  ...Object.keys(desktopPkg.devDependencies ?? {}),
];
const BANNED = /^(three|pixi|@pixi\/|regl|babylon|@babylonjs\/)/i;
const bannedHits = depNames.filter((name) => BANNED.test(name));
check(
  "⑨ 依赖里没有 three / pixi / regl / babylon",
  bannedHits.length === 0,
  bannedHits.length === 0 ? `${depNames.length} 个依赖` : bannedHits.join("、"),
);

// ============================== 10. 设备丢失兜底 ==============================

const GPU_SURFACE = join(RENDER_DIR, "surfaceWebGpu.ts");
if (existsSync(GPU_SURFACE)) {
  const gpuCode = stripComments(readFileSync(GPU_SURFACE, "utf8"));
  const hasLost = /\bdevice\.lost\b/.test(gpuCode);
  const hasLimit = /MAX_DEVICE_REBUILDS\s*=\s*2\b/.test(gpuCode);
  check(
    "⑩ surfaceWebGpu 含 device.lost 与重试上限（MAX_DEVICE_REBUILDS = 2）",
    hasLost && hasLimit,
    `lost=${hasLost}，limit=${hasLimit}`,
  );
} else {
  // 该文件本就不该存在（S2 未开工，或已按 RFC §12.1 的止损删掉）；此时的断言是
  // 「没人 import 它」——这正是「删一个文件即可回滚」这个性质的实际保障。
  const earlyImports = walkSources(SRC_DIR)
    .map((file) => relative(ROOT, file))
    .filter((rel) => /surfaceWebGpu/.test(readFileSync(join(ROOT, rel), "utf8")));
  check(
    "⑩ surfaceWebGpu 未落地（未实现或已回滚，见 RFC §12.1）且无任何引用",
    earlyImports.length === 0,
    earlyImports.length === 0 ? "无该文件、无引用" : earlyImports.join("、"),
  );
}

// ============================== 11. 降级链收口 ==============================

const ALL_PREFERENCES = ["auto", "webgpu", "canvas2d", "dom"];
const REPORTS = [
  report(),
  report({ hasGpu: false, core: { ok: false }, compat: { ok: false }, canary: "fail" }),
  report({ slow: true, canary: "skip", core: { ok: false }, compat: { ok: true } }),
  report({ canary: "fail", core: { ok: true }, compat: { ok: false } }),
];
const notEndingWithDom = [];
for (const preference of ALL_PREFERENCES) {
  for (const input of REPORTS) {
    const ladder = caps.decideBackends(input, preference);
    if (ladder.at(-1) !== "dom") notEndingWithDom.push(`${preference}→${fmtList(ladder)}`);
  }
}
check(
  "⑪ 降级链一律以 dom 收口",
  notEndingWithDom.length === 0,
  notEndingWithDom.length === 0
    ? `${ALL_PREFERENCES.length} 档偏好 × ${REPORTS.length} 份报告`
    : notEndingWithDom.slice(0, 3).join("；"),
);

// ============================== 12. LOD0 阈值两侧 ==============================

const lod0 =
  tiles.shouldPrefetchLowRes({ width: 4096, height: 100 }) === false &&
  tiles.shouldPrefetchLowRes({ width: 4097, height: 100 }) === true &&
  tiles.shouldPrefetchLowRes({ width: 9000, height: 6000 }) === true &&
  tiles.shouldPrefetchLowRes({ width: 6000, height: 9000 }) === true &&
  tiles.shouldPrefetchLowRes({ width: 100, height: 4096 }) === false &&
  // 尺寸未知按大图处理（先出低清好过白屏）。
  tiles.shouldPrefetchLowRes(null) === true &&
  tiles.LOD0_MIN_LONG_SIDE === 4096;
check("⑫ shouldPrefetchLowRes 在 4096/4097 两侧取值相反，长边判据对称", lod0);

// ============================== 汇总 ==============================

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
