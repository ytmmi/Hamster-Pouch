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

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = "E:/Hamster Pouch";

const { BlueprintEngine } = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/core/blueprintEngine.ts`).href
);

const { pickNeighborByDirection, adjacencyAxis } = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/shared/blueprintLayout.ts`).href
);

const chrome = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/shared/overlayChrome.ts`).href
);

const ui = await import(pathToFileURL(`${ROOT}/packages/ui/src/index.ts`).href);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/**
 * 浮层容器请求 → 可断言的一行。
 *
 * 断言里带上**内容面板**与**外观档位**，因为它们是宿主渲染容器所必需的输入
 * （D50 容器渲染：宿主靠 panelIds 找容器元素、靠外观档位取 token）。
 */
const overlayOp = (req) =>
  `overlay ${req.key} ${req.visible ? "show" : "hide"}` +
  ` panels=[${req.panelIds.join(",")}] shadow=${req.appearance.shadow}` +
  ` radius=${req.appearance.radius} label=${req.appearance.hideLabel ? "hidden" : "shown"}` +
  ` height=${req.appearance.height}`;

/**
 * ops 里是否存在该浮层的请求行。
 *
 * 用**前缀**判定而不是 `Array.includes(整行)`：整行里还有内容面板与外观档位，
 * 只关心显隐的断言不该随这些字段变化而失效。
 */
const hasOverlay = (ops, key, visible) =>
  ops.some((op) => op.startsWith(`overlay ${key} ${visible ? "show" : "hide"}`));

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
    applyOverlay: (req) => ops.push(overlayOp(req)),
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
    "D50：浮层是容器 → 显示浮层 = 内容面板以浮动方式显示（未写尺寸/定位时取默认最小与居中）",
    edit.includes("float tasks 240×160 @center(0, 0)"),
    edit.join(" ; ") || "（无动作）",
  );
  // 容器渲染的**输入完整性**：宿主拿不到内容面板就找不到容器元素、拿不到外观档位就只能猜像素。
  const shownOp = edit.find((op) => op.startsWith("overlay ov_float show")) ?? "";
  check(
    "D50：容器请求带内容面板与蓝图声明的外观档位（panels/shadow/radius/hide_label/height）",
    shownOp.includes("panels=[tasks] shadow=lg radius=md label=hidden height=3"),
    shownOp || "（无浮层请求）",
  );

  // 未声明外观档位 → 取缺省档位；`md` 刻意等于宿主既有浮动窗口观感，因此零视觉变化。
  {
    const bare = syntheticGraph();
    const ov = bare.nodes.find((n) => n.key === "ov_float");
    delete ov.shadow;
    delete ov.radius;
    delete ov.hide_label;
    delete ov.height;
    ov.visible = true;
    const bareOps = run(bare, "l_edit", "double_click", "image");
    const op = bareOps.find((o) => o.startsWith("overlay ov_float show")) ?? "";
    check(
      "D50：未声明外观档位 → 取缺省（shadow=md radius=md 标签显示 height=1，零视觉变化）",
      op.includes("shadow=md radius=md label=shown height=1"),
      op || "（无浮层请求）",
    );
  }

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
      applyOverlay: (req) => ops.push(overlayOp(req)),
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
        hasOverlay(ops, "ov_float", true),
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
      ops.includes("hide tasks") && hasOverlay(ops, "ov_float", false),
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
          hasOverlay(ops, "ov_float", false) &&
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
        applyOverlay: (req) => ops2.push(overlayOp(req)),
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
          !hasOverlay(ops3, "ov_float", true),
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
      applyOverlay: (req) => ops.push(overlayOp(req)),
      showOverlayPanel: (id, box) =>
        ops.push(`float ${id} ${box.width}×${box.height} @${box.anchor}(${box.offsetX}, ${box.offsetY})`),
    });
    const hideDoc = graph;
    const hideAction = hideDoc.nodes.find((n) => n.key === "a_overlay");
    hideAction.op = "hide";
    engine.dispatch({ trigger: "double_click", target: { mediaType: "image", fileId: "f" } });
    check(
      "D50：隐藏浮层 → 关闭其内容面板（浮动控件概念已取消，无需绑定）",
      ops.includes("hide tasks") && hasOverlay(ops, "ov_float", false),
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

// ---- 子类优先（用户口径）：类目链路自动排除已被子类定义的情况 ----
//
// 口径原文：「子类是类目的细分，只负责一种情况，当有子类蓝图链路时，类目中无子类的链路
// 就自动排除子类的情况，因为子类被定义了情况。在蓝图功能链路中子类不是必要节点，是补充节点。」
//
// 合成图：text 类目下有**两条**链——
//   ① 类目链路：k_text → o_text → e_text → a_text（显示 metadata）
//   ② 子类链路：k_text → k_txt(子类) → o_txt → e_txt → a_txt（显示 tags）
// 期望：format=txt 只命中子类链路；format=epub（无对应子类）仍走类目链路。
{
  const graph = {
    schema_version: 2,
    layers: [{ key: "l_main", name: "主界面" }],
    nodes: [
      { key: "ui", type: "interface", layer: "l_main", position: { x: 0, y: 0 } },
      { key: "blk", type: "layout_block", layer: "l_main", name: "区", position: { x: 0, y: 100 } },
      { key: "c_book", type: "control", layer: "l_main", panel_id: "bookpreview", position: { x: 0, y: 200 } },
      { key: "k_text", type: "class", layer: "l_main", control: "c_book", media_type: "text", position: { x: 200, y: 200 } },
      // 子类：挂在 k_text 之下，认领 txt 这一种情况
      { key: "k_txt", type: "subclass", layer: "l_main", subclass: "k_text", format: "txt", position: { x: 400, y: 200 } },
      // ① 类目链路的对象（无子类的那条分支）
      { key: "o_text", type: "object", layer: "l_main", class: "k_text", scope: "double_clicked", position: { x: 400, y: 300 } },
      { key: "e_text", type: "event", layer: "l_main", trigger: "double_click", position: { x: 600, y: 300 } },
      { key: "a_text", type: "action", layer: "l_main", op: "show", target: "c_book", position: { x: 800, y: 300 } },
      // ② 子类链路的对象
      { key: "o_txt", type: "object", layer: "l_main", subclass: "k_txt", scope: "double_clicked", position: { x: 400, y: 400 } },
      { key: "e_txt", type: "event", layer: "l_main", trigger: "double_click", position: { x: 600, y: 400 } },
      { key: "a_txt", type: "action", layer: "l_main", op: "show", target: "c_viewer", position: { x: 800, y: 400 } },
      { key: "c_viewer", type: "control", layer: "l_main", panel_id: "viewer", position: { x: 1000, y: 400 } },
    ],
    edges: [
      { from: "ui", to: "blk", kind: "contains", order: 1 },
      { from: "blk", to: "c_book", kind: "contains", order: 2 },
      { from: "c_book", to: "k_text", kind: "contains", order: 3 },
      { from: "k_text", to: "k_txt", kind: "contains", order: 4 },
      { from: "k_text", to: "o_text", kind: "contains", order: 5 },
      { from: "k_txt", to: "o_txt", kind: "contains", order: 6 },
      { from: "o_text", to: "e_text", kind: "on", order: 7 },
      { from: "o_txt", to: "e_txt", kind: "on", order: 8 },
      { from: "e_text", to: "a_text", kind: "fires", order: 9 },
      { from: "e_txt", to: "a_txt", kind: "fires", order: 10 },
    ],
  };
  // 上报时带上 format：txt 被 k_txt 子类认领 → 只走子类链路
  const runFormat = (format) => {
    const engine = new BlueprintEngine();
    engine.setGraph(graph);
    engine.setLayer("l_main");
    const ops = [];
    engine.setExecutor({
      showPanel: (id) => ops.push(`show ${id}`),
      hidePanel: (id) => ops.push(`hide ${id}`),
      togglePanel: (id) => ops.push(`toggle ${id}`),
      collapsePanels: () => undefined,
      expandPanels: () => undefined,
      playFile: () => undefined,
      navigateLayer: (k) => ops.push(`navigate ${k}`),
      applyOverlay: () => undefined,
      showOverlayPanel: () => undefined,
    });
    engine.dispatch({
      trigger: "double_click",
      target: { mediaType: "text", fileId: "f1", format },
    });
    return ops;
  };

  const txtOps = runFormat("txt");
  check(
    "子类优先：txt 已被子类认领 → 类目链路被排除，只执行子类链路（show viewer）",
    txtOps.includes("show viewer") && !txtOps.includes("show bookpreview"),
    txtOps.join(" ; ") || "（无动作）",
  );

  const epubOps = runFormat("epub");
  check(
    "子类优先：epub 没有对应子类 → 类目链路照常执行（show bookpreview）",
    epubOps.includes("show bookpreview") && !epubOps.includes("show viewer"),
    epubOps.join(" ; ") || "（无动作）",
  );

  // 子类是**补充节点**：把它删掉后，同一份 txt 上报应回落到类目链路（不是"什么都不做"）。
  {
    const withoutSubclass = {
      ...graph,
      nodes: graph.nodes.filter((n) => n.key !== "k_txt" && n.key !== "o_txt" && n.key !== "e_txt" && n.key !== "a_txt"),
      edges: graph.edges.filter(
        (e) => !["k_txt", "o_txt", "e_txt", "a_txt"].includes(e.from) && !["k_txt", "o_txt", "e_txt", "a_txt"].includes(e.to),
      ),
    };
    const engine = new BlueprintEngine();
    engine.setGraph(withoutSubclass);
    engine.setLayer("l_main");
    const ops = [];
    engine.setExecutor({
      showPanel: (id) => ops.push(`show ${id}`),
      hidePanel: () => undefined,
      togglePanel: () => undefined,
      collapsePanels: () => undefined,
      expandPanels: () => undefined,
      playFile: () => undefined,
      navigateLayer: () => undefined,
      applyOverlay: () => undefined,
      showOverlayPanel: () => undefined,
    });
    engine.dispatch({
      trigger: "double_click",
      target: { mediaType: "text", fileId: "f1", format: "txt" },
    });
    check(
      "子类是补充节点：移除子类后，同一 txt 上报回落到类目链路（不丢行为）",
      ops.includes("show bookpreview"),
      ops.join(" ; ") || "（无动作）",
    );
  }
}

// ---- 类目类型 `unlimited` / `empty` 的运行期命中（D136）----
//
// 两类极端档位：
// - `unlimited`（无限制）：该类目**匹配一切媒体类型**（跳过类型比较）；
// - `empty`（空）：该类目**排除全部**，任何上报都不命中（用于"暂时停用这条类目链"）；
// - `unlimited` **仍遵守子类优先**（照常调 `subclassClaimsFormat`）——否则"无限制"会连带把
//   已被子类认领的情况也吃进来，D102 的子类优先就失效了。
//
// 这三条是**行为**断言（真驱动引擎），不是"看代码里有这几个字"——后者换个写法就假绿。
{
  /** 一张最小图：一个类目 → 对象 → 事件 → 动作（显示 metadata），可换类目的 media_type。 */
  const graphWith = (mediaType, { withSubclass = false } = {}) => {
    const nodes = [
      { key: "ui", type: "interface", layer: "l_main", position: { x: 0, y: 0 } },
      { key: "blk", type: "layout_block", layer: "l_main", name: "区", position: { x: 0, y: 100 } },
      { key: "c_book", type: "control", layer: "l_main", panel_id: "bookpreview", position: { x: 0, y: 200 } },
      { key: "k", type: "class", layer: "l_main", control: "c_book", media_type: mediaType, position: { x: 200, y: 200 } },
      { key: "o", type: "object", layer: "l_main", class: "k", scope: "double_clicked", position: { x: 400, y: 300 } },
      { key: "e", type: "event", layer: "l_main", trigger: "double_click", position: { x: 600, y: 300 } },
      { key: "c_meta", type: "control", layer: "l_main", panel_id: "metadata", position: { x: 800, y: 300 } },
      { key: "a", type: "action", layer: "l_main", op: "show", target: "c_meta", position: { x: 800, y: 400 } },
    ];
    const edges = [
      { from: "ui", to: "blk", kind: "contains", order: 1 },
      { from: "blk", to: "c_book", kind: "contains", order: 2 },
      { from: "c_book", to: "k", kind: "contains", order: 3 },
      { from: "k", to: "o", kind: "contains", order: 4 },
      { from: "o", to: "e", kind: "on", order: 5 },
      { from: "e", to: "a", kind: "fires", order: 6 },
    ];
    if (withSubclass) {
      nodes.push({ key: "k_sc", type: "subclass", layer: "l_main", subclass: "k", format: "txt", position: { x: 400, y: 200 } });
      nodes.push({ key: "o_sc", type: "object", layer: "l_main", subclass: "k_sc", scope: "double_clicked", position: { x: 600, y: 200 } });
      nodes.push({ key: "e_sc", type: "event", layer: "l_main", trigger: "double_click", position: { x: 800, y: 200 } });
      nodes.push({ key: "c_view", type: "control", layer: "l_main", panel_id: "viewer", position: { x: 1000, y: 200 } });
      nodes.push({ key: "a_sc", type: "action", layer: "l_main", op: "show", target: "c_view", position: { x: 1000, y: 300 } });
      edges.push({ from: "k", to: "k_sc", kind: "contains", order: 7 });
      edges.push({ from: "k_sc", to: "o_sc", kind: "contains", order: 8 });
      edges.push({ from: "o_sc", to: "e_sc", kind: "on", order: 9 });
      edges.push({ from: "e_sc", to: "a_sc", kind: "fires", order: 10 });
    }
    return { schema_version: 2, layers: [{ key: "l_main", name: "主界面" }], nodes, edges };
  };
  /** 用一个上报媒体类型跑一遍，收集执行器动作。 */
  const observe = (graph, mediaType, format) => {
    const engine = new BlueprintEngine();
    engine.setGraph(graph);
    engine.setLayer("l_main");
    const ops = [];
    engine.setExecutor({
      showPanel: (id) => ops.push(`show ${id}`),
      hidePanel: (id) => ops.push(`hide ${id}`),
      togglePanel: (id) => ops.push(`toggle ${id}`),
      collapsePanels: () => undefined,
      expandPanels: () => undefined,
      playFile: () => undefined,
      navigateLayer: (k) => ops.push(`navigate ${k}`),
      applyOverlay: () => undefined,
      showOverlayPanel: () => undefined,
    });
    engine.dispatch({
      trigger: "double_click",
      target: { mediaType, fileId: "f1", ...(format ? { format } : {}) },
    });
    return ops;
  };

  // ① `unlimited` 对**每一种**媒体类型都命中（image/video/audio/text/pdf 全跑一遍）。
  const unlimitedGraph = graphWith("unlimited");
  const unlimitedHits = ["image", "video", "audio", "text", "pdf"].map((mt) => ({
    mt,
    ops: observe(unlimitedGraph, mt),
  }));
  check(
    "D136：`unlimited` 类目对 image/video/audio/text/pdf **全部命中**（无限制 = 匹配一切）",
    unlimitedHits.every(({ ops }) => ops.includes("show metadata")),
    unlimitedHits.map(({ mt, ops }) => `${mt}:${ops.includes("show metadata") ? "命中" : "未命中"}`).join(" "),
  );

  // ② `empty` 对**任何**媒体类型都不命中（含 archive 这类非媒体上报，不抛错）。
  const emptyGraph = graphWith("empty");
  const emptyProbes = ["image", "video", "audio", "text", "pdf"].map((mt) => ({
    mt,
    ops: observe(emptyGraph, mt),
  }));
  check(
    "D136：`empty` 类目对任何媒体类型**都不命中**（空 = 排除全部；不抛错、不误命中）",
    emptyProbes.every(({ ops }) => !ops.includes("show metadata")),
    emptyProbes.map(({ mt, ops }) => `${mt}:${ops.length === 0 ? "不命中" : ops.join("|")}`).join(" "),
  );

  // ③ 对照：`image` 类目只命中 image（证明 ①② 不是"所有类目都放行"的假绿）。
  const imageGraph = graphWith("image");
  check(
    "D136：对照——`image` 类目只命中 image，不命中 video（证明 unlimited/empty 的行为是特例而非普遍放行）",
    observe(imageGraph, "image").includes("show metadata") &&
      !observe(imageGraph, "video").includes("show metadata"),
    `image→${observe(imageGraph, "image").join("|") || "无"} video→${observe(imageGraph, "video").join("|") || "无"}`,
  );

  // ④ `unlimited` **仍遵守子类优先**：txt 被该类目下的子类认领时，只走子类链路。
  const unlimitedWithSub = graphWith("unlimited", { withSubclass: true });
  const subOps = observe(unlimitedWithSub, "text", "txt");
  check(
    "D136：`unlimited` 仍遵守**子类优先**（txt 被子类认领 → 只走子类链路，不走无限类目链路）",
    subOps.includes("show viewer") && !subOps.includes("show metadata"),
    subOps.join(" ; ") || "（无动作）",
  );
}
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

// ---- 宿主侧容器渲染：档位 → token，DOM 应用与撤销（D50 / control-standard 第 8 节末） ----
{
  // 假元素：只实现 overlayChrome 真正用到的那几个能力，因此自检不需要引入 jsdom。
  const makeEl = ({ titlebar = null, windowEl = null } = {}) => {
    const props = new Map();
    const attrs = new Map();
    return {
      props,
      attrs,
      style: {
        setProperty: (k, v) => props.set(k, v),
        removeProperty: (k) => {
          const old = props.get(k);
          props.delete(k);
          return old ?? "";
        },
      },
      setAttribute: (k, v) => attrs.set(k, v),
      removeAttribute: (k) => attrs.delete(k),
      getAttribute: (k) => attrs.get(k) ?? null,
      querySelector: (sel) => (sel === chrome.FLOATING_TITLEBAR_SELECTOR ? titlebar : null),
      closest: (sel) => (sel === chrome.FLOATING_WINDOW_SELECTOR ? windowEl : null),
    };
  };

  // 档位 → 像素必须**来自 token**（规范："外观只取 token 档位、像素由 packages/ui 决定"）。
  check(
    "容器外观：圆角档位取 packages/ui 的 RADIUS（none=0，sm/md/lg 与 token 逐项一致）",
    chrome.overlayRadiusPx("none") === 0 &&
      chrome.overlayRadiusPx("sm") === ui.RADIUS.sm &&
      chrome.overlayRadiusPx("md") === ui.RADIUS.md &&
      chrome.overlayRadiusPx("lg") === ui.RADIUS.lg,
  );

  const shadowLight = chrome.overlayShadowCss("md", "light");
  const shadowDark = chrome.overlayShadowCss("md", "dark");
  check(
    "容器外观：阴影档位取 packages/ui 的 SHADOW，且浅色/深色不透明度不同",
    shadowLight.includes(`${ui.SHADOW.md.y}px`) &&
      shadowLight.includes(`${ui.SHADOW.md.blur}px`) &&
      shadowLight.includes(String(ui.SHADOW.md.alpha.light)) &&
      shadowDark.includes(String(ui.SHADOW.md.alpha.dark)) &&
      shadowLight !== shadowDark,
    `${shadowLight} / ${shadowDark}`,
  );
  check(
    "容器外观：none 档位 = 无阴影（不是「不透明度为 0 的阴影」）",
    chrome.overlayShadowCss("none", "light") === "none" &&
      chrome.overlayShadowCss("none", "dark") === "none",
  );
  check(
    "容器外观：叠放高度只在浮层之间比较（基准 + height，值大者在上）",
    chrome.overlayZIndex(1) === chrome.OVERLAY_Z_BASE + 1 &&
      chrome.overlayZIndex(10) > chrome.overlayZIndex(1),
  );

  // apply：标记属性 + 圆角 + 裁剪 + 阴影变量 + 叠放变量 + 隐藏标题栏
  {
    const tb = makeEl();
    const win = makeEl({ titlebar: tb });
    const appearance = { shadow: "lg", radius: "sm", hideLabel: true, height: 4 };
    chrome.applyOverlayChrome(win, { key: "ov_1", appearance, theme: "light" });
    check(
      "容器渲染：apply 写入标记属性 + 圆角/裁剪 + 阴影与叠放变量 + 隐藏标题栏",
      win.getAttribute(chrome.OVERLAY_CHROME_ATTR) === "ov_1" &&
        win.props.get("border-radius") === `${ui.RADIUS.sm}px` &&
        win.props.get("overflow") === "hidden" &&
        win.props.get("--dv-floating-box-shadow") === chrome.overlayShadowCss("lg", "light") &&
        win.props.get("--dv-overlay-z-index") === String(chrome.overlayZIndex(4)) &&
        tb.props.get("display") === "none",
      JSON.stringify([...win.props]),
    );

    const before = JSON.stringify([...win.props]);
    chrome.applyOverlayChrome(win, { key: "ov_1", appearance, theme: "light" });
    check(
      "容器渲染：apply 幂等（重复应用结果一致，不会叠加出别的值）",
      JSON.stringify([...win.props]) === before,
    );

    chrome.clearOverlayChrome(win);
    check(
      "容器渲染：clear 与 apply 严格对称（标记属性/圆角/裁剪/两个变量/标题栏全部还原）",
      win.getAttribute(chrome.OVERLAY_CHROME_ATTR) === null &&
        win.props.size === 0 &&
        tb.props.size === 0,
      JSON.stringify([...win.props]),
    );

    const tb2 = makeEl();
    const win2 = makeEl({ titlebar: tb2 });
    chrome.applyOverlayChrome(win2, {
      key: "ov_2",
      appearance: { shadow: "md", radius: "none", hideLabel: false, height: 1 },
      theme: "dark",
    });
    check(
      "容器渲染：radius=none → 直角（0px）且**不做裁剪**（手柄不受影响），hide_label=false → 标题栏保持显示",
      win2.props.get("border-radius") === "0px" &&
        !win2.props.has("overflow") &&
        tb2.props.get("display") === "",
      JSON.stringify([...win2.props]),
    );
  }

  // floatingWindowOf：只有**浮动**组才是浮层容器
  {
    const container = makeEl();
    const groupEl = makeEl({ windowEl: container });
    const dv = (location, panelFound = true) => ({
      getPanel: () =>
        panelFound ? { api: { group: { api: { location }, element: groupEl } } } : undefined,
    });
    check(
      "容器落点：浮动组 → 返回 .dv-resize-container 容器元素",
      chrome.floatingWindowOf(dv({ type: "floating" }), "tasks") === container,
    );
    check(
      "容器落点：停靠组 → null（浮层容器只对浮动组生效）",
      chrome.floatingWindowOf(dv({ type: "grid" }), "tasks") === null,
    );
    check(
      "容器落点：面板不存在 → null（不抛错，布局不受影响）",
      chrome.floatingWindowOf(dv({ type: "floating" }, false), "tasks") === null,
    );
  }
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

// ---- 控件事件作为蓝图事件源（控件标准第 6 节 / D63）：panelId 选择加入式匹配 ----
//
// 规范要求控件事件**同时**作为蓝图事件源上报。带 `panelId` 的上报只命中声明了同一个
// `panel_id` 的 `control` 节点；**不带** `panelId` 的上报（媒体条目链路）保持既有行为。
// `controlId` 刻意不参与匹配——那是 2026-09 已取消的 D56「浮动控件」绑定口径。
//
// 注意匹配的作用点：`panelId` 决定**事件节点是否触发**，不决定它后续动作的取舍。
// 因此要用**两个各自成链的事件**（c_a→e_a→a_show_a、c_b→e_b→a_show_b）才观测得到差异
// ——共用一个事件节点时，只要有一个对象命中，该事件的全部 fires 都会执行。
{
  const graph = {
    schema_version: 2,
    layers: [{ key: "l_main", name: "主界面" }],
    nodes: [
      { key: "ui", type: "interface", layer: "l_main" },
      { key: "c_a", type: "control", layer: "l_main", panel_id: "plugin.a.panel" },
      { key: "c_b", type: "control", layer: "l_main", panel_id: "plugin.b.panel" },
      { key: "e_a", type: "event", layer: "l_main", trigger: "click" },
      { key: "e_b", type: "event", layer: "l_main", trigger: "click" },
      { key: "a_show_a", type: "action", layer: "l_main", op: "show", target: "c_a" },
      { key: "a_show_b", type: "action", layer: "l_main", op: "show", target: "c_b" },
    ],
    edges: [
      { from: "ui", to: "c_a", kind: "contains", order: 1 },
      { from: "ui", to: "c_b", kind: "contains", order: 2 },
      { from: "c_a", to: "e_a", kind: "on", order: 3 },
      { from: "c_b", to: "e_b", kind: "on", order: 4 },
      { from: "e_a", to: "a_show_a", kind: "fires", order: 5 },
      { from: "e_b", to: "a_show_b", kind: "fires", order: 6 },
    ],
  };

  const fireControlEvent = (target) => {
    const engine = new BlueprintEngine();
    engine.setGraph(graph);
    engine.setLayer("l_main");
    const ops = [];
    engine.setExecutor({
      showPanel: (id, floating) => ops.push(`show ${id}${floating ? " (floating)" : ""}`),
      hidePanel: (id) => ops.push(`hide ${id}`),
      togglePanel: (id, floating) => ops.push(`toggle ${id}${floating ? " (floating)" : ""}`),
      collapsePanels: () => ops.push("collapse"),
      expandPanels: () => ops.push("expand"),
      playFile: (fileId) => ops.push(`play ${fileId}`),
      navigateLayer: (layerKey) => ops.push(`navigate ${layerKey}`),
      applyOverlay: () => ops.push("overlay"),
      showOverlayPanel: () => ops.push("float"),
    });
    engine.dispatch({ trigger: "click", target });
    return ops;
  };

  const scoped = fireControlEvent({ panelId: "plugin.a.panel", controlId: "colors" });
  check(
    "控件事件（带 panelId）只命中声明同一 panel_id 的 control 节点",
    scoped.includes("show plugin.a.panel") && !scoped.includes("show plugin.b.panel"),
    scoped.join(" | ") || "（无动作）",
  );

  const legacy = fireControlEvent({ controlId: "colors" });
  check(
    "不带 panelId 的上报保持既有行为（既有蓝图零回归）",
    legacy.includes("show plugin.a.panel") && legacy.includes("show plugin.b.panel"),
    legacy.join(" | ") || "（无动作）",
  );
}

// ---- dockview 选择器契约守护（overlayChrome 依赖 dockview **内部类名**）----
//
// 浮层容器渲染落在 dockview 为浮动组生成的窗口元素上（`.dv-resize-container` 与
// `.dv-floating-titlebar`）。这两个是**库的内部类名**：dockview 升级改名后容器会
// **静默不再被装饰**——界面只是"没圆角/没阴影"，诊断日志里最多表现为
// 「容器 0/N 个窗口」，没有任何东西会红。因此这里把「选择器常量 ↔ 实际安装的
// dockview 样式表」对起来：库里改一名，本断言立刻失败。
{
  const cssCandidates = [
    `${ROOT}/apps/desktop/node_modules/dockview-react/dist/styles/dockview.css`,
    `${ROOT}/node_modules/dockview-react/dist/styles/dockview.css`,
  ];
  const cssPath = cssCandidates.find((p) => existsSync(p));
  const selectors = [
    ["FLOATING_WINDOW_SELECTOR", chrome.FLOATING_WINDOW_SELECTOR],
    ["FLOATING_TITLEBAR_SELECTOR", chrome.FLOATING_TITLEBAR_SELECTOR],
  ];
  if (!cssPath) {
    check(
      "dockview 选择器契约：找得到 dockview 样式表",
      false,
      "未找到 dockview-react/dist/styles/dockview.css（先 pnpm install）",
    );
  } else {
    const css = readFileSync(cssPath, "utf8");
    const missing = selectors.filter(([, value]) => !value || !css.includes(value));
    check(
      "dockview 选择器契约：overlayChrome 的选择器在已安装的 dockview 样式表里真实存在",
      missing.length === 0,
      missing.length
        ? missing.map(([n, v]) => `${n}=${v} 不在样式表里`).join(" | ")
        : selectors.map(([n, v]) => `${n}=${v}`).join(" | "),
    );
  }
}

// ---- 合成用例（v3）：标记（mark）**两段式**匹配 ----
//
// v3 契约（task-4 §3，实测口径以 task-5 为准）：标记从"挂在类目下、与子类并列"
// 改为"挂在**对象**下"（`class ⊃ object ⊃ mark`），因此引擎的 mark 分支变成
// **两段合一**：① `target.marks` 含该标记；② 它所属的父对象（`mark.object`）
// 也必须命中（`blueprintEngine.ts:299-320`）。
//
// 本文件此前**没有任何 mark 夹具**——引擎的 mark 分支零覆盖（task-10 点名要求补齐）。
// 下面补三类用例：
//   (a) 两段都成立 ⇒ 命中；
//   (b) 只成立第一段（父对象所属**类目**不匹配 / 父对象 **scope** 不匹配）⇒ 不命中，
//       并给出"同一次交互里同一个标记名换一条链"的因果对照，证明两段都在起作用；
//   (c) 旧文档残留字段（`mark.class` / `object.mark_ref`）⇒ 引擎行为与干净 v3 图
//       **逐项一致**（残留零影响），且旧层级（`类目 ⊃ 标记`）**不复活**。
{
  /** 一条"面板→类目→对象→标记"链 + 其事件/动作；同一个标记名 `book` 挂不同父对象。 */
  const marksGraph = () => ({
    schema_version: 3,
    layers: [{ key: "l_main", name: "主界面" }],
    nodes: [
      { key: "ui", type: "interface", layer: "l_main" },
      { key: "blk", type: "layout_block", layer: "l_main", name: "主区" },
      { key: "c_media", type: "control", layer: "l_main", panel_id: "media" },
      { key: "c_viewer", type: "control", layer: "l_main", panel_id: "viewer" },
      { key: "c_player", type: "control", layer: "l_main", panel_id: "player" },
      { key: "c_meta", type: "control", layer: "l_main", panel_id: "metadata" },
      { key: "c_tasks", type: "control", layer: "l_main", panel_id: "tasks" },
      { key: "k_text", type: "class", layer: "l_main", control: "c_media", media_type: "text" },
      { key: "k_image", type: "class", layer: "l_main", control: "c_media", media_type: "image" },
      // 三支同标记名的链：**只有父对象不同**，用来证明第二段（父对象）真的在过滤。
      { key: "o_book", type: "object", layer: "l_main", class: "k_text", scope: "double_clicked" },
      { key: "mk_book", type: "mark", layer: "l_main", mark: "book", object: "o_book" },
      { key: "o_book_img", type: "object", layer: "l_main", class: "k_image", scope: "double_clicked" },
      { key: "mk_book_img", type: "mark", layer: "l_main", mark: "book", object: "o_book_img" },
      { key: "o_book_click", type: "object", layer: "l_main", class: "k_text", scope: "clicked" },
      { key: "mk_book_click", type: "mark", layer: "l_main", mark: "book", object: "o_book_click" },
      // 孤儿标记：没有 `object`（未接通）——v3 下任何上报都不得命中。
      { key: "mk_orphan", type: "mark", layer: "l_main", mark: "book" },
      { key: "e_text", type: "event", layer: "l_main", trigger: "double_click" },
      { key: "e_img", type: "event", layer: "l_main", trigger: "double_click" },
      { key: "e_click", type: "event", layer: "l_main", trigger: "click" },
      { key: "e_orphan", type: "event", layer: "l_main", trigger: "double_click" },
      { key: "a_viewer", type: "action", layer: "l_main", op: "show", target: "c_viewer" },
      { key: "a_player", type: "action", layer: "l_main", op: "show", target: "c_player" },
      { key: "a_meta", type: "action", layer: "l_main", op: "show", target: "c_meta" },
      { key: "a_orphan", type: "action", layer: "l_main", op: "show", target: "c_tasks" },
    ],
    edges: [
      { from: "ui", to: "blk", kind: "contains", order: 1 },
      { from: "blk", to: "c_media", kind: "contains", order: 2 },
      { from: "c_media", to: "k_text", kind: "contains", order: 3 },
      { from: "c_media", to: "k_image", kind: "contains", order: 4 },
      { from: "k_text", to: "o_book", kind: "contains", order: 5 },
      { from: "o_book", to: "mk_book", kind: "contains", order: 6 },
      { from: "k_image", to: "o_book_img", kind: "contains", order: 7 },
      { from: "o_book_img", to: "mk_book_img", kind: "contains", order: 8 },
      { from: "k_text", to: "o_book_click", kind: "contains", order: 9 },
      { from: "o_book_click", to: "mk_book_click", kind: "contains", order: 10 },
      { from: "mk_book", to: "e_text", kind: "on", order: 11 },
      { from: "mk_book_img", to: "e_img", kind: "on", order: 12 },
      { from: "mk_book_click", to: "e_click", kind: "on", order: 13 },
      { from: "mk_orphan", to: "e_orphan", kind: "on", order: 14 },
      { from: "e_text", to: "a_viewer", kind: "fires", order: 15 },
      { from: "e_img", to: "a_player", kind: "fires", order: 16 },
      { from: "e_click", to: "a_meta", kind: "fires", order: 17 },
      { from: "e_orphan", to: "a_orphan", kind: "fires", order: 18 },
    ],
  });

  /** 驱动引擎并把执行器收到的操作拼成一行（只关心 `show`，与本组断言同口径）。 */
  const drive = (graph, input) => {
    const engine = new BlueprintEngine();
    engine.setGraph(graph);
    engine.setLayer("l_main");
    const ops = [];
    engine.setExecutor({
      showPanel: (id, floating) => ops.push(`show ${id}${floating ? " (floating)" : ""}`),
      hidePanel: (id) => ops.push(`hide ${id}`),
      togglePanel: (id) => ops.push(`toggle ${id}`),
      collapsePanels: (ids) => ops.push(`collapse [${ids.join(", ")}]`),
      expandPanels: (ids) => ops.push(`expand [${ids.join(", ")}]`),
      playFile: (fileId) => ops.push(`play ${fileId}`),
      navigateLayer: (layerKey) => ops.push(`navigate ${layerKey}`),
      applyOverlay: () => ops.push("overlay"),
      showOverlayPanel: () => ops.push("float"),
    });
    engine.dispatch(input);
    return ops.join(" ; ");
  };

  const graph = marksGraph();
  const dispatch = (trigger, mediaType, marks) =>
    drive(graph, { trigger, target: { mediaType, fileId: "file-1", marks } });

  // (a) 两段都成立：标记命中 + 父对象（k_text / double_clicked）命中 → 只该走文字链。
  const hit = dispatch("double_click", "text", ["book"]);
  check(
    "v3 标记两段式：标记命中且父对象命中 → 命中该链（且不牵连同标记名的另两条链）",
    hit === "show viewer",
    hit || "（无动作）",
  );
  check(
    "v3 标记两段式：`target.marks` 不含该标记 → 一条都不命中（第一段是必要条件）",
    dispatch("double_click", "text", []) === "",
    dispatch("double_click", "text", []) || "（无动作）",
  );

  // (b) 只成立第一段：同一个标记名 `book`，父对象换成 image 类目 / clicked 作用域。
  const byMedia = dispatch("double_click", "image", ["book"]);
  check(
    "v3 标记两段式：标记名相同、仅**父对象所属类目**不同 → 换链命中（第二段按父对象判定，而非按标记名）",
    byMedia === "show player",
    byMedia || "（无动作）",
  );
  const byScope = dispatch("click", "text", ["book"]);
  check(
    "v3 标记两段式：标记名相同、仅**父对象 scope** 不同（clicked vs double_clicked）→ 换链命中",
    byScope === "show metadata",
    byScope || "（无动作）",
  );
  check(
    "v3 标记两段式：父对象不匹配时必须**不命中**（否则等于只看标记名，退化成 D136 的一段式）",
    !hit.includes("player") && !hit.includes("metadata") && !byMedia.includes("viewer") &&
      !byScope.includes("viewer"),
    `text/double_click=${hit || "（无）"} image/double_click=${byMedia || "（无）"} text/click=${byScope || "（无）"}`,
  );
  const orphan = dispatch("double_click", "text", ["book"]);
  check(
    "v3 标记两段式：没有 `object` 的孤儿标记**永不**命中（缺失父对象 = 未接通，不是通配）",
    !orphan.includes("tasks"),
    orphan || "（无动作）",
  );

  // (c) 旧文档残留字段：引擎行为与干净 v3 图**逐项一致**（残留零影响）。
  const residueGraph = marksGraph();
  const mkResidue = residueGraph.nodes.find((n) => n.key === "mk_book");
  // D136 的"所属类目"（v3 废弃，仅旧文档残留）。
  mkResidue.class = "k_text";
  // D136 的第三条轴（v3 废弃，仅旧文档残留）。
  residueGraph.nodes.find((n) => n.key === "o_book").mark_ref = "mk_book";
  const residueRuns = [
    { trigger: "double_click", target: { mediaType: "text", fileId: "file-1", marks: ["book"] } },
    { trigger: "double_click", target: { mediaType: "image", fileId: "file-1", marks: ["book"] } },
    { trigger: "click", target: { mediaType: "text", fileId: "file-1", marks: ["book"] } },
    { trigger: "double_click", target: { mediaType: "text", fileId: "file-1", marks: [] } },
  ];
  const residueSame = residueRuns.every(
    (input) => drive(residueGraph, input) === drive(graph, input),
  );
  check(
    "旧文档残留字段（v3）：`mark.class` / `object.mark_ref` 对引擎**零影响**（四种上报逐项与干净图一致）",
    residueSame,
    residueRuns
      .map((input) => `${input.trigger}/${input.target.mediaType ?? "-"}/[${(input.target.marks ?? []).join(",")}]=${drive(residueGraph, input) || "（无）"}`)
      .join(" | "),
  );

  // (c1) 旧层级不复活：D136 形状（`类目 ⊃ 标记`，标记只带 `class`、无 `object`）不得命中。
  const legacyGraph = {
    schema_version: 3,
    layers: [{ key: "l_main", name: "主界面" }],
    nodes: [
      { key: "c_media", type: "control", layer: "l_main", panel_id: "media" },
      { key: "k_text", type: "class", layer: "l_main", control: "c_media", media_type: "text" },
      { key: "mk_old", type: "mark", layer: "l_main", mark: "book", class: "k_text" },
      { key: "e_old", type: "event", layer: "l_main", trigger: "double_click" },
      { key: "c_old", type: "control", layer: "l_main", panel_id: "old" },
      { key: "a_old", type: "action", layer: "l_main", op: "show", target: "c_old" },
    ],
    edges: [
      { from: "c_media", to: "k_text", kind: "contains", order: 1 },
      // D136 的旧层级形状：类目直连标记（v3 下这条边非法，但旧库文件里仍存在）。
      { from: "k_text", to: "mk_old", kind: "contains", order: 2 },
      { from: "mk_old", to: "e_old", kind: "on", order: 3 },
      { from: "e_old", to: "a_old", kind: "fires", order: 4 },
    ],
  };
  const legacyHit = drive(legacyGraph, {
    trigger: "double_click",
    target: { mediaType: "text", fileId: "file-1", marks: ["book"] },
  });
  check(
    "旧层级不复活（v3）：只带旧字段 `mark.class` 的标记**不再参与匹配**（引擎只读 `object`）",
    legacyHit === "",
    legacyHit || "（无动作）",
  );
}

// ---- 合成用例（D138）：相册 / 源面板的标记链**真的能命中** ----
//
// 用户口径（2026-11-02）：「相册链里的标记需要命中，并把源面板的标记也一起修复，标记就是
// 为了给单个对象进行精确细分，注意，标记不改变对象性质，只是作为对象的限制条件，是可选项，
// 功能和名称一致，即"标记"。」
//
// 这两条链的上报方（`AlbumPanel` / `SourcePanel`）此前一个恒报 `marks: []`、一个根本不
// 上报，所以引擎侧永远收不到标记 —— 引擎本身没错，错在没人上报。本节用**真实上报形态**
// 驱动引擎（`mediaType: "album"` / `"source"`，`fileId` = 相册 id / 源节点 key），钉住：
//   (a) 两段都齐 ⇒ 命中；
//   (b) 没有标记 ⇒ 不命中（标记是**可选项**，但一旦链上有标记节点就必须满足）；
//   (c) 标记不同名 ⇒ 不命中（标记是**限制条件**，是过滤而不是"有标记就行"）；
//   (d) 标记命中但父对象 scope 不符 ⇒ 不命中（不改变对象性质：类目/scope 判定仍在前）。
{
  /** 面板本地打标 → 上报用的 marks（与 UI 同口径：用户标记 ∪ 派生标记，见 D138）。 */
  const reportedMarks = (own, derived = []) => {
    const seen = new Set(own);
    const out = [...own];
    for (const token of derived) if (!seen.has(token)) { seen.add(token); out.push(token); }
    return out;
  };

  /** 驱动引擎并把执行器收到的操作拼成一行（只关心 `show`，与本组断言同口径）。 */
  const driveGraph = (graph, input) => {
    const engine = new BlueprintEngine();
    engine.setGraph(graph);
    engine.setLayer("l_main");
    const ops = [];
    engine.setExecutor({
      showPanel: (id) => ops.push(`show ${id}`),
      hidePanel: (id) => ops.push(`hide ${id}`),
      togglePanel: (id) => ops.push(`toggle ${id}`),
      collapsePanels: (ids) => ops.push(`collapse [${ids.join(", ")}]`),
      expandPanels: (ids) => ops.push(`expand [${ids.join(", ")}]`),
      playFile: (fileId) => ops.push(`play ${fileId}`),
      navigateLayer: (layerKey) => ops.push(`navigate ${layerKey}`),
      applyOverlay: () => ops.push("overlay"),
      showOverlayPanel: () => ops.push("float"),
    });
    engine.dispatch(input);
    return ops.join(" ; ");
  };

  const albumGraph = () => ({
    schema_version: 3,
    layers: [{ key: "l_main", name: "主界面" }],
    nodes: [
      { key: "ui", type: "interface", layer: "l_main" },
      { key: "blk", type: "layout_block", layer: "l_main", name: "左侧" },
      { key: "c_albums", type: "control", layer: "l_main", panel_id: "albums" },
      { key: "c_media", type: "control", layer: "l_main", panel_id: "media" },
      { key: "c_viewer", type: "control", layer: "l_main", panel_id: "viewer" },
      // 相册面板的类目：media_type 必须是本面板分域里的 "album"（`blueprintNodes.ts`
      // `PANEL_CLASS_MEDIA_TYPE_DOMAINS.albums`），而不是行内的 multimedia/image。
      { key: "k_album", type: "class", layer: "l_main", control: "c_albums", media_type: "album" },
      // 对象：单个相册（scope = 具体相册 id，RFC 0007 决策 1）与"任一相册单击"两支。
      { key: "o_album_one", type: "object", layer: "l_main", class: "k_album", scope: "alb-1" },
      { key: "mk_album_manga", type: "mark", layer: "l_main", mark: "manga", object: "o_album_one" },
      { key: "o_album_click", type: "object", layer: "l_main", class: "k_album", scope: "clicked" },
      { key: "mk_album_image", type: "mark", layer: "l_main", mark: "image", object: "o_album_click" },
      { key: "e_album_one", type: "event", layer: "l_main", trigger: "click" },
      { key: "e_album_image", type: "event", layer: "l_main", trigger: "click" },
      { key: "a_viewer", type: "action", layer: "l_main", op: "show", target: "c_viewer" },
      { key: "a_media", type: "action", layer: "l_main", op: "show", target: "c_media" },
    ],
    edges: [
      { from: "ui", to: "blk", kind: "contains", order: 1 },
      { from: "blk", to: "c_albums", kind: "contains", order: 2 },
      { from: "blk", to: "c_media", kind: "contains", order: 3 },
      { from: "c_albums", to: "k_album", kind: "contains", order: 4 },
      { from: "k_album", to: "o_album_one", kind: "contains", order: 5 },
      { from: "o_album_one", to: "mk_album_manga", kind: "contains", order: 6 },
      { from: "k_album", to: "o_album_click", kind: "contains", order: 7 },
      { from: "o_album_click", to: "mk_album_image", kind: "contains", order: 8 },
      { from: "mk_album_manga", to: "e_album_one", kind: "on", order: 9 },
      { from: "mk_album_image", to: "e_album_image", kind: "on", order: 10 },
      { from: "e_album_one", to: "a_viewer", kind: "fires", order: 11 },
      { from: "e_album_image", to: "a_media", kind: "fires", order: 12 },
    ],
  });

  const albumDispatch = (trigger, albumId, marks) =>
    driveGraph(albumGraph(), { trigger, target: { mediaType: "album", fileId: albumId, marks } });

  // (a) 两段齐：单击「带 manga 标记的指定相册」→ 命中按 id 限定的那条链。
  const albumHit = albumDispatch("click", "alb-1", reportedMarks(["manga"], ["media"]));
  check(
    "D138 相册链：click + mediaType=album + 标记命中 + 对象 scope=相册 id ⇒ **命中**（标记轴对相册生效）",
    albumHit === "show viewer",
    albumHit || "（无动作）",
  );
  // (b) 标记是可选项，但链上有标记节点就必须满足：同一相册不带标记 ⇒ 一条都不命中。
  check(
    "D138 相册链：同一相册但 `marks=[]` ⇒ **不命中**（标记是链上的限制条件，不是装饰）",
    albumDispatch("click", "alb-1", []) === "",
    albumDispatch("click", "alb-1", []) || "（无动作）",
  );
  // (c) 标记是**过滤**而非"有任意标记即可"：带别的标记不命中。
  check(
    "D138 相册链：带不相干的标记（book）⇒ **不命中**（标记名精确匹配，不是「有标记就算」）",
    albumDispatch("click", "alb-1", reportedMarks(["book"], ["media"])) === "",
    albumDispatch("click", "alb-1", reportedMarks(["book"], ["media"])) || "（无动作）",
  );
  // (d) 不改变对象性质：标记命中、scope 也命中，但**类目**必须仍是 album；
  //     用 media 类目的条目（image 文件带同一标记）不得顺带命中相册链。
  check(
    'D138 相册链：换成 `mediaType: "image"` 上报同一标记 ⇒ **不命中**（标记不改变对象所属的类目）',
    albumDispatch("click", "alb-1", reportedMarks(["manga"], ["media"])) === "show viewer" &&
      driveGraph(albumGraph(), {
        trigger: "click",
        target: { mediaType: "image", fileId: "alb-1", marks: reportedMarks(["manga"], ["image"]) },
      }) === "",
    '类目判定仍在标记之前（两段式的第二段递归回类目/scope）',
  );
  // (e) 派生标记真的能当条件用：另一支链只认 `image` 标记（`scope: "clicked"`）。
  //     同一次单击、同一个相册，只换上报里的派生标记 ⇒ 命中与否跟着标记走，
  //     证明"派生标记并入上报"（D138 的 `effectiveMarksFor`）不是摆设。
  const derivedImage = albumDispatch("click", "other-album", reportedMarks([], ["image"]));
  const derivedMedia = albumDispatch("click", "other-album", reportedMarks([], ["media"]));
  check(
    "D138 相册链：派生标记能作为条件命中（image 派生 → 命中该链；media 派生 → 不命中）",
    derivedImage === "show media" && derivedMedia === "",
    `image=${derivedImage || "（无）"} media=${derivedMedia || "（无）"}`,
  );

  // 源面板同一条契约的另一半：`mediaType: "source"`，`fileId` = 节点 key。
  const sourceGraph = () => ({
    schema_version: 3,
    layers: [{ key: "l_main", name: "主界面" }],
    nodes: [
      { key: "ui", type: "interface", layer: "l_main" },
      { key: "blk", type: "layout_block", layer: "l_main", name: "左侧" },
      { key: "c_sources", type: "control", layer: "l_main", panel_id: "sources" },
      { key: "c_media", type: "control", layer: "l_main", panel_id: "media" },
      { key: "k_source", type: "class", layer: "l_main", control: "c_sources", media_type: "source" },
      { key: "o_src_dir", type: "object", layer: "l_main", class: "k_source", scope: "dir:src-1/manga" },
      { key: "mk_src_manga", type: "mark", layer: "l_main", mark: "manga", object: "o_src_dir" },
      { key: "e_src", type: "event", layer: "l_main", trigger: "click" },
      { key: "a_media", type: "action", layer: "l_main", op: "show", target: "c_media" },
    ],
    edges: [
      { from: "ui", to: "blk", kind: "contains", order: 1 },
      { from: "blk", to: "c_sources", kind: "contains", order: 2 },
      { from: "blk", to: "c_media", kind: "contains", order: 3 },
      { from: "c_sources", to: "k_source", kind: "contains", order: 4 },
      { from: "k_source", to: "o_src_dir", kind: "contains", order: 5 },
      { from: "o_src_dir", to: "mk_src_manga", kind: "contains", order: 6 },
      { from: "mk_src_manga", to: "e_src", kind: "on", order: 7 },
      { from: "e_src", to: "a_media", kind: "fires", order: 8 },
    ],
  });
  const sourceDispatch = (nodeKey, marks) =>
    driveGraph(sourceGraph(), { trigger: "click", target: { mediaType: "source", fileId: nodeKey, marks } });
  const sourceHit = sourceDispatch("dir:src-1/manga", ["manga"]);
  check(
    'D138 源面板链：click + mediaType="source" + fileId=节点 key + 标记命中 ⇒ **命中**',
    sourceHit === "show media",
    sourceHit || "（无动作）",
  );
  check(
    "D138 源面板链：不带标记 / 换成别的节点 key ⇒ **不命中**（标记与对象两个条件都不可省）",
    sourceDispatch("dir:src-1/manga", []) === "" &&
      sourceDispatch("dir:src-1/other", ["manga"]) === "",
    `无标记=${sourceDispatch("dir:src-1/manga", []) || "（无）"} 换 key=${sourceDispatch("dir:src-1/other", ["manga"]) || "（无）"}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
