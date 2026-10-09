-- 仓库库迁移 0010：把「子类型」单列换成**可多值的文件标记表** `file_marks`。
-- forward-only：本文件发布后禁止修改。
--
-- 背景（2026-10-10 用户口径，D102）：
--   "text 为类目，md、txt、epub 为子类，book 为标记，标记可以交叉，
--    例子：漫画.zip 文件的类目为压缩包，可以标记为 manga（漫画）。"
--
-- 因此「标记」是**与类目正交、可交叉**的一维：一个文件可以**同时**带多个标记
-- （一本 epub 可以既是 `book` 又是 `manga`）。单列 `files.subtype` 表达不了集合，
-- 所以本迁移把它换成**一对多**的 `file_marks`。
--
-- 为什么按 `file_id` 存而不是内容哈希：这是**用户在某个条目上的选择**，
-- 不是内容的属性（与 `file_covers` / `ratings` 同一口径）。`file_id` 在重扫时保持不变
-- （`hp-scanner` 的 `write_one` 复用既有 id），因此重扫 / 重新分析都不会把标记打回默认。
--
-- 存量数据的搬迁口径（**只搬 `book`，不搬 `document`**）：
--   旧 `subtype = 'book'`    → 一行 (file_id, 'book')：旧口径的"电子书"就是 book 标记；
--   旧 `subtype = 'document'` → **不搬**：它从来不是一种"标记状态"，只是"没打标记"的
--                              旧默认值（D102 已明确）；搬成一堆 `document` 标记会让
--                              每个 txt / md 都凭空多一个没人要的标记。
--   `NULL` → 不搬（未标记）。
-- 迁移后 `book` 标记与旧的 `book` 子类型**一一对应**，观感零变化。
--
-- 为什么不删 `files.subtype` 列：**forward-only 且不可逆**——`0001_init.sql` 不得被改，
-- 而 `ALTER TABLE ... DROP COLUMN` 在旧 SQLite 上不可用、且会让"降级回旧版本"直接崩。
-- 保留该列、明确标注为**已废弃**（新代码不读不写），是代价最小且不丢信息的做法。
CREATE TABLE file_marks (
  file_id  TEXT NOT NULL,
  mark     TEXT NOT NULL,               -- 标记 id（可注册清单：book / manga / …）
  added_at TEXT NOT NULL,
  PRIMARY KEY (file_id, mark),          -- 同一文件同一标记只存一行（天然幂等）
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

-- 反查"哪些文件带某个标记"（蓝图按标记分派行为的取数路径）。
CREATE INDEX idx_file_marks_mark ON file_marks(mark);

-- 存量搬迁：旧的 `book` 子类型 → `book` 标记（见上面的口径说明）。
INSERT OR IGNORE INTO file_marks (file_id, mark, added_at)
SELECT id, 'book', COALESCE(scan_time, datetime('now'))
FROM files
WHERE subtype = 'book';
