/**
 * 蓝图 JSON 视图（RFC 0007「前端编辑器」的辅助核对视图）。
 *
 * 一个域：把整份图文档当文本编辑——文本域直接改 JSON，按钮把文本解析回文档。
 * 解析与归一化在 `useBlueprintEditorState.syncFromJson`（解析失败只记错误，不动文档）。
 *
 * 纯展示 + 回调。
 */

import type { Translate } from "../i18n";

export interface BlueprintJsonViewProps {
  /** 与文档同步的 JSON 文本。 */
  jsonText: string;
  onTextChange: (value: string) => void;
  /** 把文本解析回文档（辅助批量编辑）。 */
  onSync: () => void;
  t: Translate;
}

export function BlueprintJsonView({
  jsonText,
  onTextChange,
  onSync,
  t,
}: BlueprintJsonViewProps): JSX.Element {
  return (
    <div className="panel-stack">
      <textarea
        className="bp-json"
        spellCheck={false}
        value={jsonText}
        onChange={(e) => onTextChange(e.target.value)}
      />
      <div className="row">
        <button onClick={onSync}>
          {t("blueprint.syncFromJson")}
        </button>
      </div>
    </div>
  );
}
