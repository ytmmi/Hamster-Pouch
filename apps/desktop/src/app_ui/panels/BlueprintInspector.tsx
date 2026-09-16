/**
 * 蓝图节点属性检查器（RFC 0007 决策 7 / D31）。
 *
 * 选中画布节点后，在侧栏编辑该节点的全部字段：控件 `panel_id`/`title_key`、
 * 类 `control`/`media_type`、对象 `class`/`scope`、组 `mode`/`default_visible`/
 * `hide_direction`/`position`、操作 `trigger`、条件 `expr`、状态 `op`/`target`/`payload`；
 * 并支持重命名节点 key（联动更新引用与边，由面板负责唯一性校验）与删除节点。
 *
 * 展示层：参数与选项一律用本地化文案，不向用户暴露底层 key。
 */

import { useEffect, useState } from "react";

import {
  type BlueprintGraph,
  type BlueprintNode,
  type BlueprintNodeType,
  CONDITION_EXPR_HINTS,
  HIDE_DIRECTIONS,
  PANEL_IDS,
  PANEL_TITLES,
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
} from "./BlueprintCanvas";

const MEDIA_TYPES = ["image", "video", "audio"] as const;
const SCOPES = ["clicked", "double_clicked", "selected"] as const;
const ACTION_OPS = ["show", "hide", "toggle", "collapse", "expand"] as const;

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
 * 状态节点的目标候选：按动作类型给合法目标（show/hide→控件，collapse/expand→标签组），
 * 名称用**本地化显示名**（控件→面板标题、标签组→自定义名/「标签组 N」），不暴露裸 key。
 */
function actionTargets(
  doc: BlueprintGraph,
  op: BlueprintNode["op"],
  t: Translate,
): { v: string; l: string }[] {
  const wanted: BlueprintNodeType[] =
    op === "collapse" || op === "expand"
      ? ["group"]
      : op === "toggle"
        ? ["control", "group"]
        : ["control"];
  return doc.nodes
    .filter((n) => wanted.includes(n.type))
    .map((n) => ({ v: n.key, l: nodeDisplayName(n, t, doc.nodes) }));
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
  const select = (
    label: string,
    value: string,
    options: { v: string; l: string }[],
    set: (v: string) => void,
  ): JSX.Element =>
    row(
      label,
      <select value={value} onChange={(e) => set(e.target.value)}>
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>,
    );

  /** 节点 key → 本地化显示名（供下拉选项，不暴露 key）。 */
  const labelOf = (key: string): string => {
    const n = doc.nodes.find((x) => x.key === key);
    return n ? nodeDisplayName(n, t, doc.nodes) : key;
  };
  /** 引用 key → 本地化显示名（供只读展示，不暴露裸 key 给用户操作）。 */
  const derivedLabel = (key: string | undefined): string =>
    key ? labelOf(key) : "";

  // 隐藏方向：4 方向本地化 + 已有 toward:<组> 值保留为选项
  const hideDirOptions = [
    { v: "", l: "—" },
    ...HIDE_DIRECTIONS.map((d) => ({ v: d, l: hideDirLabel(d, t) })),
  ];
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
      {field(t("blueprint.name"), node.name ?? "", (v) => onPatch({ name: v }))}
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
          MEDIA_TYPES.map((m) => ({ v: m, l: mediaTypeLabel(m, t) })),
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
            {doc.nodes.filter((n) => n.type === "control").length === 0 && (
              <span className="dim">—</span>
            )}
            {doc.nodes
              .filter((n) => n.type === "control")
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
          (v) => onPatch({ hide_direction: v || undefined }),
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
          对象 → {t("blueprint.port.on")} → {t("blueprint.port.fires")} → 状态
          （从左侧「对象」端口拖线连入）
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
          ACTION_OPS.map((op) => ({ v: op, l: opLabel(op, t) })),
          (v) => onPatch({ op: v as BlueprintNode["op"] }),
        )}
      {/* 状态：**目标手动指定**（控件 show/hide/toggle、标签组 collapse/expand/toggle） */}
      {node.type === "action" &&
        select(
          t("blueprint.target"),
          node.target ?? "",
          [
            { v: "", l: t("blueprint.targetUnset") },
            ...actionTargets(doc, node.op, t),
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
      <span className="dim bp-hints">
        {HIDE_DIRECTIONS.map((d) => hideDirLabel(d, t)).join(" / ")} / toward:&lt;组&gt;
      </span>
      <span className="dim bp-hints">
        {t("blueprint.port.contains")} · {t("blueprint.port.memberOf")} ·{" "}
        {t("blueprint.port.fires")} · {t("blueprint.port.guards")}
      </span>
    </div>
  );
}
