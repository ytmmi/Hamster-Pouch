-- tag 词库迁移 0001：初始 schema（对应 RFC 0006 决策 2 修正版）
-- 词库是应用级共享多语言词表（主中文、辅日/英），独立于全局配置库与仓库库。
-- forward-only：本文件发布后禁止修改。

-- 词库元信息：来源版本、更新说明等
CREATE TABLE IF NOT EXISTS dict_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 词条：一条生态 tag（pixiv name 或 danbooru name）一个词条
-- 中文主词为展示主字段（可重复，非唯一）；任意语言命中后按中文聚合返回
CREATE TABLE IF NOT EXISTS tag_dict_entries (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,              -- pixiv|danbooru|manual
  source_key TEXT NOT NULL,              -- 原始 tag 名
  zh         TEXT NOT NULL,              -- 中文主词（展示主字段）
  category   TEXT NOT NULL,              -- general|character|copyright|artist|meta
  popularity INTEGER,                    -- 生态热度（pixiv posts / danbooru post_count）
  nsfw       INTEGER NOT NULL DEFAULT 0, -- 0=安全 1=敏感
  extra_json TEXT,                       -- 原始分类文本、双语热度、wiki 摘要等
  created_at TEXT NOT NULL,
  UNIQUE (source, source_key)
);
CREATE INDEX IF NOT EXISTS idx_dict_entries_zh ON tag_dict_entries(zh);
CREATE INDEX IF NOT EXISTS idx_dict_entries_popularity ON tag_dict_entries(popularity DESC);

-- 翻译：一词条多语言、多值（同语言内 primary/alt）
CREATE TABLE IF NOT EXISTS tag_dict_translations (
  entry_id TEXT NOT NULL,
  lang     TEXT NOT NULL,                -- zh|ja|en
  value    TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'alt',  -- primary|alt
  FOREIGN KEY (entry_id) REFERENCES tag_dict_entries(id)
);
CREATE INDEX IF NOT EXISTS idx_dict_translations_entry ON tag_dict_translations(entry_id);
CREATE INDEX IF NOT EXISTS idx_dict_translations_value ON tag_dict_translations(lang, value);

-- 别名：俗称/简称/罗马音/旧称/常见错拼，仅用于检索命中，不作为展示主词
CREATE TABLE IF NOT EXISTS tag_dict_aliases (
  entry_id TEXT NOT NULL,
  lang     TEXT NOT NULL,                -- zh|ja|en
  value    TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES tag_dict_entries(id)
);
CREATE INDEX IF NOT EXISTS idx_dict_aliases_value ON tag_dict_aliases(lang, value);
