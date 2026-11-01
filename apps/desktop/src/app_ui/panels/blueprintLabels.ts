/**
 * 蓝图节点的**本地化显示层**（RFC 0007 决策 7：只暴露本地化显示名，不暴露裸 key）。
 *
 * 节点卡片正文摘要、节点显示名与各字段的标签文案都在这里，供画布
 * （`BlueprintCanvas`）、属性面板（`BlueprintInspector`）共用——属性面板不该为了拿文案
 * 去 import 一个同级**组件**模块。全部是纯函数：入参带 `t`，无 React/宿主依赖。
 */

import {
  DEFAULT_OVERLAY_ANCHOR,
  type BlueprintGraph,
  type BlueprintLayer,
  type BlueprintNode,
  overlayOffsetLabel,
  overlaySizeLabel,
} from "@hamster-pouch/config";

import type { Translate, TranslationKey } from "../i18n";

/**
 * 节点显示名称：用户自定义 `name` 优先；面板节点回退到本地化标签名
 * （`title_key` → 「媒体预览」等，随语言切换）；界面节点取**层名**（D51）；其余按类型
 * 本地化生成（如 zh-CN 下「面板 1」「操作 2」）。
 *
 * **相册 / 源面板下的类目（2026-11-01 / D135；D134 的误实现已纠正）**：这两类面板的
 * 类目类型就是「相册」/「源」本身（`media_type = album` / `source`），若按类型本地化
 * 会显示成「类目 1」——在一个"列出相册"的面板里这等于什么都没说。因此当**类目**节点
 * 指向的面板是 `albums` / `sources` 时，显示为「相册」/「源」。
 *
 * ⚠️ **这是一处纠正**：D134 把这条判定写在了 **object** 分支上（按"对象挂在标记轴、
 * 标记所属面板是 albums/sources"推导），但用户 2026-11-01 澄清那句话实际指**类目**：
 * 「（上文的"相册面板对象节点只有「相册」、源面板的对象节点只有「源」"实际上是类目）」。
 * 对象节点因此恢复**通用命名**（`nodeSummary` 用「结构父名 · 范围」），否则"相册面板下
 * 每个对象都叫相册"会让同一面板里的多个对象无法区分。
 *
 * i18n 键名沿用 D134 的 `blueprint.object.album` / `blueprint.object.source`
 * （键名只是标识符；改键名要牵动三语字典，收益为零）。判定位置必须在
 * **自定义 name 之后**（用户命名的节点仍以用户命名为准）、**面板标题之前**
 * （类目不是面板，不该显示面板标题）。
 */
export function nodeDisplayName(
  node: BlueprintNode,
  t: Translate,
  nodes: BlueprintNode[],
  layers?: BlueprintLayer[],
): string {
  if (node.type === "interface") {
    // D51：界面显示名取自层名（界面节点不再另存 name）。
    const layer = layers?.find((l) => l.key === node.layer);
    if (layer?.name?.trim()) {
      return layer.name.trim();
    }
  }
  if (node.name?.trim()) {
    return node.name.trim();
  }
  if (node.type === "class") {
    const panelLabel = classOfSpecialPanelLabel(node, t, nodes);
    if (panelLabel) {
      return panelLabel;
    }
  }
  if (node.type === "control") {
    const title = resolveControlTitle(node, t);
    if (title) {
      return title;
    }
  }
  const sameType = nodes.filter((n) => n.type === node.type);
  const idx = sameType.findIndex((n) => n.key === node.key);
  // 标记有 10 种（D134）：按类型编号（「标记 1」「标记 2」）读不出"这是哪种标记"，
  // 因此标记节点用**标记清单的本地化名**（「媒体」「图书」…）做类型位，编号规则不变
  // （与「面板 1」「操作 2」同一套风格，同一个画布上仍能区分两个同类标记）。
  const typeLabel =
    node.type === "mark" && node.mark
      ? (() => {
          const label = markLabel(node.mark, t);
          return label && label !== node.mark ? label : nodeTypeLabel(node.type, t);
        })()
      : nodeTypeLabel(node.type, t);
  return `${typeLabel} ${idx + 1}`;
}

/**
 * **相册 / 源面板下类目**的专用显示名（D135）：类目 → 它所属的**面板**（`control`）→
 * 面板的 `panel_id`。
 *
 * 只认 `albums` / `sources` 两个面板：其余面板下的类目仍按「类型 编号」呈现
 * （例如媒体预览下的类目是"图像/视频/音频"，说成「媒体预览」就没有信息量）。
 *
 * 引用链上任一环缺失（未接通）就返回空串，交给既有回退链——**不得**猜一个标签出来，
 * 否则"没接线"与"接好了"在显示上无法区分。i18n 键缺失（语言包未跟上）时同样返回空串。
 */
function classOfSpecialPanelLabel(
  node: BlueprintNode,
  t: Translate,
  nodes: BlueprintNode[],
): string {
  const controlKey = node.control?.trim();
  if (!controlKey) return "";
  const controlNode = nodes.find((n) => n.key === controlKey);
  if (!controlNode || controlNode.type !== "control") return "";
  const key: string =
    controlNode.panel_id === "albums"
      ? "blueprint.object.album"
      : controlNode.panel_id === "sources"
        ? "blueprint.object.source"
        : "";
  if (!key) return "";
  const resolved = t(key as TranslationKey);
  // 键未落地时返回空串（不把裸键显示给用户，也不假装这里已经有专用文案）。
  return resolved === key ? "" : resolved;
}

/**
 * 节点**类型**的本地化显示名。
 *
 * 宿主只内置 10 种类型的文案（`blueprint.type.*`）；插件注册项由插件自己的语言资源
 * 提供显示名，宿主 i18n 里没有该键时**显式标注「未接通」**（RFC 0010 决策 6），
 * 而不是把裸 key 或空串显示给用户。
 */
export function nodeTypeLabel(type: string, t: Translate): string {
  const key = `blueprint.type.${type}`;
  const resolved = t(key as TranslationKey);
  return resolved === key ? `${type}（${t("blueprint.unlinkedTag")}）` : resolved;
}

/** 面板本地化标签名（`title_key` 解析；失败返回空，交由默认名兜底，不暴露 panel_id）。 */export function resolveControlTitle(node: BlueprintNode, t: Translate): string {
  if (node.title_key) {
    const resolved = t(node.title_key as TranslationKey);
    if (resolved && resolved !== node.title_key) {
      return resolved;
    }
  }
  return "";
}

/**
 * 类目**类型**的本地化标签（图像 / 视频 / 音频 / 文本 / PDF / 相册 / 源；未知值原样返回）。
 *
 * 键名仍是 `blueprint.mediaType.<value>`：D135 只把**字段标签**改叫「类型」
 * （`blueprint.mediaType` 的值 =「类型」，D135-B 线负责那一条），取值文案这组键**不变**
 * ——7 个取值各有自己的键（`pdf` / `album` / `source` 三条于 D135 补齐三语）。
 */
export function mediaTypeLabel(value: string, t: Translate): string {
  return t(`blueprint.mediaType.${value}` as TranslationKey);
}

/**
 * **子类** `format` 标签（`subclass` 节点：`epub` / `txt` / `md`）。
 *
 * 它是**格式**（与扩展名一一对应），因此文案直接用格式名。
 */
export function subclassFormatLabel(value: string, t: Translate): string {
  return t(`blueprint.format.${value}` as TranslationKey);
}

/**
 * **标记**标签（`mark` 节点的 `mark` 字段：`media` / `book` / `manga` …）。
 *
 * 标记在**语义上**与类目正交、可交叉（用户口径：`漫画.zip` 的类目是压缩包、可标记为
 * `manga`），**结构上**从属类目（D136：`class ⊃ mark ⊃ object`，与子类并列）。
 * 因此文案与"格式"分开一组键——同一个 `book` 在标记里的含义是"这是一本书"，
 * 而不是"这是 book 格式"。
 */
export function markLabel(value: string, t: Translate): string {
  const key = `blueprint.mark.${value}`;
  const resolved = t(key as TranslationKey);
  // 未登记的标记（清单可注册）：不暴露裸键，退回显示 id 本身。
  return resolved === key ? value : resolved;
}

/**
 * 类目的显示摘要：**只有类型值**（D102 起细分属于 `subclass` 节点，不再挂在类目上；
 * D135 起「媒体类型」在 UI 上叫「类型」——同一份取值域多了 `album` / `source` 两项，
 * 它们不是扫描器的媒体类型）。
 */
export function classSummary(
  node: Pick<BlueprintNode, "media_type">,
  t: Translate,
): string {
  return mediaTypeLabel(node.media_type ?? "", t);
}

/** 子类的显示摘要：格式（`epub` / `txt` / `md`）+ 所属类目名。 */
export function subclassSummary(
  node: Pick<BlueprintNode, "format">,
  t: Translate,
  ownerName?: string,
): string {
  const format = node.format ? subclassFormatLabel(node.format, t) : "";
  const head = format || "—";
  return ownerName ? `${head} · ${ownerName}` : head;
}

/** 对象范围中文标签（单击/双击/选中；未知值原样返回）。 */
export function scopeLabel(value: string, t: Translate): string {
  return t(`blueprint.scope.${value}` as TranslationKey);
}

/** 事件触发中文标签（单击/双击/选中变化；未知值原样返回）。 */
export function triggerLabel(value: string, t: Translate): string {
  return t(`blueprint.trigger.${value}` as TranslationKey);
}

/** 动作中文标签（显示/隐藏/切换/收起组/展开组；未知值原样返回）。 */
export function opLabel(value: string, t: Translate): string {
  return t(`blueprint.op.${value}` as TranslationKey);
}

/** 隐藏方向中文标签（左/右/上/下；`toward:<key>` 显示为箭头 + 目标显示名）。 */
export function hideDirLabel(
  value: string,
  t: Translate,
  targetName?: string,
): string {
  if (value.startsWith("toward:")) {
    return `→ ${targetName ?? value.slice(7)}`;
  }
  return t(`blueprint.hideDir.${value}` as TranslationKey);
}

/** 节点正文摘要（画布卡片展示关键字段；全部本地化，不暴露底层 key）。 */
export function nodeSummary(
  node: BlueprintNode,
  t: Translate,
  graph: BlueprintGraph,
): string {
  const nodes = graph.nodes;
  const nameOf = (key: string): string => {
    const n = nodes.find((x) => x.key === key);
    return n ? nodeDisplayName(n, t, nodes, graph.layers) : key;
  };
  switch (node.type) {
    case "interface":
      return t("blueprint.summary.interface");
    case "layout_block":
      return t("blueprint.summary.layoutBlock");
    case "overlay": {
      // 浮层（D50）：容器（内容由连进来的面板控件/标签组表达）+ 叠放高度 + 定位 + 外观档位。
      const anchor = node.anchor ?? DEFAULT_OVERLAY_ANCHOR;
      const placement =
        node.offset_x === undefined && node.offset_y === undefined
          ? t(`blueprint.anchor.${anchor}` as TranslationKey)
          : `${t(`blueprint.anchor.${anchor}` as TranslationKey)} ${overlayOffsetLabel(node.offset_x)}, ${overlayOffsetLabel(node.offset_y)}`;
      const parts = [
        `${t("blueprint.overlayHeight")} ${node.height ?? 1}`,
        `${t("blueprint.overlaySize")} ${overlaySizeLabel(node.size)}`,
        placement,
      ];
      if (node.shadow) {
        parts.push(`${t("blueprint.shadow")} ${node.shadow}`);
      }
      if (node.radius) {
        parts.push(`${t("blueprint.radius")} ${node.radius}`);
      }
      if (node.hide_label) {
        parts.push(t("blueprint.hideLabel"));
      }
      return parts.join(" · ");
    }
    case "control":
      return resolveControlTitle(node, t) || "—";
    case "class":
      return classSummary(node, t);
    case "subclass": {
      // 子类摘要 = 格式（+ 所属类目名）：光有 `epub` 读不出"哪一支子类"。
      const owner = node.subclass ? nodes.find((n) => n.key === node.subclass) : undefined;
      return subclassSummary(node, t, owner ? nodeDisplayName(owner, t, nodes) : undefined);
    }
    case "mark": {
      // 标记（D136）：显示 `标记名 · 所属类目名`——光有「媒体」读不出"挂在哪个类目下"，
      // 而"从属类目"正是 D136 的核心语义（照 `subclassSummary` 的写法）。
      // 所属类目名由**引用字段** `node.class` 解析（不是边）：运行期认的就是字段
      // （见 D109 的"字段只由连线落定"），因此显示它也如实反映运行期口径。
      // 引用缺失/指向已删除节点时只显示标记名，不猜一个类目出来。
      const owner = node.class ? nodes.find((n) => n.key === node.class) : undefined;
      const head = markLabel(node.mark ?? "", t);
      return owner ? `${head} · ${nodeDisplayName(owner, t, nodes, graph.layers)}` : head;
    }
    case "object": {
      // 对象的结构父有**三条正交轴**（类目 / 子类 / 标记，三者互斥）：显示实际声明的那条。
      const parentKey = node.class ?? node.subclass ?? node.mark_ref;
      const parent = parentKey ? nodes.find((n) => n.key === parentKey) : undefined;
      const parentName = parent ? nodeDisplayName(parent, t, nodes) : parentKey ?? "?";
      return `${parentName} · ${scopeLabel(node.scope ?? "", t)}`;
    }
    case "group": {
      const mode =
        node.mode === "independent"
          ? t("blueprint.mode.independent")
          : t("blueprint.mode.exclusive");
      const dir = node.hide_direction
        ? hideDirLabel(
            node.hide_direction,
            t,
            node.hide_direction.startsWith("toward:")
              ? nameOf(node.hide_direction.slice(7))
              : undefined,
          )
        : "";
      return dir ? `${mode} · ${dir}` : mode;
    }
    case "event": {
      // 规则三元组：对象 → 操作 → 状态（on 入边对象 → fires 出边状态）
      const objs = graph.edges
        .filter((e) => e.kind === "on" && e.to === node.key)
        .map((e) => nameOf(e.from));
      const states = graph.edges
        .filter((e) => e.kind === "fires" && e.from === node.key)
        .map((e) => nameOf(e.to));
      return t("blueprint.summary.eventChain", {
        trigger: triggerLabel(node.trigger ?? "", t),
        objects: objs.join("、") || "?",
        states: states.join("、") || "?",
      });
    }
    case "condition":
      return node.expr ?? "—";
    case "action": {
      const target = node.target ? nodes.find((n) => n.key === node.target) : undefined;
      const targetName = target ? nodeDisplayName(target, t, nodes) : node.target ?? "?";
      return `${opLabel(node.op ?? "", t)} → ${targetName}`;
    }
    default:
      // 插件注册项 / 当前无注册项的合法类型：宿主没有摘要规格，按「未接通」呈现
      // （节点与边原样保留，插件恢复后自动恢复，RFC 0010 决策 6）。
      return `${node.type}（${t("blueprint.unlinkedTag")}）`;
  }
}
