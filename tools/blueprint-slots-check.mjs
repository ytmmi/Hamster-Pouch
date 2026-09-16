/**
 * 蓝图槽位放置自检（开发期验证，不参与打包）。
 *
 * 针对真实故障："新增节点落在渲染画布中心失败，跑到看不见的地方"。
 * 根因是旧的搜索按"已有节点列数"循环取模、且只向下找：基准点远离世界原点时
 * 会把节点绕回左上角或一路下推。这里验证新实现（环形就近搜索）：
 * 1. 基准点空闲 → 直接落在基准点附近；
 * 2. 基准点被占 → 落在**最近**的空槽（上下左右一圈内的最小半径）；
 * 3. 基准点远离原点（模拟视口平移到远处）→ 结果仍在基准点附近，不会跳回原点；
 * 4. 缩放：基准点取任意世界坐标（含小数）都能就近落位。
 *
 * 用法：node --no-warnings --import ./tools/blueprint-check-register.mjs \
 *         tools/blueprint-slots-check.mjs
 */

import { pathToFileURL } from "node:url";

const ROOT = "E:/Hamster Pouch";
const slots = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/panels/blueprintSlots.ts`).href
);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** 造一个只带 position 的节点。 */
const node = (key, x, y) => ({
  key,
  type: "control",
  panel_id: "media",
  position: { x, y },
});

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---- 1. 空图：直接落在基准点所在槽位 ----
{
  const base = { x: 1234, y: 567 };
  const p = slots.freeSlotPosition([], base);
  check(
    "空图：落在基准点所在槽位（±1 格内）",
    dist(p, base) <= Math.hypot(slots.SLOT_W, slots.SLOT_H),
    `base=(${base.x},${base.y}) → (${p.x},${p.y})`,
  );
}

// ---- 2. 基准槽被占：落到最近空槽（半径 1 以内）----
{
  const base = { x: 1000, y: 400 };
  const align = slots.freeSlotPosition([], base); // 对齐后的槽位
  const occupied = [node("n1", align.x, align.y)];
  const p = slots.freeSlotPosition(occupied, base);
  const r = Math.max(
    Math.abs(p.x - align.x) / slots.SLOT_W,
    Math.abs(p.y - align.y) / slots.SLOT_H,
  );
  check(
    "基准槽被占：落到最近的空槽（半径 ≤ 1）",
    r <= 1 && dist(p, base) <= Math.hypot(2 * slots.SLOT_W, 2 * slots.SLOT_H),
    `align=(${align.x},${align.y}) → (${p.x},${p.y}) 半径=${r}`,
  );
}

// ---- 3. 基准点远离世界原点（视口平移到远处）：不得跳回原点附近 ----
{
  const base = { x: 9000, y: 6500 };
  const occupied = [];
  // 把基准附近铺满，逼它向外扩一圈
  for (let dc = -1; dc <= 1; dc += 1) {
    for (let dr = -1; dr <= 1; dr += 1) {
      occupied.push(node(`o_${dc}_${dr}`, base.x + dc * slots.SLOT_W, base.y + dr * slots.SLOT_H));
    }
  }
  const p = slots.freeSlotPosition(occupied, base);
  check(
    "远处基准点：结果仍在基准点附近（不回到世界原点）",
    dist(p, base) <= Math.hypot(2.5 * slots.SLOT_W, 2.5 * slots.SLOT_H),
    `base=(${base.x},${base.y}) → (${p.x},${p.y}) 距离=${Math.round(dist(p, base))}`,
  );
}

// ---- 4. 缩放后的世界坐标（含小数）同样就近落位 ----
{
  const base = { x: -1873.42, y: 921.77 };
  const p = slots.freeSlotPosition([], base);
  check(
    "含小数/负数的世界坐标：就近落位",
    dist(p, base) <= Math.hypot(slots.SLOT_W, slots.SLOT_H),
    `base=(${base.x},${base.y}) → (${p.x},${p.y})`,
  );
}

// ---- 5. 连续新增多个节点：彼此不重叠且都在基准点附近 ----
{
  const base = { x: 2000, y: 1200 };
  const placed = [];
  for (let i = 1; i <= 6; i += 1) {
    const p = slots.freeSlotPosition(placed, base);
    placed.push(node(`n${i}`, p.x, p.y));
  }
  const overlaps = [];
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i].position;
      const b = placed[j].position;
      if (Math.abs(a.x - b.x) < slots.SLOT_W && Math.abs(a.y - b.y) < slots.SLOT_H) {
        overlaps.push(`${placed[i].key}~${placed[j].key}`);
      }
    }
  }
  const far = placed.filter((n) => dist(n.position, base) > 3 * Math.hypot(slots.SLOT_W, slots.SLOT_H));
  check(
    "连续新增 6 个：互不重叠且都留在基准点附近",
    overlaps.length === 0 && far.length === 0,
    `重叠=[${overlaps.join(", ") || "无"}] 远点=${far.length} 位置=${placed
      .map((n) => `(${n.position.x},${n.position.y})`)
      .join(" ")}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
