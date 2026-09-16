/**
 * 蓝图面板 — 节点式编辑器（画布式拖拽连线，仿 ComfyUI，RFC 0007 决策 7 / D31）。
 *
 * 组成：
 * - 顶部：蓝图列表（新建/删除/设为默认/从模板创建）+ 名称 + 保存；
 * - 主区：节点画布（`BlueprintCanvas`，拖拽摆放/端口连线/平移缩放）
 *   + 右侧属性检查器（`BlueprintInspector`）+ 画布槽位（`blueprintSlots`）；
 * - JSON 视图（辅助核对与批量编辑）。
 * 保存前调用 `blueprint.validate` 服务端校验，失败不落库；保存后热更新到布局
 * （`blueprintRuntime` 重载生效蓝图并对账 dockview 布局）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DEFAULT_BLUEPRINT,
  type BlueprintEdge,
  type BlueprintGraph,
  type BlueprintNode,
  type BlueprintNodeType,
  forUserSave,
  makeEmptyBlueprint,
} from "@hamster-pouch/config";
import type {
  BlueprintItem,
  BlueprintTemplateItem,
} from "@hamster-pouch/shared-types";

import * as api from "../shared/api";
import { notifyBlueprintChangedLocally, traceBlueprint } from "../shared/blueprintRuntime";
import { analyzeUnlinked } from "../shared/blueprintLint";
import { useApp } from "../core/AppContext";
import { BlueprintCanvas } from "./BlueprintCanvas";
import { softRemove } from "./blueprintDelete";
import { NodeInspector } from "./BlueprintInspector";
import { appendNode, parentHintFor } from "./blueprintNodeFactory";
import {
  readStructure,
  snapshotFromDockview,
  structureBlueprint,
} from "./blueprintStructure";
import {
  canvasCenter,
  freeSlotPosition,
  normalizePositions,
} from "./blueprintSlots";

export function BlueprintPanel(): JSX.Element {
  const app = useApp();
  const [items, setItems] = useState<BlueprintItem[]>([]);
  const [templates, setTemplates] = useState<BlueprintTemplateItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doc, setDoc] = useState<BlueprintGraph>(() => makeEmptyBlueprint());
  const [jsonText, setJsonText] = useState<string>(() =>
    JSON.stringify(makeEmptyBlueprint(), null, 2),
  );
  const [name, setName] = useState("");
  const [newName, setNewName] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"canvas" | "json">("canvas");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /** 画布渲染视口中心（世界坐标）：新增节点落点用。 */
  const [viewCenter, setViewCenter] = useState<{ x: number; y: number } | null>(null);
  /** 新建蓝图时是否带上当前布局的结构骨架（布局块→标签组→控件）。 */
  const [withStructure, setWithStructure] = useState(true);

  const repoId = app.repoId;

  const load = useCallback(async () => {
    if (!repoId) {
      setItems([]);
      setTemplates([]);
      setSelectedId(null);
      return;
    }
    try {
      const [list, tpls] = await Promise.all([
        api.blueprintList({ repoId }),
        api.blueprintTemplateList().catch(() => [] as BlueprintTemplateItem[]),
      ]);
      setItems(list);
      setTemplates(tpls);
    } catch (e) {
      app.status(app.t("blueprint.loadFailed", { err: String(e) }), "error");
    }
  }, [repoId, app]);

  useEffect(() => {
    void load();
  }, [load, app.refreshKey]);

  /** 选中并装载蓝图文档；节点缺失 position 时按级联布局补齐。 */
  const select = useCallback(
    async (id: string) => {
      if (!repoId) {
        return;
      }
      try {
        const raw = await api.blueprintGet({ repoId, blueprintId: id });
        if (!raw) {
          return;
        }
        const parsed = JSON.parse(raw) as BlueprintGraph;
        // 缺 position 的节点按网格槽位补齐（互不重叠），并静默落库一次，
        // 保证"保存后热更新到布局"与"画布可读"对旧文档同样成立。
        const normalized = normalizePositions(parsed);
        if (normalized !== parsed) {
          void api
            .blueprintSave({
              repoId,
              blueprintId: id,
              name: items.find((i) => i.id === id)?.name,
              blueprintJson: JSON.stringify(forUserSave(normalized)),
            })
            .catch(() => undefined);
        }
        setDoc(normalized);
        setJsonText(JSON.stringify(normalized, null, 2));
        setSelectedId(id);
        setName(items.find((i) => i.id === id)?.name ?? "");
        setSelectedKey(null);
        setErrors([]);
      } catch (e) {
        app.status(app.t("blueprint.loadFailed", { err: String(e) }), "error");
      }
    },
    [repoId, items, app],
  );

  /** 统一变更文档并同步 JSON 文本。 */
  const mutate = useCallback((next: BlueprintGraph) => {
    setDoc(next);
    setJsonText(JSON.stringify(next, null, 2));
  }, []);

  /**
   * 在**当前渲染画布的中心**附近新增节点（避开已占用槽位，节点不堆叠）。
   * key 与引用从上级推导（选中节点的类型决定用谁当上级，见 `blueprintNodeFactory`）。
   */
  const addNode = useCallback(
    (type: BlueprintNodeType) => {
      // 视口中心（世界坐标）由画布上报；未上报前退回已有节点附近。
      const center = viewCenter ?? canvasCenter(doc.nodes);
      const position = freeSlotPosition(doc.nodes, center);
      const { doc: next, node } = appendNode(
        doc,
        type,
        position,
        parentHintFor(type, selectedKey, doc),
      );
      mutate(next);
      setSelectedKey(node.key);
      app.status(
        app.t("blueprint.nodeAdded", { x: position.x, y: position.y }),
        "ok",
      );
    },
    [doc, mutate, selectedKey, viewCenter, app],
  );

  const updateNode = useCallback(
    (key: string, patch: Partial<BlueprintNode>) => {
      mutate({
        ...doc,
        nodes: doc.nodes.map((n) => (n.key === key ? { ...n, ...patch } : n)),
      });
    },
    [doc, mutate],
  );

  /**
   * 删除节点（**软删除**）：只删这个节点和挂在它身上的边；**关联节点保留**，
   * 因引用丢失无法工作的部分由画布灰显"未接通"（`softRemove` / `blueprintLint`）。
   */
  const removeNode = useCallback(
    (key: string) => {
      const { doc: next, removed, unlinked } = softRemove(doc, key);
      if (removed.length === 0) {
        return;
      }
      mutate(next);
      setSelectedKey(null);
      if (unlinked.length > 0) {
        app.status(app.t("blueprint.softRemoved", { count: unlinked.length }), "info");
      }
    },
    [doc, mutate, app],
  );

  /** 删除一条边（画布刀痕删除用）。 */
  const removeEdgeAt = useCallback(
    (index: number) => {
      const edge = doc.edges[index];
      if (!edge) {
        return;
      }
      mutate({ ...doc, edges: doc.edges.filter((_, i) => i !== index) });
      app.status(app.t("blueprint.edgeRemoved", { kind: edge.kind }), "info");
    },
    [doc, mutate, app],
  );

  /**
   * 连线后自动把**子节点的引用字段**落好（用户不手填 key）：
   * 控件→类 写 `class.control`、类→对象 写 `object.class`、对象/类→操作 写 `event.target`、
   * 组↔控件 写 `memberOf` 语义（组 contains 成员）、控件→类→对象的 `contains` 已是结构本身。
   */
  const onConnect = useCallback(
    (edge: { from: string; to: string; kind: BlueprintEdge["kind"] }) => {
      const child = doc.nodes.find((n) => n.key === edge.to);
      const parent = doc.nodes.find((n) => n.key === edge.from);
      if (!child || !parent) {
        return;
      }
      const patch: Partial<BlueprintNode> = {};
      if (child.type === "class" && parent.type === "control" && child.control !== parent.key) {
        patch.control = parent.key;
      } else if (child.type === "object" && parent.type === "class" && child.class !== parent.key) {
        patch.class = parent.key;
      } else if (
        child.type === "event" &&
        (parent.type === "object" || parent.type === "class" || parent.type === "control") &&
        child.target !== parent.key
      ) {
        patch.target = parent.key;
      } else if (child.type === "action" && child.target === undefined) {
        const target = doc.nodes.find(
          (n) => n.key === edge.from && (n.type === "control" || n.type === "group"),
        );
        if (target) {
          patch.target = target.key;
        }
      }
      if (Object.keys(patch).length > 0) {
        mutate({
          ...doc,
          nodes: doc.nodes.map((n) => (n.key === child.key ? { ...n, ...patch } : n)),
        });
      }
    },
    [doc, mutate],
  );

  /** 校验并保存整文档（显式保存）。 */
  const save = useCallback(async () => {
    if (!repoId || !selectedId) {
      return;
    }
    setBusy(true);
    try {
      const result = await api.blueprintValidate({
        repoId,
        blueprintJson: JSON.stringify(doc),
      });
      if (result.errors.length > 0) {
        setErrors(result.errors);
        app.status(
          app.t("blueprint.invalidNotSaved", { err: result.errors.join("；") }),
          "error",
        );
        return;
      }
      await api.blueprintSave({
        repoId,
        blueprintId: selectedId,
        name: name.trim() || undefined,
        // 用户保存 = 不再是内置默认：去掉 default_version，停止自动升级覆盖。
        blueprintJson: JSON.stringify(forUserSave(doc)),
      });
      setErrors([]);
      app.status(app.t("blueprint.saved"), "ok");
      // 热更新：广播"已保存"（本窗口 + 跨窗口令牌），任何窗口都会重载并把语义
      // 对账到当前布局——无需手动重开面板或重启应用。
      notifyBlueprintChangedLocally({ id: selectedId, graph: doc });
      app.refresh();
      void load();
    } catch (e) {
      app.status(app.t("blueprint.saveFailed", { err: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  }, [repoId, selectedId, doc, name, app, load]);

  /**
   * 新建蓝图：默认带上**当前布局的结构骨架**（布局块 → 标签组 → 控件），
   * 用户只需在此基础上补规则；也可取消勾选从空图起步。
   */
  const create = useCallback(async () => {
    if (!repoId) {
      return;
    }
    const n = newName.trim() || app.t("blueprint.defaultName");
    setBusy(true);
    try {
      // 结构快照：优先用主窗口发布的跨窗口共享布局结构（本面板可能开在独立窗口，
      // 那里没有 dockview）；拿不到再退回本窗口的 dockview。
      const dockview = app.getDockview();
      const snapshot = dockview
        ? snapshotFromDockview(dockview)
        : readStructure();
      const skeleton =
        withStructure && snapshot && snapshot.regions.length > 0
          ? structureBlueprint(snapshot)
          : null;
      traceBlueprint(
        `[structure] 新建蓝图 withStructure=${withStructure} dockview=${!!dockview} 快照区域=${snapshot?.regions.length ?? 0} 结构节点=${skeleton?.nodes.length ?? 0}`,
      );
      const item = await api.blueprintCreate({
        repoId,
        name: n,
        blueprintJson: skeleton
          ? JSON.stringify(forUserSave(skeleton))
          : undefined,
      });
      app.status(
        skeleton
          ? app.t("blueprint.createdWithStructure", {
              name: n,
              count: skeleton.nodes.length,
            })
          : app.t("blueprint.created", { name: n }),
        "ok",
      );
      await load();
      await select(item.id);
      setName(n);
      setNewName("");
    } catch (e) {
      app.status(app.t("blueprint.createFailed", { err: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  }, [repoId, newName, app, load, select, withStructure]);

  const createFromTemplate = useCallback(
    async (tplId: string) => {
      if (!repoId) {
        return;
      }
      setBusy(true);
      try {
        const item = await api.blueprintTemplateInstall({
          repoId,
          templateId: tplId,
        });
        notifyBlueprintChangedLocally();
        await load();
        await select(item.id);
      } catch (e) {
        app.status(
          app.t("blueprint.templateInstallFailed", { err: String(e) }),
          "error",
        );
      } finally {
        setBusy(false);
      }
    },
    [repoId, load, select, app],
  );

  const remove = useCallback(async () => {
    if (!repoId || !selectedId) {
      return;
    }
    if (!window.confirm(app.t("blueprint.deleteConfirm"))) {
      return;
    }
    try {
      await api.blueprintDelete({ repoId, blueprintId: selectedId });
      setSelectedId(null);
      setSelectedKey(null);
      setDoc(makeEmptyBlueprint());
      setJsonText(JSON.stringify(makeEmptyBlueprint(), null, 2));
      setName("");
      app.status(app.t("blueprint.deleted"), "ok");
      notifyBlueprintChangedLocally();
      await load();
      app.refresh();
    } catch (e) {
      app.status(app.t("blueprint.deleteFailed", { err: String(e) }), "error");
    }
  }, [repoId, selectedId, app, load]);

  const setDefault = useCallback(async () => {
    if (!repoId || !selectedId) {
      return;
    }
    try {
      await api.blueprintSetDefault({ repoId, blueprintId: selectedId });
      app.status(app.t("blueprint.defaultSet"), "ok");
      // 默认蓝图变更 = 运行时生效蓝图变更 → 立即热更新。
      notifyBlueprintChangedLocally();
      await load();
    } catch (e) {
      app.status(app.t("blueprint.defaultFailed", { err: String(e) }), "error");
    }
  }, [repoId, selectedId, app, load]);

  /**
   * 恢复内置默认蓝图：把**当前选中蓝图的内容**替换为随应用分发的内置默认图。
   * 用于两种情况：用户改坏了图想回到出厂结构；或内置默认升级后想拿回新版结构
   * （用户编辑过的默认蓝图带不上 `default_version`，引擎不会自动覆盖，需显式恢复）。
   */
  const restoreBuiltin = useCallback(async () => {
    if (!repoId || !selectedId) {
      return;
    }
    if (!window.confirm(app.t("blueprint.restoreConfirm"))) {
      return;
    }
    setBusy(true);
    try {
      const next = JSON.parse(JSON.stringify(DEFAULT_BLUEPRINT)) as BlueprintGraph;
      await api.blueprintSave({
        repoId,
        blueprintId: selectedId,
        name: name.trim() || undefined,
        blueprintJson: JSON.stringify(next),
      });
      mutate(next);
      setErrors([]);
      app.status(app.t("blueprint.restored"), "ok");
      notifyBlueprintChangedLocally({ id: selectedId, graph: next });
      await load();
    } catch (e) {
      app.status(app.t("blueprint.restoreFailed", { err: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  }, [repoId, selectedId, name, app, mutate, load]);

  const syncFromJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText) as BlueprintGraph;
      setDoc(normalizePositions(parsed));
      setErrors([]);
    } catch (e) {
      setErrors([String(e)]);
    }
  }, [jsonText]);

  /** 静默持久化整文档（节点位置拖拽结束/一键整理后自动保存，不打扰用户）。 */
  const persistDoc = useCallback(
    (next: BlueprintGraph) => {
      if (!repoId || !selectedId) {
        return;
      }
      void api
        .blueprintSave({
          repoId,
          blueprintId: selectedId,
          name: name.trim() || undefined,
          blueprintJson: JSON.stringify(forUserSave(next)),
        })
        .catch(() => undefined);
    },
    [repoId, selectedId, name],
  );

  /** 一键整理：以选中节点为根，沿边（任意类型）BFS 分层树状展开并落位。 */
  const arrangeTree = useCallback(
    (rootKey: string) => {
      const adj = new Map<string, string[]>();
      for (const e of doc.edges) {
        if (!adj.has(e.from)) {
          adj.set(e.from, []);
        }
        adj.get(e.from)!.push(e.to);
      }
      const depth = new Map<string, number>();
      const order: string[] = [];
      const seen = new Set<string>([rootKey]);
      const queue: { key: string; d: number }[] = [{ key: rootKey, d: 0 }];
      depth.set(rootKey, 0);
      order.push(rootKey);
      while (queue.length > 0) {
        const { key, d } = queue.shift()!;
        for (const next of adj.get(key) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            depth.set(next, d + 1);
            order.push(next);
            queue.push({ key: next, d: d + 1 });
          }
        }
      }
      const H_GAP = 260;
      const V_GAP = 84;
      const colY = new Map<number, number>();
      const positions = new Map<string, { x: number; y: number }>();
      for (const key of order) {
        const d = depth.get(key) ?? 0;
        const y = colY.get(d) ?? 0;
        colY.set(d, y + V_GAP);
        positions.set(key, { x: 40 + d * H_GAP, y: 40 + y });
      }
      const next: BlueprintGraph = {
        ...doc,
        nodes: doc.nodes.map((n) =>
          positions.has(n.key)
            ? { ...n, position: positions.get(n.key)! }
            : n,
        ),
      };
      mutate(next);
      persistDoc(next);
    },
    [doc, mutate, persistDoc],
  );

  const onArrange = useCallback(() => {
    const root = selectedKey ?? doc.nodes[0]?.key;
    if (!root) {
      return;
    }
    arrangeTree(root);
  }, [selectedKey, doc.nodes, arrangeTree]);

  const selectedNode = useMemo(
    () => doc.nodes.find((n) => n.key === selectedKey) ?? null,
    [doc.nodes, selectedKey],
  );

  /** 未接通节点（派生）：画布灰显 + 顶部提示，不落库。 */
  const unlinked = useMemo(() => analyzeUnlinked(doc), [doc]);
  const unlinkedKeys = useMemo(
    () => new Set(Object.keys(unlinked)),
    [unlinked],
  );

  return (
    <div className="panel bp-panel">
      {!repoId && (
        <span className="placeholder">{app.t("blueprint.selectRepo")}</span>
      )}
      {repoId && (
        <>
          {/* 蓝图列表 + 新建/模板 */}
          <div className="bp-list">
            <div className="row">
              <input
                value={newName}
                placeholder={app.t("blueprint.namePlaceholder")}
                onChange={(e) => setNewName(e.target.value)}
              />
              <button disabled={busy} onClick={() => void create()}>
                {app.t("blueprint.create")}
              </button>
            </div>
            <label className="bp-check" title={app.t("blueprint.structureHint")}>
              <input
                type="checkbox"
                checked={withStructure}
                onChange={(e) => setWithStructure(e.target.checked)}
              />
              {app.t("blueprint.withStructure")}
            </label>
            {items.map((it) => (
              <div
                key={it.id}
                className={`bp-item ${it.id === selectedId ? "selected" : ""}`}
              >
                <button className="bp-item-main" onClick={() => void select(it.id)}>
                  {it.name}
                  {it.is_default && <span className="dim"> ★</span>}
                </button>
                <button
                  className="bp-item-action"
                  disabled={it.is_default}
                  onClick={() => void select(it.id).then(() => setDefault())}
                  title={app.t("blueprint.setDefault")}
                >
                  ★
                </button>
              </div>
            ))}
            {items.length === 0 && (
              <span className="placeholder">{app.t("blueprint.none")}</span>
            )}
            {templates.length > 0 && (
              <div className="row">
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) {
                      void createFromTemplate(e.target.value);
                    }
                  }}
                >
                  <option value="">{app.t("blueprint.fromTemplate")}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {!selectedId ? (
            <span className="placeholder">{app.t("blueprint.noSelection")}</span>
          ) : (
            <>
              {/* 名称 + 保存/删除/一键整理 + 视图切换 */}
              <div className="row bp-toolbar">
                <input
                  value={name}
                  placeholder={app.t("blueprint.namePlaceholder")}
                  onChange={(e) => setName(e.target.value)}
                />
                <button disabled={busy} onClick={() => void save()}>
                  {app.t("common.confirm")}
                </button>
                <button
                  title={app.t("blueprint.arrangeHint")}
                  onClick={onArrange}
                >
                  {app.t("blueprint.arrange")}
                </button>
                <button
                  title={app.t("blueprint.restoreHint")}
                  disabled={busy}
                  onClick={() => void restoreBuiltin()}
                >
                  {app.t("blueprint.restore")}
                </button>
                <button className="danger" onClick={() => void remove()}>
                  {app.t("blueprint.removeNode")}
                </button>
                <button
                  onClick={() => setViewMode(viewMode === "canvas" ? "json" : "canvas")}
                >
                  {viewMode === "canvas"
                    ? app.t("blueprint.jsonView")
                    : app.t("blueprint.formView")}
                </button>
              </div>

              {viewMode === "json" ? (
                <div className="panel-stack">
                  <textarea
                    className="bp-json"
                    spellCheck={false}
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                  />
                  <div className="row">
                    <button onClick={syncFromJson}>
                      {app.t("blueprint.syncFromJson")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* 节点添加面板 */}
                  <div className="bp-palette">
                    {(
                      [
                        "layout_block",
                        "control",
                        "class",
                        "object",
                        "group",
                        "event",
                        "condition",
                        "action",
                      ] as BlueprintNodeType[]
                    ).map((type) => (
                      <button
                        key={type}
                        className="bp-palette-btn"
                        onClick={() => addNode(type)}
                      >
                        {app.t(`blueprint.type.${type}`)}
                      </button>
                    ))}
                  </div>

                  {/* 画布 + 检查器 */}
                  <div className="bp-main">
                    <BlueprintCanvas
                      doc={doc}
                      onChange={mutate}
                      onPersist={persistDoc}
                      onRemoveNode={removeNode}
                      onRemoveEdge={removeEdgeAt}
                      onConnect={onConnect}
                      onViewCenterChange={setViewCenter}
                      selectedKey={selectedKey}
                      onSelect={setSelectedKey}
                      unlinked={unlinkedKeys}
                      t={app.t}
                    />
                    <NodeInspector
                      node={selectedNode}
                      doc={doc}
                      onPatch={(patch) => {
                        if (selectedKey) {
                          updateNode(selectedKey, patch);
                        }
                      }}
                      onRemove={() => {
                        if (selectedKey) {
                          removeNode(selectedKey);
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
              {errors.length > 0 && (
                <ul className="bp-errors">
                  {errors.map((e, i) => (
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
