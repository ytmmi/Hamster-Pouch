-- 仓库库迁移 0003：AI tag 高置信覆盖的撤销记录（D6）
-- forward-only：本文件发布后禁止修改。
-- 说明：AI 结果直接写入 file_tags 并标记来源/置信度/来源模型；
--       高置信覆盖用户已有 tag 时，先在此表保留覆盖前状态，供撤销。

CREATE TABLE IF NOT EXISTS ai_tag_undo (
  id                TEXT PRIMARY KEY,
  repo_id           TEXT NOT NULL,
  file_id           TEXT NOT NULL,
  tag_id            TEXT NOT NULL,
  prev_source       TEXT NOT NULL,
  prev_confidence   REAL,
  prev_source_model TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_tag_undo_repo ON ai_tag_undo(repo_id);
CREATE INDEX IF NOT EXISTS idx_ai_tag_undo_file ON ai_tag_undo(file_id);
