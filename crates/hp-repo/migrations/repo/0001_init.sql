-- 仓库库迁移 0001：初始 schema（对应 database-schema.md 第 4 节）
-- forward-only：本文件发布后禁止修改。

CREATE TABLE IF NOT EXISTS repo_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id               TEXT PRIMARY KEY,
  repo_id          TEXT NOT NULL,
  local_path       TEXT NOT NULL,
  alias            TEXT,
  parent_source_id TEXT REFERENCES sources(id),
  mounted          INTEGER NOT NULL DEFAULT 1,
  mounted_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_repo ON sources(repo_id);

-- 文件索引：身份=内容哈希；音频占位行哈希可空；视频首帧感知哈希
CREATE TABLE IF NOT EXISTS files (
  id                         TEXT PRIMARY KEY,
  source_id                  TEXT NOT NULL REFERENCES sources(id),
  relative_path              TEXT NOT NULL,
  media_type                 TEXT NOT NULL,
  content_hash               TEXT,
  content_hash_algo          TEXT,
  content_hash_algo_version  INTEGER,
  perceptual_hash            TEXT,
  perceptual_hash_algo       TEXT,
  perceptual_hash_algo_version INTEGER,
  size                       INTEGER NOT NULL,
  mtime                      TEXT NOT NULL,
  scan_time                  TEXT NOT NULL,
  verify_status              TEXT NOT NULL,
  thumb_status               INTEGER NOT NULL DEFAULT 0,
  missing_status             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_files_source ON files(source_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_source_path ON files(source_id, relative_path);
CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash);
CREATE INDEX IF NOT EXISTS idx_files_media_type ON files(media_type);

CREATE TABLE IF NOT EXISTS tags (
  id      TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  color   TEXT,
  UNIQUE (repo_id, name)
);

CREATE TABLE IF NOT EXISTS file_tags (
  file_id      TEXT NOT NULL REFERENCES files(id),
  tag_id       TEXT NOT NULL REFERENCES tags(id),
  source       TEXT NOT NULL DEFAULT 'user',
  confidence   REAL,
  source_model TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (file_id, tag_id)
);

CREATE TABLE IF NOT EXISTS ratings (
  file_id    TEXT PRIMARY KEY REFERENCES files(id),
  rating     INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS color_refs (
  file_id    TEXT PRIMARY KEY REFERENCES files(id),
  color_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS albums (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL,
  parent_album_id TEXT REFERENCES albums(id),
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  media_type      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_albums_repo ON albums(repo_id);

CREATE TABLE IF NOT EXISTS album_member (
  album_id TEXT NOT NULL REFERENCES albums(id),
  file_id  TEXT NOT NULL REFERENCES files(id),
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL,
  pinned   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (album_id, file_id)
);

CREATE TABLE IF NOT EXISTS album_sync_rule (
  album_id           TEXT PRIMARY KEY REFERENCES albums(id),
  source_id          TEXT NOT NULL REFERENCES sources(id),
  include_subsources INTEGER NOT NULL DEFAULT 0,
  media_type         TEXT NOT NULL,
  filter_json        TEXT,
  sync_mode          TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS album_sync_state (
  album_id         TEXT PRIMARY KEY REFERENCES albums(id),
  source_id        TEXT NOT NULL REFERENCES sources(id),
  last_synced_at   TEXT,
  last_scan_cursor TEXT,
  status           TEXT
);

CREATE TABLE IF NOT EXISTS ops_history (
  id           TEXT PRIMARY KEY,
  repo_id      TEXT NOT NULL,
  op_type      TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  undo_json    TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_history_repo ON ops_history(repo_id);
