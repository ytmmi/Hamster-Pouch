/**
 * 蓝图面板 — 节点式编辑器入口（画布式拖拽连线，仿 ComfyUI，RFC 0007 决策 7 / D31）。
 *
 * 本文件只做装配，不实现状态与命令：编辑器状态（`useBlueprintEditorState`）、
 * 蓝图文档命令（`useBlueprintDocuments`）、层工具接线（`useBlueprintLayerTools`）、
 * 图编辑动作（`useBlueprintGraphEdits`）、未接通派生（`useBlueprintUnlinked`）。
 *
 * 装配出的界面：
 * - 顶部：蓝图列表（`BlueprintDocList`）+ 名称/保存工具条（`BlueprintToolbar`）；
 * - 主区：层工具条（`BlueprintLayerBar`，同一时刻只渲染当前层）+ 节点添加面板
 *   （`BlueprintPalette`）+ 节点画布（`BlueprintCanvas`）+ 右侧属性检查器（`NodeInspector`）；
 * - JSON 视图（`BlueprintJsonView`，辅助核对与批量编辑）。
 *
 * 保存前调用 `blueprint.validate` 服务端校验，失败不落库；保存后热更新到布局
 * （`blueprintRuntime` 重载生效蓝图并对账 dockview 布局）。
 */

import { useMemo } from "react";

import { useApp } from "../core/AppContext";
import { BlueprintCanvas } from "./BlueprintCanvas";
import { BlueprintDocList } from "./BlueprintDocList";
import { BlueprintJsonView } from "./BlueprintJsonView";
import { BlueprintLayerBar } from "./BlueprintLayerBar";
import { BlueprintPalette } from "./BlueprintPalette";
import { BlueprintToolbar } from "./BlueprintToolbar";
import { NodeInspector } from "./BlueprintInspector";
import { useBlueprintDocuments } from "./useBlueprintDocuments";
import { useBlueprintEditorState } from "./useBlueprintEditorState";
import { useBlueprintGraphEdits } from "./useBlueprintGraphEdits";
import { useBlueprintLayerTools } from "./useBlueprintLayerTools";
import { useBlueprintUnlinked } from "./useBlueprintUnlinked";

export function BlueprintPanel(): JSX.Element {
  const app = useApp();
  const state = useBlueprintEditorState();
  const docs = useBlueprintDocuments(state);
  const layerTools = useBlueprintLayerTools(state);
  const edits = useBlueprintGraphEdits({
    state,
    addNewLayer: layerTools.addNewLayer,
    persistDoc: docs.persistDoc,
  });
  /** 未接通节点（派生）：画布灰显 + 顶部提示，不落库。 */
  const unlinkedKeys = useBlueprintUnlinked(state.doc);

  const selectedNode = useMemo(
    () => state.doc.nodes.find((n) => n.key === state.selectedKey) ?? null,
    [state.doc.nodes, state.selectedKey],
  );

  return (
    <div className="panel bp-panel">
      {!app.repoId && (
        <span className="placeholder">{app.t("blueprint.selectRepo")}</span>
      )}
      {app.repoId && (
        <>
          {/* 蓝图列表 + 新建/模板 */}
          <BlueprintDocList
            items={docs.items}
            templates={docs.templates}
            selectedId={state.selectedId}
            newName={state.newName}
            withStructure={state.withStructure}
            busy={state.busy}
            onNewNameChange={state.setNewName}
            onCreate={docs.create}
            onSelect={docs.select}
            onSetDefault={docs.setDefault}
            onCreateFromTemplate={docs.createFromTemplate}
            onWithStructureChange={state.setWithStructure}
            theme={app.theme}
            t={app.t}
          />

          {!state.selectedId ? (
            <span className="placeholder">{app.t("blueprint.noSelection")}</span>
          ) : (
            <>
              {/* 名称 + 保存/删除/一键整理 + 视图切换 */}
              <BlueprintToolbar
                name={state.name}
                busy={state.busy}
                viewMode={state.viewMode}
                onNameChange={state.setName}
                onSave={docs.save}
                onArrange={edits.onArrange}
                onRestore={docs.restoreBuiltin}
                onRemove={docs.remove}
                onToggleView={() =>
                  state.setViewMode(state.viewMode === "canvas" ? "json" : "canvas")
                }
                t={app.t}
              />

              {state.viewMode === "json" ? (
                <BlueprintJsonView
                  jsonText={state.jsonText}
                  onTextChange={state.setJsonText}
                  onSync={state.syncFromJson}
                  t={app.t}
                />
              ) : (
                <>
                  {/* 层工具条（D51）：画布同一时刻只显示一个层 */}
                  <BlueprintLayerBar
                    layers={layerTools.layers}
                    current={state.layerKey}
                    rootless={layerTools.rootlessLayers}
                    onSwitch={layerTools.switchToLayer}
                    onAdd={layerTools.addNewLayer}
                    onRename={layerTools.renameCurrentLayer}
                    onRemove={layerTools.removeCurrentLayer}
                    onMove={layerTools.moveCurrentLayer}
                    onSetHome={layerTools.setCurrentLayerAsHome}
                    t={app.t}
                  />

                  {/* 节点添加面板 */}
                  <BlueprintPalette onAdd={edits.addNode} t={app.t} />

                  {/* 画布 + 检查器 */}
                  <div className="bp-main">
                    <BlueprintCanvas
                      doc={state.doc}
                      onChange={state.mutate}
                      onPersist={docs.persistDoc}
                      onRemoveNode={edits.removeNode}
                      onRemoveBlade={edits.removeBladeHits}
                      onRemoveEdge={edits.removeEdgeAt}
                      onConnect={edits.onConnect}
                      onViewCenterChange={state.setViewCenter}
                      selectedKey={state.selectedKey}
                      onSelect={state.setSelectedKey}
                      unlinked={unlinkedKeys}
                      layerKey={state.layerKey}
                      t={app.t}
                    />
                    <NodeInspector
                      node={selectedNode}
                      doc={state.doc}
                      onPatch={(patch) => {
                        if (state.selectedKey) {
                          edits.updateNode(state.selectedKey, patch);
                        }
                      }}
                      onRemove={() => {
                        if (state.selectedKey) {
                          edits.removeNode(state.selectedKey);
                        }
                      }}
                      t={app.t}
                    />
                  </div>
                </>
              )}

              <span className="dim">{app.t("blueprint.editorHint")}</span>
              {unlinkedKeys.size > 0 && (
                <span className="bp-unlinked-hint">
                  {app.t("blueprint.unlinkedHint", { count: unlinkedKeys.size })}
                </span>
              )}
              {state.errors.length > 0 && (
                <ul className="bp-errors">
                  {state.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
