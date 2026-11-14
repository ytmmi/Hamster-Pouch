/**
 * 控件标准一致性自检（开发期验证，不参与打包）。
 *
 * 断言四件事：
 * 1. **注册表只有一处真值**：Rust `crates/hp-core/src/control_types.rs` 的 `CONTROL_REGISTRY`
 *    是真值；前端 facts 由 `cargo run -p hp-core --bin dump-control-facts` 生成、
 *    `pnpm check:control-facts` 逐字节比对。本脚本只**反向**断言 TS 侧没有第二份手抄表
 *    （D191 删掉了旧的 Rust 正则解析——解析器本身才是最脆的环节）；
 * 2. **TS 取值域来自生成物**：`controlKinds.ts` 只剩 bind 来源与显隐谓词两个前端约定；
 * 3. **渲染骨架完整性**：`CONTROL_RENDER_MAP` 覆盖全部 `kind`（少一种即宿主渲染缺口）；
 * 4. **文档一致性**：`docs/spec/control-standard.md` 的类型表列出全部 26 个 `kind`
 *    （文档与代码不脱节）。
 *
 * 用法：pnpm check:controls
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config = await import(pathToFileURL(join(ROOT, "packages/config/src/index.ts")).href);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const eqList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ============================== 1. 注册表来自生成物 ==============================

// D191：26 条控件定义的真值在 Rust（`crates/hp-core/src/control_types.rs` 的
// `CONTROL_REGISTRY`）。前端 `packages/config/src/controlFacts.generated.ts` 由
// `cargo run -p hp-core --bin dump-control-facts` 产出，`pnpm check:control-facts`
// 逐字节比对，所以这里**不再解析 Rust 源码**：正则解析器本身就是脆弱点（旧 §1/§1b
// 已删）。留下的是两条反向断言，防有人把表抄回 TS、或重新引入第二份真值。

const stripJsComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const controlRegistrySrc = stripJsComments(
  readFileSync(join(ROOT, "packages/config/src/controlRegistry.ts"), "utf8"),
);
const handCopiedKind = /\bkind:\s*"/.test(controlRegistrySrc);
check(
  "controlRegistry.ts 只从生成物派生（不再手抄 26 条类型表）",
  controlRegistrySrc.includes("CONTROL_FACTS") && !handCopiedKind,
  handCopiedKind ? "检测到手抄的 kind 字面量" : "CONTROL_FACTS",
);

const controlKindsSrc = stripJsComments(
  readFileSync(join(ROOT, "packages/config/src/controlKinds.ts"), "utf8"),
);
// 手抄的取值域会写成 `export const CONTROL_TEXT_VARIANTS = [`；生成物里只留 bind
// 来源与显隐谓词（Rust 侧不声明这两个取值域）。
const handWrittenDomains = [...controlKindsSrc.matchAll(/export const (\w+) = \[/g)].map((m) => m[1]);
check(
  "controlKinds.ts 的取值域全部来自生成物（只剩 bind / 谓词两个前端约定）",
  eqList(handWrittenDomains, ["CONTROL_BIND_KINDS", "CONTROL_PREDICATE_TESTS"]),
  handWrittenDomains.join(", "),
);

// ============================== 2. 渲染骨架 ==============================

// 覆盖清单是**纯数据**（不含 JSX），可直接导入；`.tsx` 里的 `CONTROL_RENDER_MAP`
// 与它的一致性由 TypeScript 的 `Record<ControlKind, …>` 与下方断言共同保证。
const coverage = await import(
  pathToFileURL(
    join(ROOT, "apps/desktop/src/app_ui/shared/control/controlRenderCoverage.ts"),
  ).href
);
const renderKeys = [...coverage.CONTROL_RENDER_COVERAGE];
const rendererSource = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/control/ControlRenderer.tsx"),
  "utf8",
);
const missingRender = config.CONTROL_KIND_NAMES.filter((kind) => !renderKeys.includes(kind));
check(
  "宿主渲染覆盖清单包含全部 kind（无渲染缺口）",
  missingRender.length === 0,
  `缺: ${missingRender.join(", ") || "无"}`,
);
check(
  "渲染覆盖清单没有多余的 kind",
  renderKeys.filter((k) => !config.CONTROL_KIND_NAMES.includes(k)).length === 0,
  renderKeys.filter((k) => !config.CONTROL_KIND_NAMES.includes(k)).join(", "),
);
// `CONTROL_RENDER_MAP` 的键按「两空格缩进 + 标识符 + `,` 或 `:`」逐行提取
// （对象里既有简写 `row,` 也有映射 `text: textControl,`），必须与覆盖清单完全一致。
const mapBlockStart = rendererSource.indexOf("CONTROL_RENDER_MAP");
const mapBlockEnd = rendererSource.indexOf("\n};", mapBlockStart);
const mapBody = rendererSource.slice(mapBlockStart, mapBlockEnd);
const mapKeys = [...mapBody.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*[,:]/gm)].map((m) => m[1]);
const mapDrift = config.CONTROL_KIND_NAMES.filter((k) => !mapKeys.includes(k));
check(
  "CONTROL_RENDER_MAP 与覆盖清单一致",
  mapDrift.length === 0 && eqList(mapKeys, [...renderKeys]),
  `映射表键=${mapKeys.length} 清单=${renderKeys.length} 漂移=${mapDrift.join(", ") || "无"}`,
);

// ============================== 3. 文档一致性 ==============================

const doc = readFileSync(join(ROOT, "docs/spec/control-standard.md"), "utf8");
const missingInDoc = config.CONTROL_KIND_NAMES.filter((kind) => !doc.includes(`\`${kind}\``));
check(
  "控件标准文档列出了全部 kind",
  missingInDoc.length === 0,
  `缺: ${missingInDoc.join(", ") || "无"}`,
);

// 文档声明的事件谓词表与代码一致。
const missingEvent = config.CONTROL_EVENT_NAMES.filter((event) => !doc.includes(`\`${event}\``));
check(
  "控件标准文档列出了全部事件谓词",
  missingEvent.length === 0,
  `缺: ${missingEvent.join(", ") || "无"}`,
);

// ============================== 4. 端到端：解析 + 校验 ==============================

const good = JSON.stringify({
  api_version: 1,
  panel_id: "palette.panel",
  root: {
    id: "root",
    kind: "column",
    gap: "md",
    children: [
      { id: "title", kind: "text", text_key: "palette.title", variant: "heading" },
      {
        id: "colors",
        kind: "thumbGrid",
        bind: { kind: "panel", name: "colors" },
        item_text: "hex",
        on: { double_click: "apply_color" },
      },
    ],
  },
});
const ctx = {
  expectedPanelId: "palette.panel",
  declaredQueries: ["colors"],
  declaredEvents: ["apply_color"],
};
const schema = config.parseControlSchema(good);
const ok = config.validateControlSchema(schema, ctx);
check("合法 schema 通过校验", ok.errors.length === 0, ok.errors.join(" | "));

const badKind = good.replace('"kind":"thumbGrid"', '"kind":"bogus"');
let rejected = false;
try {
  config.parseControlSchema(badKind);
} catch {
  rejected = true;
}
check("白名单外 kind 在解析层被拒绝", rejected);

const badField = good.replace('"item_text":"hex"', '"item_text":"hex","columns":["a"]');
const badResult = config.validateControlSchema(config.parseControlSchema(badField), ctx);
check(
  "类型不支持的字段被拒绝（columns 只在 table 上合法）",
  badResult.errors.some((e) => e.includes("columns")),
  badResult.errors.join(" | "),
);

const badEvent = good.replace('"double_click":"apply_color"', '"submit":"ghost"');
const badEventResult = config.validateControlSchema(config.parseControlSchema(badEvent), ctx);
check(
  "未声明事件 id / 类型不支持的事件被拒绝",
  badEventResult.errors.some((e) => e.includes("ghost")),
  badEventResult.errors.join(" | "),
);

// ==================== 运行时通道与接线（控件标准第 2/7/8 节，D61/D62）====================
//
// 这几条防的是"渲染骨架写好了但没人接线"（旧口径下 ControlPanelView 无调用方）。
// 纯文本断言：只查"调用点存在 + 请求名/上限与规范一致"，不重写 Rust 实现。

const channelSrc = readFileSync(join(ROOT, "crates/hp-plugin-host/src/channel.rs"), "utf8");
check(
  "运行时通道用统一请求名 ui.panel.schema（三种运行形态同一请求名）",
  /PANEL_SCHEMA_REQUEST:\s*&str\s*=\s*"ui\.panel\.schema"/.test(channelSrc),
);
check(
  "宿主侧超时 2s 与输出上限 256 KiB 是常量（D61）",
  /SCHEMA_QUERY_TIMEOUT:\s*Duration\s*=\s*Duration::from_secs\(2\)/.test(channelSrc) &&
    /SCHEMA_MAX_BYTES:\s*usize\s*=\s*256\s*\*\s*1024/.test(channelSrc),
);
check(
  "schema 缓存键是 (plugin_id, panel_id, plugin_version)（D61）",
  /pub struct PanelSchemaKey\s*\{[\s\S]*?plugin_id[\s\S]*?panel_id[\s\S]*?plugin_version[\s\S]*?\}/.test(
    channelSrc,
  ),
);

const bridgeSrc = readFileSync(
  join(ROOT, "apps/desktop/src-tauri/src/commands/plugin.rs"),
  "utf8",
);
// schema 通道与业务级校验 2026-09 从 `commands/plugin.rs` 拆到
// `commands/plugin_control_channel.rs`（plugin.rs 触到 1200 行文件规则上限）——
// 断言跟着代码走，不看它原来在哪（与 `plugin_panel_data.rs` 同口径，见本节末）。
const controlChannelSrc = readFileSync(
  join(ROOT, "apps/desktop/src-tauri/src/commands/plugin_control_channel.rs"),
  "utf8",
);
// 控件事件回传链同理：`commands/plugin_control_event.rs`。
const controlEventSrc = readFileSync(
  join(ROOT, "apps/desktop/src-tauri/src/commands/plugin_control_event.rs"),
  "utf8",
);
const mainSrc = readFileSync(join(ROOT, "apps/desktop/src-tauri/src/main.rs"), "utf8");
check(
  "plugin.panelSchema / plugin.validateControl 已实现并注册（D61/D62）",
  /pub\(crate\) fn plugin_panel_schema/.test(controlChannelSrc) &&
    /pub\(crate\) fn plugin_validate_control/.test(controlChannelSrc) &&
    /commands::plugin_control_channel::plugin_panel_schema/.test(mainSrc) &&
    /commands::plugin_control_channel::plugin_validate_control/.test(mainSrc),
);
check(
  "业务级校验复用 hp-core 的 ControlSchema::validate（不另写一份口径）",
  /ControlSchema::from_json/.test(controlChannelSrc) && /\.validate\(&ctx\)/.test(controlChannelSrc),
);
check(
  "失败降级为错误态 + plugin.error（不阻塞其它面板）",
  /fn emit_plugin_error/.test(controlChannelSrc) && /"plugin\.error"/.test(controlChannelSrc),
);

const hostSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/PluginPanelHost.tsx"),
  "utf8",
);
const apiSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/api/plugin.ts"),
  "utf8",
);
check(
  "ControlPanelView 已接进 PluginPanelHost（面板级入口不再是死代码）",
  /ControlPanelView/.test(hostSrc) && /pluginPanelSchema|plugin_panel_schema/.test(apiSrc),
);
check(
  "接线走的是运行时通道命令，而不是把 schema 写死在面板里",
  /api\.pluginPanelSchema\(/.test(hostSrc) && /api\.pluginValidateControl\(/.test(hostSrc),
);
check(
  "占位文案 schemaPending 不再是面板的唯一内容（已换成真实渲染/错误态）",
  !/<span className="placeholder">\{app\.t\("pluginPanel\.schemaPending"\)\}<\/span>\s*<\/div>/.test(
    hostSrc,
  ),
);

// 新命令走 D76 统一响应包装（新增命令一律按新口径）。
check(
  "新增的两条控件命令走 D76 响应包装 { ok, data?, error? }",
  /ApiResponse<PanelSchemaItem>/.test(controlChannelSrc) &&
    /ApiResponse<ControlValidateResult>/.test(controlChannelSrc) &&
    /api_from_hp\(/.test(controlChannelSrc),
);
check(
  "HpError 有 D76 的闭集错误码（前端按 code 走 i18n，不直显 message）",
  /pub fn code\(&self\) -> &'static str/.test(
    readFileSync(join(ROOT, "crates/hp-core/src/error.rs"), "utf8"),
  ),
);
check(
  "前端有统一解包层，且三套语言都有错误码文案",
  /export function unwrapApi/.test(
    readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/api/response.ts"), "utf8"),
  ) &&
    ["zh-CN", "zh-TW", "en"].every((lang) =>
      /"error\.code\.plugin"/.test(
        readFileSync(join(ROOT, `apps/desktop/src/app_ui/i18n/${lang}.ts`), "utf8"),
      ),
    ),
);

// ==================== 控件事件回传链（控件标准第 6 节，D63）====================
//
// 这一节防的是"渲染骨架点得动、但事件回不去"（旧口径下 PluginPanelHost 把 emit 置空）。

const controlEvents = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/shared/control/controlEvents.ts")).href
);

const eventSchema = config.parseControlSchema(
  JSON.stringify({
    api_version: 1,
    panel_id: "fixture.panel",
    root: {
      id: "root",
      kind: "column",
      children: [
        {
          id: "colors",
          kind: "thumbGrid",
          text_key: "fixture.colors",
          bind: { kind: "panel", name: "colors" },
          on: { double_click: "apply_color", selection_change: "pick" },
        },
        { id: "title", kind: "text", text_key: "fixture.title" },
      ],
    },
  }),
);
const eventMap = controlEvents.collectControlEventMap(eventSchema);
check(
  "事件映射按控件 id 收集（只收声明了 on 的控件）",
  eventMap.size === 1 && eventMap.get("colors")?.double_click === "apply_color",
  `size=${eventMap.size}`,
);
check(
  "事件名 → 事件 id：声明过的命中，未声明的返回 undefined（按规范记一次忽略，不算失败）",
  controlEvents.controlEventIdOf(eventMap, "colors", "double_click") === "apply_color" &&
    controlEvents.controlEventIdOf(eventMap, "colors", "click") === undefined &&
    controlEvents.controlEventIdOf(eventMap, "title", "click") === undefined,
);
check(
  "插件侧方法名是契约的字面名 plugin.{pluginId}.{eventId}",
  /CONTROL_EVENT_METHOD_PREFIX:\s*&str\s*=\s*"plugin\."/.test(channelSrc) &&
    /format!\("\{CONTROL_EVENT_METHOD_PREFIX\}\{plugin_id\}\.\{event_id\}"\)/.test(channelSrc),
);
check(
  "plugin.controlEvent 已实现并注册，且事件 id 必须在 manifest 声明过（fail-closed）",
  /pub\(crate\) fn plugin_control_event/.test(controlEventSrc) &&
    /commands::plugin_control_event::plugin_control_event/.test(mainSrc) &&
    /ControlEvent::from_str/.test(controlEventSrc) &&
    /declared_events[\s\S]{0,160}?any\(/.test(controlEventSrc),
);
check(
  "前端接线：emit 不再是空实现，回传前解析事件 id，未声明即忽略",
  /pluginControlEvent\(/.test(hostSrc) &&
    /collectControlEventMap/.test(hostSrc) &&
    /controlEventIdOf\(/.test(hostSrc) &&
    !/emit:\s*\(\)\s*=>\s*undefined/.test(hostSrc),
);

// ==================== 受控取数通道（控件标准第 5 节）====================
//
// 这一节防的是"面板渲染得出来、但 bind 永远拿不到数据"（旧口径下 PluginPanelHost
// 直接传空快照）。取数链最阴的失效模式是**快照键口径漂移**：宿主与前端各写一份
// `"{kind}:{name}"`，任何一处改了都会让插件回填全部落空，而且**没有任何编译错误**
// ——面板只是永远显示空态。因此键口径必须三处对齐并在这里断言。

const controlBinds = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/shared/control/controlBinds.ts")).href
);

// 取数通道已从 plugin.rs 拆出（plugin.rs 触到 1200 行文件规则上限）——
// 这一段的断言要读**新模块**，否则门禁会因为"文件里找不到符号"而误报。
const panelDataSrc = readFileSync(
  join(ROOT, "apps/desktop/src-tauri/src/commands/plugin_panel_data.rs"),
  "utf8",
);

check(
  "取数请求名 ui.panel.query 是独立常量，且规范第 2 节已登记",
  /PANEL_QUERY_REQUEST:\s*&str\s*=\s*"ui\.panel\.query"/.test(channelSrc) &&
    readFileSync(join(ROOT, "docs/spec/control-standard.md"), "utf8").includes("ui.panel.query"),
);
check(
  "取数的超时与字节上限与 schema 同口径（2s / 256 KiB）",
  /QUERY_TIMEOUT:\s*Duration\s*=\s*SCHEMA_QUERY_TIMEOUT/.test(channelSrc) &&
    /QUERY_MAX_BYTES:\s*usize\s*=\s*SCHEMA_MAX_BYTES/.test(channelSrc),
);
check(
  "plugin.panelData 已实现并注册，且 bind.name 必须在 manifest 声明过（fail-closed）",
  /pub\(crate\) fn plugin_panel_data/.test(panelDataSrc) &&
    /commands::plugin_panel_data::plugin_panel_data/.test(mainSrc) &&
    /declared_queries[\s\S]{0,160}?any\(/.test(panelDataSrc),
);

// 键口径三处对齐：Rust 构造、前端收集、前端查表。
check(
  "快照键口径三处一致（宿主 snapshot_key == 前端 controlBindKey == makeControlDataSnapshot）",
  /pub fn snapshot_key\(kind: &str, name: &str\) -> String\s*\{\s*format!\("\{kind\}:\{name\}"\)/.test(
    channelSrc,
  ) &&
    /return `\$\{bind\.kind\}:\$\{bind\.name\}`/.test(
      readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/control/controlBinds.ts"), "utf8"),
    ) &&
    /results\[`\$\{bind\.kind\}:\$\{bind\.name\}`\]/.test(
      readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/control/controlData.ts"), "utf8"),
    ),
);

// 行为断言：收集必须含 visible_when、必须去重、必须保留 args。
const bindsSchema = config.parseControlSchema(
  JSON.stringify({
    api_version: 1,
    panel_id: "fixture.panel",
    root: {
      id: "root",
      kind: "column",
      children: [
        {
          id: "colors",
          kind: "thumbGrid",
          text_key: "fixture.colors",
          bind: { kind: "panel", name: "colors", args: { max: 12 } },
        },
        {
          id: "again",
          kind: "list",
          text_key: "fixture.again",
          bind: { kind: "panel", name: "colors" },
        },
        {
          id: "onlyVisible",
          kind: "text",
          text_key: "fixture.v",
          visible_when: { kind: "panel", name: "colors", test: "empty" },
        },
        {
          id: "sel",
          kind: "list",
          text_key: "fixture.sel",
          bind: { kind: "selection", name: "current" },
        },
      ],
    },
  }),
);
const collected = controlBinds.collectControlBinds(bindsSchema);
check(
  "取数收集含 visible_when 的查询名（谓词也要数据，否则永远按结果缺失求值）",
  collected.some((b) => b.kind === "panel" && b.name === "colors") && collected.length === 2,
  collected.map((b) => `${b.kind}:${b.name}`).join(","),
);
check(
  "取数按快照键去重（同一查询被多个控件引用只问一次）",
  collected.filter((b) => b.kind === "panel" && b.name === "colors").length === 1,
);
check(
  "取数携带标量 args（首次出现的那次带上）",
  collected.find((b) => b.name === "colors")?.args?.max === 12,
);
check(
  "selection 类也被收集（第一版开放的两种 kind 都要问）",
  collected.some((b) => b.kind === "selection" && b.name === "current"),
);

check(
  "前端接线：一次问完、只在 schema 通过校验时取数、且随 refreshKey/选中文件重查",
  /pluginPanelData\(/.test(hostSrc) &&
    /collectControlBinds\(/.test(hostSrc) &&
    /serverResult\.errors\.length === 0/.test(hostSrc) &&
    /\[isPluginPanel, repoId, panelId, app\.refreshKey, selectedFileId\]/.test(hostSrc) &&
    /state\.kind === "ready" \? state\.data : makeControlDataSnapshot\(\{\}\)/.test(hostSrc),
);
check(
  "取数结果**不缓存**（数据陈旧风险与 schema 不同：无 PanelDataCache 一类结构）",
  !/PanelDataCache/.test(channelSrc) && !/panel_data_cache/.test(mainSrc),
);

// ============================== 汇总 ==============================

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
