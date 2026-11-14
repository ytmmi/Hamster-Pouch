-- 全局配置库迁移 0002：蓝图模板（RFC 0007 / D30）
-- 蓝图模板应用级共享（所有仓库可见），install 时一次性复制进仓库库 blueprints 表；
-- 复制后与模板脱离，模板后续修改不影响已复制蓝图。
-- forward-only：本文件发布后禁止修改。

CREATE TABLE IF NOT EXISTS blueprint_templates (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  blueprint_json TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
