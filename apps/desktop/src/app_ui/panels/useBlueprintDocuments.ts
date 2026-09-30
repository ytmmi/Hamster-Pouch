/**
 * 蓝图文档的后端命令（RFC 0007「前端编辑器」）。
 *
 * 一个域：编辑器对 `api.blueprint*` 的读写——列表与模板列表的装载、选中装载文档、
 * 校验后保存、新建（可带当前布局的结构骨架）、从模板创建、删除、设为默认、
 * 恢复内置默认、位置静默持久化。
 *
 * 不渲染界面：编辑状态由 `useBlueprintEditorState` 持有，作为参数传入；本文件只负责
 * 命令语义（服务端校验失败不落库、保存后广播本地热更新、列表随之刷新）。
 * 静默保存同样归一化分层，避免"文档已分层但节点缺 layer"被后端拒绝。
 */

import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_BLUEPRINT,
  effectiveLayers,
  forUserSave,
  makeEmptyBlueprint,
  normalizeLayersForSave,
  type BlueprintGraph,
} from "@hamster-pouch/config";
import type {
  BlueprintItem,
  BlueprintTemplateItem,
} from "@hamster-pouch/shared-types";

import { useApp } from "../core/AppContext";
import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import {
  currentLayerKey,
  notifyBlueprintChangedLocally,
  setCurrentLayerKey,
  traceBlueprint,
} from "../shared/blueprintRuntime";
import { normalizePositions } from "./blueprintSlots";
import {
  readStructure,
  snapshotFromDockview,
  structureBlueprint,
} from "./blueprintStructure";
import type { BlueprintEditorState } from "./useBlueprintEditorState";

/** 蓝图文档命令（返回值即界面用的回调）。 */
export interface BlueprintDocuments {
  /** 本仓库蓝图列表。 */
  items: BlueprintItem[];
  /** 全局蓝图模板列表（读不到时为空）。 */
  templates: BlueprintTemplateItem[];
  load: () => Promise<void>;
  select: (id: string) => Promise<void>;
  save: () => Promise<void>;
  create: () => Promise<void>;
  createFromTemplate: (tplId: string) => Promise<void>;
  remove: () => Promise<void>;
  setDefault: (blueprintId: string) => Promise<void>;
  restoreBuiltin: () => Promise<void>;
  /** 静默持久化整文档（节点位置拖拽结束/一键整理后自动保存，不打扰用户）。 */
  persistDoc: (next: BlueprintGraph) => void;
}

export function useBlueprintDocuments(state: BlueprintEditorState): BlueprintDocuments {
  const app = useApp();
  const [items, setItems] = useState<BlueprintItem[]>([]);
  const [templates, setTemplates] = useState<BlueprintTemplateItem[]>([]);

  const {
    doc,
    setDoc,
    setJsonText,
    name,
    setName,
    newName,
    setNewName,
    selectedId,
    setSelectedId,
    setSelectedKey,
    setErrors,
    setBusy,
    withStructure,
    setLayerKey,
    mutate,
  } = state;

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
      app.status(app.t("blueprint.loadFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  }, [repoId, app, setItems, setTemplates, setSelectedId]);

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
          // 自动补齐坐标属于**装载期归一化**，不是用户编辑：必须保留内置默认标记
          // （`default_version`），否则"打开一次编辑器"就会把库存默认蓝图变成用户图、
          // 从而永久失去自动升级（RFC 0007：只有用户保存才移除该标记）。
          void api
            .blueprintSave({
              repoId,
              blueprintId: id,
              name: items.find((i) => i.id === id)?.name,
              blueprintJson: JSON.stringify(normalizeLayersForSave(normalized)),
            })
            .catch(() => undefined);
        }
        setDoc(normalized);
        setJsonText(JSON.stringify(normalized, null, 2));
        setSelectedId(id);
        setName(items.find((i) => i.id === id)?.name ?? "");
        setSelectedKey(null);
        setErrors([]);
        // 当前层（D54）：优先沿用运行时记录；失效则取该蓝图的第一个层。
        const available = effectiveLayers(normalized);
        const wanted = currentLayerKey();
        const nextLayer =
          wanted && available.some((l) => l.key === wanted)
            ? wanted
            : available[0]?.key ?? null;
        setLayerKey(nextLayer);
        setCurrentLayerKey(nextLayer);
      } catch (e) {
        app.status(app.t("blueprint.loadFailed", { err: errorTextOf(app.t, e) }), "error");
      }
    },
    [
      repoId,
      items,
      app,
      setDoc,
      setJsonText,
      setSelectedId,
      setName,
      setSelectedKey,
      setErrors,
      setLayerKey,
    ],
  );

  /** 校验并保存整文档（显式保存）。 */
  const save = useCallback(async () => {
    if (!repoId || !selectedId) {
      return;
    }
    setBusy(true);
    try {
      // 保存前归一化分层（D51/D58）：把兜底单层实体化进 `layers` 并给节点补 `layer`，
      // 否则后端会以"文档已分层但节点缺 layer"拒绝保存。
      const prepared = normalizeLayersForSave(doc);
      const result = await api.blueprintValidate({
        repoId,
        blueprintJson: JSON.stringify(prepared),
      });
      if (result.errors.length > 0) {
        setErrors(result.errors);
        app.status(
          app.t("blueprint.invalidNotSaved", { err: result.errors.join("；") }),
          "error",
        );
        return;
      }
      // 服务端软告警（未接通）：不阻塞保存，但要让使用者知道哪些节点不生效。
      if (result.warnings?.length) {
        app.status(
          app.t("blueprint.serverWarnings", { count: result.warnings.length }),
          "info",
        );
      }
      await api.blueprintSave({
        repoId,
        blueprintId: selectedId,
        name: name.trim() || undefined,
        // 用户保存 = 不再是内置默认：去掉 default_version，停止自动升级覆盖。
        blueprintJson: JSON.stringify(forUserSave(prepared)),
      });
      mutate(prepared);
      setErrors([]);
      app.status(app.t("blueprint.saved"), "ok");
      // 热更新：广播"已保存"（本窗口 + 跨窗口令牌），任何窗口都会重载并把语义
      // 对账到当前布局——无需手动重开面板或重启应用。
      notifyBlueprintChangedLocally({ id: selectedId, graph: prepared });
      app.refresh();
      void load();
    } catch (e) {
      app.status(app.t("blueprint.saveFailed", { err: errorTextOf(app.t, e) }), "error");
    } finally {
      setBusy(false);
    }
  }, [
    repoId,
    selectedId,
    doc,
    name,
    app,
    load,
    mutate,
    setBusy,
    setErrors,
  ]);

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
      app.status(app.t("blueprint.createFailed", { err: errorTextOf(app.t, e) }), "error");
    } finally {
      setBusy(false);
    }
  }, [
    repoId,
    newName,
    app,
    load,
    select,
    withStructure,
    setBusy,
    setName,
    setNewName,
  ]);

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
          app.t("blueprint.templateInstallFailed", { err: errorTextOf(app.t, e) }),
          "error",
        );
      } finally {
        setBusy(false);
      }
    },
    [repoId, load, select, app, setBusy],
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
      app.status(app.t("blueprint.deleteFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  }, [
    repoId,
    selectedId,
    app,
    load,
    setSelectedId,
    setSelectedKey,
    setDoc,
    setJsonText,
    setName,
  ]);

  /**
   * 设为默认蓝图。**必须显式传入目标 id**：点击"★"时 `selectedId` 还是上一个选中项
   * （`select` 是异步的），读 state 会把默认蓝图设到错误的蓝图行上。
   */
  const setDefault = useCallback(
    async (blueprintId: string) => {
      if (!repoId) {
        return;
      }
      try {
        await api.blueprintSetDefault({ repoId, blueprintId });
        app.status(app.t("blueprint.defaultSet"), "ok");
        // 默认蓝图变更 = 运行时生效蓝图变更 → 立即热更新。
        notifyBlueprintChangedLocally();
        await load();
      } catch (e) {
        app.status(app.t("blueprint.defaultFailed", { err: errorTextOf(app.t, e) }), "error");
      }
    },
    [repoId, app, load],
  );

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
      app.status(app.t("blueprint.restoreFailed", { err: errorTextOf(app.t, e) }), "error");
    } finally {
      setBusy(false);
    }
  }, [
    repoId,
    selectedId,
    name,
    app,
    mutate,
    load,
    setBusy,
    setErrors,
  ]);

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
          // 位置静默保存同样归一化分层，避免"文档已分层但节点缺 layer"被后端拒绝。
          blueprintJson: JSON.stringify(forUserSave(normalizeLayersForSave(next))),
        })
        .catch(() => undefined);
    },
    [repoId, selectedId, name],
  );

  return {
    items,
    templates,
    load,
    select,
    save,
    create,
    createFromTemplate,
    remove,
    setDefault,
    restoreBuiltin,
    persistDoc,
  };
}
