/**
 * 蓝图节点属性检查器（RFC 0007 决策 7 / D31 / D50 修订）。
 *
 * 选中画布节点后，在侧栏编辑该节点的全部字段：控件 `panel_id`/`title_key`、
 * 类 `control`/`media_type`、对象 `class`/`scope`、组 `mode`/`default_visible`/
 * `hide_direction`/`position`、浮层（容器）`visible`/`height`/`shadow`/`radius`/`hide_label`、
 * 操作 `trigger`、条件 `expr`、状态 `op`/`target`/`payload`；
 * 并支持重命名节点 key（联动更新引用与边，由面板负责唯一性校验）与删除节点。
 *
 * 展示层：参数与选项一律用本地化文案，不向用户暴露底层 key。
 */

import { useEffect, useState } from "react";

import {
  BLUEPRINT_ACTION_OPS,
  BLUEPRINT_MEDIA_TYPES,
  type BlueprintGraph,
  type BlueprintHideDirection,
  type BlueprintNode,
  type BlueprintNodeType,
  CONDITION_EXPR_HINTS,
  DEFAULT_OVERLAY_ANCHOR,
  HIDE_DIRECTIONS,
  OVERLAY_ANCHORS,
  OVERLAY_HEIGHT_MAX,
  OVERLAY_HEIGHT_MIN,
  OVERLAY_MAX_SIZE,
  OVERLAY_MIN_SIZE,
  overlayOffsetLabel,
  overlaySizeLabel,
  nodeLayerKey,
  PANEL_IDS,
  PANEL_TITLES,
  TOKEN_LEVELS,
} from "@hamster-pouch/config";

import type { Translate, TranslationKey } from "../i18n";
import {
  hideDirLabel,
  mediaTypeLabel,
  nodeDisplayName,
  opLabel,
  resolveControlTitle,
  scopeLabel,
  triggerLabel,
} from "./blueprintLabels";

/** 对象作用范围：三个交互关键字（RFC 0007 决策 1 亦允许填具体 `file_id`，高级用户可手改 JSON）。 */
const SCOPES = ["clicked", "double_clicked", "selected"] as const;

/**
 * 只读的"从上级推导"字段：展示由连线/上级自动落定的引用（key），不可手填。
 * 与"本节点必须设定的字段"（类型、媒体类型、触发、操作…）区分开。
 */
function DerivedField({
  label,
  value,
  label_,
  t,
}: {
  label: string;
  value: string | undefined;
  label_: string;
  t: Translate;
}): JSX.Element {
  return (
    <div className="bp-field">
      <label>{label}</label>
      <span className={`bp-derived ${value ? "" : "empty"}`} title={value ?? ""}>
        {value ? label_ : t("blueprint.derivedEmpty")} <em>{t("blueprint.autoTag")}</em>
      </span>
    </div>
  );
}

/**
 * 状态节点的目标候选：按动作类型给合法目标
 * （show/hide→面板控件/浮层，collapse/expand→标签组，toggle→面板控件/标签组/浮层，
 * navigate→界面），名称用**本地化显示名**（面板控件→面板标题、标签组→自定义名/
 * 「标签组 N」、界面→层名、浮层→自定义名/「浮层 N」），不暴露裸 key。
 *
 * **层级口径（RFC 0007 决策 6）**：跨层只允许 `navigate` 引用，其余动作的目标必须与
 * 状态节点**同层**——否则编辑器会产出被后端以"跨层引用"拒绝的文档。
 */
function actionTargets(
  doc: BlueprintGraph,
  op: BlueprintNode["op"],
  layerKey: string,
  t: Translate,
): { v: string; l: string }[] {
  const wanted: BlueprintNodeType[] =
    op === "navigate"
      ? ["interface"]
      : op === "collapse" || op === "expand"
        ? ["group"]
        : op === "toggle"
          ? ["control", "group", "overlay"]
          : ["control", "overlay"];
  // navigate 是跨层跳转（界面与层 1:1），因此它的候选**不**按层过滤。
  const crossLayer = op === "navigate";
  return doc.nodes
    .filter((n) => wanted.includes(n.type))
    .filter((n) => crossLayer || nodeLayerKey(doc, n) === layerKey)
    .map((n) => ({ v: n.key, l: nodeDisplayName(n, t, doc.nodes, doc.layers) }));
}

/** 节点属性检查器：只暴露**本节点必须设定**的字段；key 型引用一律只读展示。 */
export function NodeInspector({
  node,
  doc,
  onPatch,
  onRemove,
  t,
}: {
  node: BlueprintNode | null;
  doc: BlueprintGraph;
  onPatch: (patch: Partial<BlueprintNode>) => void;
  onRemove: () => void;
  t: Translate;
}): JSX.Element {
  if (!node) {
    return (
      <div className="bp-inspector">
        <span className="placeholder">{t("blueprint.noSelection")}</span>
      </div>
    );
  }
  const layerKey = nodeLayerKey(doc, node);
  /** 同层判定（跨层只允许 `navigate` 引用，RFC 0007 决策 6）。 */
  const inSameLayer = (n: BlueprintNode): boolean =>
    nodeLayerKey(doc, n) === layerKey;
  /** 本层的面板控件（组的默认可见成员候选；跨层成员会被校验拒绝）。 */
  const layerControls = doc.nodes.filter(
    (n) => n.type === "control" && inSameLayer(n),
  );

  const row = (label: string, control: JSX.Element): JSX.Element => (
    <div className="bp-field">
      <label>{label}</label>
      {control}
    </div>
  );
  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
  ): JSX.Element =>
    row(label, <input value={value} onChange={(e) => set(e.target.value)} />);
  /** 下拉框（泛型取值：调用方传字面量清单时，回填值自动收窄为字面量联合）。 */
  function select<T extends string>(
    label: string,
    value: string,
    options: { v: T; l: string }[],
    set: (v: T) => void,
  ): JSX.Element {
    return row(
      label,
      <select value={value} onChange={(e) => set(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>,
    );
  }

  /** 节点 key → 本地化显示名（供下拉选项，不暴露 key）。 */
  const labelOf = (key: string): string => {
    const n = doc.nodes.find((x) => x.key === key);
    return n ? nodeDisplayName(n, t, doc.nodes, doc.layers) : key;
  };
  /** 引用 key → 本地化显示名（供只读展示，不暴露裸 key 给用户操作）。 */
  const derivedLabel = (key: string | undefined): string =>
    key ? labelOf(key) : "";

  // 隐藏方向：4 个轴向值（本地化）+ 同层标签组的 `toward:<组>` 候选 + 保留已有取值
  const hideDirOptions: { v: string; l: string }[] = [
    { v: "", l: "—" },
    ...HIDE_DIRECTIONS.map((d) => ({ v: d as string, l: hideDirLabel(d, t) })),
  ];
  // `toward:<同层标签组>`（D29）：让编辑器也能产出"精确指定由哪个邻居吸收空间"的取值。
  for (const other of doc.nodes) {
    if (other.type !== "group" || other.key === node.key || !inSameLayer(other)) {
      continue;
    }
    hideDirOptions.push({ v: `toward:${other.key}`, l: `→ ${labelOf(other.key)}` });
  }
  const hideDirValue = node.hide_direction ?? "";
  if (
    hideDirValue.startsWith("toward:") &&
    !hideDirOptions.some((o) => o.v === hideDirValue)
  ) {
    hideDirOptions.push({ v: hideDirValue, l: hideDirValue });
  }

  return (
    <div className="bp-inspector">
      <div className="bp-inspector-title">
        {t(`blueprint.type.${node.type}`)} · {t("blueprint.inspector")}
      </div>
      {/* 节点 key：自动生成（由上级推导）；输入框已废弃，改为只读展示，见下 */}
      <div className="bp-field">
        <label>{t("blueprint.key")}</label>
        <span className="bp-derived" title={node.key}>
          {node.key} <em>{t("blueprint.autoTag")}</em>
        </span>
      </div>
      {node.type !== "interface" &&
        field(t("blueprint.name"), node.name ?? "", (v) => onPatch({ name: v }))}
      {node.type === "interface" && (
        <span className="dim bp-hints">{t("blueprint.layer.renameHint")}</span>
      )}
      {node.type === "control" &&
        select(
          t("blueprint.panelId"),
          node.panel_id ?? "",
          PANEL_IDS.map((id) => ({
            v: id,
            l: t(PANEL_TITLES[id] as TranslationKey),
          })),
          (v) => onPatch({ panel_id: v }),
        )}
      {node.type === "control" && (
        <span className="dim bp-hints">
          {t("blueprint.tabTitle")}: {resolveControlTitle(node, t) || "—"}
        </span>
      )}
      {/* 类：本节点只需选媒体类型；control 从上级（控件）自动获取 */}
      {node.type === "class" &&
        select(
          t("blueprint.mediaType"),
          node.media_type ?? "",
          BLUEPRINT_MEDIA_TYPES.map((m) => ({ v: m, l: mediaTypeLabel(m, t) })),
          (v) => onPatch({ media_type: v }),
        )}
      {node.type === "class" && (
        <DerivedField
          label={t("blueprint.tab.controls")}
          value={node.control}
          label_={derivedLabel(node.control)}
          t={t}
        />
      )}
      {/* 对象：本节点只需选作用范围；class 从上级（类）自动获取 */}
      {node.type === "object" &&
        select(
          t("blueprint.scope"),
          node.scope ?? "",
          SCOPES.map((s) => ({ v: s, l: scopeLabel(s, t) })),
          (v) => onPatch({ scope: v }),
        )}
      {node.type === "object" && (
        <DerivedField
          label={t("blueprint.tab.classes")}
          value={node.class}
          label_={derivedLabel(node.class)}
          t={t}
        />
      )}
      {/* 浮层（D50）：容器——内容由连进来的面板控件/标签组表达；这里只设显隐/叠放/外观 */}
      {node.type === "overlay" &&
        row(
          t("blueprint.visible"),
          <input
            type="checkbox"
            checked={node.visible ?? false}
            onChange={(e) => onPatch({ visible: e.target.checked })}
          />,
        )}
      {node.type === "overlay" &&
        row(
          t("blueprint.overlayHeight"),
          <input
            type="number"
            min={OVERLAY_HEIGHT_MIN}
            max={OVERLAY_HEIGHT_MAX}
            value={node.height ?? 1}
            onChange={(e) =>
              onPatch({ height: Number(e.target.value) || OVERLAY_HEIGHT_MIN })
            }
          />,
        )}
      {node.type === "overlay" && (
        <span className="dim bp-hints">{OVERLAY_HEIGHT_MIN}–{OVERLAY_HEIGHT_MAX}</span>
      )}
      {/* 相对定位（D50 修订）：九宫格锚点 + 双模式偏移（0–1 = 比例，>1 = 像素） */}
      {node.type === "overlay" &&
        select(
          t("blueprint.anchor"),
          node.anchor ?? DEFAULT_OVERLAY_ANCHOR,
          OVERLAY_ANCHORS.map((a) => ({ v: a, l: t(`blueprint.anchor.${a}` as TranslationKey) })),
          (v) => onPatch({ anchor: v as BlueprintNode["anchor"] }),
        )}
      {node.type === "overlay" &&
        row(
          t("blueprint.offset"),
          <span className="bp-field-pair">
            <input
              type="number"
              step="0.05"
              value={node.offset_x ?? 0}
              onChange={(e) => onPatch({ offset_x: Number(e.target.value) || 0 })}
            />
            <input
              type="number"
              step="0.05"
              value={node.offset_y ?? 0}
              onChange={(e) => onPatch({ offset_y: Number(e.target.value) || 0 })}
            />
          </span>,
        )}
      {node.type === "overlay" && (
        <span className="dim bp-hints">
          {t("blueprint.offsetHint", {
            x: overlayOffsetLabel(node.offset_x),
            y: overlayOffsetLabel(node.offset_y),
          })}
        </span>
      )}
      {/* 浮层框体尺寸（px，2026-09 用户新增）：不写 = 默认最小尺寸；小于最小值按最小值夹紧 */}
      {node.type === "overlay" &&
        row(
          t("blueprint.overlaySize"),
          <span className="bp-field-pair">
            <input
              type="number"
              min={OVERLAY_MIN_SIZE.width}
              max={OVERLAY_MAX_SIZE}
              step="10"
              value={node.size?.width ?? OVERLAY_MIN_SIZE.width}
              onChange={(e) =>
                onPatch({
                  size: {
                    width: Number(e.target.value) || OVERLAY_MIN_SIZE.width,
                    height: node.size?.height ?? OVERLAY_MIN_SIZE.height,
                  },
                })
              }
            />
            <input
              type="number"
              min={OVERLAY_MIN_SIZE.height}
              max={OVERLAY_MAX_SIZE}
              step="10"
              value={node.size?.height ?? OVERLAY_MIN_SIZE.height}
              onChange={(e) =>
                onPatch({
                  size: {
                    width: node.size?.width ?? OVERLAY_MIN_SIZE.width,
                    height: Number(e.target.value) || OVERLAY_MIN_SIZE.height,
                  },
                })
              }
            />
          </span>,
        )}
      {node.type === "overlay" && (
        <span className="dim bp-hints">
          {t("blueprint.overlaySizeHint", {
            w: OVERLAY_MIN_SIZE.width,
            h: OVERLAY_MIN_SIZE.height,
            current: overlaySizeLabel(node.size),
          })}
        </span>
      )}
      {/* 浮层外观（D50 修订 / D44）：只选宿主设计 token 档位，像素由宿主决定 */}
      {node.type === "overlay" &&
        select(
          t("blueprint.shadow"),
          node.shadow ?? "none",
          TOKEN_LEVELS.map((v) => ({ v, l: v })),
          (v) => onPatch({ shadow: v as BlueprintNode["shadow"] }),
        )}
      {node.type === "overlay" &&
        select(
          t("blueprint.radius"),
          node.radius ?? "none",
          TOKEN_LEVELS.map((v) => ({ v, l: v })),
          (v) => onPatch({ radius: v as BlueprintNode["radius"] }),
        )}
      {node.type === "overlay" &&
        row(
          t("blueprint.hideLabel"),
          <input
            type="checkbox"
            checked={node.hide_label ?? false}
            onChange={(e) => onPatch({ hide_label: e.target.checked })}
          />,
        )}
      {node.type === "overlay" && (
        <span className="dim bp-hints">{t("blueprint.overlayContainerHint")}</span>
      )}
      {node.type === "group" &&
        select(
          t("blueprint.mode"),
          node.mode ?? "exclusive",
          [
            { v: "exclusive", l: t("blueprint.mode.exclusive") },
            { v: "independent", l: t("blueprint.mode.independent") },
          ],
          (v) => onPatch({ mode: v as BlueprintNode["mode"] }),
        )}
      {node.type === "group" &&
        row(
          t("blueprint.defaultVisible"),
          <span className="bp-field-multi">
            {layerControls.length === 0 && <span className="dim">—</span>}
            {layerControls
              .map((c) => c.key)
              .map((k) => {
                const on = node.default_visible?.includes(k) ?? false;
                return (
                  <button
                    key={k}
                    className={on ? "on" : ""}
                    onClick={() =>
                      onPatch({
                        default_visible: on
                          ? (node.default_visible ?? []).filter((x) => x !== k)
                          : [...(node.default_visible ?? []), k],
                      })
                    }
                  >
                    {labelOf(k)}
                  </button>
                );
              })}
          </span>,
        )}
      {node.type === "group" &&
        select(
          t("blueprint.hideDirection"),
          hideDirValue,
          hideDirOptions,
          (v) => onPatch({ hide_direction: (v || undefined) as BlueprintNode["hide_direction"] }),
        )}
      {(node.type === "group" || node.type === "layout_block") &&
        row(
          t("blueprint.position"),
          <span className="bp-field-pair">
            <input
              type="number"
              value={node.position?.x ?? 0}
              onChange={(e) =>
                onPatch({
                  position: {
                    x: Number(e.target.value),
                    y: node.position?.y ?? 0,
                  },
                })
              }
            />
            <input
              type="number"
              value={node.position?.y ?? 0}
              onChange={(e) =>
                onPatch({
                  position: {
                    x: node.position?.x ?? 0,
                    y: Number(e.target.value),
                  },
                })
              }
            />
          </span>,
        )}
      {/* 操作：本节点只需选触发；对象来源由连线/上级自动落定（只读展示） */}
      {node.type === "event" &&
        select(
          t("blueprint.trigger"),
          node.trigger ?? "",
          [
            { v: "click", l: triggerLabel("click", t) },
            { v: "double_click", l: triggerLabel("double_click", t) },
            { v: "selection_change", l: triggerLabel("selection_change", t) },
          ],
          (v) => onPatch({ trigger: v as BlueprintNode["trigger"] }),
        )}
      {node.type === "event" && (
        <DerivedField
          label={t("blueprint.tab.objects")}
          value={node.target}
          label_={derivedLabel(node.target)}
          t={t}
        />
      )}
      {node.type === "event" && (
        <span className="dim bp-hints">
          {t("blueprint.hint.objectChain", {
            on: t("blueprint.port.on"),
            fires: t("blueprint.port.fires"),
          })}
        </span>
      )}
      {node.type === "condition" &&
        field(t("blueprint.conditionExpr"), node.expr ?? "", (v) =>
          onPatch({ expr: v }),
        )}
      {node.type === "condition" && (
        <span className="dim bp-hints">
          {CONDITION_EXPR_HINTS.slice(0, 4).join("；")}
        </span>
      )}
      {node.type === "action" &&
        select(
          t("blueprint.op"),
          node.op ?? "",
          BLUEPRINT_ACTION_OPS.map((op) => ({ v: op, l: opLabel(op, t) })),
          (v) => onPatch({ op: v as BlueprintNode["op"] }),
        )}
      {/* 状态：**目标手动指定**（控件 show/hide/toggle、标签组 collapse/expand/toggle） */}
      {node.type === "action" &&
        select(
          t("blueprint.target"),
          node.target ?? "",
          [
            { v: "", l: t("blueprint.targetUnset") },
            ...actionTargets(doc, node.op, layerKey, t),
          ],
          (v) => onPatch({ target: v || undefined }),
        )}
      {node.type === "action" && node.target === undefined && (
        <span className="dim bp-hints">{t("blueprint.targetHint")}</span>
      )}
      {node.type === "action" &&
        row(
          t("blueprint.payload"),
          <textarea
            className="bp-payload"
            spellCheck={false}
            value={node.payload === undefined ? "" : JSON.stringify(node.payload)}
            placeholder='{"play": true}'
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (!raw) {
                onPatch({ payload: undefined });
                return;
              }
              try {
                onPatch({ payload: JSON.parse(raw) });
              } catch {
                /* 暂存非法 JSON 不落库 */
              }
            }}
          />,
        )}
      <div className="row">
        <button className="danger" onClick={onRemove}>
          {t("blueprint.deleteNode")}
        </button>
      </div>
      {node.type === "group" && (
        <span className="dim bp-hints">
          {t("blueprint.hint.hideDirection", {
            dirs: HIDE_DIRECTIONS.map((d) => hideDirLabel(d, t)).join(" / "),
          })}
        </span>
      )}
      <span className="dim bp-hints">
        {t("blueprint.port.contains")} · {t("blueprint.port.memberOf")} ·{" "}
        {t("blueprint.port.fires")} · {t("blueprint.port.guards")}
      </span>
    </div>
  );
}
