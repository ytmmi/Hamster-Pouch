-- 仓库库迁移 0002：files 表增加 media_info_json 列（D15 视频全量元数据缓存）
-- forward-only：本文件发布后禁止修改。

ALTER TABLE files ADD COLUMN media_info_json TEXT;
