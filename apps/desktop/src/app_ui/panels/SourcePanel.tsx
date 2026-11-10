/**
 * 媒体源组件 — 添加媒体源（选取文件夹）+ 已添加媒体源目录树（右键操作）。
 *
 * 添加流程：点「添加媒体源」→ 原生对话框选取文件夹 → 以**文件夹名为默认源名称**挂载；
 * 别名不在添加时填写，只能在添加后于条目上重命名。
 */

import { Fragment, useCallback, useEffect, useRef, useState, type JSX } from "react";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { useApp } from "../core/AppContext";
import { getTask, setTask, useTask } from "../core/taskStore";
import { ContextMenu } from "../menu/ContextMenu";
import { SwitchToggle } from "../shared/SwitchToggle";
import { MarkMenuTree, usePanelMarks } from "./markMenu";
import { marksOf } from "../shared/panelMarks";
import type { SourceExclusionItem, SourceTreeNode } from "../shared/types";

/** 取路径最后一段文件夹名。 */
function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 路径比较：同一文件夹只应挂载一次（Windows 路径忽略大小写，统一分隔符与末尾斜杠）。 */
function samePath(a: string, b: string): boolean {
  const isWindowsPath = (p: string) => p.includes("\\") || /^[A-Za-z]:/.test(p);
  const normalize = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const na = normalize(a);
  const nb = normalize(b);
  if (isWindowsPath(a) || isWindowsPath(b)) {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/** 文件夹图标（内联 SVG，currentColor）。 */
function FolderIcon(): JSX.Element {
  return (
    <svg
      className="tree-folder-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z" />
    </svg>
  );
}

/** 展开箭头（内联 SVG，currentColor；展开时旋转 90°）。 */
function ChevronIcon(): JSX.Element {
  return (
    <svg
      className="tree-chevron-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** 路径文本：过长省略尾部；悬停时滚轮可水平滚动查看完整路径。 */
function PathText({ path }: { path: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth > el.clientWidth) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <span ref={ref} className="source-path" title={path}>
      {path}
    </span>
  );
}

interface ContextMenuState {
  x: number;
  y: number;
  sourceId: string;
  /** 右键目标相对路径：源根为 null，子文件夹为该节点 relative_path。 */
  relativePath: string | null;
  /** 右键目标显示名（用于「复制为相册」的相册名）。 */
  name: string;
}

/** 递归移除指定 source_id 的节点（卸载后本地即时更新）。 */
function removeBySourceId(
  nodes: SourceTreeNode[],
  sourceId: string,
): SourceTreeNode[] {
  return nodes
    .filter((n) => n.source_id !== sourceId)
    .map((n) => ({ ...n, children: removeBySourceId(n.children, sourceId) }));
}

export function SourcePanel(): JSX.Element {
  const app = useApp();
  const { t } = app;
  // 任务进度走独立 store：进度变化只重渲染本面板与浮窗，不再波及所有面板
  const task = useTask();
  const [nodes, setNodes] = useState<SourceTreeNode[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  // 右键菜单内「添加标记」子菜单开关（D134）
  const [openMarkSub, setOpenMarkSub] = useState(false);
  // 被排除的子目录清单（D149）：源根右键「取消排除」是否显示由它决定
  const [exclusions, setExclusions] = useState<SourceExclusionItem[]>([]);
  // 「取消排除」清单弹窗的目标源；null = 不显示
  const [unexcludeFor, setUnexcludeFor] = useState<string | null>(null);
  // 清单弹窗里勾选的相对目录（默认全选：这是"还原"操作，一步到位更顺手）
  const [unexcludeChecked, setUnexcludeChecked] = useState<Set<string>>(new Set());
  // 本面板内的打标状态：与相册面板**各存一份**，自定义标记互不可见（用户口径）
  const { marks, persist: persistMarks } = usePanelMarks(app.repoId);

  const load = useCallback(async () => {
    if (!app.repoId) {
      setNodes([]);
      setExclusions([]);
      return;
    }
    try {
      // 排除清单与目录树一起取：右键菜单要按它决定「取消排除」是否出现，
      // 分两次请求会出现"树里没了、菜单里还没认"的中间态。
      const [tree, excluded] = await Promise.all([
        api.sourceTree({ repoId: app.repoId }),
        api.sourceExclusions({ repoId: app.repoId }),
      ]);
      setNodes(tree);
      setExclusions(excluded.items);
    } catch (e) {
      app.status(app.t("source.treeFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
  }, [load, app.refreshKey]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  /**
   * 右键目标节点的打标键（D134）：与后端 `commands/source.rs` 生成的节点 key **同口径**——
   * 源根 `src:<sourceId>`，子目录 `dir:<sourceId>/<relativePath>`。
   *
   * 为什么复用节点 key 而不是另造一套：树里的持久化坐标本来就是它，另造一套要维护
   * 两份"同一节点的身份"，重命名/移动源之后必然分家。
   */
  const markTargetKey = (sourceId: string, relativePath: string | null): string =>
    relativePath === null ? `src:${sourceId}` : `dir:${sourceId}/${relativePath}`;

  // 点击任意处关闭右键菜单
  useEffect(() => {
    if (!menu) {
      return;
    }
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);

  // 扫描事件订阅已上移到应用层（core/AppUiApp → core/ScanOverlay）：
  // 进度浮窗与"完成即刷新"不再依赖本面板是否挂载。

  /**
   * 添加媒体源：选取文件夹 → 以文件夹名为默认名称挂载。
   * 不在添加时填别名（别名只能添加后在条目上重命名）。
   */
  const addSource = async () => {
    if (!app.repoId) {
      app.status(t("common.pleaseOpenRepo"), "error");
      return;
    }
    let picked: string | null;
    try {
      picked = await api.pickFolder(t("source.pickFolderTitle"));
    } catch (e) {
      app.status(t("source.pickFailed", { err: errorTextOf(app.t, e) }), "error");
      return;
    }
    if (!picked) {
      return; // 用户取消
    }
    // 同一文件夹只挂载一次：已添加则直接选中，避免重复条目
    const existing = nodes.find(
      (n) => n.local_path !== null && samePath(n.local_path, picked),
    );
    if (existing?.source_id) {
      app.setSourceId(existing.source_id);
      app.setDirPath(null);
      app.setAlbumId(null);
      app.status(t("source.alreadyAdded", { name: existing.name }), "info");
      return;
    }
    const name = baseName(picked);
    try {
      const s = await api.sourceMount({ repoId: app.repoId, localPath: picked });
      // 立即入列，避免等待刷新
      setNodes((prev) =>
        prev.some((n) => n.source_id === s.id)
          ? prev
          : [
              ...prev,
              {
                key: `src:${s.id}`,
                name: s.alias ?? name,
                local_path: s.local_path,
                relative_path: null,
                source_id: s.id,
                file_count: 0,
                children: [],
              },
            ],
      );
      app.status(t("source.added", { name: s.alias ?? name }), "ok");
      app.refresh();
    } catch (e) {
      app.status(t("source.mountFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /** 开始重命名已添加媒体源的别名（添加时不可填）。 */
  const beginRename = (node: SourceTreeNode) => {
    setMenu(null);
    setRenameId(node.source_id);
    setRenameValue(node.name);
  };

  /** 提交别名重命名。 */
  const commitRename = async () => {
    if (!app.repoId || !renameId) return;
    const alias = renameValue.trim();
    if (!alias) {
      app.status(t("source.renameEmpty"), "error");
      return;
    }
    try {
      await api.sourceRename({ repoId: app.repoId, sourceId: renameId, alias });
      setNodes((prev) =>
        prev.map((n) => (n.source_id === renameId ? { ...n, name: alias } : n)),
      );
      app.status(t("source.renamed", { name: alias }), "ok");
      setRenameId(null);
      setRenameValue("");
      app.refresh();
    } catch (e) {
      app.status(t("source.renameFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  // 重命名输入框自动聚焦
  useEffect(() => {
    if (renameId) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renameId]);

  /**
   * 卸载媒体源：先取影响预估 → 弹出警告（与进度浮窗同款）告知**不可恢复**的后果 →
   * 确认后在后台执行（带进度浮窗）。源在标记离线后立即从列表消失。
   */
  const unmount = async (sourceId: string) => {
    if (!app.repoId) return;
    const node = nodes.find((n) => n.source_id === sourceId);
    const name = node?.name ?? sourceId;

    let preview: Awaited<ReturnType<typeof api.sourceUnmountPreview>>;
    try {
      preview = await api.sourceUnmountPreview({ repoId: app.repoId, sourceId });
    } catch (e) {
      app.status(t("source.unmountFailed", { err: errorTextOf(app.t, e) }), "error");
      return;
    }

    const confirmed = await app.askConfirm({
      title: t("unmount.confirmTitle", { name }),
      message: t("unmount.confirmBody", {
        files: preview.file_count,
        tags: preview.tag_count,
        ratings: preview.rating_count,
        colors: preview.color_count,
        members: preview.member_count,
        albums: preview.albums.length,
      }),
      warning: t("unmount.confirmWarn"),
      details: preview.albums.map((a) => `${a.name}（${a.members}）`),
      detailsTitle:
        preview.albums.length > 0
          ? t("unmount.confirmDetails", { count: preview.albums.length })
          : undefined,
      confirmLabel: t("common.unmount"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (!confirmed) return;

    // 卸载的正是当前选中源时清掉选中，避免媒体预览停在一个已离线的源上
    if (app.sourceId === sourceId) {
      app.setSourceId(null);
      app.setDirPath(null);
    }
    // 立即挂上进度浮窗（后端第一帧进度到达前也要有反馈）
    // `taskId` 此刻还不知道（命令尚未返回）；浮窗按 `taskId` 空值禁用控制按钮，
    // 第一帧进度事件（带 taskId）到达后即可按任务操作。
    setTask({
      titleKey: "unmount.title",
      taskId: "",
      sourceId,
      subtitle: name,
      messageKey: "unmount.preparing",
      messageParams: {},
      processed: 0,
      total: 0,
      current: null,
      // 卸载可取消：后端的清理循环在相册之间采样取消标志，不会把界面锁死
      cancellable: true,
      // 卸载不可暂停：清理循环没有暂停点
      pausable: false,
      updatedAt: Date.now(),
    });

    try {
      await api.sourceUnmount({ repoId: app.repoId, sourceId });
      // 完成/失败由事件驱动（taskStore 会收尾并刷新）
    } catch (e) {
      setTask(null);
      app.status(t("source.unmountFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /** 该源当前是否有被排除的子文件夹（源根右键「取消排除」的显示条件）。 */
  const hasExclusions = (sourceId: string): boolean =>
    exclusions.some((e) => e.source_id === sourceId);

  /**
   * 排除子文件夹（D149，**软排除**）：把它连同全部后代从目录树与媒体库视图里藏起来，
   * 一行数据都不删。
   *
   * 为什么不直接复刻卸载：卸载会 `purge_source_data` 把索引/标签/评分/相册成员一起
   * 抹掉，是不可恢复的；排除只写一张 `source_exclusion` 表，标签评分原地不动，
   * 「取消排除」即刻原样回来——两者的确认文案也必须如实区分，别让用户以为能反悔。
   */
  const excludeDir = async (sourceId: string, relativePath: string, name: string) => {
    if (!app.repoId) return;
    const confirmed = await app.askConfirm({
      title: t("source.excludeConfirmTitle", { name }),
      message: t("source.excludeConfirmBody"),
      warning: t("source.excludeConfirmWarn"),
      confirmLabel: t("source.exclude"),
      cancelLabel: t("common.cancel"),
      // 不标 danger：这是可逆的软排除（数据一行不删），红色危险按钮会和
      // 上面"不会删除任何数据"的提示自相矛盾。真正危险的「卸载」才用红色。
    });
    if (!confirmed) return;
    try {
      const res = await api.sourceExclude({ repoId: app.repoId, sourceId, relativePath });
      setExclusions(res.items);
      // 当前选中的目录（或它的上级）刚被排除时清掉选中：媒体库视图里已经没有这些行了
      if (
        app.sourceId === sourceId &&
        app.dirPath !== null &&
        (app.dirPath === relativePath || app.dirPath.startsWith(`${relativePath}/`))
      ) {
        app.setDirPath(null);
      }
      app.status(t("source.excluded", { name }), "info");
      // 目录树要重新取：被排除的子树立即消失（含祖先节点的文件数变化）
      await load();
    } catch (e) {
      app.status(t("source.excludeFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /** 打开「取消排除」清单弹窗（逐个勾选恢复，默认全选）。 */
  const openUnexcludeDialog = (sourceId: string) => {
    const items = exclusions.filter((e) => e.source_id === sourceId);
    if (items.length === 0) return;
    setUnexcludeChecked(new Set(items.map((e) => e.relative_path)));
    setUnexcludeFor(sourceId);
  };

  /**
   * 取消排除：`all` = 全部恢复（忽略勾选），否则只恢复勾中的那些。
   * 恢复后台会重新出现在目录树里——数据从未离开，所以这里不存在"重建"开销。
   */
  const restoreExclusions = async (all: boolean) => {
    if (!app.repoId || !unexcludeFor) return;
    const sourceId = unexcludeFor;
    const items = exclusions.filter((e) => e.source_id === sourceId);
    const picked = (all ? items : items.filter((e) => unexcludeChecked.has(e.relative_path))).map(
      (e) => e.relative_path,
    );
    if (picked.length === 0) {
      app.status(t("source.unexcludeNothing"), "info");
      return;
    }
    try {
      const res = await api.sourceUnexclude({
        repoId: app.repoId,
        sourceId,
        relativePaths: picked,
      });
      setUnexcludeFor(null);
      app.status(t("source.unexcluded", { count: res.removed }), "info");
      await load();
    } catch (e) {
      app.status(t("source.unexcludeFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /**
   * 发起扫描。进度与完成事件由应用层集中订阅并渲染居中浮窗
   * （见 `core/TaskOverlay.tsx`），面板只负责发起与提示。
   */
  const scan = async (sourceId: string, full: boolean) => {
    if (!app.repoId) return;
    if (getTask()) {
      app.status(t("task.busy"), "info");
      return;
    }
    const name = nodes.find((n) => n.source_id === sourceId)?.name ?? null;
    try {
      // 扫描命令返回 taskId：立刻用它挂浮窗，取消/暂停从第一帧起就能按任务定位（缺陷 0003）
      const taskId = await api.sourceScan({ repoId: app.repoId, sourceId, full });
      // 立刻置为"遍历中、总数未知"：后端第一帧进度可能还要等一会儿才到
      setTask({
        titleKey: "scan.title",
        taskId,
        sourceId,
        subtitle: name,
        messageKey: "scan.walking",
        messageParams: { count: 0 },
        processed: 0,
        total: 0,
        current: null,
        cancellable: true,
        // 扫描是唯一支持暂停/恢复的长任务
        pausable: true,
        updatedAt: Date.now(),
      });
      app.status(t("source.scanStarted"), "info");
    } catch (e) {
      app.status(t("source.scanStartFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /**
   * 创建为相册（仅当前对象）：把当前源/目录下**已有**的对象一次性复制成固定型相册。
   *
   * 快照语义（D128）：创建后不再跟随源，之后新增/删除的文件都不会影响这个相册；
   * 需要持续跟随请用 {@link createSyncAlbum}。
   */
  const createSnapshotAlbum = async (
    sourceId: string,
    relativePath: string | null,
    name: string,
  ) => {
    if (!app.repoId) return;
    try {
      const r = await api.albumCreateSnapshot({
        repoId: app.repoId,
        name,
        // 新建相册默认「无限制」（D139，与相册面板的新建同口径）：
        // 显式传值而不是留空，免得"按继承算"在将来顶层默认值变化时行为漂移。
        mediaType: "unlimited",
        sourceId,
        relativePath,
        includeSubsources: false,
      });
      app.status(t("source.createdAsAlbum", { name }), "ok");
      app.setAlbumId(r.album_id);
      app.setSourceId(null);
      app.refresh();
    } catch (e) {
      app.status(t("source.createAsAlbumFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /**
   * 创建为同步相册：建立持续跟随该源的相册，并按源目录层级自动维护镜像子相册（D128）。
   *
   * 同步时"只增不删"：源里新出现的对象自动加入；用户手动移除的对象记入排除表，
   * 后续同步不再加回（尊重手动编辑）。
   */
  const createSyncAlbum = async (
    sourceId: string,
    relativePath: string | null,
    name: string,
  ) => {
    if (!app.repoId) return;
    try {
      const r = await api.albumCreateSync({
        repoId: app.repoId,
        name,
        // 新建相册默认「无限制」（D139）：同步相册的媒体属性同时决定同步规则拉哪些文件，
        // `unlimited` 与 `multimedia` 的可收集合同为三种媒体，因此不改变同步结果。
        mediaType: "unlimited",
        sourceId,
        relativePath,
      });
      await api.albumSync({ repoId: app.repoId, albumId: r.album_id });
      app.status(t("source.createdAsSyncAlbum", { name }), "ok");
      app.setAlbumId(r.album_id);
      app.setSourceId(null);
      app.refresh();
    } catch (e) {
      app.status(t("source.createSyncAlbumFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /** 递归渲染目录树节点。 */
  const renderNode = (
    node: SourceTreeNode,
    depth: number,
    ownerSourceId: string,
  ): JSX.Element => {
    const isSource = node.source_id !== null;
    const expanded = !collapsed.has(node.key);
    const hasChildren = node.children.length > 0;
    const indent = depth * 14;
    // 重命名只针对源根节点（改名即改媒体源别名）。
    const renaming = isSource && renameId === node.source_id;
    const selected = isSource
      ? app.sourceId === node.source_id && app.dirPath === null
      : app.sourceId === ownerSourceId && app.dirPath === node.relative_path;

    return (
      <Fragment key={node.key}>
        <div className="tree-node-wrap">
          <div
            className={`tree-node list-row${selected ? " selected" : ""}`}
            style={{ paddingLeft: indent }}
            onClick={
              renaming
                ? undefined
                : () => {
                    if (isSource) {
                      app.setSourceId(node.source_id!);
                      app.setDirPath(null);
                    } else {
                      app.setSourceId(ownerSourceId);
                      app.setDirPath(node.relative_path);
                    }
                    app.setAlbumId(null);
                    // 上报蓝图引擎（D138）：源面板此前**完全不上报**，与相册面板同一缺口
                    // ——「源类目 → 对象 → 标记 → 操作」在运行时求值不到。
                    // `mediaType` 写字面量 `"source"`：类目节点的类型取值域是
                    // `sources:[unlimited, source, empty]`（`blueprintNodes.ts`），源行
                    // 本身没有 media_type 可透传；这份上报与 `AlbumPanel` 的 `"album"`
                    // 是同一条契约的两半（面板身份 > 行内数据）。
                    // `fileId` 复用**节点 key**：它与右键菜单 `markTargetKey()` 以及后端
                    // `commands/source.rs` 生成的 key 三方同源（`src:<id>` /
                    // `dir:<id>/<rel>`），不另造身份。对象节点把 `scope` 写成具体 key
                    // 即可精确命中某个源/目录（RFC 0007 决策 1）。
                    // `marks` 取本面板 `sources` 域打在该节点上的标记；源面板不传派生
                    // （派生标记由相册的媒体属性推出，源没有该属性，D134）。
                    app.dispatch({
                      trigger: "click",
                      target: {
                        mediaType: "source",
                        fileId: node.key,
                        marks: marksOf(marks, "sources", node.key),
                      },
                    });
                  }
            }
            onContextMenu={(e) => {
              e.preventDefault();
              // 每次右键都重置子菜单展开态：不重置会让上一次展开的「添加标记」
              // 在新位置凭空跟着一起打开（菜单对象换了、开关还是旧的 true）。
              setOpenMarkSub(false);
              if (isSource) {
                // 源根节点：右键同步选中，不切换预览
                app.setSourceId(node.source_id!);
                app.setDirPath(null);
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  sourceId: node.source_id!,
                  relativePath: null,
                  name: node.name,
                });
              } else {
                // 子文件夹节点：右键也打开同一菜单，sourceId 取所属源
                app.setSourceId(ownerSourceId);
                app.setDirPath(node.relative_path);
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  sourceId: ownerSourceId,
                  relativePath: node.relative_path,
                  name: node.name,
                });
              }
            }}
          >
            <span
              className={`tree-arrow${hasChildren ? "" : " is-empty"}${
                expanded ? " on" : ""
              }`}
              onClick={(e) => {
                e.stopPropagation();
                if (hasChildren) {
                  toggle(node.key);
                }
              }}
            >
              {hasChildren ? <ChevronIcon /> : null}
            </span>
            <span className="tree-folder">
              <FolderIcon />
            </span>
            {renaming ? (
              // 重命名只改「已添加媒体源」的别名，源路径不变
              <span className="rename-row" onClick={(e) => e.stopPropagation()}>
                <input
                  ref={renameRef}
                  className="menu-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void commitRename();
                    } else if (e.key === "Escape") {
                      setRenameId(null);
                    }
                  }}
                />
                <button className="menu-item small" onClick={() => void commitRename()}>
                  {"\u2713"}
                </button>
                <button
                  className="menu-item small"
                  onClick={() => setRenameId(null)}
                  title={t("common.cancel")}
                >
                  {"\u2715"}
                </button>
              </span>
            ) : (
              <span className="source-name">{node.name}</span>
            )}
            <span className="tree-count">{node.file_count}</span>
          </div>

          {isSource && node.local_path && (
            <div className="tree-path" style={{ paddingLeft: indent + 28 }}>
              <PathText path={node.local_path} />
            </div>
          )}
        </div>

        {expanded &&
          hasChildren &&
          node.children.map((child) =>
            renderNode(child, depth + 1, ownerSourceId),
          )}
      </Fragment>
    );
  };

  return (
    <div className="panel">
      {!app.repoId && (
        <span className="placeholder">{t("common.pleaseOpenRepo")}</span>
      )}
      {app.repoId && (
        <>
          {/* 添加媒体源：选取文件夹，源名称默认取文件夹名 */}
          <button className="menu-item" onClick={() => void addSource()}>
            {t("source.add")}
          </button>

          {/* 扫描进度改由应用层居中浮窗显示（core/ScanOverlay.tsx），面板不再内嵌进度条 */}

          {/* 已添加的媒体源目录树（右键操作） */}
          <div className="section-title">
            {t("source.list")}（{nodes.length}）
          </div>
          <div className="list source-list">
            {nodes.map((n) => renderNode(n, 0, n.source_id!))}
            {nodes.length === 0 && (
              <span className="placeholder">{t("source.noSource")}</span>
            )}
          </div>

          {/* 右键上下文菜单 */}
          {menu && (
            <ContextMenu x={menu.x} y={menu.y}>
              <button
                className="menu-item"
                disabled={task !== null}
                onClick={() => {
                  void scan(menu.sourceId, false);
                  setMenu(null);
                }}
              >
                {t("common.scan")}
              </button>
              <button
                className="menu-item"
                disabled={task !== null}
                onClick={() => {
                  void scan(menu.sourceId, true);
                  setMenu(null);
                }}
              >
                {t("common.fullScan")}
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item"
                onClick={() => {
                  void createSnapshotAlbum(menu.sourceId, menu.relativePath, menu.name);
                  setMenu(null);
                }}
              >
                {t("source.copyAsAlbum")}
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  void createSyncAlbum(menu.sourceId, menu.relativePath, menu.name);
                  setMenu(null);
                }}
              >
                {t("source.createSyncAlbum")}
              </button>

              {/* 添加标记：子菜单（树状系统标记 + 本面板自定义标记，默认全折叠，D134） */}
              <div className="menu-sep" />
              <button
                className="menu-item has-sub"
                onClick={() => setOpenMarkSub((v) => !v)}
              >
                {t("mark.add")} <span className="sub-arrow">{openMarkSub ? "▾" : "▸"}</span>
              </button>
              {openMarkSub && (
                <div className="menu-sub">
                  <MarkMenuTree
                    scope="sources"
                    targetKey={markTargetKey(menu.sourceId, menu.relativePath)}
                    marks={marks}
                    onPersist={persistMarks}
                    onClose={() => setMenu(null)}
                  />
                </div>
              )}
              {menu.relativePath === null ? (
                <>
                  <div className="menu-sep" />
                  {/* 别名只能在添加之后修改 */}
                  <button
                    className="menu-item"
                    onClick={() => {
                      const node = nodes.find((n) => n.source_id === menu.sourceId);
                      if (node) {
                        beginRename(node);
                      } else {
                        setMenu(null);
                      }
                    }}
                  >
                    {t("common.rename")}
                  </button>
                  {/* 只有该源确有被排除的子文件夹时才出现（用户口径：没有就不显示） */}
                  {hasExclusions(menu.sourceId) && (
                    <>
                      <div className="menu-sep" />
                      <button
                        className="menu-item"
                        onClick={() => {
                          openUnexcludeDialog(menu.sourceId);
                          setMenu(null);
                        }}
                      >
                        {t("source.unexclude")}
                      </button>
                    </>
                  )}
                  <div className="menu-sep" />
                  <button
                    className="menu-item danger"
                    onClick={() => {
                      void unmount(menu.sourceId);
                      setMenu(null);
                    }}
                  >
                    {t("common.unmount")}
                  </button>
                </>
              ) : (
                <>
                  <div className="menu-sep" />
                  {/* 子文件夹的「排除」＝软化版的卸载：隐藏而不删数据，随时可还原（D149） */}
                  <button
                    className="menu-item"
                    onClick={() => {
                      const relativePath = menu.relativePath;
                      // 菜单只在子文件夹上渲染这一项；TS 在回调里丢掉了收窄，这里补一次判定
                      if (relativePath === null) {
                        setMenu(null);
                        return;
                      }
                      const name = menu.name;
                      setMenu(null);
                      void excludeDir(menu.sourceId, relativePath, name);
                    }}
                  >
                    {t("source.exclude")}
                  </button>
                </>
              )}
            </ContextMenu>
          )}

          {/* 「取消排除」清单弹窗：逐个勾选恢复（复用任务浮窗的遮罩/卡片样式） */}
          {unexcludeFor && (
            <div className="task-overlay" onClick={() => setUnexcludeFor(null)}>
              <div className="task-card exclude-card" onClick={(e) => e.stopPropagation()}>
                <div className="task-title">{t("source.unexcludeTitle")}</div>
                <div className="exclude-hint">{t("source.unexcludeHint")}</div>
                <div className="exclude-list">
                  {exclusions
                    .filter((e) => e.source_id === unexcludeFor)
                    .map((e) => (
                      // 容器必须是 `<span>`：`<label>` 不得包住可交互元素，
                      // 勾选框走宿主统一的胶囊开关（原生复选框在 app_ui 内被 check:settings 禁止）
                      <span key={e.relative_path} className="exclude-row">
                        <SwitchToggle
                          checked={unexcludeChecked.has(e.relative_path)}
                          theme={app.theme}
                          label={e.relative_path}
                          onChange={(next) => {
                            setUnexcludeChecked((prev) => {
                              const picked = new Set(prev);
                              if (next) {
                                picked.add(e.relative_path);
                              } else {
                                picked.delete(e.relative_path);
                              }
                              return picked;
                            });
                          }}
                        />
                        <span className="exclude-path" title={e.relative_path}>
                          {e.relative_path}
                        </span>
                      </span>
                    ))}
                </div>
                <div className="task-actions">
                  <button className="menu-item" onClick={() => void restoreExclusions(false)}>
                    {t("source.unexcludeSelected")}
                  </button>
                  <button className="menu-item" onClick={() => void restoreExclusions(true)}>
                    {t("source.unexcludeAll")}
                  </button>
                  <button className="menu-item" onClick={() => setUnexcludeFor(null)}>
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
