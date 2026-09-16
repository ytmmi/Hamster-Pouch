-- 仓库库迁移 0006：蓝图（RFC 0007 / D28-D32）
-- 蓝图是仓库内节点式「控件显隐 + 组布局控制」配置文档。
-- 定义按仓库持久化（每仓库一个仓库库文件）；整文档 JSON 存储，save = 整文档替换
-- （对齐 D1 的 panel_layouts 先例）；is_default 每仓库唯一，无默认回退内置默认蓝图。
-- forward-only：本文件发布后禁止修改。

CREATE TABLE IF NOT EXISTS blueprints (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  is_default     INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  blueprint_json TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blueprints_repo ON blueprints(repo_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blueprints_default
  ON blueprints(repo_id, is_default) WHERE is_default = 1;
