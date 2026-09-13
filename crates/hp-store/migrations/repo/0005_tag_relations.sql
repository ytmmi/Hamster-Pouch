-- 仓库库迁移 0005：tag 关系（层级 + 关联），作为关系图谱组件的数据源（D22）
-- tag 之间为多对多关系，支持多父级（DAG）；层级与关联用 relation_kind 区分：
--   hierarchy：from 是 to 的上级（from 包含 to）
--   related  ：一般关联
-- forward-only：本文件发布后禁止修改。

CREATE TABLE IF NOT EXISTS tag_relations (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL,
  from_tag_id   TEXT NOT NULL REFERENCES tags(id),
  to_tag_id     TEXT NOT NULL REFERENCES tags(id),
  relation_kind TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (repo_id, from_tag_id, to_tag_id, relation_kind)
);
CREATE INDEX IF NOT EXISTS idx_tag_relations_repo ON tag_relations(repo_id);
CREATE INDEX IF NOT EXISTS idx_tag_relations_from ON tag_relations(from_tag_id);
CREATE INDEX IF NOT EXISTS idx_tag_relations_to ON tag_relations(to_tag_id);
