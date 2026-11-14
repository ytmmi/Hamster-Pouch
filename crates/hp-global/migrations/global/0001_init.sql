-- 全局配置库迁移 0001：初始 schema（对应 database-schema.md 第 3 节）
-- forward-only：本文件发布后禁止修改。

CREATE TABLE IF NOT EXISTS repos (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  repo_db_path   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_opened_at TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 决策 D1：布局表在全局配置库，每行带 repo_id
CREATE TABLE IF NOT EXISTS panel_layouts (
  id          TEXT PRIMARY KEY,
  repo_id     TEXT NOT NULL,
  workspace   TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_panel_layouts_repo ON panel_layouts(repo_id, workspace);

CREATE TABLE IF NOT EXISTS plugin_registry (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  trust_level   TEXT NOT NULL,
  source_kind   TEXT NOT NULL,
  source_ref    TEXT,
  runtime_kind  TEXT NOT NULL,
  installed_at  TEXT NOT NULL,
  manifest_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_repo_state (
  plugin_id   TEXT NOT NULL,
  repo_id     TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0,
  grants_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (plugin_id, repo_id)
);

CREATE TABLE IF NOT EXISTS ai_provider_config (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  model       TEXT,
  config_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
