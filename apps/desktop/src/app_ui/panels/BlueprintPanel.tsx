/**
 * 蓝图面板 — 过渡编辑器（表单/列表式，RFC 0007 决策 7 / D31）。
 *
 * 阶段一形态：蓝图列表（新建/删除/设为默认/从模板创建）+ 表单视图
 * （控件/类/对象/组/规则 五个标签页逐项编辑）+ JSON 视图（含校验）。
 * 保存前调用 `blueprint.validate` 服务端校验，失败不落库。
 *
 * 画布式拖拽连线编辑器将在功能测试通过后构建（M6 阶段二）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type BlueprintEdge,
  type BlueprintGraph,
  type BlueprintNode,
  CONDITION_EXPR_HINTS,
  HIDE_DIRECTIONS,
  makeEmptyBlueprint,
  PANEL_IDS,
} from "@hamster-pouch/config";
import type {
  BlueprintItem,
  BlueprintTemplateItem,
} from "@hamster-pouch/shared-types";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";

type Tab = "controls" | "classes" | "objects" | "groups" | "rules" | "json";

const TYPE_PREFIX: Record<string, string> = {
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
const EDGE_KINDS = ["contains", "memberOf", "fires", "guards"] as const;
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
  const [tab, setTab] = useState<Tab>("controls");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // 规则页新增表单草稿
  const [edgeDraft, setEdgeDraft] = useState<BlueprintEdge>({
    from: "",
    kind: "fires",
    to: "",
    order: 1,
  });

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

  /** 选中并装载蓝图文档。 */
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
        setDoc(parsed);
        setJsonText(JSON.stringify(parsed, null, 2));
        setSelectedId(id);
        setName(items.find((i) => i.id === id)?.name ?? "");
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

  const addNode = useCallback(
    (partial: BlueprintNode) => {
      mutate({
        ...doc,
        nodes: [...doc.nodes, { ...partial, key: nextKey(partial.type) }],
      });
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

  const removeNode = useCallback(
    (key: string) => {
      mutate({
        ...doc,
        nodes: doc.nodes.filter((n) => n.key !== key),
        edges: doc.edges.filter((e) => e.from !== key && e.to !== key),
      });
    },
    [doc, mutate],
  );

  const addEdge = useCallback(
    (edge: BlueprintEdge) => {
      mutate({ ...doc, edges: [...doc.edges, edge] });
    },
    [doc, mutate],
  );

  const removeEdge = useCallback(
    (index: number) => {
      mutate({ ...doc, edges: doc.edges.filter((_, i) => i !== index) });
    },
    [doc, mutate],
  );

  /** 校验并保存整文档。 */
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
      setDoc(parsed);
      setErrors([]);
    } catch (e) {
      setErrors([String(e)]);
    }
  }, [jsonText]);

  // 派生选项列表
  const controlKeys = useMemo(
    () => doc.nodes.filter((n) => n.type === "control").map((n) => n.key),
    [doc.nodes],
  );
  const classKeys = useMemo(
    () => doc.nodes.filter((n) => n.type === "class").map((n) => n.key),
    [doc.nodes],
  );
  const eventKeys = useMemo(
    () => doc.nodes.filter((n) => n.type === "event").map((n) => n.key),
    [doc.nodes],
  );
  const conditionKeys = useMemo(
    () => doc.nodes.filter((n) => n.type === "condition").map((n) => n.key),
    [doc.nodes],
  );
  const groupKeys = useMemo(
    () => doc.nodes.filter((n) => n.type === "group").map((n) => n.key),
    [doc.nodes],
  );
  const actionKeys = useMemo(
    () => doc.nodes.filter((n) => n.type === "action").map((n) => n.key),
    [doc.nodes],
  );

  /** 按边类型 + 起点类型推导可选终点。 */
  const edgeToOptions = useCallback(
    (kind: BlueprintEdge["kind"], from: string): string[] => {
      const fromNode = doc.nodes.find((n) => n.key === from);
      const fromType = fromNode?.type;
      switch (kind) {
        case "contains":
          return fromType === "control" ? classKeys : fromType === "class" ? doc.nodes.filter((n) => n.type === "object").map((n) => n.key) : [];
        case "memberOf":
          return groupKeys;
        case "fires":
          return [...conditionKeys, ...actionKeys];
        case "guards":
          return actionKeys;
        default:
          return [];
      }
    },
    [doc.nodes, classKeys, conditionKeys, actionKeys, groupKeys],
  );

  // ============================== 各页渲染 ==============================

  const renderControls = (): JSX.Element => (
    <div className="panel-stack">
      {doc.nodes
        .filter((n) => n.type === "control")
        .map((n) => (
          <div key={n.key} className="row">
            <span className="dim mono">{n.key}</span>
            <select
              value={n.panel_id ?? ""}
              onChange={(e) => updateNode(n.key, { panel_id: e.target.value })}
            >
              <option value="">—</option>
              {PANEL_IDS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <input
              value={n.title_key ?? ""}
              placeholder={app.t("blueprint.titleKey")}
              onChange={(e) => updateNode(n.key, { title_key: e.target.value })}
            />
            <button className="danger" onClick={() => removeNode(n.key)}>
              {app.t("blueprint.removeNode")}
            </button>
          </div>
        ))}
      <div className="row">
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) {
              addNode({ key: "", type: "control", panel_id: e.target.value });
            }
          }}
        >
          <option value="">{app.t("blueprint.addNode")}…</option>
          {PANEL_IDS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>
    </div>
  );

  const renderClasses = (): JSX.Element => (
    <div className="panel-stack">
      {doc.nodes
        .filter((n) => n.type === "class")
        .map((n) => (
          <div key={n.key} className="row">
            <span className="dim mono">{n.key}</span>
            <select
              value={n.control ?? ""}
              onChange={(e) => updateNode(n.key, { control: e.target.value })}
            >
              <option value="">—</option>
              {controlKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select
              value={n.media_type ?? ""}
              onChange={(e) => updateNode(n.key, { media_type: e.target.value })}
            >
              <option value="">—</option>
              {MEDIA_TYPES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button className="danger" onClick={() => removeNode(n.key)}>
              {app.t("blueprint.removeNode")}
            </button>
          </div>
        ))}
      <div className="row">
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) {
              addNode({
                key: "",
                type: "class",
                control: e.target.value,
                media_type: "image",
              });
            }
          }}
        >
          <option value="">{app.t("blueprint.addNode")}…</option>
          {controlKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
    </div>
  );

  const renderObjects = (): JSX.Element => (
    <div className="panel-stack">
      {doc.nodes
        .filter((n) => n.type === "object")
        .map((n) => (
          <div key={n.key} className="row">
            <span className="dim mono">{n.key}</span>
            <select
              value={n.class ?? ""}
              onChange={(e) => updateNode(n.key, { class: e.target.value })}
            >
              <option value="">—</option>
              {classKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select
              value={n.scope ?? ""}
              onChange={(e) => updateNode(n.key, { scope: e.target.value })}
            >
              <option value="">—</option>
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button className="danger" onClick={() => removeNode(n.key)}>
              {app.t("blueprint.removeNode")}
            </button>
          </div>
        ))}
      <div className="row">
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) {
              addNode({
                key: "",
                type: "object",
                class: e.target.value,
                scope: "clicked",
              });
            }
          }}
        >
          <option value="">{app.t("blueprint.addNode")}…</option>
          {classKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
    </div>
  );

  const renderGroups = (): JSX.Element => (
    <div className="panel-stack">
      {doc.nodes
        .filter((n) => n.type === "group")
        .map((n) => (
          <div key={n.key} className="row">
            <span className="dim mono">{n.key}</span>
            <select
              value={n.mode ?? "exclusive"}
              onChange={(e) =>
                updateNode(n.key, {
                  mode: e.target.value as "exclusive" | "independent",
                })
              }
            >
              <option value="exclusive">
                {app.t("blueprint.mode.exclusive")}
              </option>
              <option value="independent">
                {app.t("blueprint.mode.independent")}
              </option>
            </select>
            <input
              value={(n.default_visible ?? []).join(",")}
              placeholder={app.t("blueprint.defaultVisible")}
              onChange={(e) =>
                updateNode(n.key, {
                  default_visible: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
            <input
              value={n.hide_direction ?? ""}
              placeholder={app.t("blueprint.hideDirection")}
              onChange={(e) =>
                updateNode(n.key, { hide_direction: e.target.value })
              }
            />
            <button className="danger" onClick={() => removeNode(n.key)}>
              {app.t("blueprint.removeNode")}
            </button>
          </div>
        ))}
      <div className="row">
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) {
              addNode({ key: "", type: "group", mode: "exclusive" });
            }
          }}
        >
          <option value="">{app.t("blueprint.addNode")}…</option>
          <option value="new">{app.t("blueprint.tab.groups")}</option>
        </select>
        <span className="dim">
          {HIDE_DIRECTIONS.join(" / ")} / toward:&lt;groupKey&gt;
        </span>
      </div>
    </div>
  );

  const renderRules = (): JSX.Element => (
    <div className="panel-stack">
      {doc.edges.map((e, i) => (
        <div key={`${e.from}-${e.kind}-${e.to}-${i}`} className="row">
          <span className="dim mono">
            {e.from} --{e.kind}--&gt; {e.to} #{e.order}
          </span>
          <button className="danger" onClick={() => removeEdge(i)}>
            {app.t("blueprint.removeNode")}
          </button>
        </div>
      ))}
      <div className="row">
        <select
          value={edgeDraft.from}
          onChange={(e) => {
            const from = e.target.value;
            setEdgeDraft((d) => ({
              ...d,
              from,
              to: "",
            }));
          }}
        >
          <option value="">{app.t("blueprint.from")}…</option>
          {[...eventKeys, ...conditionKeys].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select
          value={edgeDraft.kind}
          onChange={(e) =>
            setEdgeDraft((d) => ({
              ...d,
              kind: e.target.value as BlueprintEdge["kind"],
              to: "",
            }))
          }
        >
          {EDGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select
          value={edgeDraft.to}
          onChange={(e) =>
            setEdgeDraft((d) => ({ ...d, to: e.target.value }))
          }
        >
          <option value="">{app.t("blueprint.to")}…</option>
          {edgeToOptions(edgeDraft.kind, edgeDraft.from).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          type="number"
          value={edgeDraft.order}
          onChange={(e) =>
            setEdgeDraft((d) => ({ ...d, order: Number(e.target.value) }))
          }
        />
        <button
          disabled={!edgeDraft.from || !edgeDraft.to}
          onClick={() => {
            addEdge(edgeDraft);
            setEdgeDraft({ from: "", kind: "fires", to: "", order: 1 });
          }}
        >
          {app.t("blueprint.addNode")}
        </button>
      </div>
      <span className="dim">
        {app.t("blueprint.conditionExpr")}: {CONDITION_EXPR_HINTS.join("；")}
      </span>
    </div>
  );

  const renderJson = (): JSX.Element => (
    <div className="panel-stack">
      <textarea
        className="bp-json"
        spellCheck={false}
        value={jsonText}
        onChange={(e) => setJsonText(e.target.value)}
      />
      <div className="row">
        <button onClick={syncFromJson}>{app.t("blueprint.syncFromJson")}</button>
      </div>
    </div>
  );

  const TAB_RENDER: Record<Tab, () => JSX.Element> = {
    controls: renderControls,
    classes: renderClasses,
    objects: renderObjects,
    groups: renderGroups,
    rules: renderRules,
    json: renderJson,
  };

  return (
    <div className="panel bp-panel">
      {!repoId && (
        <span className="placeholder">{app.t("blueprint.selectRepo")}</span>
      )}
      {repoId && (
        <>
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
                <button
                  className="bp-item-main"
                  onClick={() => void select(it.id)}
                >
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
              <div className="row">
                <input
                  value={name}
                  placeholder={app.t("blueprint.namePlaceholder")}
                  onChange={(e) => setName(e.target.value)}
                />
                <button disabled={busy} onClick={() => void save()}>
                  {app.t("common.confirm")}
                </button>
                <button className="danger" onClick={() => void remove()}>
                  {app.t("blueprint.removeNode")}
                </button>
              </div>
              <div className="bp-tabs">
                {(
                  [
                    "controls",
                    "classes",
                    "objects",
                    "groups",
                    "rules",
                    "json",
                  ] as Tab[]
                ).map((tb) => (
                  <button
                    key={tb}
                    className={tab === tb ? "active" : ""}
                    onClick={() => setTab(tb)}
                  >
                    {app.t(`blueprint.tab.${tb}`)}
                  </button>
                ))}
              </div>
              <div className="bp-editor">{TAB_RENDER[tab]()}</div>
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
