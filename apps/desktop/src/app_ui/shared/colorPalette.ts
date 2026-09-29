/**
 * 调色板的**按需提取**（D18：浏览时按需提取并缓存；仅图片）。
 *
 * 两个调用方共用**唯一入口** `requestPaletteExtraction`：
 * - 装配层的选中监视器（`core/colorPaletteWatch.tsx`）：点击图像那一刻请求；
 * - 色彩参考面板的装载自检：面板打开时若仍无调色板（上次失败/应用刚重启）再请求一次。
 *
 * 面板与监视器都不自己判断"要不要提取"——两处判断必然漂移。缓存的形态与"是否过期"
 * 判断在 `shared/paletteJson.ts`（纯函数）。
 *
 * ## 为什么要"短延迟 + 只保留最新一次"
 *
 * 提取是**后端阻塞任务**（`color.extract` → `spawn_blocking` 里解码整张图），而仓库锁
 * （`AppState.open_repo`）是**全应用唯一**的一把：它被提取任务占住时，媒体预览查询、
 * 元数据、tag、保存布局等命令都会排队。因此：
 *
 * - **短延迟**（[`PALETTE_REQUEST_DELAY_MS`]）：按住方向键连续浏览时，选中项每几十毫秒
 *   就变一次，若每次都立刻提取，就会排出一长串解码任务把仓库锁挤满；延迟期间被后一次
 *   请求顶掉的中间项**不需要**调色板（用户没有停在它上面），真的回到它时会重新请求；
 * - **只保留最新一次 + 单飞**：同一时刻最多一请求在跑，pending 槽只留最后一个。
 *
 * 这是"点击图像就把当前图的调色板取回来"与"不要把全应用唯一的仓库锁打满"之间的取舍。
 */

import * as api from "./api";
import { parsePaletteJson } from "./paletteJson";

/** 请求到真正发起提取之间的延迟（毫秒）：合并快速连点/按住方向键的连续选中。 */
export const PALETTE_REQUEST_DELAY_MS = 250;

/** 待处理的最后一次请求（新请求顶掉旧的）。 */
let pending: { repoId: string; fileId: string } | null = null;
/** 延迟计时器（每次新请求重置）。 */
let timer: ReturnType<typeof setTimeout> | null = null;
/** 是否有一次提取正在处理中（单飞；处理完再取 pending）。 */
let draining = false;

/**
 * 请求"确保这张图片的调色板已提取"（延迟合并 + 只保留最新一次）。
 *
 * 同步返回：调用方（`useEffect`）不需要 await，也不需要处理错误。
 */
export function requestPaletteExtraction(repoId: string, fileId: string): void {
  pending = { repoId, fileId };
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void drainPaletteRequests();
  }, PALETTE_REQUEST_DELAY_MS);
}

/** 依次处理请求槽；一次只处理一个，处理期间到达的请求在下一轮被取走。 */
async function drainPaletteRequests(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending !== null) {
      const next = pending;
      pending = null;
      await extractIfMissing(next.repoId, next.fileId);
    }
  } finally {
    draining = false;
  }
}

/**
 * 读缓存 → 缺失（或已过期）即请求后台提取。
 *
 * 提取是**后台任务**（`color.extract` 立即返回 taskId，结果经 `color.extracted` 事件回来），
 * 因此这里不等待结果、也不抛错：调色板暂时缺失不该打断浏览。失败**不记忆**——下次请求
 * 会重新读缓存并再试一次（面板里没有手动重试按钮，自动重试就是唯一的重试路径）。
 */
async function extractIfMissing(repoId: string, fileId: string): Promise<void> {
  try {
    const json = await api.colorGet({ repoId, fileId });
    if (parsePaletteJson(json).length > 0) return;
    await api.colorExtract({ repoId, fileId });
  } catch {
    /* 读取或提取失败：不打断浏览，下次请求会重试 */
  }
}
