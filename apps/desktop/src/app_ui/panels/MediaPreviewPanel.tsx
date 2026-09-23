/**
 * 媒体预览面板。
 *
 * 默认「预览图」视图：图像缩略图 / 视频首帧 / 音频波形（波纹图）；
 * 可切换为「文件名」列表视图。支持媒体类型筛选。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import { ContextMenu } from "../menu/ContextMenu";
import type { Translate } from "../i18n";
import type { FileItem, SourceItem } from "../shared/types";
import { drawWaveform, extractWaveform } from "../shared/waveform";

type ViewMode = "thumb" | "name";
type TypeFilter = "all" | "image" | "video" | "audio";

/** 跨挂载保存滚动位置：面板被 dockview 卸载重建时也能恢复浏览进度。 */
let savedThumbScroll = 0;
let savedNameScroll = 0;

/** 拼接本地绝对路径（按 base 的分隔符风格）。 */
function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  const normalized = rel.replace(/[\\/]/g, sep);
  return base.endsWith(sep) ? `${base}${normalized}` : `${base}${sep}${normalized}`;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 音频波形画布。 */
function AudioWaveform({ url, t }: { url: string; t: Translate }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void (async () => {
      try {
        const peaks = await extractWaveform(url, 72);
        if (!cancelled && ref.current) {
          drawWaveform(ref.current, peaks);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (failed) {
    return <span className="mp-fallback">{t("media.waveUnavailable")}</span>;
  }
  return <canvas ref={ref} className="mp-wave" />;
}

/** 缩略图 URL 缓存：fileId -> 已解析的 asset url（null=不可用）。 */
const thumbUrlCache = new Map<string, string | null>();
/** in-flight 请求去重：fileId -> 正在进行的 Promise，防止重复请求。 */
const thumbPromiseCache = new Map<string, Promise<string | null>>();

/** 解析文件缩略图 URL（命中缓存直接返回；否则发起请求并缓存结果）。 */
function resolveThumbUrl(
  repoId: string,
  fileId: string,
): Promise<string | null> {
  const cached = thumbUrlCache.get(fileId);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const inflight = thumbPromiseCache.get(fileId);
  if (inflight) {
    return inflight;
  }
  const promise = api
    .thumbGet({ repoId, fileId })
    .then((path): string | null => {
      const url = path ? convertFileSrc(path) : null;
      thumbUrlCache.set(fileId, url);
      thumbPromiseCache.delete(fileId);
      return url;
    })
    .catch((): null => {
      thumbUrlCache.set(fileId, null);
      thumbPromiseCache.delete(fileId);
      return null;
    });
  thumbPromiseCache.set(fileId, promise);
  return promise;
}

/**
 * 媒体缩略图单元。
 *
 * 使用 IntersectionObserver（rootMargin 200px）在接近视口时才：
 * - 图片/视频：请求并显示后端缓存的缩略图（而非原始全分辨率文件）；
 * - 音频：挂载波形组件并开始解码（而非一次性预解码全部音频）。
 * 离屏时显示占位符，节省网络与 CPU。
 */
function ThumbCell({
  file,
  repoId,
  url,
  selected,
  onSelect,
  onDoubleClick,
  onDragStart,
  onContextMenu,
  t,
}: {
  file: FileItem;
  repoId: string;
  url: string;
  selected: boolean;
  onSelect: (file: FileItem, mods: { shift: boolean; ctrl: boolean }) => void;
  onDoubleClick: () => void;
  /** 拖拽起始：父级负责写入 dataTransfer 载荷并按需更新选中集。 */
  onDragStart: (file: FileItem, e: DragEvent) => void;
  /** 右键菜单：父级负责定位、选中和渲染菜单。 */
  onContextMenu: (file: FileItem, e: MouseEvent) => void;
  /** 翻译函数（供占位/降级文案使用）。 */
  t: Translate;
}): JSX.Element {
  const cellRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);

  // 图片/视频需要请求缩略图 URL；音频走波形懒加载
  const needsThumb =
    file.media_type === "image" || file.media_type === "video";
  // undefined=尚未请求；null=请求了但不可用；string=已就绪
  const [thumbUrl, setThumbUrl] = useState<string | null | undefined>(
    undefined,
  );

  // 进入视口附近后标记可见（仅触发一次，随后断开观察器）
  useEffect(() => {
    const el = cellRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            obs.disconnect();
          }
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // 可见后请求缩略图（带模块级缓存 + in-flight 去重）
  useEffect(() => {
    if (!visible || !needsThumb) return;
    let cancelled = false;
    void resolveThumbUrl(repoId, file.id).then((resolved) => {
      if (!cancelled) setThumbUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, needsThumb, repoId, file.id]);

  return (
    <button
      ref={cellRef}
      className={`mp-cell ${selected ? "selected" : ""}`}
      draggable
      onClick={(e) =>
        onSelect(file, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
      }
      onDoubleClick={onDoubleClick}
      onDragStart={(e) => onDragStart(file, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(file, e);
      }}
      title={file.relative_path}
    >
      <div className="mp-thumb">
        {!url ? (
          <span className="mp-fallback">{t("media.noPath")}</span>
        ) : needsThumb ? (
          thumbUrl === undefined ? (
            <span className="mp-thumb-placeholder">{file.media_type}</span>
          ) : thumbUrl === null ? (
            <span className="mp-fallback">{t("media.unavailable")}</span>
          ) : (
            <img src={thumbUrl} alt={file.relative_path} loading="lazy" />
          )
        ) : visible ? (
          <AudioWaveform url={url} t={t} />
        ) : (
          <span className="mp-thumb-placeholder">audio</span>
        )}
      </div>
      <span className="mp-name">{fileName(file.relative_path)}</span>
    </button>
  );
}

/** 右键上下文菜单位置与目标文件。 */
interface ContextMenuState {
  x: number;
  y: number;
  file: FileItem;
}

export function MediaPreviewPanel(): JSX.Element {
  const app = useApp();
  const [viewMode, setViewMode] = useState<ViewMode>("thumb");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 右键上下文菜单状态（null=关闭）
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  // 内联重命名输入状态
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const load = useCallback(async () => {
    if (!app.repoId) {
      setFiles([]);
      setSources([]);
      return;
    }
    try {
      const [list, srcs] = await Promise.all([
        app.albumId
          ? api.albumMembers({ repoId: app.repoId, albumId: app.albumId })
          : api.fileQuery({
              repoId: app.repoId,
              sourceId: app.sourceId ?? undefined,
              dirPrefix: app.dirPath ?? undefined,
              mediaType: typeFilter === "all" ? undefined : typeFilter,
              limit: 300,
            }),
        api.sourceList({ repoId: app.repoId }),
      ]);
      setFiles(list);
      setSources(srcs);
    } catch (e) {
      app.status(app.t("media.loadFailed", { err: String(e) }), "error");
    }
  }, [app, typeFilter]);

  useEffect(() => {
    void load();
  }, [load, app.refreshKey]);

  // 缩略图视图：恢复并跟踪滚动位置（跨面板卸载重建）
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    el.scrollTop = savedThumbScroll;
    const onScroll = () => {
      savedThumbScroll = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewMode, app.repoId, files.length > 0]);

  // 列表视图：恢复并跟踪滚动位置
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = savedNameScroll;
    const onScroll = () => {
      savedNameScroll = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewMode, app.repoId, files.length > 0]);

  const sourceMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) {
      map.set(s.id, s.local_path);
    }
    return map;
  }, [sources]);

  const items = useMemo(
    () =>
      files.map((file) => {
        const base = sourceMap.get(file.source_id) ?? "";
        const full = base ? joinPath(base, file.relative_path) : "";
        return { file, url: full ? convertFileSrc(full) : "" };
      }),
    [files, sourceMap],
  );

  const repoId = app.repoId;
  const setSelectedIds = app.setSelectedIds;
  // Shift 范围选择的锚点（上一次点击项，随面板实例保存）。
  const anchorRef = useRef<string | null>(null);
  // selection_change 异步取 context 的过期令牌：只让最后一次选中上报生效。
  const selectionTokenRef = useRef(0);

  // 切换仓库或筛选（列表内容变化）时清空多选，避免残留失效选择。
  useEffect(() => {
    setSelectedIds(new Set());
    anchorRef.current = null;
  }, [app.repoId, typeFilter, setSelectedIds]);

  /**
   * 选中变化上报蓝图引擎（RFC 0007 实现期开放点）：`selection_change` 事件源，
   * 并携带 `rating >=` / `has_tag ==` 条件求值所需的运行时 context（评分 + 人工/自动 tag 名）。
   * context 是异步取的，故用令牌丢弃过期响应，避免快速切换选中时旧结果误触发规则。
   */
  const dispatchSelectionChange = useCallback(
    (file: FileItem) => {
      if (!app.repoId) {
        return;
      }
      const token = ++selectionTokenRef.current;
      const currentRepo = app.repoId;
      void (async () => {
        let rating: number | undefined;
        let tags: string[] | undefined;
        try {
          const [r, tagResult] = await Promise.all([
            api.ratingGet({ repoId: currentRepo, fileId: file.id }),
            api.tagForFile({ repoId: currentRepo, fileId: file.id }),
          ]);
          rating = r ?? undefined;
          tags = [...tagResult.manual, ...tagResult.auto].map((t) => t.name);
        } catch {
          // context 取不到时按缺失处理（rating/has_tag 条件求值为 false，不阻塞选中上报）。
        }
        if (token !== selectionTokenRef.current) {
          return;
        }
        app.dispatch({
          trigger: "selection_change",
          target: { mediaType: file.media_type, fileId: file.id },
          context: { rating, tags },
        });
      })();
    },
    [app],
  );

  /**
   * 点击选择：
   * - 无修饰：单选（清空其余）；
   * - Shift+左键：从锚点到当前项的连续范围多选（类似资源管理器）；
   * - Ctrl/Cmd+左键：切换单项选中。
   */
  const handleSelect = useCallback(
    (file: FileItem, mods: { shift: boolean; ctrl: boolean }) => {
      const next = new Set(app.selectedIds);
      // 锚点缺失（如面板重建）时回退到全局主选中项。
      const anchor = anchorRef.current ?? app.selectedFile?.id ?? null;
      if (mods.shift && anchor) {
        const from = items.findIndex((it) => it.file.id === anchor);
        const to = items.findIndex((it) => it.file.id === file.id);
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from];
          next.clear();
          for (let i = start; i <= end; i += 1) {
            next.add(items[i].file.id);
          }
          app.setSelectedIds(next);
          app.setSelectedFile(file);
          dispatchSelectionChange(file);
          return;
        }
      }
      if (mods.ctrl) {
        if (next.has(file.id)) {
          next.delete(file.id);
        } else {
          next.add(file.id);
        }
        anchorRef.current = file.id;
        app.setSelectedIds(next);
        app.setSelectedFile(file);
        dispatchSelectionChange(file);
        return;
      }
      anchorRef.current = file.id;
      app.setSelectedIds(new Set([file.id]));
      app.setSelectedFile(file);
      dispatchSelectionChange(file);
      // 单击事件上报蓝图引擎（默认蓝图无单击规则，行为不变；用户蓝图可响应）。
      app.dispatch({
        trigger: "click",
        target: { mediaType: file.media_type, fileId: file.id },
      });
    },
    [app, items, dispatchSelectionChange],
  );

  const selectedCount = useMemo(
    () => items.reduce((n, it) => (app.selectedIds.has(it.file.id) ? n + 1 : n), 0),
    [items, app.selectedIds],
  );

  // 右键菜单：点击外部或按 Esc 关闭（镜像 AlbumPanel / SourcePanel 模式）
  useEffect(() => {
    if (!menu) return;
    const close = () => {
      setMenu(null);
      setRenaming(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  /**
   * 拖拽起始：若拖拽项不在当前选中集合内，先单选它，
   * 再将选中集序列化为 dataTransfer 载荷。
   */
  const handleDragStart = useCallback(
    (file: FileItem, e: DragEvent) => {
      if (!app.selectedIds.has(file.id)) {
        app.setSelectedIds(new Set([file.id]));
        app.setSelectedFile(file);
      }
      // 载荷 = 拖拽后的选中集（单选时为 [file.id]，否则为现有选中集）
      const payload = app.selectedIds.has(file.id)
        ? [...app.selectedIds]
        : [file.id];
      e.dataTransfer.setData("application/x-hp-files", JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "copy";
    },
    [app],
  );

  /**
   * 右键菜单：未选中项先单选，已选中则保持多选；
   * 在光标位置打开自定义上下文菜单。
   */
  const handleContextMenu = useCallback(
    (file: FileItem, e: MouseEvent) => {
      e.preventDefault();
      if (!app.selectedIds.has(file.id)) {
        app.setSelectedIds(new Set([file.id]));
        app.setSelectedFile(file);
      }
      setMenu({ x: e.clientX, y: e.clientY, file });
    },
    [app],
  );

  /**
   * 删除选中文件：
   * - 相册上下文 → 移出相册（albumRemoveMember）；
   * - 源/目录上下文 → 移入系统回收站（fileTrash）。
   * 完成后清空选中集并刷新。
   */
  const handleDelete = useCallback(async () => {
    if (!app.repoId || app.selectedIds.size === 0) return;
    setMenu(null);
    const fileIds = [...app.selectedIds];
    try {
      if (app.albumId) {
        const r = await api.albumRemoveMember({
          repoId: app.repoId,
          albumId: app.albumId,
          fileIds,
        });
        app.status(app.t("media.removedFromAlbum", { count: r.removed }), "ok");
      } else {
        const n = await api.fileTrash({ repoId: app.repoId, fileIds });
        app.status(app.t("media.trashed", { count: n }), "ok");
      }
      app.setSelectedIds(new Set());
      app.refresh();
    } catch (e) {
      app.status(app.t("media.deleteFailed", { err: String(e) }), "error");
    }
  }, [app]);

  /** 确认内联重命名：调用 fileRename，成功后刷新。 */
  const confirmRename = useCallback(async () => {
    if (!menu || !app.repoId) return;
    const newName = renameValue.trim();
    if (!newName) {
      app.status(app.t("media.nameRequired"), "error");
      return;
    }
    try {
      await api.fileRename({
        repoId: app.repoId,
        fileId: menu.file.id,
        newName,
      });
      app.status(app.t("media.renamed"), "ok");
      app.refresh();
    } catch (e) {
      app.status(String(e), "error");
    }
    setRenaming(false);
    setMenu(null);
  }, [menu, renameValue, app]);

  /** 复制单个文件绝对路径到剪贴板。 */
  const copyPath = useCallback(async () => {
    if (!menu || !app.repoId) return;
    setMenu(null);
    try {
      const path = await api.filePath({
        repoId: app.repoId,
        fileId: menu.file.id,
      });
      await navigator.clipboard.writeText(path);
      app.status(app.t("media.pathCopied"), "ok");
    } catch (e) {
      app.status(app.t("media.pathCopyFailed", { err: String(e) }), "error");
    }
  }, [menu, app]);

  /** 重新分析单个文件（重算哈希 / 缩略图 / 媒体信息）。 */
  const reanalyze = useCallback(async () => {
    if (!menu || !app.repoId) return;
    setMenu(null);
    try {
      await api.fileReanalyze({
        repoId: app.repoId,
        fileId: menu.file.id,
      });
      app.status(app.t("media.reanalyzed"), "ok");
      app.refresh();
    } catch (e) {
      app.status(app.t("media.reanalyzeFailed", { err: String(e) }), "error");
    }
  }, [menu, app]);

  return (
    <div className="panel mp-panel">
      <div className="mp-toolbar">
        <div className="mp-toggle">
          <button
            className={viewMode === "thumb" ? "active" : ""}
            onClick={() => setViewMode("thumb")}
          >
            {app.t("media.viewThumb")}
          </button>
          <button
            className={viewMode === "name" ? "active" : ""}
            onClick={() => setViewMode("name")}
          >
            {app.t("media.viewName")}
          </button>
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
        >
          <option value="all">{app.t("media.filter.all")}</option>
          <option value="image">{app.t("media.filter.image")}</option>
          <option value="video">{app.t("media.filter.video")}</option>
          <option value="audio">{app.t("media.filter.audio")}</option>
        </select>
        <span className="mp-count">
          {selectedCount > 0
            ? app.t("media.selectedCount", {
                selected: selectedCount,
                total: items.length,
              })
            : app.t("media.itemCount", { count: items.length })}
        </span>
      </div>

      {!repoId && <span className="placeholder">{app.t("common.pleaseOpenRepo")}</span>}

      {repoId && viewMode === "thumb" && (
        <div
          className="mp-grid"
          ref={gridRef}
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
              e.preventDefault();
              app.setSelectedIds(new Set(items.map((it) => it.file.id)));
            } else if (e.key === "Escape") {
              app.setSelectedIds(new Set());
            } else if (e.key === "Delete" && app.selectedIds.size > 0) {
              e.preventDefault();
              void handleDelete();
            }
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              app.setSelectedIds(new Set());
              app.setSelectedFile(null);
            }
          }}
        >
          {items.map(({ file, url }) => (
            <ThumbCell
              key={file.id}
              file={file}
              repoId={repoId}
              url={url}
              selected={app.selectedIds.has(file.id)}
              onSelect={handleSelect}
              onDoubleClick={() =>
                app.dispatch({
                  trigger: "double_click",
                  target: { mediaType: file.media_type, fileId: file.id },
                })
              }
              onDragStart={handleDragStart}
              onContextMenu={handleContextMenu}
              t={app.t}
            />
          ))}
          {items.length === 0 && (
            <span className="placeholder">{app.t("media.noFiles")}</span>
          )}
        </div>
      )}

      {repoId && viewMode === "name" && (
        <div
          className="mp-list"
          ref={listRef}
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
              e.preventDefault();
              app.setSelectedIds(new Set(items.map((it) => it.file.id)));
            } else if (e.key === "Escape") {
              app.setSelectedIds(new Set());
            } else if (e.key === "Delete" && app.selectedIds.size > 0) {
              e.preventDefault();
              void handleDelete();
            }
          }}
        >
          {items.map(({ file }) => (
            <button
              key={file.id}
              className={`mp-row ${
                app.selectedIds.has(file.id) ? "selected" : ""
              }`}
              draggable
              onClick={(e) =>
                handleSelect(file, {
                  shift: e.shiftKey,
                  ctrl: e.ctrlKey || e.metaKey,
                })
              }
              onDoubleClick={() =>
                app.dispatch({
                  trigger: "double_click",
                  target: { mediaType: file.media_type, fileId: file.id },
                })
              }
              onDragStart={(e) => handleDragStart(file, e)}
              onContextMenu={(e) => {
                e.preventDefault();
                handleContextMenu(file, e);
              }}
            >
              <span className={`mp-badge ${file.media_type}`}>
                {file.media_type}
              </span>
              <span className="mp-row-name">{file.relative_path}</span>
              <span className="mp-row-size">{file.size}</span>
            </button>
          ))}
          {items.length === 0 && (
            <span className="placeholder">{app.t("media.noFiles")}</span>
          )}
        </div>
      )}

      {/* 右键上下文菜单 */}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y}>
          {renaming ? (
            <div className="menu-item-row">
              <input
                className="menu-input"
                value={renameValue}
                autoFocus
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void confirmRename();
                  } else if (e.key === "Escape") {
                    setRenaming(false);
                    setMenu(null);
                  }
                }}
              />
              <button
                className="menu-item small"
                onClick={() => void confirmRename()}
              >
                ✓
              </button>
            </div>
          ) : (
            <>
              {selectedCount === 1 && (
                <button
                  className="menu-item"
                  onClick={() => {
                    setRenaming(true);
                    setRenameValue(fileName(menu.file.relative_path));
                  }}
                >
                  {app.t("common.rename")}
                </button>
              )}
              {selectedCount === 1 && (
                <button
                  className="menu-item"
                  onClick={() => void copyPath()}
                >
                  {app.t("media.copyPath")}
                </button>
              )}
              {selectedCount === 1 && (
                <button
                  className="menu-item"
                  onClick={() => void reanalyze()}
                >
                  {app.t("media.reanalyzeFile")}
                </button>
              )}
              <div className="menu-sep" />
              <button
                className="menu-item danger"
                onClick={() => void handleDelete()}
              >
                {app.t("media.delete")}
              </button>
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
