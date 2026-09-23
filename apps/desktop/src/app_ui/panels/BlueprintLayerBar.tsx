/**
 * 蓝图层工具条（RFC 0007 / D51 / D54 / D55 / D60 / D67）。
 *
 * 画布同一时刻只渲染**一个层**（一个层 = 一张画布 = 一个界面/页面）。本工具条负责：
 * 切换当前层、新增层、重命名层、删除层（直接删除、禁止删最后一层）、层排序、
 * **设为主界面**（D67：应用进入该仓库时默认显示的界面），并标出**无根层**
 * （界面节点被软删除 → 未接通软告警）。
 *
 * 纯展示 + 回调；文档变更由面板（`BlueprintPanel`）通过 `blueprintLayers` 的纯函数完成。
 */

import type { BlueprintLayer } from "@hamster-pouch/config";

import type { Translate } from "../i18n";

export interface BlueprintLayerBarProps {
  layers: BlueprintLayer[];
  /** 当前层 key（可能为 null：无蓝图内容时）。 */
  current: string | null;
  /** 无根层的层 key（层内没有界面节点 → 未接通）。 */
  rootless: ReadonlySet<string>;
  onSwitch: (layerKey: string) => void;
  onAdd: () => void;
  onRename: (layerKey: string, name: string) => void;
  onRemove: (layerKey: string) => void;
  onMove: (layerKey: string, delta: number) => void;
  /** 把某层设为主界面（D67）。 */
  onSetHome: (layerKey: string) => void;
  t: Translate;
}

export function BlueprintLayerBar({
  layers,
  current,
  rootless,
  onSwitch,
  onAdd,
  onRename,
  onRemove,
  onMove,
  onSetHome,
  t,
}: BlueprintLayerBarProps): JSX.Element {
  const index = layers.findIndex((l) => l.key === current);
  const active = index >= 0 ? layers[index] : undefined;
  const home = layers.find((l) => l.is_home === true);
  const activeIsHome = active !== undefined && home?.key === active.key;

  return (
    <div className="bp-layerbar">
      <span className="bp-layerbar-label" title={t("blueprint.layer.switchHint")}>
        {t("blueprint.layer.current")}
      </span>
      <select
        className="bp-layerbar-select"
        value={current ?? ""}
        onChange={(e) => onSwitch(e.target.value)}
      >
        {layers.map((l) => (
          <option key={l.key} value={l.key}>
            {rootless.has(l.key) ? `${l.name}（${t("blueprint.layer.rootless")}）` : l.name}
            {l.is_home === true ? ` ★${t("blueprint.layer.home")}` : ""}
          </option>
        ))}
      </select>
      <button className="bp-layerbar-btn" onClick={onAdd} title={t("blueprint.layer.addHint")}>
        {t("blueprint.layer.add")}
      </button>
      <button
        className="bp-layerbar-btn"
        disabled={!active || activeIsHome}
        onClick={() => active && onSetHome(active.key)}
        title={t("blueprint.layer.setHomeHint")}
      >
        {activeIsHome ? t("blueprint.layer.isHome") : t("blueprint.layer.setHome")}
      </button>
      <button
        className="bp-layerbar-btn"
        disabled={!active}
        onClick={() => {
          if (!active) {
            return;
          }
          const next = window.prompt(t("blueprint.layer.newPrompt"), active.name);
          if (next !== null && next.trim()) {
            onRename(active.key, next);
          }
        }}
        title={t("blueprint.layer.renameHint")}
      >
        {t("blueprint.layer.rename")}
      </button>
      <button
        className="bp-layerbar-btn"
        disabled={!active || index <= 0}
        onClick={() => active && onMove(active.key, -1)}
        title={t("blueprint.layer.moveUp")}
      >
        ↑
      </button>
      <button
        className="bp-layerbar-btn"
        disabled={!active || index < 0 || index >= layers.length - 1}
        onClick={() => active && onMove(active.key, 1)}
        title={t("blueprint.layer.moveDown")}
      >
        ↓
      </button>
      <button
        className="bp-layerbar-btn danger"
        disabled={!active}
        onClick={() => {
          if (!active) {
            return;
          }
          if (window.confirm(t("blueprint.layer.removeConfirm", { name: active.name }))) {
            onRemove(active.key);
          }
        }}
        title={t("blueprint.layer.remove")}
      >
        {t("blueprint.layer.remove")}
      </button>
      {active && rootless.has(active.key) && (
        <span className="bp-layerbar-warn">{t("blueprint.layer.rootless")}</span>
      )}
      <span className="dim bp-layerbar-hint">{t("blueprint.layer.switchHint")}</span>
    </div>
  );
}
