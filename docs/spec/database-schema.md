# 数据库 Schema 规格

状态：正式草案。本文是数据库实现的规格草案，字段可按实现细化，但不得反向修改 `docs/architecture/decision-checklist.md` 与 `docs/rfc/*.md` 中已确认的决策。

## 1. 边界回顾

- 应用有一个全局配置库（应用级），每个仓库一个独立 SQLite 文件（仓库级），另有一个应用级共享的 tag 词库独立 SQLite 文件（RFC 0006）。
- 全局库知道"有哪些仓库"；仓库库知道"这个仓库如何解释文件"；词库是"字典"——多语言参考词表（主中文、辅日/英），与仓库 tag 解耦，不参与仓库隔离。
- UI 不得直连任何 SQLite；所有读写经过 `hp-store` 通过 Tauri 命令桥接。
- 跨仓库默认禁止 JOIN/搜索；如未来需要，必须通过显式只读聚合服务。

## 2. 通用约定

- 表/列命名使用 `snake_case`；主键统一 `id`，外键命名 `{table}_id`。
- 所有时间戳使用 ISO 8601 文本（UTC），列名以 `_at` 结尾。
- 启用 `PRAGMA foreign_keys = ON` 与 `PRAGMA journal_mode = WAL`。
- 文件行采用软删除/状态标记，不物理删除索引（见 RFC 0001）。
- schema 迁移只向前（forward-only），每个迁移包在事务中执行。

## 3. 全局配置库

### 3.1 仓库注册表 `repos`

```sql
CREATE TABLE repos (
  id            TEXT PRIMARY KEY,          -- 仓库稳定 ID（UUID）
  name          TEXT NOT NULL,
  repo_db_path  TEXT NOT NULL,             -- 仓库库文件路径
  created_at    TEXT NOT NULL,
  last_opened_at TEXT
);
```

### 3.2 应用设置 `app_settings`

```sql
CREATE TABLE app_settings (
  key          TEXT PRIMARY KEY,           -- 主题/语言/默认扫描并发/缩略图缓存位置
  value        TEXT NOT NULL               -- JSON 编码值
);
```

### 3.3 面板布局 `panel_layouts`

```sql
-- 决策 D1：布局表放全局配置库，每行带 repo_id，按仓库读取/覆盖
-- 决策 D53（已落地，迁移 global/0004）：再加 layer_key —— 蓝图每层一份布局（层与布局 1:1）；
--   当前层按仓库持久化（D54，应用设置键 blueprint.currentLayer.{repo_id}），保存布局写当前层那一份。
-- 决策 D59：布局可绑定蓝图（blueprint_ids_json，迁移 global/0003 已落地）。
CREATE TABLE panel_layouts (
  id                 TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL,         -- 空串或特殊值表示全局默认布局
  workspace          TEXT NOT NULL,         -- 工作区标识（= 布局预设名，同名每层一行）
  layer_key          TEXT NOT NULL DEFAULT '', -- 蓝图层的 key（D53）；'' = 层无关行（迁移前旧预设，读取时兜底命中）
  blueprint_ids_json TEXT NOT NULL DEFAULT '[]', -- 绑定的蓝图 id 列表（D59）；生效取第一个（预设级，作用于全部层行）
  layout_json        TEXT NOT NULL,         -- 面板位置/大小/可见性
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_panel_layouts_repo ON panel_layouts(repo_id, workspace);
CREATE UNIQUE INDEX idx_panel_layouts_layer ON panel_layouts(repo_id, workspace, layer_key); -- 迁移 global/0004
```

> **默认布局标记**不在本表：实现走 `app_settings` 的键 `layout.default.{repo_id}`（与 `layout.setDefault/getDefault` 对应）。
>
> **`app_settings` 键空间**（见 3.2）：`ui.theme`、`ui.language`、`layout.default.{repo_id}`、`blueprint.currentLayer.{repo_id}`（D54：该仓库的当前层，层切换时写入、启动时读取）等；新增键必须登记，避免与列方案混淆。

### 3.4 插件注册表 `plugin_registry`

```sql
-- 全局安装；启用与能力授权是仓库级（见 plugin_repo_state）
CREATE TABLE plugin_registry (
  id            TEXT PRIMARY KEY,          -- 全局唯一插件 ID
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  trust_level   TEXT NOT NULL,             -- system|trusted|community|local-dev
  source_kind   TEXT NOT NULL,             -- system|git|local-path
  source_ref    TEXT,                      -- git URL + 锁定 commit/tag 或本地路径
  runtime_kind  TEXT NOT NULL,             -- external-process|dynamic-library|wasm
  installed_at  TEXT NOT NULL,
  manifest_json TEXT NOT NULL
);
```

### 3.5 插件仓库级状态 `plugin_repo_state`

```sql
-- 按仓库启用 + 按仓库能力授权（RFC 0004）
CREATE TABLE plugin_repo_state (
  plugin_id    TEXT NOT NULL,
  repo_id      TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 0,
  grants_json  TEXT NOT NULL DEFAULT '[]', -- 已授权能力列表（含高危标记）
  PRIMARY KEY (plugin_id, repo_id)
);
```

### 3.6 AI 提供方配置 `ai_provider_config`

```sql
-- 只保存配置引用，不保存密钥明文（RFC 0003）；密钥存储方式属于实现期开放点
CREATE TABLE ai_provider_config (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  model       TEXT,
  config_json TEXT NOT NULL,               -- 引用凭据句柄/端点等非敏感配置
  created_at  TEXT NOT NULL
);
```

### 3.7 蓝图模板 `blueprint_templates`（应用级共享）

```sql
-- 全局配置库迁移 global/0002_blueprint_templates.sql
-- 模板整文档存储，install = 一次复制（复制后与模板脱离）；无 repo_id（应用级共享）
CREATE TABLE blueprint_templates (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  blueprint_json TEXT NOT NULL,             -- 含 layers[] 与各节点 layer（D51/D52）
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
```

> 编号说明：本节原为 `### 3.6.1` 且错置在 `### 3.3` 与 `### 3.4` 之间（与 `3.6` = AI 提供方配置无隶属关系），2026-09 经 DB schema 对账（`docs/architecture/schema-drift.md` §5 Q1）移到此位并重编为 `3.7`。

## 4. 仓库库

### 4.1 仓库元信息 `repo_meta`

```sql
CREATE TABLE repo_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 键至少包含：name、schema_version、created_at
-- 注：**不含 `id`** —— 仓库 ID 的权威在全局库 `repos` 表，本表不再存一份（见 docs/issues 与 schema 对账 D-6）
```

### 4.2 媒体源挂载 `sources`

```sql
CREATE TABLE sources (
  id                TEXT PRIMARY KEY,
  repo_id           TEXT NOT NULL,
  local_path        TEXT NOT NULL,
  alias             TEXT,                  -- 自定义别名，可空
  parent_source_id  TEXT,                  -- 嵌套源；顶层可空
  mounted           INTEGER NOT NULL DEFAULT 1,
  mounted_at        TEXT NOT NULL,
  FOREIGN KEY (parent_source_id) REFERENCES sources(id)
);
CREATE INDEX idx_sources_repo ON sources(repo_id);
```

### 4.3 文件索引 `files`

```sql
-- 字段覆盖 RFC 0001 数据约束：身份=内容哈希；size/mtime/路径只用于变更发现
-- media_type 判定：扩展名优先 + 内容兜底（D11）
-- 音频占位行（D11）：media_type=audio，content_hash/perceptual_hash 为 NULL，
--   无缩略图，后续开放音频索引时原位升级
-- 视频（D14-D16）：全量媒体信息由 ffprobe 探测后缓存（存储形式见实现期开放点），
--   首帧缩略图扫描时由 ffmpeg 生成，thumb_status 标记是否已生成
CREATE TABLE files (
  id                        TEXT PRIMARY KEY,  -- 稳定文件 ID
  source_id                 TEXT NOT NULL,
  relative_path             TEXT NOT NULL,
  media_type                TEXT NOT NULL,     -- image|video|audio
  content_hash              TEXT,              -- 音频占位行可空
  content_hash_algo         TEXT,              -- 如 BLAKE3/SHA-256
  content_hash_algo_version INTEGER,
  perceptual_hash           TEXT,              -- 视频=首帧图像感知哈希（D12）
  perceptual_hash_algo      TEXT,
  perceptual_hash_algo_version INTEGER,
  size                      INTEGER NOT NULL,
  mtime                     TEXT NOT NULL,
  scan_time                 TEXT NOT NULL,
  verify_status             TEXT NOT NULL,     -- ok|changed|missing|unreadable|placeholder
  thumb_status              INTEGER NOT NULL DEFAULT 0, -- 0=未生成 1=已生成 -1=失败
  missing_status            INTEGER NOT NULL DEFAULT 0, -- 软删除/缺失标记
  media_info_json           TEXT,              -- 视频全量媒体信息（ffprobe 探测后缓存；迁移 repo/0002 以 ALTER TABLE 追加，故位于列尾）
  FOREIGN KEY (source_id) REFERENCES sources(id)
);
CREATE INDEX idx_files_source ON files(source_id);
CREATE UNIQUE INDEX idx_files_source_path ON files(source_id, relative_path);
CREATE INDEX idx_files_content_hash ON files(content_hash);
CREATE INDEX idx_files_media_type ON files(media_type);
```

视频全量元数据（音轨/字幕/章节等）**已定为列** `media_info_json`（迁移 `repo/0002_media_info.sql:4` 以 `ALTER TABLE` 追加，故位于 `files` 列尾，见上表）；**不得另建表**。

### 4.4 tag 实体与关联 `tags` / `file_tags` / `file_auto_tags`

```sql
-- tag 实体（人工与自动共用，D21）；按仓库独立（D23）
CREATE TABLE tags (
  id      TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  color   TEXT,                             -- 可空
  UNIQUE (repo_id, name)
);

-- 人工 tag 关联（D21）
CREATE TABLE file_tags (
  file_id    TEXT NOT NULL,
  tag_id     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, tag_id),
  FOREIGN KEY (file_id) REFERENCES files(id),
  FOREIGN KEY (tag_id)  REFERENCES tags(id)
);

-- 自动 tag 关联（D21：与人工关联表独立，不混在一起）
CREATE TABLE file_auto_tags (
  file_id      TEXT NOT NULL,
  tag_id       TEXT NOT NULL,
  confidence   REAL,                         -- AI 结果置信度
  source_model TEXT,                         -- 来源模型（AI）
  created_at   TEXT NOT NULL,
  PRIMARY KEY (file_id, tag_id),
  FOREIGN KEY (file_id) REFERENCES files(id),
  FOREIGN KEY (tag_id)  REFERENCES tags(id)
);
CREATE INDEX idx_file_auto_tags_file ON file_auto_tags(file_id);  -- 迁移 repo/0004
```

### 4.4.1 tag 关系 `tag_relations`

```sql
-- D22：tag 层级与关联，多父级 DAG，作为关系图谱组件的数据源；按仓库独立（D23）
CREATE TABLE tag_relations (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL,
  from_tag_id   TEXT NOT NULL,               -- 层级语义下为上级
  to_tag_id     TEXT NOT NULL,               -- 层级语义下为下级
  relation_kind TEXT NOT NULL,               -- hierarchy | related
  created_at    TEXT NOT NULL,
  UNIQUE (repo_id, from_tag_id, to_tag_id, relation_kind),
  FOREIGN KEY (from_tag_id) REFERENCES tags(id),
  FOREIGN KEY (to_tag_id)   REFERENCES tags(id)
);
CREATE INDEX idx_tag_relations_repo ON tag_relations(repo_id);
CREATE INDEX idx_tag_relations_from ON tag_relations(from_tag_id);   -- 迁移 repo/0005
CREATE INDEX idx_tag_relations_to   ON tag_relations(to_tag_id);     -- 迁移 repo/0005
```

### 4.4.2 AI tag 撤销记录 `ai_tag_undo`

```sql
-- 仓库库迁移 repo/0003_plugin_ai.sql（表 :6-15，索引 :17 / :18）
-- D6：AI 结果写入 file_auto_tags；高置信**覆盖**用户已有 tag 前，在此表保留**覆盖前状态**供撤销。
-- 注：该迁移头注释里的"AI 结果直接写入 file_tags"是 repo/0004 拆分**之前**的历史表述；
--     当前终态是 人工关联在 file_tags、自动关联在 file_auto_tags（D21），见 §4.4。
CREATE TABLE ai_tag_undo (
  id                TEXT PRIMARY KEY,
  repo_id           TEXT NOT NULL,
  file_id           TEXT NOT NULL,
  tag_id            TEXT NOT NULL,
  prev_source       TEXT NOT NULL,
  prev_confidence   REAL,
  prev_source_model TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_ai_tag_undo_repo ON ai_tag_undo(repo_id);
CREATE INDEX idx_ai_tag_undo_file ON ai_tag_undo(file_id);
```

三条必须写明的口径（否则规范读者会误判这张表）：

1. **`file_id` / `tag_id` 刻意没有外键**（**不要**为它补）。这不是遗漏：删除顺序由 `crates/hp-store/src/repo/purge_repo.rs:96`-`103` 的**显式删除**保证，理由记在 `purge_repo.rs:18`。且 SQLite 不支持 `ALTER TABLE ... ADD CONSTRAINT`，补外键必须重建表 —— 属刻意取舍，已登记为 `docs/issues/0007`。
2. **与 §4.4 的分工**：`file_tags` / `file_auto_tags` 存**当前**关联；本表存**撤销流水**（覆盖前状态），不是关联表，不参与 tag 展示与检索。读写落点：`crates/hp-store/src/repo/ai_undo_repo.rs:21`、`:45`、`:62`、`:82`、`:96`、`:108`。
3. **库分界**：插件**注册与授权**状态在**全局库**（§3.4 / §3.5）；**单文件级 AI 撤销记录**在**仓库库**（本表）。二者不要混淆 —— 本表虽然是由 `repo/0003_plugin_ai.sql` 建立的，但它与插件注册无关，纯粹是仓库内的 AI 撤销数据。

### 4.5 评分与色彩参考 `ratings` / `color_refs`

```sql
CREATE TABLE ratings (
  file_id     TEXT PRIMARY KEY,
  rating      INTEGER NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (file_id) REFERENCES files(id)
);

CREATE TABLE color_refs (
  file_id     TEXT PRIMARY KEY,
  color_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (file_id) REFERENCES files(id)
);
```

> `color_json` 是**派生缓存**的内容（列本身是不透明 JSON 文本，不进 schema 校验）：自动提取写
> `{"version":2,"colors":[…],"locked":false}`，其中 `version` = `hp_media::PALETTE_FORMAT_VERSION`
> ——前端 `apps/desktop/src/app_ui/shared/paletteJson.ts` 据此把**旧版本缓存当作「未提取」并自动重算**
> （色板规模从 6 改到 8 就是靠它自愈，D81）；手动锁定写 `locked:true`，**不受版本影响**。

### 4.6 相册（与 RFC 0002 数据模型草案一致）

```sql
CREATE TABLE albums (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL,
  parent_album_id TEXT,                      -- 嵌套；可空
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,             -- fixed|follow_source
  media_type      TEXT,                      -- image|video|audio|multimedia；可空=继承父相册（D10）
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (parent_album_id) REFERENCES albums(id)
);
CREATE INDEX idx_albums_repo ON albums(repo_id);

CREATE TABLE album_member (
  album_id  TEXT NOT NULL,
  file_id   TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  added_by  TEXT NOT NULL,                   -- user|sync_rule
  pinned    INTEGER NOT NULL DEFAULT 0,      -- 跟随型中用户手动固定
  PRIMARY KEY (album_id, file_id),
  FOREIGN KEY (album_id) REFERENCES albums(id),
  FOREIGN KEY (file_id) REFERENCES files(id)
);
-- 仓库库迁移 repo/0007：主键 (album_id, file_id) 只能按 album_id 前缀检索，"按文件反查相册"会退化为全表扫描。
-- 受影响的两条查询（`repo/0007:6-7`）：`list_album_source_members`（卸载源的影响评估）、
--   `list_album_ids_for_file`（源间复制继承成员关系）。
-- 实测 12 万行成员：卸载源的成员清点 639 ms → 8 ms（**约 80×**）。
CREATE INDEX idx_album_member_file ON album_member(file_id);

CREATE TABLE album_sync_rule (
  album_id           TEXT PRIMARY KEY,
  source_id          TEXT NOT NULL,
  include_subsources INTEGER NOT NULL DEFAULT 0,
  media_type         TEXT NOT NULL,          -- 与相册属性联动（D13），默认 multimedia
  filter_json        TEXT,                   -- DSL 属于实现期开放点
  sync_mode          TEXT NOT NULL,          -- add_only|mirror
  enabled            INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (album_id)  REFERENCES albums(id),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE album_sync_state (
  album_id        TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL,
  last_synced_at  TEXT,
  last_scan_cursor TEXT,
  status          TEXT,
  FOREIGN KEY (album_id)  REFERENCES albums(id),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);
```

### 4.7 操作历史 `ops_history`

```sql
-- 所有真实文件操作必须可记录（RFC 0001 / 模块边界）
-- op_type 含 album_media_change：相册属性变更移除成员时写入，供追溯
CREATE TABLE ops_history (
  id          TEXT PRIMARY KEY,
  repo_id     TEXT NOT NULL,
  op_type     TEXT NOT NULL,                 -- copy|move|rename|rebuild|sync|album_media_change
  payload_json TEXT NOT NULL,                -- 源/目标文件 ID、路径等
  undo_json   TEXT,                          -- 撤销所需数据；范围属于实现期开放点
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_ops_history_repo ON ops_history(repo_id);
```

### 4.8 tag 词库库（独立 SQLite 文件，RFC 0006）

> ⚠️ **本节已被 RFC 0008 / D33 / D36 / D37 取代**，仅作历史对照：实体锚点改为「概念」、交付改为「内置轻量基底 + 按需安装扩展包 + 用户数据层」、库文件改为 `tag_lib.sqlite`（`migrations/dict_lib/`）。**新实现以 `docs/rfc/0008-tag-libraries.md` 为准**，本节结构不得据以实现。

```sql
-- 词库是应用级共享的多语言词表（主中文、辅日/英），独立于全局配置库与仓库库。
-- 词条以原始生态 tag（pixiv/danbooru name）为锚，中文主词为展示主字段（可重复），
-- 任意语言命中后按中文聚合返回。词库访问经 hp-store 的 TagDictDb（只读为主）。

-- 词库元信息：版本、来源、生成时间等
CREATE TABLE dict_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 词条：一条生态 tag（pixiv name 或 danbooru name）一个词条
CREATE TABLE tag_dict_entries (
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
CREATE INDEX idx_dict_entries_zh ON tag_dict_entries(zh);
CREATE INDEX idx_dict_entries_popularity ON tag_dict_entries(popularity DESC);

-- 翻译：一词条多语言、多值（同语言内 primary/alt）
CREATE TABLE tag_dict_translations (
  entry_id TEXT NOT NULL,
  lang     TEXT NOT NULL,                -- zh|ja|en
  value    TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'alt',  -- primary|alt
  FOREIGN KEY (entry_id) REFERENCES tag_dict_entries(id)
);
CREATE INDEX idx_dict_translations_entry ON tag_dict_translations(entry_id);
CREATE INDEX idx_dict_translations_value ON tag_dict_translations(lang, value);

-- 别名：俗称/简称/罗马音/旧称/常见错拼，仅用于检索命中
CREATE TABLE tag_dict_aliases (
  entry_id TEXT NOT NULL,
  lang     TEXT NOT NULL,                -- zh|ja|en
  value    TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES tag_dict_entries(id)
);
CREATE INDEX idx_dict_aliases_value ON tag_dict_aliases(lang, value);
```

### 4.9 蓝图 `blueprints`（每仓库一份定义）

```sql
-- 仓库库迁移 repo/0006_blueprint.sql（**权威文本以该迁移文件为准**）
-- 整文档 JSON 存储，save = 整文档替换；is_default 每仓库唯一（D30）
-- 文档内 schema_version 为版本权威，本列必须同步写入（D52/版本迁移见 RFC 0007）
-- 层（D51）与浮层（D50）都在 blueprint_json 内部，不新增列/表
CREATE TABLE IF NOT EXISTS blueprints (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  is_default     INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1, -- 默认值 1 属历史遗留（迁移 forward-only 不改）；
                                             -- 所有写库路径必须显式写当前版本，不得依赖默认值（D58）
  blueprint_json TEXT NOT NULL,             -- { schema_version, layers[], nodes[], edges[] }
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blueprints_repo ON blueprints(repo_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blueprints_default
  ON blueprints(repo_id, is_default) WHERE is_default = 1;
```

## 5. 迁移策略

- 三库**共用同一个版本追踪机制**：`PRAGMA user_version`。读：`crates/hp-store/src/migrate.rs:12`；版本号以"迁移数组下标 + 1"推导（`migrate.rs:16`）；每次未执行版本单开事务执行后写回（`migrate.rs:23`）。三库分别在 `crates/hp-store/src/repo/repo_db.rs:71`、`crates/hp-store/src/global/global_db.rs:65`、`crates/hp-store/src/dict/dict_db.rs:41` 调用同一个 `migrate::apply`。
  - **当前仓库库版本 = 7**（`0007` 为 `album_member(file_id)` 索引；读 `repo_db.rs:92`）。
  - **当前全局配置库版本 = 4**（`global/0001_init` … `global/0004_layout_layers`，见 `crates/hp-store/src/global/global_db.rs:15`-`18` 的四个 `include_str!`）；全局库内**没有**镜像表（7 张表里没有 `global_meta`）。
  - **当前词库版本 = 1**（`dict_db.rs:19`）；`dict_meta`（`dict/0001:6-9`）是数据元信息 K/V，**不是** schema 版本。
- **`repo_meta.schema_version` 是**镜像键**，每次打开仓库库都按权威值回写**（2026-09 修复缺陷 0006）：`repo_db.rs:86`-`89`（`sync_schema_version_meta`）在 `repo_db.rs:78`-`79`（`open_inner` 汇总点，`migrate::apply` 与蓝图文档迁移之后）执行，**新建与打开两条路径共用这一处**，因此升级过的库不再与 `user_version` 分叉。回写**不能**下沉到 `migrate::apply`（`migrate.rs:10`）：那个执行器由仓库库/全局库/词库共用，且全局库与词库**没有** `repo_meta`。**版本判断一律以 `PRAGMA user_version` 为准**，不要读镜像键（该键仍无读取方）。
- 每个仓库库打开时都会 `busy_timeout = 5s`：**扫描与完全卸载各用一条独立连接**（不占用主连接锁，避免长任务把界面命令堵住），双连接在 WAL 下并存需要这个等待窗口。
- 每次启动比对并顺序应用未执行的迁移；迁移脚本存放在 `crates/hp-store/migrations/`（当前分 `repo/`、`global/`、`dict/` **三个**目录，共 12 个 `.sql`），按 `0001_xxx.sql` 编号。**`dict_lib/` 属 RFC 0008 的规划、尚未创建**（见 `docs/rfc/0008-tag-libraries.md:93`）——不要往不存在的目录加迁移。
- 每个迁移在事务中执行；失败则回滚并阻止打开仓库，提示备份/导出策略。
- 不允许修改已发布的迁移文件；新增需求一律追加新迁移。
- **JSON 内结构的演进不走 SQL 迁移**：如蓝图文档 schema v1→v2（D52）必须先改 `validate` 的版本闸门、再做 Rust 侧一次性回填（遍历 `blueprints` / `blueprint_templates`，迁移后回写 `blueprint_json` 并同步 `schema_version` 列）。

## 6. 实现期开放点（非架构决策）

- 内容哈希算法最终取值（BLAKE3 / SHA-256）；`content_hash_algo` 已预留字段。
- 感知哈希算法（pHash / dHash / aHash / 多算法并存）；视频首帧哈希复用图像算法（D12）。
- 密钥/AI token 的存储方式（Windows Credential Manager 或其他）。
- 仓库库文件命名与默认存放位置。
- `filter_json` 的具体 DSL 范围。
- `undo_json` 的撤销范围与交互方式。
- 缩略图缓存位置与清理策略（缓存不属于核心 schema，另行处理）。
- 后续新增媒体类型枚举值时的迁移方式（`media_type` 已存文本，扩展无需改列结构，仅需数据回填规则）。
