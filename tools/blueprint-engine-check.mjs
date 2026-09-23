/**
 * 蓝图引擎行为自检（开发期验证，不参与打包）。
 *
 * 两部分：
 * 1. **合成用例（始终运行，断言 + 退出码）**：用内存图驱动真实 `BlueprintEngine`，
 *    覆盖 D48 界面跳转（`navigate`）、D50 浮层显隐（`overlay`）、D51 只求值当前层、
 *    以及组收起（collapse/expand）；这些是引擎的可判定行为，不依赖宿主环境。
 * 2. **诊断（可选）**：给定仓库库路径时，对该库的当前生效蓝图跑一遍典型交互并打印
 *    引擎推导出的操作序列——用于回答"删掉规则后为什么还有联动"这类问题。
 *
 * 用法：pnpm check:blueprint-engine [仓库库路径] [蓝图id]
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = "E:/Hamster Pouch";

const { BlueprintEngine } = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/core/blueprintEngine.ts`).href
);

const { pickNeighborByDirection, adjacencyAxis } = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/shared/blueprintLayout.ts`).href
);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** 双层的合成图：l_main 里双击图像 → 显示查看器；单击 → 跳转到 l_edit；l_edit 里显示浮层。 */
function syntheticGraph() {
  return {
    schema_version: 2,
    layers: [
      { key: "l_main", name: "主界面" },
      { key: "l_edit", name: "编辑界面" },
    ],
    nodes: [
      { key: "ui_main", type: "interface", layer: "l_main", position: { x: 40, y: 40 } },
      { key: "ui_edit", type: "interface", layer: "l_edit", position: { x: 40, y: 40 } },
      { key: "blk_main", type: "layout_block", layer: "l_main", name: "主区", position: { x: 40, y: 170 } },
      { key: "blk_edit", type: "layout_block", layer: "l_edit", name: "编辑区", position: { x: 40, y: 170 } },
      { key: "g_main", type: "group", layer: "l_main", mode: "exclusive", position: { x: 340, y: 170 } },
      { key: "g_edit", type: "group", layer: "l_edit", mode: "exclusive", position: { x: 340, y: 170 } },
      { key: "c_media", type: "control", layer: "l_main", panel_id: "media", position: { x: 340, y: 300 } },
      { key: "c_viewer", type: "control", layer: "l_main", panel_id: "viewer", position: { x: 640, y: 300 } },
      { key: "c_player", type: "control", layer: "l_main", panel_id: "player", position: { x: 640, y: 430 } },
      { key: "c_edit", type: "control", layer: "l_edit", panel_id: "metadata", position: { x: 340, y: 300 } },
      { key: "k_edit", type: "class", layer: "l_edit", control: "c_edit", media_type: "image", position: { x: 640, y: 300 } },
      { key: "o_edit", type: "object", layer: "l_edit", class: "k_edit", scope: "double_clicked", position: { x: 940, y: 300 } },
      { key: "k_image", type: "class", layer: "l_main", control: "c_media", media_type: "image", position: { x: 940, y: 300 } },
      { key: "o_img", type: "object", layer: "l_main", class: "k_image", scope: "double_clicked", position: { x: 1240, y: 300 } },
      { key: "o_img_click", type: "object", layer: "l_main", class: "k_image", scope: "clicked", position: { x: 1240, y: 430 } },
      { key: "e_dbl", type: "event", layer: "l_main", trigger: "double_click", position: { x: 1540, y: 300 } },
      { key: "e_click", type: "event", layer: "l_main", trigger: "click", position: { x: 1540, y: 430 } },
      { key: "e_edit_dbl", type: "event", layer: "l_edit", trigger: "double_click", position: { x: 1540, y: 300 } },
      { key: "ov_float", type: "overlay", layer: "l_edit", name: "浮层 1", visible: false, height: 3, shadow: "lg", radius: "md", hide_label: true, position: { x: 940, y: 560 } },
      { key: "c_float", type: "control", layer: "l_edit", panel_id: "tasks", title_key: "panel.tasks", position: { x: 1240, y: 560 } },
      { key: "a_show_viewer", type: "action", layer: "l_main", op: "show", target: "c_viewer", position: { x: 1840, y: 300 } },
      { key: "a_navigate", type: "action", layer: "l_main", op: "navigate", target: "ui_edit", position: { x: 1840, y: 430 } },
      { key: "a_collapse", type: "action", layer: "l_main", op: "collapse", target: "g_main", position: { x: 1840, y: 560 } },
      { key: "a_overlay", type: "action", layer: "l_edit", op: "show", target: "ov_float", position: { x: 1840, y: 300 } },
    ],
    edges: [
      { from: "ui_main", to: "blk_main", kind: "contains", order: 1 },
      { from: "ui_edit", to: "blk_edit", kind: "contains", order: 2 },
      { from: "blk_main", to: "g_main", kind: "contains", order: 3 },
      { from: "blk_edit", to: "g_edit", kind: "contains", order: 4 },
      { from: "g_main", to: "c_media", kind: "contains", order: 5 },
      { from: "g_main", to: "c_viewer", kind: "contains", order: 6 },
      { from: "g_main", to: "c_player", kind: "contains", order: 7 },
      { from: "g_edit", to: "c_edit", kind: "contains", order: 8 },
      { from: "c_edit", to: "k_edit", kind: "contains", order: 19 },
      { from: "k_edit", to: "o_edit", kind: "contains", order: 20 },
      { from: "o_edit", to: "e_edit_dbl", kind: "on", order: 21 },
      { from: "c_media", to: "k_image", kind: "contains", order: 9 },
      { from: "k_image", to: "o_img", kind: "contains", order: 10 },
      { from: "k_image", to: "o_img_click", kind: "contains", order: 11 },
      { from: "ui_edit", to: "ov_float", kind: "contains", order: 12 },
      { from: "ov_float", to: "c_float", kind: "contains", order: 22 },
      { from: "o_img", to: "e_dbl", kind: "on", order: 13 },
      { from: "o_img_click", to: "e_click", kind: "on", order: 14 },
      { from: "e_dbl", to: "a_show_viewer", kind: "fires", order: 15 },
      { from: "e_click", to: "a_navigate", kind: "fires", order: 16 },
      { from: "e_dbl", to: "a_collapse", kind: "fires", order: 17 },
      { from: "e_edit_dbl", to: "a_overlay", kind: "fires", order: 18 },
    ],
  };
}

/** 驱动引擎并收集执行器收到的操作。 */
function run(graph, layer, trigger, mediaType, context) {
  const engine = new BlueprintEngine();
  engine.setGraph(graph);
  engine.setLayer(layer);
  const ops = [];
  engine.setExecutor({
    showPanel: (id, floating) => ops.push(`show ${id}${floating ? " (floating)" : ""}`),
    hidePanel: (id) => ops.push(`hide ${id}`),
    togglePanel: (id, floating) => ops.push(`toggle ${id}${floating ? " (floating)" : ""}`),
    collapsePanels: (ids, absorb) =>
      ops.push(
        `collapse [${ids.join(", ")}]${
          absorb ? " absorb=" + JSON.stringify(absorb) : ""
        }`,
      ),
    expandPanels: (ids) => ops.push(`expand [${ids.join(", ")}]`),
    playFile: (fileId) => ops.push(`play ${fileId}`),
    navigateLayer: (layerKey) => ops.push(`navigate ${layerKey}`),
    setOverlayVisible: (overlayKey, visible) =>
      ops.push(`overlay ${overlayKey} ${visible ? "show" : "hide"}`),
    showOverlayPanel: (panelId, box) =>
      ops.push(`float ${panelId} ${box.width}×${box.height} @${box.anchor}(${box.offsetX}, ${box.offsetY})`),
  });
  engine.dispatch({
    trigger,
    target: { mediaType, fileId: "file-1" },
    ...(context ? { context } : {}),
  });
  return ops;
}

// ---- 合成用例：D48 界面跳转 / D50 浮层 / D51 分层求值 ----
{
  const graph = syntheticGraph();

  const main = run(graph, "l_main", "double_click", "image");
  check(
    "D48/D29：当前层 l_main 双击图像 → 显示查看器 + 收起组（同为 fires 的动作都执行）",
    main.includes("show viewer") && main.includes("collapse [media, viewer, player]"),
    main.join(" ; ") || "（无动作）",
  );

  const nav = run(graph, "l_main", "click", "image");
  check(
    "D48：单击图像 → 界面跳转 navigate l_edit",
    nav.includes("navigate l_edit"),
    nav.join(" ; ") || "（无动作）",
  );

  const other = run(graph, "l_main", "double_click", "video");
  check(
    "D51/D33：非当前层（l_edit）的规则不参与求值",
    !other.some((op) => op.startsWith("overlay")),
    other.join(" ; ") || "（无动作）",
  );

  const edit = run(graph, "l_edit", "double_click", "image");
  check(
    "D50：浮层是容器 → 显示浮层 = 内容面板以浮动方式显示（未写尺寸/定位时取默认最小与居中）+ 通知宿主",
    edit.includes("float tasks 240×160 @center(0, 0)") &&
      edit.includes("overlay ov_float show"),
    edit.join(" ; ") || "（无动作）",
  );

  // 回归：`visible: true` 的浮层必须在**装载对账**时就显示其内容
  // （旧缺陷：只在事件动作里显隐，浮层内容永远不出现）。
  {
    const engine = new BlueprintEngine();
    engine.setGraph(graph);
    engine.setLayer("l_edit");
    const ops = [];
    engine.setExecutor({
      showPanel: (id, floating) => ops.push(`show ${id}${floating ? " (floating)" : ""}`),
      hidePanel: (id) => ops.push(`hide ${id}`),
      togglePanel: (id) => ops.push(`toggle ${id}`),
      collapsePanels: (ids) => ops.push(`collapse [${ids.join(", ")}]`),
      expandPanels: (ids) => ops.push(`expand [${ids.join(", ")}]`),
      playFile: (id) => ops.push(`play ${id}`),
      navigateLayer: (key) => ops.push(`navigate ${key}`),
      setOverlayVisible: (key, visible) =>
        ops.push(`overlay ${key} ${visible ? "show" : "hide"}`),
      showOverlayPanel: (id, box) =>
        ops.push(`float ${id} ${box.width}×${box.height} @${box.anchor}(${box.offsetX}, ${box.offsetY})`),
    });
    const visibleGraph = syntheticGraph();
    const ov = visibleGraph.nodes.find((n) => n.key === "ov_float");
    ov.visible = true;
    ov.size = { width: 420, height: 300 };
    ov.anchor = "bottom_right";
    ov.offset_x = -24;
    // 初始对账：只有 visible===true 的浮层会自动显示
    engine.applyOverlayDefaults(visibleGraph, "l_edit");
    check(
      "浮层初始显隐对账：visible=true 的浮层在装载时即显示内容（含尺寸与九宫格定位）",
      ops.includes("float tasks 420×300 @bottom_right(-24, 0)") &&
        ops.includes("overlay ov_float show"),
      ops.join(" ; ") || "（无动作）",
    );
    // 再对账一次：状态未变 → 不重复执行（幂等，不打扰使用者）
    ops.length = 0;
    engine.applyOverlayDefaults(visibleGraph, "l_edit");
    check(
      "浮层初始显隐对账是幂等的（状态未变不重复显示）",
      ops.length === 0,
      ops.join(" ; ") || "（无动作）",
    );
    // **回归**：套用布局会重建 dockview 内容 → 必须清空记忆后重新显示浮层
    // （真实缺陷：先显示、再被 fromJSON 抹掉，之后因"已在目标状态"永不重显）。
    engine.resetOverlayState();
    ops.length = 0;
    engine.applyOverlayDefaults(visibleGraph, "l_edit");
    check(
      "套用布局后重新对账浮层：清空记忆 → visible=true 的浮层内容被重新显示",
      ops.includes("float tasks 420×300 @bottom_right(-24, 0)"),
      ops.join(" ; ") || "（无动作）",
    );
    // 蓝图改成不显示 → 收敛为隐藏
    const hiddenGraph = syntheticGraph();
    hiddenGraph.nodes.find((n) => n.key === "ov_float").visible = false;
    engine.applyOverlayDefaults(hiddenGraph, "l_edit");
    check(
      "浮层初始显隐对账：蓝图改为不显示 → 隐藏其内容",
      ops.includes("hide tasks") && ops.includes("overlay ov_float hide"),
      ops.join(" ; ") || "（无动作）",
    );

    // **回归**：断开「界面 --contains--> 浮层」后，浮层不能再显示（用户报告：
    // 断开连接后浮层还在）。已显示的要收起来，未显示的不许显示。
    {
      engine.resetOverlayState();
      const attachedGraph = syntheticGraph();
      const a = attachedGraph.nodes.find((n) => n.key === "ov_float");
      a.visible = true;
      engine.applyOverlayDefaults(attachedGraph, "l_edit");
      ops.length = 0;
      // 用户删掉 ui_edit → ov_float 这条 contains 边
      const detachedGraph = {
        ...attachedGraph,
        edges: attachedGraph.edges.filter((e) => e.to !== "ov_float"),
      };
      engine.applyOverlayDefaults(detachedGraph, "l_edit");
      check(
        "回归：断开 界面→浮层 连接后 → 浮层收起（hide）且不再显示",
        ops.includes("hide tasks") &&
          ops.includes("overlay ov_float hide") &&
          !ops.some((op) => op.startsWith("float ")),
        ops.join(" ; ") || "（无动作）",
      );

      // 未连接 + 从未显示过 + visible=true → 什么都不做（不许显示）
      const fresh = new BlueprintEngine();
      fresh.setGraph(detachedGraph);
      fresh.setLayer("l_edit");
      const ops2 = [];
      fresh.setExecutor({
        showPanel: (id) => ops2.push(`show ${id}`),
        hidePanel: (id) => ops2.push(`hide ${id}`),
        togglePanel: (id) => ops2.push(`toggle ${id}`),
        collapsePanels: () => undefined,
        expandPanels: () => undefined,
        playFile: () => undefined,
        navigateLayer: (k) => ops2.push(`navigate ${k}`),
        setOverlayVisible: (k, v) => ops2.push(`overlay ${k} ${v ? "show" : "hide"}`),
        showOverlayPanel: (id) => ops2.push(`float ${id}`),
      });
      fresh.applyOverlayDefaults(detachedGraph, "l_edit");
      check(
        "回归：从未连接界面的浮层（visible=true）在装载时不显示",
        ops2.length === 0,
        ops2.join(" ; ") || "（无动作）",
      );

      // 显式动作指向未连接的浮层 → 也不显示
      const g3 = syntheticGraph();
      g3.nodes.find((n) => n.key === "ov_float").visible = false;
      const detached3 = { ...g3, edges: g3.edges.filter((e) => e.to !== "ov_float") };
      const ops3 = run(detached3, "l_edit", "double_click", "image");
      check(
        "回归：show 动作指向未连接界面的浮层 → 不显示（未接通）",
        !ops3.some((op) => op.startsWith("float ")) &&
          !ops3.includes("overlay ov_float show"),
        ops3.join(" ; ") || "（无动作）",
      );
    }
  }

  // 隐藏浮层：关闭其内容面板，并通知宿主（取消「浮动控件」后不再需要绑定 id）
  {
    const engine = new BlueprintEngine();
    engine.setGraph(graph);
    engine.setLayer("l_edit");
    const ops = [];
    engine.setExecutor({
      showPanel: (id, floating) => ops.push(`show ${id}${floating ? " (floating)" : ""}`),
      hidePanel: (id) => ops.push(`hide ${id}`),
      togglePanel: (id) => ops.push(`toggle ${id}`),
      collapsePanels: (ids) => ops.push(`collapse [${ids.join(", ")}]`),
      expandPanels: (ids) => ops.push(`expand [${ids.join(", ")}]`),
      playFile: (id) => ops.push(`play ${id}`),
      navigateLayer: (key) => ops.push(`navigate ${key}`),
      setOverlayVisible: (key, visible) =>
        ops.push(`overlay ${key} ${visible ? "show" : "hide"}`),
      showOverlayPanel: (id, box) =>
        ops.push(`float ${id} ${box.width}×${box.height} @${box.anchor}(${box.offsetX}, ${box.offsetY})`),
    });
    const hideDoc = graph;
    const hideAction = hideDoc.nodes.find((n) => n.key === "a_overlay");
    hideAction.op = "hide";
    engine.dispatch({ trigger: "double_click", target: { mediaType: "image", fileId: "f" } });
    check(
      "D50：隐藏浮层 → 关闭其内容面板（浮动控件概念已取消，无需绑定）",
      ops.includes("hide tasks") && ops.includes("overlay ov_float hide"),
      ops.join(" ; ") || "（无动作）",
    );
  }
}

// ---- D29 hide_direction 透传 + selection_change/rating/has_tag 运行时 context ----
{
  // 轴向：组带 hide_direction=left → collapse 动作把 { direction: "left" } 传给执行器
  const g = syntheticGraph();
  g.nodes.find((n) => n.key === "g_main").hide_direction = "left";
  const ops = run(g, "l_main", "double_click", "image");
  check(
    "D29：collapse 动作透传 hide_direction=left（执行器据此把空间让给左侧邻居）",
    ops.some(
      (op) =>
        op.startsWith("collapse [media, viewer, player]") &&
        op.includes('"direction":"left"'),
    ),
    ops.join(" ; ") || "（无动作）",
  );

  // toward:<组> → 引擎解析为目标组成员面板 id 列表
  const g2 = syntheticGraph();
  g2.nodes.push({
    key: "g_other",
    type: "group",
    layer: "l_main",
    mode: "independent",
    position: { x: 340, y: 620 },
  });
  g2.nodes.push({
    key: "c_other",
    type: "control",
    layer: "l_main",
    panel_id: "tags",
    position: { x: 640, y: 620 },
  });
  g2.edges.push({ from: "blk_main", to: "g_other", kind: "contains", order: 30 });
  g2.edges.push({ from: "g_other", to: "c_other", kind: "contains", order: 31 });
  g2.nodes.find((n) => n.key === "g_main").hide_direction = "toward:g_other";
  const opsToward = run(g2, "l_main", "double_click", "image");
  check(
    "D29：collapse 动作把 toward:<组> 解析为成员面板 id（towardPanelIds=[tags]）",
    opsToward.some(
      (op) =>
        op.startsWith("collapse [media, viewer, player]") &&
        op.includes('"towardPanelIds":["tags"]'),
    ),
    opsToward.join(" ; ") || "（无动作）",
  );

  // selection_change 事件源 + rating 运行时 context（对象 scope=selected 才命中 selected 作用域）
  const g3 = syntheticGraph();
  g3.nodes.push({
    key: "o_sel",
    type: "object",
    layer: "l_main",
    class: "k_image",
    scope: "selected",
    position: { x: 1240, y: 620 },
  });
  g3.nodes.push({ key: "e_sel", type: "event", layer: "l_main", trigger: "selection_change", position: { x: 1540, y: 620 } });
  g3.nodes.push({ key: "cnd_rating", type: "condition", layer: "l_main", expr: "rating >= 3", position: { x: 1840, y: 620 } });
  g3.nodes.push({ key: "a_sel_viewer", type: "action", layer: "l_main", op: "show", target: "c_viewer", position: { x: 2140, y: 620 } });
  g3.edges.push({ from: "o_sel", to: "e_sel", kind: "on", order: 40 });
  g3.edges.push({ from: "e_sel", to: "cnd_rating", kind: "fires", order: 41 });
  g3.edges.push({ from: "cnd_rating", to: "a_sel_viewer", kind: "guards", order: 42 });
  const hits = run(g3, "l_main", "selection_change", "image", { rating: 4, tags: [] });
  check(
    "selection_change + rating>=3：context.rating=4 命中 → 显示查看器",
    hits.includes("show viewer"),
    hits.join(" ; ") || "（无动作）",
  );
  const miss = run(g3, "l_main", "selection_change", "image", { rating: 2, tags: [] });
  check(
    "selection_change + rating>=3：context.rating=2 不命中 → 无动作",
    !miss.includes("show viewer"),
    miss.join(" ; ") || "（无动作）",
  );

  // has_tag 运行时 context
  const g4 = syntheticGraph();
  g4.nodes.push({
    key: "o_sel2",
    type: "object",
    layer: "l_main",
    class: "k_image",
    scope: "selected",
    position: { x: 1240, y: 750 },
  });
  g4.nodes.push({ key: "e_sel2", type: "event", layer: "l_main", trigger: "selection_change", position: { x: 1540, y: 750 } });
  g4.nodes.push({ key: "cnd_tag", type: "condition", layer: "l_main", expr: "has_tag == 猫", position: { x: 1840, y: 750 } });
  g4.nodes.push({ key: "a_sel2_viewer", type: "action", layer: "l_main", op: "show", target: "c_viewer", position: { x: 2140, y: 750 } });
  g4.edges.push({ from: "o_sel2", to: "e_sel2", kind: "on", order: 50 });
  g4.edges.push({ from: "e_sel2", to: "cnd_tag", kind: "fires", order: 51 });
  g4.edges.push({ from: "cnd_tag", to: "a_sel2_viewer", kind: "guards", order: 52 });
  const tagHit = run(g4, "l_main", "selection_change", "image", { rating: 0, tags: ["猫", "动物"] });
  check(
    "selection_change + has_tag==猫：context.tags 命中 → 显示查看器",
    tagHit.includes("show viewer"),
    tagHit.join(" ; ") || "（无动作）",
  );
  const tagMiss = run(g4, "l_main", "selection_change", "image", { rating: 0, tags: ["风景"] });
  check(
    "selection_change + has_tag==猫：context.tags 不命中 → 无动作",
    !tagMiss.includes("show viewer"),
    tagMiss.join(" ; ") || "（无动作）",
  );
}

// ---- 纯几何：hide_direction 邻居选择（与运行时共用同一实现） ----
{
  const A = { id: "A", box: { left: 0, top: 0, width: 200, height: 400 } };
  const B = { id: "B", box: { left: 200, top: 0, width: 300, height: 400 } };
  const C = { id: "C", box: { left: 500, top: 0, width: 200, height: 400 } };
  check(
    "几何：水平行 A|B|C 中 B 的左邻=A",
    pickNeighborByDirection(B.box, [A, C], "left") === "A",
  );
  check(
    "几何：水平行 A|B|C 中 B 的右邻=C",
    pickNeighborByDirection(B.box, [A, C], "right") === "C",
  );
  const Av = { id: "A", box: { left: 0, top: 0, width: 400, height: 200 } };
  const Bv = { id: "B", box: { left: 0, top: 200, width: 400, height: 300 } };
  const Cv = { id: "C", box: { left: 0, top: 500, width: 400, height: 200 } };
  check(
    "几何：垂直列 A|B|C 中 B 的上邻=A",
    pickNeighborByDirection(Bv.box, [Av, Cv], "up") === "A",
  );
  check(
    "几何：垂直列 A|B|C 中 B 的下邻=C",
    pickNeighborByDirection(Bv.box, [Av, Cv], "down") === "C",
  );
  check(
    "几何：同水平带判定为水平相邻轴",
    adjacencyAxis(B.box, A.box) === "horizontal",
  );
  check(
    "几何：同垂直带判定为垂直相邻轴",
    adjacencyAxis(Bv.box, Av.box) === "vertical",
  );
}

// ---- 诊断（可选）：对给定仓库库跑一遍典型交互 ----
const dbPath = process.argv[2];
if (dbPath && existsSync(dbPath)) {
  const { DatabaseSync } = await import("node:sqlite");
  const wantedId = process.argv[3] ?? null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = wantedId
    ? db.prepare("SELECT * FROM blueprints WHERE id = ?").get(wantedId)
    : db.prepare("SELECT * FROM blueprints WHERE is_default = 1 LIMIT 1").get();
  db.close();
  if (!row) {
    console.error("找不到蓝图");
  } else {
    const graph = JSON.parse(row.blueprint_json);
    console.log(`\n[诊断] 蓝图: ${row.name} (id=${row.id})`);
    console.log(
      `节点 ${graph.nodes.length} / 边 ${graph.edges.length} / schema=${graph.schema_version} / default_version=${graph.default_version ?? "-"}`,
    );
    console.log(
      `层: ${(graph.layers ?? []).map((l) => `${l.key}(${l.name})`).join(", ") || "（单层兜底）"}`,
    );
    const layer = graph.layers?.[0]?.key ?? null;
    for (const [trigger, mediaType] of [
      ["double_click", "image"],
      ["double_click", "video"],
      ["double_click", "audio"],
      ["click", "image"],
      ["selection_change", "image"],
    ]) {
      const ops = run(graph, layer, trigger, mediaType);
      console.log(`${trigger} / ${mediaType} → ${ops.length ? ops.join(" ; ") : "（无动作）"}`);
    }
  }
} else if (dbPath) {
  console.error(`仓库库不存在，跳过诊断：${dbPath}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
