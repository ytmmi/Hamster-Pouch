-- 仓库库迁移 0007：为 album_member(file_id) 补索引
-- forward-only：本文件发布后禁止修改。
--
-- 背景（已实测）：album_member 的主键是 (album_id, file_id)，只能按 album_id 前缀检索。
-- 任何"按文件反查相册"的查询都因此退化为全表扫描：
--   - 卸载源的影响评估 list_album_source_members（JOIN files ON f.id = m.file_id）；
--   - 源间复制继承成员关系 list_album_ids_for_file(file_id)。
-- 实测 12 万行 album_member 时，影响评估 639 ms → 建索引后 8 ms（约 80×）。
-- 成员表会随跟随源相册增长到很大，故按 file_id 单独建索引。

CREATE INDEX IF NOT EXISTS idx_album_member_file ON album_member(file_id);
