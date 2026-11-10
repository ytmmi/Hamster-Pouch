/**
 * 「布局与蓝图同源」比对（D155）。
 *
 * 两侧的数据形状不同：
 *   - 布局：dockview 的 `layers_json`（每层一棵 split 树，叶片 `data.views` 列出面板 id）；
 *   - 蓝图：`BlueprintGraph`（每层一组节点，面板控件用 `panel_id` 指回面板 id）。
 *
 * 两者必须**逐层一一对应**：层集合相等；每层面板集合相等。任何一侧单改都会让全新安装
 * 出现「布局有面板、画布无节点」或反之——这正是 v7 时代 `DEFAULT_BLUEPRINT` 停在单层
 * 而演示布局已两层造成的缺陷。
 *
 * 纯函数，无 IO：调用方（package-build 一体校验、`check:blueprint-pair` 门禁）自己取数。
 */

/** 从 dockview split 树收集面板 id（叶片 `data.views`）。 */
export function collectViews(node, acc = []) {
  if (!node) return acc;
  if (node.type === "leaf") acc.push(...(node.data?.views ?? []));
  else for (const child of node.data ?? []) collectViews(child, acc);
  return acc;
}

/**
 * 比对布局 `layers_json` 与蓝图图文档，返回问题清单（空数组 = 同源）。
 *
 * @param {object} graph `BlueprintGraph`（`layers` + `nodes`）
 * @param {Record<string, { grid?: { root?: unknown } }>} preset `layers_json`（层 key → 层；`""` 为层无关快照）
 * @returns {string[]}
 */
export function compareBlueprintWithLayout(graph, preset) {
  const problems = [];
  const bpLayers = new Set((graph.layers ?? []).map((l) => l.key));
  const presetLayers = new Set(Object.keys(preset ?? {}).filter((k) => k !== ""));
  for (const key of bpLayers) {
    if (!presetLayers.has(key)) problems.push(`蓝图有层 ${key}，布局没有`);
  }
  for (const key of presetLayers) {
    if (!bpLayers.has(key)) problems.push(`布局有层 ${key}，内置默认蓝图没有`);
  }
  for (const layer of graph.layers ?? []) {
    const fromLayout = new Set(collectViews(preset?.[layer.key]?.grid?.root));
    const fromBlueprint = new Set(
      (graph.nodes ?? [])
        .filter((n) => n.layer === layer.key && n.type === "control" && n.panel_id)
        .map((n) => n.panel_id),
    );
    for (const panel of fromLayout) {
      if (!fromBlueprint.has(panel)) problems.push(`层 ${layer.key}：布局有面板 ${panel}，蓝图无节点`);
    }
    for (const panel of fromBlueprint) {
      if (!fromLayout.has(panel)) problems.push(`层 ${layer.key}：蓝图有面板 ${panel}，布局未挂载`);
    }
  }
  return problems;
}
