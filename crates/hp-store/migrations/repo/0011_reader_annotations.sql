-- 仓库库迁移 0011：新增**阅读批注**表 `reader_annotations`（书签 / 笔记 / 高亮）。
-- forward-only：本文件发布后禁止修改。
--
-- 背景（2026-10-16 用户口径，D113）：图书阅读器的左侧栏有「书签 / 笔记 / 高亮」
-- 三个标签页，用户在决定项里裁决为**落库**（"重启后仍在"）。
--
-- 为什么三者在**同一张表**：它们是**同一件事的三种形态**——"读者在书里的某个位置
-- 留下的东西"。三张表会让"这一章我留了什么"变成三次查询 + 三份几乎相同的读写代码，
-- 而三者的差别只有 `kind`（有没有备注、有没有选中文字），字段本身高度重合。
-- 用 `kind` 区分，一条记录只表达一种（与 `file_covers` 的 `kind` 同一处置）。
--
-- 为什么按 `file_id` 存而不是内容哈希：这是**读者在某个条目上的批注**，不是内容的
-- 属性（与 `file_covers` / `ratings` / `file_marks` 同一口径）。`file_id` 在重扫时
-- **保持不变**（`hp-scanner` 的 `write_one` 复用既有 id），因此重扫 / 重新分析都不会
-- 让批注丢失。
--
-- ## 位置口径（`cursor` + `progress`）
--
-- `cursor` 与 `book.content` 的游标**同语义**（epub = 章节序号、纯文本 = **字符偏移**、
-- md = 顶层块序号）——与 `book.toc` 的 `TocEntry::cursor` 是同一套坐标。因此"点书签
-- 跳回去"就是把这里的值原样交给 `book.content`，不需要任何换算（D113 ④）。
-- 它存 TEXT 而不是 INTEGER：三种格式的游标虽都是十进制数字，但把"游标是字符串"
-- 这个契约写进列类型，可以避免将来某种格式换成非数字游标时被迫改表。
--
-- `progress` 是**保存时的阅读进度百分比（0–10000 = 0.00%–100.00%）**，冗余存一份：
-- 书签列表要显示"这本书读到哪儿了"，而按 `cursor` 反推进度需要**知道全书总量**
-- （要再读一次 `book.toc`）。冗余一个整数列换"列表直接可读"，且它只是显示用，
-- 不影响跳转（跳转恒用 `cursor`）。用整数而不是 REAL：百分比只到两位小数，
-- 整数比较不受浮点误差影响。
--
-- ## 为什么 `excerpt` / `note` 分两列
--
-- 高亮的 `excerpt` 是**选中的原文**（只读快照），`note` 是**读者写的话**。
-- 合成一列就无法区分"这段是原文"与"这段是我写的"——而两者在界面上的排版完全不同
-- （原文引用块 vs 我的批注）。书签两者都为空，笔记只有 `note`。
--
-- `excerpt` 冗余存原文快照是**刻意的**：正文可能因为换编码 / 换版本而变，
-- 但"我当时划的是这句话"是读者的记录，不该跟着正文漂移。
CREATE TABLE reader_annotations (
  id         TEXT PRIMARY KEY,          -- UUID（与 tag 等实体同一套 id 口径）
  file_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- bookmark|note|highlight
  cursor     TEXT NOT NULL,             -- 与 book.content 的游标同语义（见上）
  progress   INTEGER NOT NULL DEFAULT 0,-- 保存时的进度（0–10000，两位小数百分比）
  title      TEXT NOT NULL DEFAULT '',  -- 位置标题（章节名 / 目录项），便于列表展示
  excerpt    TEXT NOT NULL DEFAULT '',  -- 高亮的选中原文（只读快照）
  note       TEXT NOT NULL DEFAULT '',  -- 读者写的备注 / 笔记正文
  created_at TEXT NOT NULL,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

-- 反查"某本书的全部批注"（阅读器打开一本书就要列一次）——按位置排序，
-- 因此把 `cursor` 一起放进索引会让 `ORDER BY` 直接走索引。
-- 注意 `cursor` 是 TEXT，排序是**字典序**：这正是不把它当数值用的原因
-- （列表按创建时间排更稳，见仓储实现）。
CREATE INDEX idx_reader_annotations_file ON reader_annotations(file_id, kind);

-- 反查"哪些文件有批注"（图书预览将来可据此显示角标；当前无消费者，
-- 但索引很便宜，而漏了它将来加消费者时要再来一次迁移）。
CREATE INDEX idx_reader_annotations_kind ON reader_annotations(kind);
