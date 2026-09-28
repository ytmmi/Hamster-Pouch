/**
 * 控件标准一致性自检（开发期验证，不参与打包）。
 *
 * 断言四件事：
 * 1. **Rust 注册表 ↔ TS 注册表**：`kind` 清单与顺序、每种类型的 `container` 标记、
 *    专属字段名集合、可声明事件集合完全一致（`crates/hp-core/src/control_types.rs`
 *    ↔ `packages/config/src/controlRegistry.ts`）；
 * 2. **事件谓词表**：Rust `CONTROL_EVENTS` ↔ TS `CONTROL_EVENTS`；
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
const eqSets = (a, b) =>
  a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
const eqList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * 截取一段字面量块：从 `startPattern` 匹配处起，按**括号配对**找到对应的 `]` / `}`。
 * （纯文本解析，不依赖 Rust/TS 工具链；不会误取块内嵌套数组的 `];`。）
 */
function sliceLiteral(source, startPattern, label) {
  const match = startPattern.exec(source);
  if (!match) throw new Error(`未能在源码中定位 ${label}`);
  const start = match.index + match[0].length;
  const open = source[start - 1];
  const close = open === "{" ? "}" : "]";
  const other = open === "{" ? "{" : "[";
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (c === open || c === other) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i);
    } else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth -= 1;
  }
  throw new Error(`未能找到 ${label} 的结束标记`);
}

const sliceBlock = sliceLiteral;

/** PascalCase → snake_case（`KeyValue` → `key_value`，`AiInfer` → `ai_infer`）。 */
const toSnake = (name) =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

/** 从 `as_str` 的 match 臂里读出「枚举名 → JSON 取值」的权威映射。 */
function asStrMap(source, enumName) {
  const block = sliceLiteral(
    source,
    new RegExp(`impl\\s+${enumName}\\s*\\{[\\s\\S]*?fn\\s+as_str[\\s\\S]*?match\\s+self\\s*\\{`),
    `${enumName}::as_str`,
  );
  const map = new Map();
  for (const m of block.matchAll(new RegExp(`${enumName}::(\\w+)\\s*=>\\s*"([^"]+)"`, "g"))) {
    map.set(m[1], m[2]);
  }
  if (map.size === 0) throw new Error(`未能解析 ${enumName}::as_str`);
  return map;
}

// ============================== 1. Rust 注册表 ==============================

const rustTypes = readFileSync(join(ROOT, "crates/hp-core/src/control_types.rs"), "utf8");

/** JSON 取值（而非 Rust 命名）是权威：`KeyValue` → `keyValue`，`DoubleClick` → `double_click`。 */
const KIND_JSON = asStrMap(rustTypes, "ControlKind");
const EVENT_JSON = asStrMap(rustTypes, "ControlEvent");

const rustKindBlock = sliceBlock(rustTypes, /ControlKind;\s*\d+\]\s*=\s*\[/, "ControlKind::ALL");
/** Rust `ControlKind::ALL` 的顺序（按 `as_str` 翻译成 JSON 取值）。 */
const rustKindNames = [...rustKindBlock.matchAll(/ControlKind::(\w+)/g)].map(
  (m) => KIND_JSON.get(m[1]) ?? `?${m[1]}`,
);

const rustEventBlock = sliceBlock(rustTypes, /CONTROL_EVENTS:\s*\[ControlEvent;\s*\d+\]\s*=\s*\[/, "CONTROL_EVENTS");
const rustEvents = [...rustEventBlock.matchAll(/ControlEvent::(\w+)/g)].map(
  (m) => EVENT_JSON.get(m[1]) ?? `?${m[1]}`,
);

const rustRegistryBlock = sliceBlock(
  rustTypes,
  /CONTROL_REGISTRY:\s*\[ControlKindSpec;\s*\d+\]\s*=\s*\[/,
  "CONTROL_REGISTRY",
);

/** 把 Rust 注册表按 `ControlKindSpec {` 切成一条条记录。 */
function rustSpecEntries(block) {
  const entries = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < block.length; i += 1) {
    if (block.startsWith("ControlKindSpec {", i) && depth === 0) {
      start = i;
    }
    if (block[i] === "{") depth += 1;
    else if (block[i] === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        entries.push(block.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return entries;
}

/** Rust 注册表解析结果：`kind 的 JSON 取值 → { raw, container, events, props }`。 */
const rustSpecMap = new Map(
  rustSpecEntries(rustRegistryBlock).map((text) => {
    const enumName = /ControlKind::(\w+)/.exec(text)?.[1] ?? "";
    const kind = KIND_JSON.get(enumName) ?? `?${enumName}`;
    const container = /container:\s*(true|false)/.exec(text)?.[1] === "true";
    const eventsBlock = /events:\s*&\[([\s\S]*?)\]/.exec(text)?.[1] ?? "";
    const events = [...eventsBlock.matchAll(/ControlEvent::(\w+)/g)].map(
      (m) => EVENT_JSON.get(m[1]) ?? `?${m[1]}`,
    );
    // 专属字段：既支持内联数组 `&[ControlProp::new(...)]`，也支持共用常量组 `&GAP_ALIGN` / `&NO_PROPS`。
    const propsMatch = /props:\s*&(\[|(?:\w+))/.exec(text);
    const inline = propsMatch?.[1] === "[";
    const propsSource = inline
      ? text.slice(text.indexOf("&[", propsMatch.index) + 2, text.indexOf("]\n", propsMatch.index))
      : sliceLiteral(
          rustTypes,
          new RegExp(`(?:const|static)\\s+${propsMatch?.[1] ?? ""}\\s*:\\s*[^=]*=\\s*\\[`),
          propsMatch?.[1] ?? "props",
        );
    const props = [...propsSource.matchAll(/ControlProp::new\("([^"]+)"/g)].map((m) => m[1]);
    return [kind, { raw: enumName, kind, container, events, props }];
  }),
);

/** 供自检脚本与 TS 比对：Rust 侧每个 kind 的 PascalCase 名。 */
const rustRawByKind = new Map([...rustSpecMap.values()].map((s) => [s.kind, s.raw]));

// ============================== 1b. 与 TS 注册表逐项比对 ==============================

const tsSpecs = config.CONTROL_REGISTRY.map((spec) => ({
  kind: spec.kind,
  container: spec.container,
  events: [...spec.events],
  props: spec.props.map((p) => p.name),
}));

check(
  "Rust 与 TS 的 kind 清单及顺序一致",
  eqList(rustKindNames, config.CONTROL_KIND_NAMES),
  `rust=${rustKindNames.length} ts=${config.CONTROL_KIND_NAMES.length}`,
);

check(
  "Rust 注册表覆盖全部 kind（无重复/无遗漏）",
  eqSets([...rustSpecMap.keys()], config.CONTROL_KIND_NAMES),
  `rust=${rustSpecMap.size} ts=${config.CONTROL_KIND_NAMES.length}`,
);

const containerMismatch = tsSpecs.filter((spec) => {
  const rust = rustSpecMap.get(spec.kind);
  return !rust || rust.container !== spec.container;
});
check(
  "容器/叶子标记一致（row/column/panel/section/notice 为容器）",
  containerMismatch.length === 0,
  containerMismatch.map((s) => s.kind).join(", "),
);

const eventMismatch = tsSpecs.filter((spec) => {
  const rust = rustSpecMap.get(spec.kind);
  return !rust || !eqSets(rust.events, spec.events);
});
check(
  "每种类型的可声明事件一致",
  eventMismatch.length === 0,
  eventMismatch.map((s) => s.kind).join(", "),
);

const propMismatch = tsSpecs.filter((spec) => {
  const rust = rustSpecMap.get(spec.kind);
  return !rust || !eqSets(rust.props, spec.props);
});
check(
  "每种类型的专属字段名一致",
  propMismatch.length === 0,
  propMismatch.map((s) => `${s.kind}: rust=[${rustSpecMap.get(s.kind)?.props}] ts=[${s.props}]`).join(" | "),
);

check(
  "事件谓词表一致（6 个）",
  eqList(rustEvents, [...config.CONTROL_EVENT_NAMES]),
  `rust=${rustEvents.join("/")} ts=${config.CONTROL_EVENT_NAMES.join("/")}`,
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
const mainSrc = readFileSync(join(ROOT, "apps/desktop/src-tauri/src/main.rs"), "utf8");
check(
  "plugin.panelSchema / plugin.validateControl 已实现并注册（D61/D62）",
  /pub\(crate\) fn plugin_panel_schema/.test(bridgeSrc) &&
    /pub\(crate\) fn plugin_validate_control/.test(bridgeSrc) &&
    /commands::plugin::plugin_panel_schema/.test(mainSrc) &&
    /commands::plugin::plugin_validate_control/.test(mainSrc),
);
check(
  "业务级校验复用 hp-core 的 ControlSchema::validate（不另写一份口径）",
  /ControlSchema::from_json/.test(bridgeSrc) && /\.validate\(&ctx\)/.test(bridgeSrc),
);
check(
  "失败降级为错误态 + plugin.error（不阻塞其它面板）",
  /fn emit_plugin_error/.test(bridgeSrc) && /"plugin\.error"/.test(bridgeSrc),
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
  /ApiResponse<PanelSchemaItem>/.test(bridgeSrc) &&
    /ApiResponse<ControlValidateResult>/.test(bridgeSrc) &&
    /api_from_hp\(/.test(bridgeSrc),
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
  /pub\(crate\) fn plugin_control_event/.test(bridgeSrc) &&
    /commands::plugin::plugin_control_event/.test(mainSrc) &&
    /ControlEvent::from_str/.test(bridgeSrc) &&
    /declared_events[\s\S]{0,160}?any\(/.test(bridgeSrc),
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
