/**
 * 蓝图「同步布局」自检（开发期验证，不参与打包）。
 *
 * 判据全部落在**纯函数** `blueprintLayoutSync.syncLayoutIntoGraph` 上，外加几条
 * **源码锚点**（工具条按钮 / 面板接线 / 落库），因为 React 组件没有单测。
 *
 * 覆盖（用户口径 m00001 / m00071——那两句话是**同一个**要求）：
 * ① 面板换了所属标签组时，面板与它的**后续（尾部）节点当作一个整体**一起移动，
 *    簇内相对形状不变（逐节点同一位移）；
 * ② 没换组的面板一个节点都不动；没出现在布局里的面板原样保留（结构父不丢，D108）；
 * ③ 布局里新出现的面板补出控件节点；
 * ④ 结构一致时**零改动、零落库**（幂等）；
 * ⑤ 旧图 `control --memberOf--> group` 归一成 `group --contains--> control`（D59）；
 * ⑥ **独立窗口**（蓝图面板被拖出主窗口、那个窗口里没有 dockview）：快照改读主窗口发布的
 *    跨窗口共享结构，「发布 → 读取 → 同步」与直连 dockview 等价；
 * ⑦ **浮层（overlay）拥有的面板不参与页面结构**：浮层的内容面板可能正好停靠在某个标签组里
 *    而出现在布局快照中，它只能有浮层一个结构父（结构父唯一），同步必须对它零改动，
 *    也不能因为"标签组里少了它"就把这一栏的标签组拆掉（曾报「浮层连接的面板被再挂到
 *    不属于浮层的标签组下」）。
 *
 * 用法：pnpm check:blueprint-layout-sync
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sync = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/blueprintLayoutSync.ts")).href
);

const structure = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/blueprintStructure.ts")).href
);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/**
 * 夹具：两个布局块（列）。列 2 里是一个标签组 `g_1`（media + preview）；
 * 列 1 里是单面板 `c_log`；`c_ghost` **不在布局里**；`c_media` 后面挂了一整条尾部
 * （类目 → 对象 → 事件 → 动作），用来验证"整体搬运"。
 */
const doc0 = () =>
  JSON.parse(
    JSON.stringify({
      schema_version: 1,
      layers: [{ key: "l1", name: "主界面", is_home: true }],
      nodes: [
        { key: "ui", type: "interface", layer: "l1", position: { x: 300, y: 40 } },
        { key: "blk_1", type: "layout_block", layer: "l1", name: "区域 1", position: { x: 40, y: 170 } },
        { key: "blk_2", type: "layout_block", layer: "l1", name: "区域 2", position: { x: 340, y: 170 } },
        { key: "g_1", type: "group", layer: "l1", mode: "exclusive", position: { x: 340, y: 300 } },
        { key: "c_media", type: "control", layer: "l1", panel_id: "media", position: { x: 340, y: 430 } },
        { key: "c_preview", type: "control", layer: "l1", panel_id: "preview", position: { x: 340, y: 560 } },
        { key: "c_log", type: "control", layer: "l1", panel_id: "log", position: { x: 40, y: 300 } },
        { key: "c_ghost", type: "control", layer: "l1", panel_id: "ghost", position: { x: 700, y: 700 } },
        { key: "k_media", type: "class", layer: "l1", position: { x: 600, y: 430 } },
        { key: "o_media", type: "object", layer: "l1", position: { x: 860, y: 430 } },
        { key: "e_play", type: "event", layer: "l1", position: { x: 860, y: 560 } },
        { key: "a_open", type: "action", layer: "l1", op: "open", position: { x: 1120, y: 560 } },
      ],
      edges: [
        { from: "ui", to: "blk_1", kind: "contains", order: 1 },
        { from: "ui", to: "blk_2", kind: "contains", order: 2 },
        { from: "blk_1", to: "c_log", kind: "contains", order: 3 },
        { from: "blk_1", to: "c_ghost", kind: "contains", order: 4 },
        { from: "blk_2", to: "g_1", kind: "contains", order: 5 },
        { from: "g_1", to: "c_media", kind: "contains", order: 6 },
        { from: "g_1", to: "c_preview", kind: "contains", order: 7 },
        { from: "c_media", to: "k_media", kind: "contains", order: 8 },
        { from: "k_media", to: "o_media", kind: "contains", order: 9 },
        { from: "o_media", to: "e_play", kind: "on", order: 10 },
        { from: "e_play", to: "a_open", kind: "fires", order: 11 },
      ],
    }),
  );

/** 布局 A：与夹具一致（列 2 仍是 media + preview 的标签组）。 */
const snapA = () => ({
  at: 1,
  regions: [
    { panels: ["log"], left: 0, right: 100, top: 0 },
    { panels: ["media", "preview"], left: 200, right: 300, top: 0 },
  ],
});

/** 布局 B：media 与 preview 被拆成了各自独占的标签组（都换了所属标签组）。 */
const snapB = () => ({
  at: 2,
  regions: [
    { panels: ["log"], left: 0, right: 100, top: 0 },
    { panels: ["media"], left: 200, right: 300, top: 0 },
    { panels: ["preview"], left: 200, right: 300, top: 400 },
  ],
});

/** 布局 C：标签组里多了一个布局里新出现的面板 inspector。 */
const snapC = () => ({
  at: 3,
  regions: [
    { panels: ["log"], left: 0, right: 100, top: 0 },
    { panels: ["media", "preview", "inspector"], left: 200, right: 300, top: 0 },
  ],
});

const nodeOf = (doc, key) => doc.nodes.find((n) => n.key === key);
const posOf = (doc, key) => nodeOf(doc, key)?.position ?? null;
const samePos = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;
const edgeSet = (doc) => doc.edges.map((e) => `${e.kind}|${e.from}|${e.to}`).sort();
const sameEdges = (a, b) => JSON.stringify(edgeSet(a)) === JSON.stringify(edgeSet(b));
const hasEdge = (doc, from, to, kind) =>
  doc.edges.some((e) => e.from === from && e.to === to && e.kind === kind);

// ---- 1. 没有可同步的布局：原样返回，零改动 ----
{
  const doc = doc0();
  const none = sync.syncLayoutIntoGraph({ doc, snapshot: null, layerKey: "l1" });
  const empty = sync.syncLayoutIntoGraph({
    doc,
    snapshot: { at: 0, regions: [] },
    layerKey: "l1",
  });
  check(
    "无布局（null / 空区域）：不做任何改动、节点与边一个不碰",
    none.count === 0 &&
      none.added.length === 0 &&
      none.moved.length === 0 &&
      none.structureChanged === false &&
      empty.count === 0 &&
      sameEdges(none.doc, doc),
  );
}

// ---- 2. 结构一致：零改动（同步是增量的，不是重整） ----
{
  const doc = doc0();
  const out = sync.syncLayoutIntoGraph({ doc, snapshot: snapA(), layerKey: "l1" });
  check(
    "布局与结构一致：零新增 / 零归组 / 零移动 / 结构未变（幂等，不产生多余落库）",
    out.count === 0 &&
      out.added.length === 0 &&
      out.regrouped.length === 0 &&
      out.moved.length === 0 &&
      out.structureChanged === false,
    `count=${out.count} structureChanged=${out.structureChanged}`,
  );
  check(
    "结构一致时：边集合（含 on/fires 逻辑边）逐条不变，标签组 g_1 仍带 media/preview",
    sameEdges(out.doc, doc) &&
      hasEdge(out.doc, "g_1", "c_media", "contains") &&
      hasEdge(out.doc, "g_1", "c_preview", "contains"),
  );
  check(
    "结构一致时：所有节点位置逐项不变",
    out.doc.nodes.every((n) => samePos(n.position, nodeOf(doc, n.key)?.position)),
  );
}

// ---- 3. 换了标签组：面板 + 尾部作为整体移动 ----
{
  const doc = doc0();
  const out = sync.syncLayoutIntoGraph({ doc, snapshot: snapB(), layerKey: "l1" });
  const tail = ["k_media", "o_media", "e_play", "a_open"];
  const before = (key) => posOf(doc, key);
  const after = (key) => posOf(out.doc, key);
  const anchorBefore = before("c_media");
  const anchorAfter = after("c_media");
  const dx = anchorAfter.x - anchorBefore.x;
  const dy = anchorAfter.y - anchorBefore.y;

  check(
    "换了标签组：面板被识别为重新归组（regrouped）",
    out.regrouped.includes("c_media"),
    out.regrouped.join(", "),
  );
  check(
    "整体搬运：面板 + 尾部 5 个节点全部进 moved（同布局里另一个换组的面板各算独立簇）",
    ["c_media", ...tail].every((k) => out.moved.includes(k)) && out.moved.length === 6,
    `moved=${out.moved.length}: ${out.moved.join(", ")}`,
  );
  check(
    "没有尾部的面板独自成一簇：c_preview 的簇只有它自己（不牵连别的面板与尾部）",
    out.moved.includes("c_preview") &&
      out.moves.find((m) => m.anchor === "c_preview")?.keys.length === 1 &&
      out.moves.find((m) => m.anchor === "c_media")?.keys.length === 5,
    out.moves.map((m) => `${m.anchor}:${m.keys.length}`).join(" "),
  );
  check(
    "簇内相对形状不变：尾部每个节点与面板的**位移完全相同**（一个整体，不被拆散）",
    (anchorAfter.x !== anchorBefore.x || anchorAfter.y !== anchorBefore.y) &&
      tail.every((k) => {
        const b = before(k);
        const a = after(k);
        return a.x - b.x === dx && a.y - b.y === dy;
      }),
    `Δ=(${dx},${dy})`,
  );
  check(
    "落点在新容器子树**下沿之下**：面板不再压住既有内容（y 增大）",
    dy > 0 && dx === 0,
    `Δ=(${dx},${dy})`,
  );
  check(
    "归属改写：g_1 不再 contains c_media，改为 blk_2 contains c_media（D59 口径）",
    !hasEdge(out.doc, "g_1", "c_media", "contains") &&
      hasEdge(out.doc, "blk_2", "c_media", "contains") &&
      hasEdge(out.doc, "blk_2", "c_preview", "contains"),
  );
  check(
    "没换组的面板不动：c_log 位置不变",
    samePos(after("c_log"), before("c_log")),
  );
  check(
    "不在布局里的面板原样保留：c_ghost 位置不变、结构父仍是 blk_1（不会变成未接通，D108）",
    samePos(after("c_ghost"), before("c_ghost")) &&
      hasEdge(out.doc, "blk_1", "c_ghost", "contains"),
  );
  check(
    "空掉的旧标签组不丢结构父：g_1 仍挂在 blk_2 上（同步不替用户删节点）",
    hasEdge(out.doc, "blk_2", "g_1", "contains"),
  );
  check(
    "逻辑边（on / fires）一条不少、也不动",
    hasEdge(out.doc, "o_media", "e_play", "on") &&
      hasEdge(out.doc, "e_play", "a_open", "fires"),
  );

  // 对同一份结果再同步一次：必须彻底收敛（幂等）。
  const again = sync.syncLayoutIntoGraph({
    doc: out.doc,
    snapshot: snapB(),
    layerKey: "l1",
  });
  check(
    "连续两次同步收敛：第二次零改动、结构未变、位置逐项一致",
    again.count === 0 &&
      again.structureChanged === false &&
      again.doc.nodes.every((n) => samePos(n.position, nodeOf(out.doc, n.key)?.position)),
    `count=${again.count} structureChanged=${again.structureChanged}`,
  );
}

// ---- 4. 布局里新出现的面板：补出控件节点并归位 ----
{
  const doc = doc0();
  const out = sync.syncLayoutIntoGraph({ doc, snapshot: snapC(), layerKey: "l1" });
  const addedControl = out.added.find((k) => nodeOf(out.doc, k)?.panel_id === "inspector");
  check(
    "新面板补出控件节点：added 里有一条 inspector 控件，且带 contains 入边",
    !!addedControl &&
      nodeOf(out.doc, addedControl)?.type === "control" &&
      hasEdge(out.doc, "g_1", addedControl, "contains"),
    `added=${out.added.join(", ")}`,
  );
  check(
    "多面板区域复用成员重合最多的既有标签组：没有凭空新建第二个标签组",
    out.doc.nodes.filter((n) => n.type === "group").length === 1 &&
      hasEdge(out.doc, "g_1", "c_media", "contains") &&
      hasEdge(out.doc, "g_1", "c_preview", "contains"),
  );
  check(
    "归属没变的老成员不动：c_media / c_preview 位置不变（只把新面板放进来）",
    samePos(posOf(out.doc, "c_media"), posOf(doc, "c_media")) &&
      samePos(posOf(out.doc, "c_preview"), posOf(doc, "c_preview")),
  );
}

// ---- 5. 旧图兼容：memberOf 归一成 contains ----
{
  const doc = doc0();
  doc.edges = doc.edges.filter((e) => !(e.from === "g_1" && e.to === "c_media"));
  doc.edges.push({ from: "c_media", to: "g_1", kind: "memberOf", order: 6 });
  const out = sync.syncLayoutIntoGraph({ doc, snapshot: snapA(), layerKey: "l1" });
  check(
    "旧图 control --memberOf--> group：识别出归属未变（不搬运，memberOf 不算换组）",
    out.moved.length === 0 && out.regrouped.length === 0,
    `moved=${out.moved.length}`,
  );
  check(
    "旧图 memberOf 归一成 contains：结果不再含 memberOf，且结构变化被如实报告",
    !out.doc.edges.some((e) => e.kind === "memberOf") &&
      hasEdge(out.doc, "g_1", "c_media", "contains") &&
      out.structureChanged === true,
  );
}

// ---- 6. 面板数如实统计 ----
{
  const out = sync.syncLayoutIntoGraph({ doc: doc0(), snapshot: snapB(), layerKey: "l1" });
  check("参与同步的面板数 = 布局里的面板数", out.panels === 3, `panels=${out.panels}`);
}

// ---- 7. 独立窗口（没有 dockview）：快照走跨窗口共享通道 ----
// 用户实测回归（蓝图面板被拖成**独立窗口**后点「同步布局」只报"当前没有可同步的页面布局"、
// 画布毫无变化）：独立窗口里 `getDockview()` 恒为 null（见 `SinglePanelHost`），所以快照必须
// 改读主窗口在每次布局变化时发布的结构。这里把「发布 → 读取 → 同步」整条数据链路跑通。
{
  const store = new Map();
  const stub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
  };
  const hadLocalStorage = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
  try {
    check("跨窗口共享快照：还没发布时读到 null（降级而不是抛错）", structure.readStructure() === null);
    structure.publishStructure(snapB());
    const shared = structure.readStructure();
    check(
      "跨窗口共享快照：主窗口发布后，独立窗口能读到同一份结构",
      !!shared && shared.regions.length === snapB().regions.length,
      `regions=${shared?.regions.length ?? 0}`,
    );
    const viaShared = sync.syncLayoutIntoGraph({
      doc: doc0(),
      snapshot: shared,
      layerKey: "l1",
    });
    const viaDirect = sync.syncLayoutIntoGraph({
      doc: doc0(),
      snapshot: snapB(),
      layerKey: "l1",
    });
    check(
      "独立窗口路径：共享快照驱动的同步与直连 dockview 等价，且真的产生移动",
      viaShared.moved.length > 0 &&
        JSON.stringify(viaShared.moved) === JSON.stringify(viaDirect.moved) &&
        JSON.stringify(viaShared.regrouped) === JSON.stringify(viaDirect.regrouped) &&
        viaShared.structureChanged === viaDirect.structureChanged,
      `moved=${viaShared.moved.length} regrouped=${viaShared.regrouped.length}`,
    );
  } finally {
    if (hadLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
    } else {
      delete globalThis.localStorage;
    }
  }
}

// ---- 8. 浮层（overlay）拥有的面板：不参与页面结构，结构父唯一 ----
{
  /** 每个节点最多一个结构父（contains / 旧图 memberOf 都算）。 */
  const parentsOf = (doc, key) =>
    doc.edges.filter(
      (e) => (e.kind === "contains" || e.kind === "memberOf") && e.to === key,
    );

  /**
   * 浮层夹具：`ov_1` 浮层拥有 `c_media`（media 面板）；media 在布局里**停靠**在
   * 与 preview 同一个标签组 `g_1` 里（浮层显示时它才是浮动窗口，停靠时照样进快照）。
   */
  const docOverlay = () =>
    JSON.parse(
      JSON.stringify({
        schema_version: 1,
        layers: [{ key: "l1", name: "主界面", is_home: true }],
        nodes: [
          { key: "ui", type: "interface", layer: "l1", position: { x: 300, y: 40 } },
          { key: "blk_1", type: "layout_block", layer: "l1", name: "区域 1", position: { x: 40, y: 170 } },
          { key: "g_1", type: "group", layer: "l1", mode: "exclusive", position: { x: 40, y: 300 } },
          { key: "c_preview", type: "control", layer: "l1", panel_id: "preview", position: { x: 40, y: 430 } },
          { key: "ov_1", type: "overlay", layer: "l1", position: { x: 400, y: 170 } },
          { key: "c_media", type: "control", layer: "l1", panel_id: "media", position: { x: 400, y: 300 } },
        ],
        edges: [
          { from: "ui", to: "blk_1", kind: "contains", order: 1 },
          { from: "blk_1", to: "g_1", kind: "contains", order: 2 },
          { from: "g_1", to: "c_preview", kind: "contains", order: 3 },
          { from: "ui", to: "ov_1", kind: "contains", order: 4 },
          { from: "ov_1", to: "c_media", kind: "contains", order: 5 },
        ],
      }),
    );

  /** 浮层里嵌的是标签组：`ov_1 → og_1(group) → c_media`。 */
  const docOverlayGroup = () =>
    JSON.parse(
      JSON.stringify({
        schema_version: 1,
        layers: [{ key: "l1", name: "主界面", is_home: true }],
        nodes: [
          { key: "ui", type: "interface", layer: "l1", position: { x: 300, y: 40 } },
          { key: "blk_1", type: "layout_block", layer: "l1", name: "区域 1", position: { x: 40, y: 170 } },
          { key: "g_1", type: "group", layer: "l1", mode: "exclusive", position: { x: 40, y: 300 } },
          { key: "c_preview", type: "control", layer: "l1", panel_id: "preview", position: { x: 40, y: 430 } },
          { key: "ov_1", type: "overlay", layer: "l1", position: { x: 400, y: 170 } },
          { key: "og_1", type: "group", layer: "l1", mode: "independent", position: { x: 400, y: 300 } },
          { key: "c_media", type: "control", layer: "l1", panel_id: "media", position: { x: 400, y: 430 } },
        ],
        edges: [
          { from: "ui", to: "blk_1", kind: "contains", order: 1 },
          { from: "blk_1", to: "g_1", kind: "contains", order: 2 },
          { from: "g_1", to: "c_preview", kind: "contains", order: 3 },
          { from: "ui", to: "ov_1", kind: "contains", order: 4 },
          { from: "ov_1", to: "og_1", kind: "contains", order: 5 },
          { from: "og_1", to: "c_media", kind: "contains", order: 6 },
        ],
      }),
    );

  /** 布局：media 与 preview 同属一个标签组（media 是浮层内容，但此刻停靠在这里）。 */
  const snapOverlay = () => ({
    at: 9,
    regions: [{ panels: ["media", "preview"], left: 0, right: 200, top: 0 }],
  });

  /** 布局：整个界面只有浮层内容面板 media 自己一栏。 */
  const snapOverlayOnly = () => ({
    at: 10,
    regions: [{ panels: ["media"], left: 0, right: 200, top: 0 }],
  });

  const before = docOverlay();
  const out = sync.syncLayoutIntoGraph({ doc: before, snapshot: snapOverlay(), layerKey: "l1" });

  check(
    "浮层拥有的面板：同步后仍只有浮层一个结构父（不再被挂到页面标签组下）",
    parentsOf(out.doc, "c_media").length === 1 && parentsOf(out.doc, "c_media")[0].from === "ov_1",
    parentsOf(out.doc, "c_media").map((e) => `${e.kind}:${e.from}`).join(" + ") || "无结构父",
  );
  check(
    "浮层场景零改动：既不新增也不换组，结构未变、边集合与位置逐项一致",
    out.added.length === 0 &&
      out.regrouped.length === 0 &&
      out.moved.length === 0 &&
      out.structureChanged === false &&
      sameEdges(before, out.doc) &&
      samePos(posOf(before, "c_media"), posOf(out.doc, "c_media")) &&
      samePos(posOf(before, "c_preview"), posOf(out.doc, "c_preview")),
    `added=${out.added.length} regrouped=${out.regrouped.length} moved=${out.moved.length}`,
  );
  check(
    "浮层占了一个标签页，不因此把这一栏的标签组拆掉：g_1 仍是 c_preview 的父",
    hasEdge(out.doc, "g_1", "c_preview", "contains") &&
      nodeOf(out.doc, "c_preview").position.x === nodeOf(before, "c_preview").position.x,
  );
  check(
    "浮层场景幂等：再同步一次仍是零改动",
    (() => {
      const again = sync.syncLayoutIntoGraph({
        doc: out.doc,
        snapshot: snapOverlay(),
        layerKey: "l1",
      });
      return again.count === 0 && again.structureChanged === false;
    })(),
  );
  check(
    "浮层内容面板不出现在布局里时同样不动它（也不因缺席被重挂父）",
    (() => {
      const lonely = docOverlay();
      const r = sync.syncLayoutIntoGraph({
        doc: lonely,
        snapshot: { at: 11, regions: [{ panels: ["preview"], left: 0, right: 100, top: 0 }] },
        layerKey: "l1",
      });
      // preview 是页面面板：布局里只剩它一个 → 按"单面板区域"约定上提到布局块（既有规则）。
      // 这里要盯的是**浮层内容面板**：父不变、位置不变、不参与搬运。
      return (
        parentsOf(r.doc, "c_media").length === 1 &&
        parentsOf(r.doc, "c_media")[0].from === "ov_1" &&
        !r.moved.includes("c_media") &&
        samePos(posOf(lonely, "c_media"), posOf(r.doc, "c_media"))
      );
    })(),
  );
  check(
    "整栏面板都归浮层：不新建空区域，节点数一个不增",
    (() => {
      const r = sync.syncLayoutIntoGraph({
        doc: docOverlay(),
        snapshot: snapOverlayOnly(),
        layerKey: "l1",
      });
      return r.added.length === 0 && r.doc.nodes.length === before.nodes.length;
    })(),
  );
  check(
    "浮层嵌套标签组：浮层子树（标签组 + 面板）整体不参与，页面也不会复用它",
    (() => {
      const r = sync.syncLayoutIntoGraph({
        doc: docOverlayGroup(),
        snapshot: snapOverlay(),
        layerKey: "l1",
      });
      return (
        parentsOf(r.doc, "c_media").length === 1 &&
        parentsOf(r.doc, "c_media")[0].from === "og_1" &&
        parentsOf(r.doc, "og_1").length === 1 &&
        parentsOf(r.doc, "og_1")[0].from === "ov_1" &&
        r.structureChanged === false
      );
    })(),
  );
  /**
   * **真实工程回归**（用户库里的蓝图 + `data/debug.log` 的
   * `[reconcile] … dockviewGroup=1 active=repo→repo members=[repo, tasks]`）：
   * `tasks` 是浮层 `ov_1` 的内容面板，却正停靠在 `repo` 所在的标签组里。
   * 这正是「浮层连接的面板被再挂到不属于浮层的标签组下」的原始现场。
   */
  const docReal = () =>
    JSON.parse(
      JSON.stringify({
        schema_version: 2,
        layers: [{ key: "l_main", name: "主界面", is_home: true }],
        nodes: [
          { key: "ui", type: "interface", layer: "l_main", position: { x: 600, y: 40 } },
          { key: "blk_left", type: "layout_block", layer: "l_main", name: "左栏", position: { x: 40, y: 170 } },
          { key: "g_1_1", type: "group", layer: "l_main", mode: "exclusive", position: { x: 40, y: 300 } },
          { key: "c_repo", type: "control", layer: "l_main", panel_id: "repo", position: { x: 40, y: 430 } },
          { key: "ov_1", type: "overlay", layer: "l_main", position: { x: 700, y: 170 } },
          { key: "c_1", type: "control", layer: "l_main", panel_id: "tasks", position: { x: 700, y: 300 } },
        ],
        edges: [
          { from: "ui", to: "blk_left", kind: "contains", order: 1 },
          { from: "blk_left", to: "g_1_1", kind: "contains", order: 2 },
          { from: "g_1_1", to: "c_repo", kind: "contains", order: 3 },
          { from: "ui", to: "ov_1", kind: "contains", order: 4 },
          { from: "ov_1", to: "c_1", kind: "contains", order: 5 },
        ],
      }),
    );

  /** 布局：`repo` 与浮层内容面板 `tasks` 就在同一个标签组里。 */
  const snapReal = () => ({
    at: 20,
    regions: [{ panels: ["repo", "tasks"], left: 0, right: 200, top: 0 }],
  });

  check(
    "真实场景回归：浮层内容面板与别的面板同停靠在一个标签组 —— 同步后仍只有浮层一个结构父",
    (() => {
      const before = docReal();
      const r = sync.syncLayoutIntoGraph({
        doc: before,
        snapshot: snapReal(),
        layerKey: "l_main",
      });
      return (
        parentsOf(r.doc, "c_1").length === 1 &&
        parentsOf(r.doc, "c_1")[0].from === "ov_1" &&
        !hasEdge(r.doc, "g_1_1", "c_1", "contains")
      );
    })(),
  );
  check(
    "真实场景回归：这一栏的标签组不被拆掉，repo 仍留在 g_1_1，整次同步零改动",
    (() => {
      const before = docReal();
      const r = sync.syncLayoutIntoGraph({
        doc: before,
        snapshot: snapReal(),
        layerKey: "l_main",
      });
      return (
        hasEdge(r.doc, "g_1_1", "c_repo", "contains") &&
        !hasEdge(r.doc, "blk_left", "c_repo", "contains") &&
        r.added.length === 0 &&
        r.moved.length === 0 &&
        r.structureChanged === false &&
        sameEdges(before, r.doc)
      );
    })(),
  );

  check(
    "结构父唯一（跨夹具不变量）：任何控件/标签组节点都不会有第二个结构父",
    (() => {
      const cases = [
        sync.syncLayoutIntoGraph({ doc: doc0(), snapshot: snapA(), layerKey: "l1" }).doc,
        sync.syncLayoutIntoGraph({ doc: doc0(), snapshot: snapB(), layerKey: "l1" }).doc,
        sync.syncLayoutIntoGraph({ doc: doc0(), snapshot: snapC(), layerKey: "l1" }).doc,
        sync.syncLayoutIntoGraph({ doc: docOverlay(), snapshot: snapOverlay(), layerKey: "l1" }).doc,
        sync.syncLayoutIntoGraph({ doc: docOverlayGroup(), snapshot: snapOverlay(), layerKey: "l1" }).doc,
      ];
      for (const doc of cases) {
        for (const node of doc.nodes) {
          if (node.type !== "control" && node.type !== "group") {
            continue;
          }
          if (parentsOf(doc, node.key).length > 1) {
            return false;
          }
        }
      }
      return true;
    })(),
  );
  check(
    "面板数如实统计：归浮层的面板不计入页面结构",
    out.panels === 1,
    `panels=${out.panels}`,
  );
}

// ---- 9. 源码锚点：工具条入口 + 面板接线 + 落库 + 浮层排除 ----
{
  const read = (p) => readFileSync(join(ROOT, p), "utf8");
  const toolbar = read("apps/desktop/src/app_ui/panels/BlueprintToolbar.tsx");
  const panel = read("apps/desktop/src/app_ui/panels/BlueprintPanel.tsx");
  const edits = read("apps/desktop/src/app_ui/panels/useBlueprintGraphEdits.ts");
  const syncSrc = read("apps/desktop/src/app_ui/panels/blueprintLayoutSync.ts");
  check(
    "工具条（正向锚点）：有 onSyncLayout 回调与「同步布局」按钮，title 指向 syncLayoutHint",
    toolbar.includes("onSyncLayout: () => void;") &&
      toolbar.includes("onSyncLayout,") &&
      toolbar.includes('t("blueprint.syncLayout")') &&
      toolbar.includes('title={t("blueprint.syncLayoutHint")}'),
  );
  check(
    "面板接线（正向锚点）：BlueprintPanel 把 edits.onSyncLayout 传给工具条",
    panel.includes("onSyncLayout={edits.onSyncLayout}"),
  );
  check(
    "落库（正向锚点）：同步后写入编辑器状态并静默落库（persistDoc）",
    edits.includes("syncLayoutIntoGraph({ doc, snapshot, layerKey })") &&
      edits.includes("mutate(outcome.doc)") &&
      edits.includes("persistDoc(outcome.doc)"),
  );
  check(
    "快照来源（正向锚点）：本窗口有 dockview 就直抓，没有就退回跨窗口共享快照",
    edits.includes("app.getDockview()") &&
      edits.includes("snapshotFromDockview(dv)") &&
      edits.includes(": readStructure()"),
  );
  check(
    "独立窗口回归锚点：不再因 getDockview() 为 null 就早退（曾报「同步布局无效」）",
    /const snapshot = dv \? snapshotFromDockview\(dv\) : readStructure\(\);/.test(edits) &&
      !/if \(!dv\)\s*\{/.test(edits),
  );
  check(
    "无布局兜底（正向锚点）：确实拿不到结构时才给「没有可同步的布局」提示",
    edits.includes('app.t("blueprint.syncLayoutNoLayout")') &&
      edits.includes("snapshot.regions.length === 0"),
  );
  check(
    "浮层排除（正向锚点）：overlay 子树被摘出页面结构，overlay 也不算页面结构父",
    syncSrc.includes("overlayOwned") &&
      syncSrc.includes("overlayPanels") &&
      syncSrc.includes("overlayOwned.has(node.key)") &&
      syncSrc.includes('from === "overlay" || overlayOwned.has(e.from) || overlayOwned.has(e.to)') &&
      /STRUCT_PARENT[^=]*= new Set\(\[[^\]]*"interface"/.test(syncSrc) &&
      !/STRUCT_PARENT[^=]*= new Set\(\[[^\]]*"overlay"/.test(syncSrc),
  );
  check(
    "标签组判据用布局面板数（回归锚点）：浮层占一个标签页时不误拆这一栏的标签组",
    syncSrc.includes("if (panels === 1)"),
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
