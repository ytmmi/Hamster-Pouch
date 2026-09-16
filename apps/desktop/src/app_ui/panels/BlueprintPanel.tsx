/**
 * 蓝图面板 — 节点式编辑器（画布式拖拽连线，仿 ComfyUI，RFC 0007 决策 7 / D31）。
 *
 * 组成：
 * - 顶部：蓝图列表（新建/删除/设为默认/从模板创建）+ 名称 + 保存；
 * - 主区：节点画布（`BlueprintCanvas`，拖拽摆放/端口连线/平移缩放）+ 右侧属性检查器；
 * - JSON 视图（辅助核对与批量编辑）。
 * 保存前调用 `blueprint.validate` 服务端校验，失败不落库。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type BlueprintGraph,
  type BlueprintNode,
  type BlueprintNodeType,
  CONDITION_EXPR_HINTS,
  HIDE_DIRECTIONS,
  makeEmptyBlueprint,
  PANEL_IDS,
  PANEL_TITLES,
} from "@hamster-pouch/config";
import type {
  BlueprintItem,
  BlueprintTemplateItem,
} from "@hamster-pouch/shared-types";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import type { Translate, TranslationKey } from "../i18n";
import {
  BlueprintCanvas,
  hideDirLabel,
  mediaTypeLabel,
  nodeDisplayName,
  opLabel,
  resolveControlTitle,
  scopeLabel,
  triggerLabel,
} from "./BlueprintCanvas";

const TYPE_PREFIX: Record<string, string> = {
  layout_block: "blk",
  control: "c",
  class: "k",
  object: "o",
  group: "g",
  event: "e",
  condition: "cond",
  action: "a",
};

const MEDIA_TYPES = ["image", "video", "audio"] as const;
const SCOPES = ["clicked", "double_clicked", "selected"] as const;
const ACTION_OPS = ["show", "hide", "toggle", "collapse", "expand"] as const;

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
        const normalized = normalizePositions(parsed);
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

  /** 自动生成唯一节点 key。 */
  const nextKey = useCallback(
    (type: string) => {
      const prefix = TYPE_PREFIX[type] ?? "n";
      let i = 1;
      while (doc.nodes.some((n) => n.key === `${prefix}_${i}`)) {
        i += 1;
      }
      return `${prefix}_${i}`;
    },
    [doc.nodes],
  );

  /** 在画布中部附近新增节点。 */
  const addNode = useCallback(
    (type: BlueprintNodeType) => {
      const base: BlueprintNode = {
        key: nextKey(type),
        type,
        position: {
          x: 80 + Math.round(Math.random() * 120),
          y: 60 + Math.round(Math.random() * 120),
        },
      };
      switch (type) {
        case "layout_block":
          break;
        case "control":
          base.panel_id = PANEL_IDS[0];
          break;
        case "class":
          base.media_type = "image";
          break;
        case "object":
          base.scope = "clicked";
          break;
        case "group":
          base.mode = "exclusive";
          break;
        case "event":
          base.trigger = "double_click";
          break;
        case "condition":
          base.expr = "media_type == image";
          break;
        case "action":
          base.op = "show";
          break;
        default:
          break;
      }
      mutate({ ...doc, nodes: [...doc.nodes, base] });
      setSelectedKey(base.key);
    },
    [doc, mutate, nextKey],
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
   * 删除节点（级联）：除边外，凡「必填引用」指向被删节点的节点一并删除
   * （类的 control、对象的 class、事件的 target、动作的 target），保证保存不再因
   * 悬空引用报错；「可选引用」就地清理（组 default_visible、hide_direction toward）。
   */
  const removeNode = useCallback(
    (key: string) => {
      const toRemove = new Set<string>([key]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of doc.nodes) {
          if (toRemove.has(n.key)) {
            continue;
          }
          const depends =
            (n.control !== undefined && toRemove.has(n.control)) ||
            (n.class !== undefined && toRemove.has(n.class)) ||
            (n.target !== undefined && toRemove.has(n.target));
          if (depends) {
            toRemove.add(n.key);
            changed = true;
          }
        }
      }
      // 可选引用就地清理（不级联删除宿主节点）
      const patchOptional = (n: BlueprintNode): BlueprintNode => {
        const p: Partial<BlueprintNode> = {};
        const dv = (n.default_visible ?? []).filter((k) => !toRemove.has(k));
        if (dv.length !== (n.default_visible ?? []).length) {
          p.default_visible = dv;
        }
        if (n.hide_direction?.startsWith("toward:") && toRemove.has(n.hide_direction.slice(7))) {
          p.hide_direction = undefined;
        }
        return Object.keys(p).length ? { ...n, ...p } : n;
      };
      mutate({
        ...doc,
        nodes: doc.nodes
          .filter((n) => !toRemove.has(n.key))
          .map(patchOptional),
        edges: doc.edges.filter((e) => !toRemove.has(e.from) && !toRemove.has(e.to)),
      });
      setSelectedKey(null);
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
        blueprintJson: JSON.stringify(doc),
      });
      setErrors([]);
      app.status(app.t("blueprint.saved"), "ok");
      app.refresh(); // 引擎重载，立即生效
      void load();
    } catch (e) {
      app.status(app.t("blueprint.saveFailed", { err: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  }, [repoId, selectedId, doc, name, app, load]);

  const create = useCallback(async () => {
    if (!repoId) {
      return;
    }
    const n = newName.trim() || app.t("blueprint.defaultName");
    setBusy(true);
    try {
      const item = await api.blueprintCreate({ repoId, name: n });
      app.status(app.t("blueprint.created", { name: n }), "ok");
      await load();
      await select(item.id);
      setName(n);
      setNewName("");
    } catch (e) {
      app.status(app.t("blueprint.createFailed", { err: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  }, [repoId, newName, app, load, select]);

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
      await load();
    } catch (e) {
      app.status(app.t("blueprint.defaultFailed", { err: String(e) }), "error");
    }
  }, [repoId, selectedId, app, load]);

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
          blueprintJson: JSON.stringify(next),
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

  // 派生选项列表
  const controlKeys = useMemo(
    () => doc.nodes.filter((n) => n.type === "control").map((n) => n.key),
    [doc.nodes],
  );
  const classKeys = useMemo(
    () => doc.nodes.filter((n) => n.type === "class").map((n) => n.key),
    [doc.nodes],
  );
  const objectKeys = useMemo(
    () => doc.nodes.filter((n) => n.type === "object").map((n) => n.key),
    [doc.nodes],
  );
  const groupKeys = useMemo(
    () => doc.nodes.filter((n) => n.type === "group").map((n) => n.key),
    [doc.nodes],
  );

  const selectedNode = useMemo(
    () => doc.nodes.find((n) => n.key === selectedKey) ?? null,
    [doc.nodes, selectedKey],
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
                      selectedKey={selectedKey}
                      onSelect={setSelectedKey}
                      t={app.t}
                    />
                    <NodeInspector
                      node={selectedNode}
                      doc={doc}
                      controlKeys={controlKeys}
                      classKeys={classKeys}
                      objectKeys={objectKeys}
                      groupKeys={groupKeys}
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

/** 节点缺失 position 时按级联布局补齐（画布展示需要世界坐标）。 */
function normalizePositions(doc: BlueprintGraph): BlueprintGraph {
  let idx = 0;
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.position) {
        return n;
      }
      idx += 1;
      return {
        ...n,
        position: { x: 40 + ((idx * 30) % 300), y: 40 + Math.floor(idx / 10) * 30 },
      };
    }),
  };
}

/** 节点属性检查器（编辑全部参数 + 删除；参数与选项均中文/多语言，不暴露底层 key）。 */
function NodeInspector({
  node,
  doc,
  controlKeys,
  classKeys,
  objectKeys,
  groupKeys,
  onPatch,
  onRemove,
  t,
}: {
  node: BlueprintNode | null;
  doc: BlueprintGraph;
  controlKeys: string[];
  classKeys: string[];
  objectKeys: string[];
  groupKeys: string[];
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
    key: string,
    value: string,
    set: (v: string) => void,
  ): JSX.Element =>
    row(
      label,
      <input value={value} onChange={(e) => set(e.target.value)} />,
    );
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

  /** 节点 key → 中文显示名（供下拉选项，不暴露 key）。 */
  const labelOf = (key: string): string => {
    const n = doc.nodes.find((x) => x.key === key);
    return n ? nodeDisplayName(n, t, doc.nodes) : key;
  };
  const optionsOf = (keys: string[]): { v: string; l: string }[] =>
    keys.map((k) => ({ v: k, l: labelOf(k) }));

  const eventTargetKeys = [...classKeys, ...objectKeys];
  const actionTargetKeys =
    node.op === "collapse" || node.op === "expand"
      ? groupKeys
      : [...controlKeys, ...groupKeys];

  // 隐藏方向：4 方向中文 + 已有 toward:<组> 值保留为选项
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
      {field(t("blueprint.name"), "name", node.name ?? "", (v) =>
        onPatch({ name: v }),
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
      {node.type === "control" &&
        field(t("blueprint.titleKey"), "title_key", node.title_key ?? "", (v) =>
          onPatch({ title_key: v }),
        )}
      {node.type === "control" && (
        <span className="dim bp-hints">
          {t("blueprint.tabTitle")}: {resolveControlTitle(node, t) || "—"}
        </span>
      )}
      {node.type === "class" &&
        select(
          t("blueprint.tab.controls"),
          node.control ?? "",
          optionsOf(controlKeys),
          (v) => onPatch({ control: v }),
        )}
      {node.type === "class" &&
        select(
          t("blueprint.mediaType"),
          node.media_type ?? "",
          MEDIA_TYPES.map((m) => ({ v: m, l: mediaTypeLabel(m, t) })),
          (v) => onPatch({ media_type: v }),
        )}
      {node.type === "object" &&
        select(
          t("blueprint.tab.classes"),
          node.class ?? "",
          optionsOf(classKeys),
          (v) => onPatch({ class: v }),
        )}
      {node.type === "object" &&
        select(
          t("blueprint.scope"),
          node.scope ?? "",
          SCOPES.map((s) => ({ v: s, l: scopeLabel(s, t) })),
          (v) => onPatch({ scope: v }),
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
            {controlKeys.length === 0 && <span className="dim">—</span>}
            {controlKeys.map((k) => {
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
      {node.type === "event" &&
        select(
          t("blueprint.target"),
          node.target ?? "",
          optionsOf(eventTargetKeys),
          (v) => onPatch({ target: v }),
        )}
      {node.type === "condition" &&
        field(t("blueprint.conditionExpr"), "expr", node.expr ?? "", (v) =>
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
      {node.type === "action" &&
        select(
          t("blueprint.target"),
          node.target ?? "",
          optionsOf(actionTargetKeys),
          (v) => onPatch({ target: v }),
        )}
      {node.type === "action" &&
        row(
          t("blueprint.payload"),
          <textarea
            className="bp-payload"
            spellCheck={false}
            value={
              node.payload === undefined ? "" : JSON.stringify(node.payload)
            }
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
