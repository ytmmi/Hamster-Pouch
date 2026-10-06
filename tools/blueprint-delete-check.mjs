/**
 * 蓝图软删除自检（开发期验证，不参与打包）。
 *
 * 验证产品规则：**删除一个节点只删它自己和挂在它身上的边，关联节点全部保留**；
 * 因引用断开而无法工作的节点由 `blueprintLint` 判定为"未接通"（画布灰显）。
 *
 * 覆盖：
 * 1. 删事件 `e_dbl_img` → 对象/类/控件保留，`a_show_viewer` 保留但未接通；
 * 2. 删对象 `o_img` → 事件 `e_dbl_img` 保留但未接通（无对象来源）；
 * 3. 删动作 `a_show_viewer` → 事件保留，且不再触发查看器；
 * 4. 实时引擎口径：删除后 dispatch 不再产生动作。
 *
 * 用法：node --no-warnings --import ./tools/blueprint-check-register.mjs \
 *         tools/blueprint-delete-check.mjs [仓库库路径]
 */

import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const ROOT = "E:/Hamster Pouch";
const defaultDb =
  "E:/Hamster Pouch/apps/desktop/src-tauri/target/release/data/user/repos/00c37ce8-8464-4808-8c51-c9af38e86516.sqlite3";
const dbPath = process.argv[2] ?? defaultDb;

const { softRemove, softRemoveMany } = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/panels/blueprintDelete.ts`).href
);
const { analyzeUnlinked } = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/shared/blueprintLint.ts`).href
);
const { BlueprintEngine } = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/core/blueprintEngine.ts`).href
);
const config = await import(
  pathToFileURL(`${ROOT}/packages/config/src/index.ts`).href
);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const defaults = () => JSON.parse(JSON.stringify(config.DEFAULT_BLUEPRINT));
const has = (doc, key) => doc.nodes.some((n) => n.key === key);

// ---- 1. 删事件：关联节点全保留，动作变未接通 ----
{
  const { doc, unlinked } = softRemove(defaults(), "e_dbl_img");
  const lint = analyzeUnlinked(doc);
  check(
    "删 e_dbl_img：对象/类/控件/动作全部保留（不级联删除）",
    has(doc, "o_img") &&
      has(doc, "k_image") &&
      has(doc, "c_media") &&
      has(doc, "a_show_viewer"),
    `removed=[${unlinked.join(", ") || "无"}]`,
  );
  check(
    "删 e_dbl_img：动作 a_show_viewer 变为未接通",
    Boolean(lint.a_show_viewer),
    `原因=${lint.a_show_viewer ?? "（未标记）"}`,
  );
  check(
    "删 e_dbl_img：视频/音频链路不受影响",
    !lint.e_dbl_vid && !lint.a_show_player && !lint.o_vid,
    `未接通=[${Object.keys(lint).join(", ") || "无"}]`,
  );
}

// ---- 2. 删对象：事件保留但未接通 ----
{
  const { doc } = softRemove(defaults(), "o_img");
  const lint = analyzeUnlinked(doc);
  check(
    "删 o_img：事件 e_dbl_img 保留且标记未接通（缺对象来源）",
    has(doc, "e_dbl_img") && lint.e_dbl_img === "missing-object-source",
    `原因=${lint.e_dbl_img ?? "（未标记）"}`,
  );
  check(
    "删 o_img：不再有指向它的边（o_img→e_dbl_img 已移除）",
    !doc.edges.some((e) => e.from === "o_img" || e.to === "o_img"),
  );
}

// ---- 3. 删动作：事件保留（操作本身仍接通），引擎不再产出动作 ----
{
  const { doc } = softRemove(defaults(), "a_show_viewer");
  const lint = analyzeUnlinked(doc);
  check(
    "删 a_show_viewer：事件 e_dbl_img 保留且仍接通（操作有对象来源即可）",
    has(doc, "e_dbl_img") && !lint.e_dbl_img,
    `未接通=[${Object.keys(lint).join(", ") || "无"}]`,
  );

  const engine = new BlueprintEngine();
  engine.setGraph(doc);
  const ops = [];
  engine.setExecutor({
    showPanel: (id) => ops.push(`show ${id}`),
    hidePanel: (id) => ops.push(`hide ${id}`),
    togglePanel: (id) => ops.push(`toggle ${id}`),
    collapsePanels: () => ops.push("collapse"),
    expandPanels: () => ops.push("expand"),
    playFile: () => ops.push("play"),
  });
  engine.dispatch({ trigger: "double_click", target: { mediaType: "image", fileId: "f1" } });
  check("删 a_show_viewer 后：双击图像不再有任何动作", ops.length === 0, ops.join("; ") || "（无动作）");
}

// ---- 4. 删类：对象保留但未接通 ----
{
  const { doc } = softRemove(defaults(), "k_image");
  const lint = analyzeUnlinked(doc);
  check(
    "删 k_image：对象 o_img 保留且标记未接通（缺类）",
    has(doc, "o_img") && lint.o_img === "missing-class",
    `原因=${lint.o_img ?? "（未标记）"}`,
  );
}

// ---- 5. 库存文档：软删除后仍是合法可保存的文档（仅剩软告警） ----
{
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db
    .prepare("SELECT blueprint_json FROM blueprints WHERE is_default = 1 LIMIT 1")
    .get();
  db.close();
  if (!row) {
    console.log("SKIP  库存里没有默认蓝图");
  } else {
    const doc = JSON.parse(row.blueprint_json);
    const target = doc.nodes.find((n) => n.type === "action" || n.type === "event");
    const { doc: next } = softRemove(doc, target.key);
    check(
      `库存文档：软删除 ${target.key} 后节点数只少 1（关联节点保留）`,
      next.nodes.length === doc.nodes.length - 1,
      `${doc.nodes.length} → ${next.nodes.length}`,
    );
  }
}

// ---- 6. 一次划线批量删除（`softRemoveMany`）：多处**原子**生效 ----
// 真实缺陷：画布对每个命中项各调一次 removeEdgeAt/removeNode，而两者都从**同一份旧文档**
// 派生新文档 → 后一次覆盖前一次，划痕实际"只能删一个"。
{
  const base = {
    schema_version: 2,
    layers: [{ key: "l_main", name: "主界面" }],
    nodes: [
      { key: "ui", type: "interface", layer: "l_main", position: { x: 0, y: 0 } },
      { key: "c1", type: "control", panel_id: "media", layer: "l_main", position: { x: 0, y: 0 } },
      { key: "k1", type: "class", control: "c1", media_type: "image", layer: "l_main", position: { x: 0, y: 0 } },
      { key: "o1", type: "object", class: "k1", scope: "double_clicked", layer: "l_main", position: { x: 0, y: 0 } },
      { key: "e1", type: "event", trigger: "double_click", layer: "l_main", position: { x: 0, y: 0 } },
      { key: "a1", type: "action", op: "show", target: "c1", layer: "l_main", position: { x: 0, y: 0 } },
    ],
    edges: [
      { from: "ui", to: "c1", kind: "contains", order: 1 },
      { from: "c1", to: "k1", kind: "contains", order: 2 },
      { from: "k1", to: "o1", kind: "contains", order: 3 },
      { from: "o1", to: "e1", kind: "on", order: 4 },
      { from: "e1", to: "a1", kind: "fires", order: 5 },
    ],
  };
  const cloned = () => JSON.parse(JSON.stringify(base));

  // 划线命中：2 个节点（o1、e1）+ 1 条边（下标 0 = ui→c1）
  const batch = softRemoveMany(cloned(), ["o1", "e1"], [0]);
  check(
    "批量删除：2 个节点 + 1 条边一次全部生效（6→4 节点，5→1 边）",
    batch.removed.join(",") === "o1,e1" &&
      batch.doc.nodes.length === 4 &&
      batch.doc.edges.length === 1,
    `removed=[${batch.removed.join(", ")}] nodes=${batch.doc.nodes.length} edges=${batch.doc.edges.length}`,
  );
  check(
    "批量删除：被删节点的关联边一并剔除，其它节点保留（软删除口径不变）",
    !batch.doc.nodes.some((n) => n.key === "o1" || n.key === "e1") &&
      batch.doc.nodes.some((n) => n.key === "k1") &&
      batch.doc.nodes.some((n) => n.key === "a1") &&
      batch.doc.edges.every((e) => e.from !== "o1" && e.to !== "o1" && e.from !== "e1" && e.to !== "e1") &&
      batch.doc.edges.some((e) => e.from === "c1" && e.to === "k1"),
    batch.doc.edges.map((e) => `${e.from}->${e.to}`).join(", "),
  );
  // 回归对照：旧写法"各调一次、各自基于同一份旧文档" → 只剩最后一次生效（只删 1 个节点）。
  const oldWayLast = softRemove(cloned(), "e1");
  check(
    "回归对照：逐个从同一份旧文档删除只剩最后一次生效（这正是「只能删一个」的根因）",
    oldWayLast.doc.nodes.length === 5 && batch.doc.nodes.length === 4,
    `旧写法=${oldWayLast.doc.nodes.length} 节点，批量=${batch.doc.nodes.length} 节点`,
  );
  // 健壮性：重复 key、已删 key、越界边下标都不崩、不做多余删除。
  const messy = softRemoveMany(cloned(), ["o1", "o1", "nope"], [0, 999]);
  check(
    "批量删除：重复 key / 不存在 key / 越界边下标被忽略（结果与去重后一致）",
    messy.removed.join(",") === "o1" &&
      messy.doc.nodes.length === 5 &&
      messy.doc.edges.length === 2,
    `removed=[${messy.removed.join(", ")}] nodes=${messy.doc.nodes.length} edges=${messy.doc.edges.length}`,
  );
  check(
    "批量删除：被清空引用的节点若随后也被删掉，不再计入「未接通」提示",
    softRemoveMany(cloned(), ["k1", "o1"], []).unlinked.length === 0,
    `unlinked=[${softRemoveMany(cloned(), ["k1", "o1"], []).unlinked.join(", ")}]`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
