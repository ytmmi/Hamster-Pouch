/**
 * 蓝图文档列表（RFC 0007「前端编辑器」）。
 *
 * 一个域：列出本仓库的蓝图并给出文档级入口——名称输入 + 新建、带结构创建开关、
 * 列表选中（点击行）/设为默认（★）、全局模板下拉（从模板创建）。
 *
 * 纯展示 + 回调：命令与状态由 `useBlueprintDocuments` / `useBlueprintEditorState` 提供。
 * 容器用 `<span>`：`<label>` 不得包住可交互元素，胶囊开关自带无障碍名。
 */

import type { ThemeName } from "@hamster-pouch/ui";
import type {
  BlueprintItem,
  BlueprintTemplateItem,
} from "@hamster-pouch/shared-types";

import type { Translate } from "../i18n";
import { SwitchToggle } from "../shared/SwitchToggle";

export interface BlueprintDocListProps {
  items: BlueprintItem[];
  templates: BlueprintTemplateItem[];
  selectedId: string | null;
  newName: string;
  withStructure: boolean;
  busy: boolean;
  onNewNameChange: (value: string) => void;
  onCreate: () => Promise<void>;
  onSelect: (id: string) => Promise<void>;
  onSetDefault: (blueprintId: string) => Promise<void>;
  onCreateFromTemplate: (templateId: string) => Promise<void>;
  onWithStructureChange: (enabled: boolean) => void;
  /** 主题（胶囊开关按主题取色）。 */
  theme: ThemeName;
  t: Translate;
}

export function BlueprintDocList({
  items,
  templates,
  selectedId,
  newName,
  withStructure,
  busy,
  onNewNameChange,
  onCreate,
  onSelect,
  onSetDefault,
  onCreateFromTemplate,
  onWithStructureChange,
  theme,
  t,
}: BlueprintDocListProps): JSX.Element {
  return (
    <div className="bp-list">
      <div className="row">
        <input
          value={newName}
          placeholder={t("blueprint.namePlaceholder")}
          onChange={(e) => onNewNameChange(e.target.value)}
        />
        <button disabled={busy} onClick={() => void onCreate()}>
          {t("blueprint.create")}
        </button>
      </div>
      {/* 容器用 `<span>`：`<label>` 不得包住可交互元素，胶囊开关自带无障碍名。 */}
      <span className="bp-check" title={t("blueprint.structureHint")}>
        <SwitchToggle
          checked={withStructure}
          theme={theme}
          label={t("blueprint.withStructure")}
          onChange={onWithStructureChange}
        />
        {t("blueprint.withStructure")}
      </span>
      {items.map((it) => (
        <div
          key={it.id}
          className={`bp-item ${it.id === selectedId ? "selected" : ""}`}
        >
          <button className="bp-item-main" onClick={() => void onSelect(it.id)}>
            {it.name}
            {it.is_default && <span className="dim"> ★</span>}
          </button>
          <button
            className="bp-item-action"
            disabled={it.is_default}
            onClick={() => void onSelect(it.id).then(() => onSetDefault(it.id))}
            title={t("blueprint.setDefault")}
          >
            ★
          </button>
        </div>
      ))}
      {items.length === 0 && (
        <span className="placeholder">{t("blueprint.none")}</span>
      )}
      {templates.length > 0 && (
        <div className="row">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) {
                void onCreateFromTemplate(e.target.value);
              }
            }}
          >
            <option value="">{t("blueprint.fromTemplate")}</option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
