/**
 * 图像查看器面板（`panel.imageviewer`）。
 *
 * 职责：把「当前选中的图像」放进一个可缩放/平移的画布，并把浏览上下文（胶片栏）与
 * 基础信息（信息栏）拼成一块面板。它**只消费**应用上下文里的选中项：
 * 切换图像走 `app.setSelectedFile`（与媒体预览面板同一份选中状态），不在这里另立会话状态。
 *
 * 面板设置（「全部设置 → 面板 → 图像查看器」，声明在 `packages/config/src/panels.ts`）：
 * - `navigatorEnabled` / `navigatorPosition`：导航器是否启用 + 停靠四角；
 * - `filmstripEnabled` / `filmstripPosition`：胶片栏是否启用 + 停靠四边；
 * - `filmstripSize`：胶片栏**厚度**（左右边 = 宽、上下边 = 高，**只设这一个是值**）；
 * - `filmstripView`：胶片栏视图——**自适应**（缺省，缩略图按图像宽高比完整显示）/ **平铺**（统一方形、裁剪填满）；
 * - `zoomAnchor`：滚轮缩放的**中心点**——缺省**指针位置**，可切到图像中心。
 *
 * 交互（与媒体播放器面板同一取向：不摆按钮、不写提示文字）：
 * - 滚轮 = 以设置的中心点缩放；超出舞台时按住左键拖动 = 平移；
 * - 方向键 / PageUp / PageDown = 上一张 / 下一张（顺序即胶片栏序列）；
 * - `Home` = 适应窗口，`1` = 100%（1:1）。
 *
 * 几何与格式化全在 `viewerZoom.ts` / `viewerFormat.ts` / `viewerPlacement.ts`
 * 的纯函数里，本文件只做状态编排；序列来源见 `useViewerSequence.ts`。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../../shared/api";
import { errorTextOf } from "../../shared/api/response";
import { useApp } from "../../core/AppContext";
import type { PanelRenderCtx } from "../../core/panelRegistry";
import { ViewerFilmstrip } from "./ViewerFilmstrip";
import { ViewerInfoBar } from "./ViewerInfoBar";
import { ViewerNavigator } from "./ViewerNavigator";
import { ViewerStage } from "./ViewerStage";
import { useViewerSequence } from "./useViewerSequence";
import { useViewerSettings } from "./useViewerSettings";
import { isFilmstripVertical, stepIndex } from "./viewerPlacement";
import {
  centerAnchor,
  centerOn,
  clampOffset,
  fitZoom,
  IDENTITY_TRANSFORM,
  isOverflowing,
  scaledSize,
  zoomAround,
  type Offset,
  type Size,
  type ViewTransform,
} from "./viewerZoom";

export interface ImageViewerPanelProps {
  /**
   * dockview 面板 API（可选）。
   *
   * 用途只有一个：面板从后台标签回到前台时补读一次设置——用户在后台标签期间改了设置，
   * 切回来必须已经生效。独立单面板窗口（`SinglePanelHost`）传的是恒激活替身，同样可用。
   */
  api?: PanelRenderCtx["api"];
}

export function ImageViewerPanel({ api: panelApi }: ImageViewerPanelProps = {}): JSX.Element {
  const app = useApp();
  const settings = useViewerSettings(panelApi);
  const sequence = useViewerSequence(app);

  const repoId = app.repoId;
  const file = app.selectedFile;
  const isImage = file?.media_type === "image";

  /** 图像 asset URL；`null` = 未加载（无选中/非图像/加载中）。 */
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /** 原图尺寸（`<img>` 解码后由舞台上报）。 */
  const [natural, setNatural] = useState<Size | null>(null);
  /** 舞台实测尺寸（缩放/夹紧/视口框都依赖它）。 */
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [transform, setTransform] = useState<ViewTransform>(IDENTITY_TRANSFORM);
  /** 已按"适应窗口"初始化过的图像标识：同一张图不因面板改尺寸而被重置缩放。 */
  const fittedRef = useRef<string | null>(null);
  /** 面板根节点：点击画布后把焦点交给它，键盘（上一张/下一张、适应窗口、1:1）才可达。 */
  const rootRef = useRef<HTMLDivElement>(null);
  /** 是否处于「适应窗口」模式：留在该模式时，面板改尺寸会跟着重新适应。 */
  const fitModeRef = useRef(true);
  /** 最新上下文（供只订阅一次的 effect 读取，避免闭包过期 / 依赖整个 `app` 对象）。 */
  const appRef = useRef(app);
  appRef.current = app;

  /**
   * 舞台尺寸上报：**尺寸没变就不换对象**。
   *
   * 舞台尺寸是"适应窗口"与平移夹紧的输入；若每次滚轮都把新对象塞进 state，
   * 尺寸相关 effect 会在每次缩放后空跑一遍（只多渲染，不影响结果）。
   */
  const updateViewport = useCallback((size: Size) => {
    setViewport((prev) =>
      prev.width === size.width && prev.height === size.height ? prev : size,
    );
  }, []);

  // 选中项变化 → 解析绝对路径；旧请求用令牌丢弃（快速切换不会串图）。
  useEffect(() => {
    setUrl(null);
    setFailed(false);
    setNatural(null);
    if (!repoId || !file || file.media_type !== "image") return;
    let cancelled = false;
    void (async () => {
      const ctx = appRef.current;
      try {
        const path = await api.filePath({ repoId, fileId: file.id });
        if (!cancelled) setUrl(convertFileSrc(path));
      } catch (e) {
        if (!cancelled) {
          setFailed(true);
          ctx.status(ctx.t("imageviewer.loadFailed", { err: errorTextOf(ctx.t, e) }), "error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, file?.id, file?.media_type]);

  // 尺寸就绪 → 首次「适应窗口」；此后：仍在适应模式则跟着改尺寸重新适应，
  // 否则只做平移夹紧（**不覆盖**用户的缩放）。
  useEffect(() => {
    if (!natural || viewport.width <= 0 || viewport.height <= 0) return;
    const token = url ?? "";
    if (fittedRef.current !== token) {
      fittedRef.current = token;
      fitModeRef.current = true;
    }
    if (fitModeRef.current) {
      setTransform({ zoom: fitZoom(natural, viewport), offset: { x: 0, y: 0 } });
      return;
    }
    setTransform((prev) => ({
      zoom: prev.zoom,
      offset: clampOffset(prev.offset, scaledSize(natural, prev.zoom), viewport),
    }));
  }, [natural, viewport, url]);

  /** 滚轮缩放：中心点按设置取"指针位置"（缺省）或舞台中心。 */
  const handleWheelZoom = useCallback(
    (factor: number, pointer: Offset, size: Size) => {
      if (!natural) return;
      updateViewport(size);
      // 用户一旦自己缩放就不再是"适应窗口"模式（改尺寸不覆盖其缩放）。
      fitModeRef.current = false;
      const anchor = settings.zoomAnchor === "pointer" ? pointer : centerAnchor(size);
      setTransform((prev) => zoomAround(prev, prev.zoom * factor, natural, size, anchor));
    },
    [natural, settings.zoomAnchor, updateViewport],
  );

  /** 导航器点击/拖动 → 把该点移到舞台正中。 */
  const handleNavigate = useCallback(
    (u: number, v: number) => {
      if (!natural) return;
      fitModeRef.current = false;
      setTransform((prev) => centerOn(prev, natural, viewport, u, v));
    },
    [natural, viewport],
  );

  /** 适应窗口 / 1:1。 */
  const applyFit = useCallback(() => {
    if (!natural) return;
    fitModeRef.current = true;
    setTransform({ zoom: fitZoom(natural, viewport), offset: { x: 0, y: 0 } });
  }, [natural, viewport]);

  const applyActualSize = useCallback(() => {
    if (!natural) return;
    fitModeRef.current = false;
    setTransform((prev) => zoomAround(prev, 1, natural, viewport, centerAnchor(viewport)));
  }, [natural, viewport]);

  /** 选中序列中的第 `index` 项（点击胶片栏 / 上一张下一张共用）。 */
  const selectIndex = useCallback(
    (index: number) => {
      const next = sequence.files[index];
      if (!next) return;
      app.setSelectedIds(new Set([next.id]));
      app.setSelectedFile(next);
    },
    [app, sequence.files],
  );

  const step = useCallback(
    (delta: number) => {
      const next = stepIndex(sequence.index, sequence.files.length, delta);
      if (next >= 0 && next !== sequence.index) selectIndex(next);
    },
    [selectIndex, sequence.files.length, sequence.index],
  );

  /** 键盘：上一张/下一张 + 适应窗口 + 1:1。 */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
      case "PageUp":
        event.preventDefault();
        step(-1);
        return;
      case "ArrowRight":
      case "ArrowDown":
      case "PageDown":
        event.preventDefault();
        step(1);
        return;
      case "Home":
        event.preventDefault();
        applyFit();
        return;
      case "1":
        event.preventDefault();
        applyActualSize();
        return;
      default:
    }
  };

  const totalBytes = useMemo(
    () => sequence.files.reduce((sum, item) => sum + (item.size || 0), 0),
    [sequence.files],
  );
  /** 图像已超出舞台 → 可拖动平移、且需要导航器。 */
  const pannable = natural !== null && isOverflowing(transform, natural, viewport);
  const showNavigator = settings.navigatorEnabled && Boolean(url) && natural !== null && pannable;
  const stackFilmstrip =
    settings.filmstripEnabled && !isFilmstripVertical(settings.filmstripPosition);

  const placeholder = !repoId
    ? app.t("common.pleaseOpenRepo")
    : !file
      ? app.t("common.noSelection")
      : !isImage
        ? app.t("imageviewer.imageOnly")
        : failed
          ? app.t("imageviewer.unavailable")
          : app.t("common.loading");

  return (
    <div
      ref={rootRef}
      className={`panel iv-panel${stackFilmstrip ? " iv-stack" : ""}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        // 点击画布即把键盘焦点交给面板（`<div>` 不会因子元素被点击而自动获得焦点）；
        // 胶片栏单元是 `<button>`，点它们时**不抢**焦点，避免键盘操作被面板吞掉。
        // `preventScroll` 防止聚焦把面板滚进视口引起跳动。
        if ((event.target as HTMLElement).closest("button")) return;
        rootRef.current?.focus({ preventScroll: true });
      }}
    >
      <div className="iv-main">
        <ViewerStage
          url={isImage && !failed ? (url ?? "") : ""}
          alt={file?.relative_path ?? ""}
          natural={natural}
          transform={transform}
          pannable={pannable}
          onWheelZoom={handleWheelZoom}
          onNatural={setNatural}
          onFailed={() => {
            setFailed(true);
            setUrl(null);
            app.status(app.t("imageviewer.unavailable"), "error");
          }}
          onViewport={updateViewport}
          onTransform={setTransform}
          placeholder={<span className="placeholder">{placeholder}</span>}
          overlay={
            showNavigator && url && natural ? (
              <ViewerNavigator
                url={url}
                natural={natural}
                viewport={viewport}
                transform={transform}
                corner={settings.navigatorPosition}
                onCenter={handleNavigate}
              />
            ) : undefined
          }
        />
        <ViewerInfoBar
          file={file}
          index={sequence.index}
          total={sequence.files.length}
          totalBytes={totalBytes}
          truncated={sequence.truncated}
          natural={natural}
          zoom={transform.zoom}
          t={app.t}
        />
      </div>

      {/*
        胶片栏只要有序列就渲染（**不要求已选中图像**）：
        它本身就是"当前相册/源"的浏览入口，点缩略图即选中；也正因如此，
        「启用胶片栏」「胶片栏位置」「胶片栏尺寸」三项设置在任何时候都能立刻看出效果。
      */}
      {settings.filmstripEnabled && repoId && (
        <ViewerFilmstrip
          edge={settings.filmstripPosition}
          repoId={repoId}
          files={sequence.files}
          index={sequence.index}
          size={settings.filmstripSize}
          view={settings.filmstripView}
          onSelect={selectIndex}
          ariaLabel={app.t("imageviewer.filmstrip")}
        />
      )}
    </div>
  );
}
