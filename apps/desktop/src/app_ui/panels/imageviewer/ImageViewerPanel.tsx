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
 * **按键可达性（2026-10-07）**：键盘处理挂在面板根节点上，因此**先要有焦点**。
 * 两条入口都必须成立：
 *
 * 1. **从其他面板进入**（蓝图双击图像 → `focusPanel` → `panel.api.setActive()`）：
 *    程序激活**不会**自动把 DOM 焦点移过来（焦点还在原面板上），根节点的
 *    `onKeyDown` 于是收不到方向键。本面板订阅 `onDidActiveChange` /
 *    `onDidVisibilityChange`，成为**激活且可见**的面板时按 `shouldTakeViewerFocus`
 *    的判据把焦点拿到根节点（正在输入 / 模态浮层 / 标签条键盘导航都不抢）。
 * 2. **在图像查看器面板内点击**：`onPointerDown` 把焦点交给根节点
 *    （胶片栏的 `<button>` 不抢，避免键盘操作被面板吞掉）。
 *
 * 几何与格式化全在 `viewerZoom.ts` / `viewerFormat.ts` / `viewerPlacement.ts`
 * 的纯函数里，按键映射与焦点判据在 `viewerKeymap.ts`，本文件只做状态编排；
 * 序列来源见 `useViewerSequence.ts`。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  resolveDateFormat,
  resolveDateShowTime,
  resolveSizeUnit,
  SETTING_KEYS,
} from "@hamster-pouch/config";

import { errorTextOf } from "../../shared/api/response";
import { useApp } from "../../core/AppContext";
import type { PanelRenderCtx } from "../../core/panelRegistry";
import { resolveImageUrlOutcome } from "../../shared/imageUrl";
import { needsPreview, resolvePreviewUrl } from "../../shared/previewUrl";
import { usePanelForeground } from "../../shared/panelForeground";
import { useHostSettingValue } from "../../shared/settingValue";
import { ViewerFilmstrip } from "./ViewerFilmstrip";
import { ViewerInfoBar } from "./ViewerInfoBar";
import { ViewerNavigator } from "./ViewerNavigator";
import { ViewerStage } from "./ViewerStage";
import { useViewerPreload } from "./useViewerPreload";
import { useViewerSequence } from "./useViewerSequence";
import { useViewerSettings } from "./useViewerSettings";
import { isFilmstripVertical, stepIndex } from "./viewerPlacement";
import { shouldTakeViewerFocus, viewerKeyAction } from "./viewerKeymap";
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
  // 信息栏的体积 / 日期口径来自**宿主设置**（与元数据面板同一批，见 `shared/format.ts`）：
  // 面板自己声明的 7 项设置管布局（导航器 / 胶片栏 / 缩放中心），显示格式不在这里重复声明。
  const sizeUnit = resolveSizeUnit(useHostSettingValue(SETTING_KEYS.sizeUnit, panelApi));
  const dateFormat = resolveDateFormat(useHostSettingValue(SETTING_KEYS.dateFormat, panelApi));
  const dateShowTime = resolveDateShowTime(
    useHostSettingValue(SETTING_KEYS.dateShowTime, panelApi),
  );
  const settings = useViewerSettings(panelApi);
  const sequence = useViewerSequence(app);
  /**
   * 面板是否**正在显示**（判据只看 `isVisible`，理由见 `shared/panelForeground.ts`）。
   * 预加载只在显示时进行：dockview 会把后台标签留在 DOM 里，隐藏时预加载纯属浪费
   * （用户看不到，还占磁盘与内存）。
   */
  const foreground = usePanelForeground(panelApi);

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
  /**
   * 上一次同步到的"激活且可见"状态：焦点只在**进入**该状态的转换上取一次
   * （`panelApi` 在独立单面板窗口里每次渲染都是新替身，不加这道判据会反复抢焦点）。
   */
  const enteredRef = useRef(false);
  /** 待执行的"取焦点"帧（延后一帧，等浏览器"点击即聚焦标签"的默认动作走完）。 */
  const focusFrameRef = useRef(0);
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

  // 选中项变化 → 解析图像源：Chromium 可解的格式加载**原图**（全分辨率）；
  // HEIC/HEIF 走后端**全分辨率预览**（`preview.get`，缺陷 0019）。旧请求用令牌丢弃
  // （快速切换不会串图）。取图策略收敛在 `shared/imageUrl.ts`——预加载走**同一份**
  // 缓存，因此预加载过的邻居在这里是**同步命中**，不再有 IPC 往返。
  useEffect(() => {
    setUrl(null);
    setFailed(false);
    setNatural(null);
    if (!repoId || !file || file.media_type !== "image") return;
    let cancelled = false;
    void (async () => {
      const ctx = appRef.current;
      const outcome = await resolveImageUrlOutcome(repoId, file.id, file.relative_path);
      if (cancelled) return;
      if (outcome.url) {
        setUrl(outcome.url);
        return;
      }
      setFailed(true);
      if (outcome.error !== null) {
        ctx.status(ctx.t("imageviewer.loadFailed", { err: errorTextOf(ctx.t, outcome.error) }), "error");
      } else {
        // 预览不可用（生成失败等）：按"不可用"占位，不再二次请求。
        ctx.status(ctx.t("imageviewer.unavailable"), "error");
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

  /**
   * 相邻图像预加载：把"上一张/下一张"最贵的那段（HEIC/HEIF 的全分辨率生成，
   * 实测 102 MP 需 0.8 s）提前到用户还在看当前图的时候。取哪些邻居、取多少在
   * `viewerPreload.ts` 的纯函数里，本钩子只负责"取"。
   */
  useViewerPreload({
    enabled: foreground && Boolean(repoId),
    repoId,
    files: sequence.files,
    index: sequence.index,
    radius: settings.preloadRadius,
  });

  /** 键盘：上一张/下一张 + 适应窗口 + 1:1（键位判定在 `viewerKeymap.ts`，只此一处）。 */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = viewerKeyAction(event.key);
    // 无关按键**放行**：不处理也不 `preventDefault`，宿主与浮层的快捷键照常冒泡。
    if (!action) return;
    event.preventDefault();
    if (action === "prev") {
      step(-1);
    } else if (action === "next") {
      step(1);
    } else if (action === "fit") {
      applyFit();
    } else {
      applyActualSize();
    }
  };

  /**
   * 「从其他面板进入图像查看器」这条路径：面板被**程序激活**时（蓝图双击图像 →
   * `focusPanel` → `panel.api.setActive()`）DOM 焦点还留在原面板上，根节点的
   * `onKeyDown` 收不到方向键。**进入**（或挂载即处于）激活且可见态时把焦点拿到根节点即可。
   *
   * 三道收敛，缺一不可：
   *
   * 1. **只在"进入"这个转换上取一次**（`enteredRef`）。`panelApi` 在独立单面板窗口里是
   *    每次渲染新建的替身对象，若不加这道判据，重渲染就会反复抢焦点——把用户正在
   *    同一个窗口里用键盘操作的按钮顶掉。
   * 2. **判据在激活的**当帧**读**（`shouldTakeViewerFocus`）：`onDidActiveChange` 在
   *    `pointerdown` 的派发过程中同步触发（`dndStrategy = "pointer"` 时 dockview 就是
   *    同步 `openPanel`），此刻浏览器**还没有**执行"点击即聚焦"的默认动作——所以鼠标
   *    点标签页进来时读到的仍是**点之前**的焦点（通常是别的面板），判据放行；而键盘在
   *    标签条里按 Enter 激活时读到的就是标签元素本身，判据拦下（标签条的左右键导航
   *    得以保留）。
   * 3. **取焦点延后一帧**：鼠标点标签页时浏览器会在默认动作里把焦点给**标签元素**
   *    （dockview 的标签是可聚焦的 `div`），同步 `focus()` 会被它覆盖掉，表现为
   *    "点进来了、方向键还是不动"。等默认动作走完再取，面板根节点才真正拿到键盘。
   *    延后期间**不重复判据**——否则又会读到刚被聚焦的标签而放弃。
   */
  useEffect(() => {
    if (!panelApi) return;
    const sync = () => {
      const active = Boolean(panelApi.isVisible && panelApi.isActive);
      const entered = active && !enteredRef.current;
      enteredRef.current = active;
      if (!entered) return;
      if (!shouldTakeViewerFocus(document.activeElement)) return;
      // 连续快速切换标签时只保留最后一次待执行的取焦点（不因重渲染丢掉它——
      // 独立单面板窗口的 `panelApi` 每次渲染都换身份，本 effect 会随之重跑）。
      cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = requestAnimationFrame(() => {
        // 帧内**重读激活态**：这一帧里用户可能已经切走了，此时不能再抢焦点。
        // （只重读激活态，不重读焦点判据——那时浏览器已把焦点给到标签元素。）
        if (!panelApi.isVisible || !panelApi.isActive) return;
        rootRef.current?.focus({ preventScroll: true });
      });
    };
    sync();
    const disposables = [panelApi.onDidActiveChange(sync), panelApi.onDidVisibilityChange(sync)];
    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [panelApi]);

  // 卸载时撤掉尚未执行的取焦点（组件已不在，聚焦无处可去）。
  useEffect(() => () => cancelAnimationFrame(focusFrameRef.current), []);

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
            // 原图加载失败：若当前不是预览（Chromium 意外不支持的格式等），
            // 回退到有界预览**一次**；预览也失败或已是预览 → 不可用。
            if (url && !needsPreview(file?.relative_path ?? "")) {
              setUrl(null); // 先停掉坏图，占位期间请求预览
              void resolvePreviewUrl(repoId ?? "", file?.id ?? "").then((previewUrl) => {
                if (previewUrl) {
                  setFailed(false);
                  setUrl(previewUrl);
                } else {
                  setFailed(true);
                  app.status(app.t("imageviewer.unavailable"), "error");
                }
              });
              return;
            }
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
          sizeUnit={sizeUnit}
          dateFormat={dateFormat}
          dateShowTime={dateShowTime}
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
