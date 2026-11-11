/**
 * 缩略图**分辨率档梯**（缺陷 0046：媒体预览放大后发糊）。
 *
 * 后端 `thumb.get` 按"请求长边像素"**向上吸附**到档梯生成并分档缓存缩略图；
 * 前端这一侧必须用**同一张档梯**算请求值与缓存键——两侧各写一套就会出现
 * "前端当它是 640 档、后端按 480 档存"，同一张图来回生成两次（缓存条目也翻倍）。
 *
 * 档梯与 `crates/hp-media/src/thumbnail.rs` 的 `IMAGE_THUMB_DIM_LADDER` 同源：
 * `[320, 480, 640, 960, 1280]`。首档就是**升级前的固定口径**（长边 320），
 * 因此默认设置（图片宽度 160、DPR 1–2）下的请求值与后端的缓存文件名
 * （`<hash>.webp`）都与升级前逐位一致，不会整库重算。
 */

/** 长边档梯（px，升序）。首档同时是缺省档。 */
export const THUMB_DIM_LADDER = [320, 480, 640, 960, 1280] as const;

/**
 * 缺省档（未指定尺寸 / 旧调用方）：等于升级前的固定长边 320。
 *
 * **不建议在媒体预览里直接用它**——面板会按"图片宽度 × 视图倍率 × 设备像素比"
 * 算出该格真实需要的长边再传下来；这里只服务于"不知道该多大"的调用方
 * （图像查看器胶片栏、音频波形图这类单尺寸缩略图）。
 */
export const THUMB_DIM_BASE: number = THUMB_DIM_LADDER[0];

/**
 * 把请求的设备像素长边**向上吸附**到档梯。
 *
 * 向上而不是就近：缩略图被浏览器放大才会糊，"小一号刚好够用"意味着
 * 每次都要多解一张图；宁可多给一档（相邻档最多 1.5× 像素），也不让用户
 * 看到放大的模糊图。非数值 / 非正数归首档（后端把 0 也当作"未指定"）。
 */
export function thumbBucket(requestedPx: number): number {
  if (!Number.isFinite(requestedPx) || requestedPx <= THUMB_DIM_BASE) {
    return THUMB_DIM_BASE;
  }
  for (const dim of THUMB_DIM_LADDER) {
    if (requestedPx <= dim) return dim;
  }
  // 超过上限：夹到最后一档（再清晰由后端的"回退原图"负责，不是无限放大缓存）。
  return THUMB_DIM_LADDER[THUMB_DIM_LADDER.length - 1];
}

/**
 * 缩略图缓存键：**同一 fileId 的不同档是不同条目**。
 *
 * 换档（改图片宽度、拖到另一台 DPR 不同的屏幕）必须重新取图；
 * 若仍按 fileId 缓存，界面会一直显示第一档的糊图。
 */
export function thumbCacheKey(fileId: string, bucket: number): string {
  return `${fileId}@${bucket}`;
}
