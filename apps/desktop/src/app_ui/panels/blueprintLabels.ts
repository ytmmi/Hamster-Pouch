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
  if (node.type === "control") {
    const title = resolveControlTitle(node, t);
    if (title) {
      return title;
    }
  }
  const sameType = nodes.filter((n) => n.type === node.type);
  const idx = sameType.findIndex((n) => n.key === node.key);
  return `${nodeTypeLabel(node.type, t)} ${idx + 1}`;
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

/** 媒体类型中文标签（图像/视频/音频；未知值原样返回）。 */
export function mediaTypeLabel(value: string, t: Translate): string {
  return t(`blueprint.mediaType.${value}` as TranslationKey);
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
      return mediaTypeLabel(node.media_type ?? "", t);
    case "object": {
      const cls = node.class ? nodes.find((n) => n.key === node.class) : undefined;
      const clsName = cls ? nodeDisplayName(cls, t, nodes) : node.class ?? "?";
      return `${clsName} · ${scopeLabel(node.scope ?? "", t)}`;
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
