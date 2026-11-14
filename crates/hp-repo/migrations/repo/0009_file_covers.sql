-- 仓库库迁移 0009：新增**文件封面覆盖**表 `file_covers`。
-- forward-only：本文件发布后禁止修改。
--
-- 背景（2026-10-09 用户口径）："txt 右键可以更换封面颜色或自定义图片"。
-- 一本书的默认封面是**算出来的**（epub 取内嵌封面、其余文本按作品名派生文字封面），
-- 本表存的是用户**显式指定**的封面，优先级高于那两套默认——因此叫"覆盖"。
--
-- 为什么按 `file_id` 存而不是内容哈希：这是**用户在某个条目上的选择**，
-- 不是内容的属性（与 `subtype` / `ratings` 同一口径）。`file_id` 在重扫时保持不变
-- （`hp-scanner` 的 `write_one` 复用既有 id），因此重扫 / 重新分析都不会把它打回默认。
--
-- 为什么颜色与图片用同一张表：两者是**同一个决策的两种取值**（"这本书的封面长什么样"），
-- 互斥且必选其一；分成两张表就会出现"同时有颜色和图片、优先级靠代码约定"的状态。
-- `kind` 区分，一行只表达一种，`ON CONFLICT(file_id)` 天然实现"换一种就顶掉另一种"。
--
-- `value` 的含义随 `kind` 变：
--   color → `#rrggbb` 小写（`hp_core::normalize_cover_color` 规范化后写入）
--   image → `covers/` 目录下的**裸文件名**（`hp_core::is_safe_cover_file_name` 校验；
--           拼进磁盘路径前必须过这道校验，否则库里的一行就能决定读哪个文件）
--
-- 外键 `ON DELETE CASCADE`：文件行被删除（回收站 / 卸载源）时覆盖随之消失。
CREATE TABLE file_covers (
  file_id    TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,             -- color|image
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
