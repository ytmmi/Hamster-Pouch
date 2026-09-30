-- tag 库迁移 0001：四库统一 schema（RFC 0008 / D33-D37）。
--
-- 结构：库 1 tag 总库为权威全集（概念为锚，D33），库 2/3/4 以 tag.id 为外键的附加层。
-- 同构复用：内置基底库（data/system/tag_lib_base.sqlite3）、扩展词库包
-- （plugins-dist/tag-dict/data/tag_lib.sqlite3）、用户库（data/user/tag_lib_user.sqlite3）
-- 三者使用**完全相同**的 schema，便于聚合查询层统一处理（D36）。
--
-- 与 dict/0001_init.sql（RFC 0006 旧形态）的关系：本迁移是**新增**，不改动 dict/。
-- 旧 tag_dict.sqlite 保留作对照与回退（RFC 0008「与 RFC 0006 关系」）。
--
-- forward-only：本文件发布后禁止修改。

-- ===== 库 1：tag 总库（核心实体） =====
-- 一条记录 = 一个 tag 概念，持稳定唯一 ID；生态写法挂在 tag_source 下（D33）。
CREATE TABLE IF NOT EXISTS tag (
  id          TEXT PRIMARY KEY,           -- 稳定身份，跨库引用键
  kind        TEXT NOT NULL,              -- artist|work|character|general|meta|unknown（库 3 维度）
  nsfw        INTEGER NOT NULL DEFAULT 0, -- 0=安全 1=敏感
  popularity  INTEGER,                    -- 生态热度（多来源合并取最大）
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  extra_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tag_kind ON tag(kind);
CREATE INDEX IF NOT EXISTS idx_tag_popularity ON tag(popularity DESC);

-- 生态来源：一个概念可有多个原始 tag 写法（pixiv / danbooru / bangumi / manual）。
-- PRIMARY KEY (source, source_key) 保证一个生态 tag 只归属一个概念（D33）。
CREATE TABLE IF NOT EXISTS tag_source (
  tag_id     TEXT NOT NULL REFERENCES tag(id),
  source     TEXT NOT NULL,               -- pixiv|danbooru|bangumi|manual
  source_key TEXT NOT NULL,               -- 原始 tag 名
  popularity INTEGER,                     -- 该来源侧热度
  extra_json TEXT,
  PRIMARY KEY (source, source_key)
);
CREATE INDEX IF NOT EXISTS idx_tag_source_tag ON tag_source(tag_id);

-- ===== 库 4：别名与多语言映射（D37） =====
-- 每 (tag_id, lang) 至多一个 kind='standard'，其余为别名。
CREATE TABLE IF NOT EXISTS tag_name (
  tag_id  TEXT NOT NULL REFERENCES tag(id),
  lang    TEXT NOT NULL,                  -- zh|zh-Hant|ja|en|...
  value   TEXT NOT NULL,
  kind    TEXT NOT NULL,                  -- standard|alias|romanization|misspelling
  PRIMARY KEY (tag_id, lang, value)
);
CREATE INDEX IF NOT EXISTS idx_tag_name_value ON tag_name(lang, value);
-- 每语言每概念至多一个标准名（D37 的硬约束）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_name_standard
  ON tag_name(tag_id, lang) WHERE kind = 'standard';

-- ===== 库 3：分类映射（分类维度 + 三类专属字段，D35） =====
-- 原作：IP / 游戏 / 动画等
CREATE TABLE IF NOT EXISTS tag_work (
  tag_id     TEXT PRIMARY KEY REFERENCES tag(id),
  short_name TEXT,                        -- 常用简称，如 BA
  medium     TEXT,                        -- game|anime|manga|novel|music|vocaloid|...
  extra_json TEXT
);

-- 角色：同名角色靠 IP 识别（work_tag_id 指向原作概念）
CREATE TABLE IF NOT EXISTS tag_character (
  tag_id      TEXT PRIMARY KEY REFERENCES tag(id),
  work_tag_id TEXT REFERENCES tag(id),    -- 归属原作；爱丽丝#绝区零 与 爱丽丝#蔚蓝档案 由此区分
  extra_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tag_character_work ON tag_character(work_tag_id);

-- 艺术家：人类创作记人名，AI 创作记绘画模型名并精确到基座（D35）
CREATE TABLE IF NOT EXISTS tag_artist (
  tag_id      TEXT PRIMARY KEY REFERENCES tag(id),
  artist_kind TEXT NOT NULL,              -- human|ai_model
  person_name TEXT,                       -- artist_kind=human：人名
  base_model  TEXT,                       -- artist_kind=ai_model：绘画模型基座
  extra_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tag_artist_kind ON tag_artist(artist_kind);

-- ===== 库 2：关系映射（树状 / 网状，规则同 tag 表控件 D34） =====
-- 多父级 DAG；hierarchy 时 from 是 to 的上级。
CREATE TABLE IF NOT EXISTS tag_relation (
  id            TEXT PRIMARY KEY,
  from_tag_id   TEXT NOT NULL REFERENCES tag(id),
  to_tag_id     TEXT NOT NULL REFERENCES tag(id),
  relation_kind TEXT NOT NULL,            -- hierarchy|related
  created_at    TEXT NOT NULL,
  UNIQUE (from_tag_id, to_tag_id, relation_kind)
);
CREATE INDEX IF NOT EXISTS idx_tag_relation_from ON tag_relation(from_tag_id);
CREATE INDEX IF NOT EXISTS idx_tag_relation_to ON tag_relation(to_tag_id);

-- ===== 元信息 =====
-- 记录 version|generated_at|sources|counts，以及 source（base|extension|user，D36 三层）。
CREATE TABLE IF NOT EXISTS lib_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
