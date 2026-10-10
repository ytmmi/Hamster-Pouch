/**
 * 蓝图编辑器工具条（RFC 0007「前端编辑器」）。
 *
 * 一个域：把**当前选中蓝图**的文档级操作排成一行——名称输入、保存（校验后落库）、
 * 一键整理、恢复内置默认、删除蓝图，以及在画布视图与 JSON 视图之间切换。
 *
 * 纯展示 + 回调：命令语义在 `useBlueprintDocuments`，图编辑动作在 `useBlueprintGraphEdits`。
 */

import type { Translate } from "../i18n";
import type { BlueprintViewMode } from "./useBlueprintEditorState";

export interface BlueprintToolbarProps {
  name: string;
  busy: boolean;
  viewMode: BlueprintViewMode;
  onNameChange: (value: string) => void;
  onSave: () => Promise<void>;
  /** 一键整理：以选中节点为起始节点树状展开（起始节点位置不变）。 */
  onArrange: () => void;
  /**
   * 刷新：重算派生状态（未接通灰显 / 端口测量 / JSON 文本），**不改文档**。
   * 用于"连线后节点状态仍显示未接通"这类需要重新对齐的场合。
   */
  onRefresh: () => void;
  /** 恢复内置默认蓝图（替换当前选中蓝图的内容）。 */
  onRestore: () => Promise<void>;
  /** 删除当前选中蓝图。 */
  onRemove: () => Promise<void>;
  /** 画布视图 ↔ JSON 视图。 */
  onToggleView: () => void;
  t: Translate;
}

export function BlueprintToolbar({
  name,
  busy,
  viewMode,
  onNameChange,
  onSave,
  onArrange,
  onRefresh,
  onRestore,
  onRemove,
  onToggleView,
  t,
}: BlueprintToolbarProps): JSX.Element {
  return (
    <div className="row bp-toolbar">
      <input
        value={name}
        placeholder={t("blueprint.namePlaceholder")}
        onChange={(e) => onNameChange(e.target.value)}
      />
      <button disabled={busy} onClick={() => void onSave()}>
        {t("common.confirm")}
      </button>
      <button
        title={t("blueprint.arrangeHint")}
        onClick={onArrange}
      >
        {t("blueprint.arrange")}
      </button>
      <button title={t("blueprint.refreshHint")} onClick={onRefresh}>
        {t("blueprint.refresh")}
      </button>
      <button
        title={t("blueprint.restoreHint")}
        disabled={busy}
        onClick={() => void onRestore()}
      >
        {t("blueprint.restore")}
      </button>
      <button className="danger" onClick={() => void onRemove()}>
        {t("blueprint.removeNode")}
      </button>
      <button onClick={onToggleView}>
        {viewMode === "canvas"
          ? t("blueprint.jsonView")
          : t("blueprint.formView")}
      </button>
    </div>
  );
}
