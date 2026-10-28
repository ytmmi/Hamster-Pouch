-- 仓库库迁移 0013：相册同级排序（D132）。
-- forward-only：本文件发布后禁止修改。
--
-- 背景：相册树此前只按 `created_at` 升序展示，用户无法调整同级顺序。
-- 拖拽排序需要一份显式的顺序位，否则"插到两行中间"这个意图无处落库。
--
-- 设计要点：
-- 1. `sort_order` 是**同一父级内**的整数序号，0 起递增；不同父级之间互不比较，
--    因此移动相册到别的父级时只需重排目标父级的序号，不必全局重编号。
-- 2. 默认值 0 让既有行在迁移后全都并列；读侧按 `(sort_order, created_at)` 排序，
--    于是老相册仍然保持"先建的在前"的观感，不会因为迁移而乱序。
-- 3. 该列不参与任何唯一约束：拖拽过程中允许出现重复序号，写入端每次都整体重排，
--    重复只是一次未完成的中间态，读侧仍有 `created_at` 兜底，不会丢行。

ALTER TABLE albums ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- 相册树的主查询是"某仓库的全部相册，按父级 + 顺序"，顺带覆盖子相册列举。
CREATE INDEX IF NOT EXISTS idx_albums_repo_order ON albums(repo_id, parent_album_id, sort_order);
