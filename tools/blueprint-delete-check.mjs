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
  "C:/Users/wxlxt/AppData/Roaming/dev.hamsterpouch.desktop/repos/00c37ce8-8464-4808-8c51-c9af38e86516.sqlite3";
const dbPath = process.argv[2] ?? defaultDb;

const { softRemove } = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/panels/blueprintDelete.ts`).href
);
const { analyzeUnlinked } = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/shared/blueprintLint.ts`).href
);
const { BlueprintEngine } = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/core/blueprintEngine.ts`).href
);
const config = await import(
  pathToFileURL(`${ROOT}/packages/config/src/blueprint.ts`).href
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

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
