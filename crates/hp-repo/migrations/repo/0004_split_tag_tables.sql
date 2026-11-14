-- 仓库库迁移 0004：人工 tag 与自动 tag 的**关联**使用互相独立的表（D21）
-- tag 实体共用 `tags` 表；关联分表：
--   人工组：file_tags（file_id, tag_id, created_at）
--   自动组：file_auto_tags（file_id, tag_id, confidence, source_model, created_at）
-- forward-only：本文件发布后禁止修改。

-- 1. 文件与自动 tag 关联表（tag_id 引用共用 tags 表）
CREATE TABLE IF NOT EXISTS file_auto_tags (
  file_id      TEXT NOT NULL REFERENCES files(id),
  tag_id       TEXT NOT NULL REFERENCES tags(id),
  confidence   REAL,
  source_model TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (file_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_file_auto_tags_file ON file_auto_tags(file_id);

-- 2. 迁移历史 AI 关联到独立关联表
INSERT OR IGNORE INTO file_auto_tags (file_id, tag_id, confidence, source_model, created_at)
  SELECT file_id, tag_id, confidence, source_model, created_at
  FROM file_tags WHERE source = 'ai';

-- 3. 重建 file_tags 为纯人工关联（移除 source/confidence/source_model 列）
CREATE TABLE IF NOT EXISTS file_tags_v2 (
  file_id    TEXT NOT NULL REFERENCES files(id),
  tag_id     TEXT NOT NULL REFERENCES tags(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, tag_id)
);

INSERT OR IGNORE INTO file_tags_v2 (file_id, tag_id, created_at)
  SELECT file_id, tag_id, created_at FROM file_tags WHERE source = 'user';

DROP TABLE file_tags;

ALTER TABLE file_tags_v2 RENAME TO file_tags;
