-- 仓库库迁移 0008：新增媒体类型 `text` 与文件**子类型**列
-- forward-only：本文件发布后禁止修改。
--
-- 背景（2026-10-08 用户口径）：
-- - 新增媒体类型 `text`（txt / md / epub 等，**只认扩展名**，不做内容兜底）；
-- - 新增「子类型」——媒体类型之下的**可编辑标记**：`epub` 默认 `book`，
--   其余文本默认 `document`。扫描**只在为空时补默认值**，不覆盖用户改过的值，
--   所以它必须是**独立列**，不能从 `media_type` / 扩展名现算。
--
-- 兼容性：`files.media_type` 是裸 TEXT 列、**没有 CHECK 约束**（0001 迁移如此），
-- 因此新增取值 `text` 不需要重建表（SQLite 也不支持用 ALTER 改 CHECK）。
-- 既有行的 `subtype` 为 NULL：下次扫描按"缺失即补默认值"补齐；未重扫的旧行
-- 仍按 `text` 类型正常显示（子类型缺失在前端只是"没有标记"，不是错误）。

ALTER TABLE files ADD COLUMN subtype TEXT;
