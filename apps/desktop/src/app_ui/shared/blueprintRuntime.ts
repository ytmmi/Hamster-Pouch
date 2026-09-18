/**
 * 蓝图运行时装配（RFC 0007「运行时集成」）。
 *
 * 职责：
 * 1. **生效蓝图标识**：记住当前仓库激活的蓝图（默认蓝图，或套用布局时绑定的蓝图）；
 * 2. **装载**：从仓库读取该蓝图 → 解析 → 交给 `BlueprintEngine`；
 * 3. **热更新**：订阅后端 `blueprint.changed`（保存/新建/删除/设默认/模板安装）与
 *    窗口内本地变更通知，重新装载并把蓝图语义对账到当前 dockview 布局；
 * 4. **对账入口**：套用布局 / 语言切换等引起布局或渲染变化时重新对账。
 *
 * 与 `layout.*` 的关系：布局管位置/大小/分组结构基准（D1），本模块只把蓝图叠加的
 * 显隐/默认可见/组收起语义套到现有布局上（D29）。
 */

import {
  DEFAULT_BLUEPRINT,
  effectiveLayers,
  isObsoleteDefaultBlueprint,
  type BlueprintGraph,
} from "@hamster-pouch/config";
import type { DockviewApi } from "dockview-react";

import * as api from "./api";
import { BlueprintEngine, blueprintEngine } from "../core/blueprintEngine";
import { reconcileLayout, resetLayoutReconcileState, setLayoutReconcileLogger } from "./blueprintLayout";
import { normalizeLayoutJson } from "./panelLayout";
import {
  publishBlueprintRevision,
  readBlueprintRevision,
  subscribeBlueprintRevision,
} from "./blueprintRevision";

/** 内置默认蓝图在仓库中的名称（种子时使用；与 i18n「默认蓝图」一致）。 */
const DEFAULT_BLUEPRINT_NAME = "默认蓝图";

/** 生效蓝图装载结果：`loaded=false` 表示指定蓝图不可用（消费层可回退默认）。 */
export interface LoadedBlueprint {
  graph: BlueprintGraph;
  loaded: boolean;
}

/**
 * 装载链路所需的蓝图命令子集（默认走 Tauri `invoke`；可注入以便脱离宿主验证
 * 装载/升级/回退链路本身）。
 */
export interface BlueprintLoadApi {
  blueprintGet(args: { repoId: string; blueprintId: string }): Promise<string | null>;
  blueprintGetDefault(args: { repoId: string }): Promise<string | null>;
  blueprintList(args: { repoId: string }): Promise<{ id: string; name: string; is_default: boolean }[]>;
  blueprintCreate(args: {
    repoId: string;
    name: string;
    blueprintJson?: string;
  }): Promise<{ id: string; name: string; is_default: boolean }>;
  blueprintSave(args: {
    repoId: string;
    blueprintId: string;
    name?: string;
    blueprintJson: string;
  }): Promise<unknown>;
  blueprintSetDefault(args: { repoId: string; blueprintId: string }): Promise<void>;
}

/** 当前生效蓝图（仓库默认，或套用布局时绑定的蓝图）。 */
let activeId: string | null = null;
let activeGraph: BlueprintGraph | null = null;
/** 本窗口内蓝图已保存但后端事件未到达时的兜底通知（非 Tauri 运行时同样可用）。 */
let localRevision = 0;
/** 同时进行的装载去重（种子默认蓝图时后端会广播 `blueprint.changed`，避免重复装载）。 */
let inflight: Promise<LoadedBlueprint> | null = null;
/** 已装载文档的指纹（轮询安全网用于判断"库里是否已经变了"）。 */
let activeDigest: string | null = null;

/** 文档指纹：长度 + 节点/边数量（足够区分变更，避免与装载路径重复解析）。 */
function digestOf(json: string, parsed: BlueprintGraph): string {
  return `${json.length}:${parsed.nodes.length}:${parsed.edges.length}`;
}

const LOCAL_EVENT = "hp-blueprint-local-changed";

/**
 * 诊断日志（追加到应用数据目录 `debug.log`）：仅用于定位**打包运行**下的
 * 装载/升级链路问题，不影响业务结果（失败静默）。链路稳定后可整体保留不动，
 * 因为它只在关键分支打印少量行。
 */
function trace(message: string): void {
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("debug_log", { message }))
    .catch(() => undefined);
}

/** 供编辑器/布局模块复用的诊断打点（同 `trace`，语义化别名）。 */
export const traceBlueprint = trace;

// 模块装载即打点：区分"前端没跑到蓝图链路"与"跑到了但分支不对"。
trace(`[blueprint] runtime module imported at ${new Date().toISOString()} hw=${navigator.hardwareConcurrency}`);

/** 当前生效蓝图 ID（列表刷新、状态展示用）。 */
export function activeBlueprintId(): string | null {
  return activeId;
}

/** 当前生效蓝图图文档。 */
export function activeBlueprintGraph(): BlueprintGraph | null {
  return activeGraph;
}

/**
 * 指定生效蓝图（`null` = 回到仓库默认蓝图）；不触发装载，只更新标识。
 * 套用布局绑定蓝图时调用，并显式 `setGraph` 后 `reconcile`。
 */
export function setActiveBlueprintId(id: string | null): void {
  activeId = id;
}

/** 把图文档装入引擎（缺省回退内置默认蓝图）；同时记录文档指纹供轮询安全网比对。 */
function activate(graph: BlueprintGraph | null, digest?: string): BlueprintGraph {
  activeGraph = graph ?? DEFAULT_BLUEPRINT;
  if (digest) {
    activeDigest = digest;
  }
  blueprintEngine.setGraph(activeGraph);
  // 当前层随生效蓝图变化：仍存在则保留，否则回退第一个层（D54）。
  const layers = effectiveLayers(activeGraph);
  if (!activeLayer || !layers.some((l) => l.key === activeLayer)) {
    activeLayer = layers[0]?.key ?? null;
  }
  blueprintEngine.setLayer(activeLayer);
  return activeGraph;
}

// 引擎诊断日志接入统一诊断通道（排查"某操作为何仍有/没有联动"）。
blueprintEngine.setLogger(trace);
setLayoutReconcileLogger(trace);

/**
 * 装载生效蓝图（指定 id 或仓库默认）；无默认时补种内置默认（保证零回归）。
 * 旧版内置默认蓝图按 `default_version` 静默升级为新版，不保留旧模式兼容。
 */
export async function loadActiveBlueprint(
  repoId: string,
  blueprintId?: string | null,
  apiImpl: BlueprintLoadApi = api,
): Promise<LoadedBlueprint> {
  if (inflight) {
    return inflight;
  }
  inflight = loadActiveBlueprintInner(repoId, blueprintId, apiImpl).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function loadActiveBlueprintInner(
  repoId: string,
  blueprintId: string | null | undefined,
  client: BlueprintLoadApi,
): Promise<LoadedBlueprint> {
  setActiveBlueprintId(blueprintId ?? null);
  try {
    let doc = blueprintId
      ? await client.blueprintGet({ repoId, blueprintId })
      : await client.blueprintGetDefault({ repoId });
    trace(
      `[blueprint] load repo=${repoId} requested=${blueprintId ?? "(default)"} doc=${doc ? doc.length : "null"}`,
    );
    if (!doc && !blueprintId) {
      // 无默认蓝图：以内置默认补种（默认蓝图是运行时行为来源，必须存在）。
      const created = await client.blueprintCreate({
        repoId,
        name: DEFAULT_BLUEPRINT_NAME,
        blueprintJson: JSON.stringify(DEFAULT_BLUEPRINT),
      });
      await client.blueprintSetDefault({ repoId, blueprintId: created.id });
      doc = await client.blueprintGetDefault({ repoId });
      trace(`[blueprint] seeded default id=${created.id}`);
    }
    if (!doc) {
      trace("[blueprint] no doc → built-in default (not loaded)");
      return { graph: activate(null), loaded: false };
    }
    const parsed = BlueprintEngine.parse(doc);
    if (!parsed) {
      trace("[blueprint] parse failed → built-in default");
      return { graph: activate(null), loaded: false };
    }
    const digest = digestOf(doc, parsed);
    if (isObsoleteDefaultBlueprint(parsed)) {
      // 旧库存内置默认蓝图 → 升级为新版内置默认（不保留旧模式兼容）。
      // 必须落库：否则下次装载又从库里读回旧的，表现为"默认蓝图永远没更新"。
      const list = await client.blueprintList({ repoId });
      const def = list.find((i) => i.is_default);
      trace(
        `[blueprint] obsolete v${parsed.default_version} → upgrade; list=${list.length} default=${def?.id ?? "none"}`,
      );
      if (def) {
        await client.blueprintSave({
          repoId,
          blueprintId: def.id,
          name: def.name,
          blueprintJson: JSON.stringify(DEFAULT_BLUEPRINT),
        });
        trace(`[blueprint] upgraded default persisted id=${def.id}`);
      } else if (!blueprintId) {
        // 默认标记缺失（异常库存）：补种内置默认并设为默认，保证运行时行为来源存在。
        const created = await client.blueprintCreate({
          repoId,
          name: DEFAULT_BLUEPRINT_NAME,
          blueprintJson: JSON.stringify(DEFAULT_BLUEPRINT),
        });
        await client.blueprintSetDefault({ repoId, blueprintId: created.id });
        trace(`[blueprint] re-seeded default id=${created.id}`);
      }
      return { graph: activate(DEFAULT_BLUEPRINT, digest), loaded: true };
    }
    trace(`[blueprint] loaded doc v=${parsed.default_version ?? "-"} nodes=${parsed.nodes.length}`);
    return { graph: activate(parsed, digest), loaded: true };
  } catch (e) {
    trace(`[blueprint] load failed repo=${repoId}: ${String(e)}`);
    return { graph: activate(null), loaded: false };
  }
}

/** 把当前生效蓝图对账到 dockview 布局（保存后/套用布局后/语言变化后调用）。 */
export function reconcileActiveBlueprint(dv: DockviewApi | null): void {
  reconcileLayout(activeGraph, dv);
  // 浮层的**初始显隐**也要对账（过去只在事件动作里显隐，导致 `visible: true` 的浮层
  // 内容永远不出现）。放在布局对账之后、按当前层执行。
  if (activeGraph) {
    blueprintEngine.applyOverlayDefaults(activeGraph, activeLayer);
  }
}

/** 套用布局：清空收起尺寸记忆后重新对账（布局基准已变，旧记忆失效）。 */
export function reconcileAfterLayoutApplied(dv: DockviewApi | null): void {
  resetLayoutReconcileState();
  reconcileLayout(activeGraph, dv);
  if (activeGraph) {
    blueprintEngine.applyOverlayDefaults(activeGraph, activeLayer);
  }
}

// ============================== 当前层（D53/D54） ==============================

/** 当前层 key（按仓库持久化；本进程内缓存，供布局保存/套用使用）。 */
let activeLayer: string | null = null;

/** 当前层 key（未装载时为 null）。 */
export function currentLayerKey(): string | null {
  return activeLayer;
}

/** 指定当前层（只更新标识，不触发装载/套用布局）。 */
export function setCurrentLayerKey(layerKey: string | null): void {
  activeLayer = layerKey;
  blueprintEngine.setLayer(layerKey);
}

/** 生效蓝图的有效层清单（含单层兜底）。 */
export function activeLayers() {
  return activeGraph ? effectiveLayers(activeGraph) : [];
}

/**
 * 装载某仓库的当前层（D54）：优先读取持久化记录；记录缺失或已不在生效蓝图里时，
 * 回退到生效蓝图的第一个层。返回最终当前层 key（无蓝图时为 null）。
 */
export async function loadCurrentLayer(repoId: string): Promise<string | null> {
  const layers = activeGraph ? effectiveLayers(activeGraph) : [];
  let key: string | null = null;
  try {
    key = await api.blueprintCurrentLayerGet(repoId);
  } catch {
    key = null;
  }
  if (!key || !layers.some((l) => l.key === key)) {
    key = layers[0]?.key ?? null;
  }
  setCurrentLayerKey(key);
  trace(`[layer] 当前层 repo=${repoId} layer=${key ?? "-"} layers=${layers.length}`);
  return key;
}

/**
 * 套用某一层的布局（D53：每层一份布局）：读取默认布局在该层的快照并套用，
 * 然后按蓝图语义对账一次（D54：切层时目标层按自身结构对账一次）。
 *
 * 该层没有专属布局行时返回 `false`（保持当前布局不动）；布局损坏时同样返回 `false`。
 */
export async function applyLayerLayout(
  repoId: string,
  layerKey: string,
  dv: DockviewApi | null,
): Promise<boolean> {
  if (!dv) {
    return false;
  }
  try {
    const name = await api.layoutGetDefault({ repoId });
    if (!name) {
      return false;
    }
    const raw = await api.layoutGet({ repoId, name, layerKey });
    if (!raw) {
      return false;
    }
    dv.fromJSON(normalizeLayoutJson(JSON.parse(raw)));
    reconcileAfterLayoutApplied(dv);
    return true;
  } catch (e) {
    trace(`[layer] 套用层布局失败 repo=${repoId} layer=${layerKey}: ${String(e)}`);
    return false;
  }
}

/**
 * 切换当前层（D54）：持久化记录 → 套用该层布局 → 对账蓝图语义。幂等（已在该层则无操作）。
 * 供编辑器的层切换与引擎的 `navigate`（界面跳转）共用。
 */
export async function switchLayer(
  repoId: string,
  layerKey: string,
  dv: DockviewApi | null,
): Promise<boolean> {
  const same = activeLayer === layerKey;
  setCurrentLayerKey(layerKey);
  try {
    await api.blueprintCurrentLayerSet(repoId, layerKey);
  } catch {
    /* 持久化失败不影响本次切换 */
  }
  trace(`[layer] 切层 repo=${repoId} → ${layerKey}（${same ? "重入" : "切换"}）`);
  const applied = await applyLayerLayout(repoId, layerKey, dv);
  if (!applied) {
    // 该层没有专属布局：只按蓝图语义对账一次，避免显隐/收起状态漂移。
    reconcileActiveBlueprint(dv);
  }
  return applied;
}

/**
 * 广播「蓝图已变更」（保存后立即热更新）。
 *
 * 同时做三件事，保证**任何窗口**（含主窗口与独立面板窗口）都能自行收敛：
 * 1. 本窗口事件（最快）；
 * 2. 跨窗口令牌 `blueprintRevision`（绑在共享宿主对象 + localStorage 上）；
 * 3. 后端 `blueprint.changed` 会由命令层广播（此处不重复）。
 *
 * 传入保存后的蓝图 id 与图文档时，令牌可携带指纹供其他窗口直接判断是否需要重载。
 */
export function notifyBlueprintChangedLocally(input?: {
  id?: string;
  graph?: BlueprintGraph;
}): void {
  localRevision += 1;
  if (input?.id && input.graph) {
    const rev = publishBlueprintRevision({ id: input.id, graph: input.graph });
    trace(
      `[hot] 本窗口已保存蓝图 ${input.id}（nodes=${input.graph.nodes.length} rev=${rev.at}）→ 广播热更新`,
    );
  } else {
    trace(`[hot] 本窗口蓝图已变更（local rev=${localRevision}）→ 广播热更新`);
  }
  try {
    window.dispatchEvent(new Event(LOCAL_EVENT));
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/**
 * 订阅蓝图变更 → 重新装载生效蓝图 → 对账布局（热更新到布局上）。
 *
 * 三条**互相独立**的触发路径（任何一条可用即热更新成立；蓝图面板可能开在独立窗口，
 * 所以不能只依赖本窗口广播）：
 * 1. 本窗口保存通知（`LOCAL_EVENT`，最快）；
 * 2. 跨窗口令牌 `blueprintRevision`（共享宿主对象/localStorage，保存方无需知道谁在听）；
 * 3. 后端事件 `blueprint.changed`；
 * 外加一条轮询安全网：定期比对"库里默认蓝图指纹"与本窗口已装载指纹，不一致就重载
 * （前三条若因宿主环境失效，热更新最迟在一个轮询周期内生效）。
 *
 * 返回取消订阅函数。
 */
export function subscribeBlueprintHotReload(
  getRepoId: () => string | null,
  getDockview: () => DockviewApi | null,
): () => void {
  // 进函数即打点：区分"这个订阅根本没被调用"与"调用了但后续路径没工作"。
  trace(`[hot] 订阅蓝图热更新（window=${typeof window} doc=${typeof document} ls=${typeof localStorage}）`);
  try {
    return subscribeBlueprintHotReloadInner(getRepoId, getDockview);
  } catch (e) {
    trace(`[hot] 热更新订阅初始化失败: ${String(e)}`);
    return () => undefined;
  }
}

function subscribeBlueprintHotReloadInner(
  getRepoId: () => string | null,
  getDockview: () => DockviewApi | null,
): () => void {
  let lastSeen = localRevision;
  let lastTokenAt = 0;
  let unlisten: (() => void) | null = null;
  let unsubscribeToken: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const reload = async (reason: string) => {
    const repoId = getRepoId();
    trace(`[hot] reload 触发 reason=${reason} repo=${repoId ?? "-"} active=${activeId ?? "(default)"}`);
    if (!repoId) {
      return;
    }
    const requestedId = activeId;
    const primary = await loadActiveBlueprint(repoId, requestedId);
    // 生效蓝图被删除/损坏 → 回退仓库默认蓝图（RFC 0007：加载无效文档时回退内置默认）。
    if (!primary.loaded && requestedId) {
      await loadActiveBlueprint(repoId, null);
    }
    reconcileActiveBlueprint(getDockview());
  };

  const onLocal = () => {
    if (localRevision === lastSeen) {
      return;
    }
    lastSeen = localRevision;
    void reload("local");
  };
  window.addEventListener(LOCAL_EVENT, onLocal);

  // 路径 2：跨窗口令牌（共享 document 自定义事件 / localStorage）。
  try {
    unsubscribeToken = subscribeBlueprintRevision((rev) => {
      if (rev.at <= lastTokenAt) {
        return;
      }
      lastTokenAt = rev.at;
      void reload(`token:${rev.id}`);
    });
    const initial = readBlueprintRevision();
    if (initial) {
      lastTokenAt = initial.at;
    }
    trace("[hot] 已订阅跨窗口令牌");
  } catch (e) {
    trace(`[hot] 跨窗口令牌订阅失败: ${String(e)}`);
  }

  // 路径 3：后端事件（跨窗口/跨命令的权威变更源；非 Tauri 运行时静默忽略）。
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<{ repoId: string; blueprintId?: string | null }>("blueprint.changed", (e) => {
        trace(`[hot] blueprint.changed 到达：payload=${JSON.stringify(e.payload)}`);
        const repoId = getRepoId();
        if (!repoId || e.payload.repoId !== repoId) {
          trace(
            `[hot] blueprint.changed 忽略：当前仓库=${repoId ?? "-"} 事件仓库=${e.payload.repoId}`,
          );
          return;
        }
        void reload(`backend:${e.payload.blueprintId ?? "-"}`);
      }),
    )
    .then((un) => {
      if (disposed) {
        un();
        return;
      }
      unlisten = un;
      trace("[hot] 已订阅后端 blueprint.changed");
    })
    .catch(() => undefined);

  // 安全网：定期比对"库里默认蓝图指纹"与"已装载指纹"，不一致则重载。
  // 这让热更新不依赖任何事件桥接是否工作（独立窗口保存后最迟一个周期内生效）。
  timer = setInterval(() => {
    void (async () => {
      const repoId = getRepoId();
      if (!repoId || disposed) {
        return;
      }
      try {
        const doc = activeId
          ? await api.blueprintGet({ repoId, blueprintId: activeId })
          : await api.blueprintGetDefault({ repoId });
        if (!doc) {
          return;
        }
        const parsed = BlueprintEngine.parse(doc);
        if (!parsed) {
          return;
        }
        const digest = digestOf(doc, parsed);
        if (activeDigest !== null && digest !== activeDigest) {
          trace(`[hot] 轮询发现文档变更（${activeDigest} → ${digest}）`);
          void reload("poll");
        }
      } catch {
        /* 轮询失败忽略（仓库未打开/命令不可用） */
      }
    })();
  }, POLL_INTERVAL_MS);

  return () => {
    disposed = true;
    window.removeEventListener(LOCAL_EVENT, onLocal);
    unsubscribeToken?.();
    unsubscribeToken = null;
    unlisten?.();
    unlisten = null;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** 指纹轮询周期（安全网；正常路径是事件驱动，这里是兜底）。 */
const POLL_INTERVAL_MS = 1500;
