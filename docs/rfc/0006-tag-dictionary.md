# RFC 0006：多语言 tag 词库（Tag Dictionary）

状态：正式草案。已确认方向：建立"主中文、辅日语/英语"的图片 tag 多语言词库，作为应用级共享参考数据；词库与仓库内 tag（`tags` 表）解耦；数据获取以开放数据源为主、pixiv 爬取为补充。数据源已通过可行性验证（见"数据管线可行性验证"节）：主数据源为 ffdkj 的 Danbooru 与 pixiv 中英对照表（MIT 许可，每日更新），无需自爬。实现进度：数据模型与 `TagDictDb` 仓储已落地（hp-core `tag_dict.rs`、hp-store `dict/` + 迁移 0001）；数据管线已实现（`tools/tagdict/`，产出内置词库 222,632 词条）；AI 打标归一化、输入建议、跨语言检索等集成点待实现。

> **后续修订（RFC 0008）**：本文"决策 2：词条锚点改为原始 tag"一条已被 **D33 取代**——tag 库 1 改为**以概念为锚**（一条记录 = 一个 tag 概念，生态写法作来源证据），并统一为「库 1 概念总库 + 库 2 关系映射 / 库 3 分类映射 / 库 4 别名与多语言」四库结构。**交付方式亦被 D36 取代**：四库**不再作为应用内置数据**，改为**插件扩展级**——应用只内置轻量基底库，完整词库（含全量 artist）经插件系统安装为 `data-pack` 贡献，用户自定义落独立可写用户库；本文"决策 1：词库作为应用级共享数据随应用分发"的**内置交付部分**不再适用，但"逻辑上应用级共享、独立于仓库库、与仓库 tag 解耦"的语义继续有效。详见 `docs/rfc/0008-tag-libraries.md`。本文其余决策（与仓库 tag 解耦、AI 归一化集成点、数据管线与许可结论）继续有效。

## 背景

仓鼠颊的 tag 体系现状（D21/D22/D23）：

- 仓库内 tag 实体的 `name` 是**单一文本**，按仓库独立，人工/自动两组关联表分离。
- AI 打标（`hp-ai`）输出候选 tag 名 + 置信度，直接以名称落库。
- tag 表（层级树）、跨语言检索（D27 的 i18n 仅覆盖界面文案，不覆盖内容数据）。

现实痛点：

1. **AI 打标输出的 tag 语言不可控**。主流打标模型训练数据以英文（Danbooru 系）或日文（pixiv 系）为主，直接落库的 tag 与中文用户的认知不一致，tag 表里出现大量英文/日文条目。
2. **人工打标语言不统一**。用户习惯用中文，但二次元 tag 生态以日文（pixiv）和英文（Danbooru）为标准语言，跨语言检索（如用"照片"搜到标了"写真"的图）目前不可行。
3. **tag 生态存在现成多语言映射**。pixiv 的"写真"、Danbooru 的 "photo"、中文的"照片"指向同一概念，但没有任何一层数据把这些概念对齐。

## 术语与定位

- **tag 词库（tag dictionary）**：应用级共享的**多语言参考词表**。以中文主词为锚，记录同一概念的日语、英语映射，以及别名与分类。**不改变任何仓库内已打 tag 的数据**。
- **仓库 tag（repo tag）**：用户在某个仓库实际打的标签，`tags.name` 单一文本，按仓库隔离（D23）。词库与仓库 tag 通过"名称命中"关联，而非外键强约束。
- **词条（entry）**：词库中的一条记录，代表一个概念（一个中文主词及其多语言映射）。

词库是"字典"，仓库 tag 是"用法"。字典服务于打标建议、AI 结果归一化、跨语言检索、tag 表展示映射；字典不强制仓库改名、不参与仓库隔离。

## 目标

1. 设计"主中文、辅日语/英语"的图片 tag 词库数据模型（词条 + 多语言翻译 + 别名）。
2. 制定数据获取策略，含 pixiv tag 爬取的可行性评估与替代数据源。
3. 定义词库与现有体系的集成点：AI 打标归一化、打标输入建议、跨语言检索、tag 表展示。
4. 首期聚焦图片 tag；从人工精选核心集起步，可持续扩充（社区数据/增量更新）。

## 非目标

- **不改动现有 `tags` 表结构**（D21/D23 已确认，词库独立存在）。
- **运行时不做联网爬取**（D20 依赖与构建链本地化；数据获取是开发期一次性管线，产物随应用分发）。
- **不做视频 tag 词库**（首期聚焦图片，与 D17 一致）。
- **不做跨仓库共享 tag 实体**（词库是词表，不是仓库解释数据；D23 不变）。

## 决策

### 1. 词库定位：全局共享参考数据，独立文件存放

- 词库是**应用级数据**（类似内置字典），不是仓库解释数据，不受 D23 仓库隔离约束；所有仓库共享同一词库。
- 存放：**独立 SQLite 文件**（如 `tag_dict.sqlite`），与全局配置库、仓库库分离。全局配置库（`app_settings`）只保存词库引用（路径、schema 版本、更新时间）。
- 理由：
  - 词库数据量大（数万~数十万条），单独成库便于整体替换/升级，不污染配置库语义。
  - 迁移、备份、损坏恢复独立于仓库库；词库丢失不影响仓库 tag 数据。
  - 与既有"全局配置库 + 每仓库一库"的结构并列，符合模块边界（`hp-store` 增加词库仓储，不新增数据库引擎）。

### 2. 数据模型：词条 - 翻译 - 别名 三层（已按验证结果修正）

> **修正说明**：验证发现 pixiv 生态中**同一中文翻译可对应多个原始 tag**（如"写真"→`写真`(摄影) 与 `Gravure`(写真)；`女の子` 与 `Girl` 是不同 tag、不同热度）。若以中文主词为词条锚点（UNIQUE zh）会丢失生态热度信息。故**词条锚点改为"原始 tag"**（一条 pixiv/danbooru tag = 一个词条），中文主词作为展示主字段（允许重复），检索时按中文聚合。

```sql
-- 词条：一条生态 tag（pixiv name 或 danbooru name）一个词条
CREATE TABLE tag_dict_entries (
  id         TEXT PRIMARY KEY,          -- UUID
  source     TEXT NOT NULL,             -- pixiv|danbooru|manual（merged=人工合并词条）
  source_key TEXT NOT NULL,             -- 原始 tag 名（pixiv name / danbooru name）
  zh         TEXT NOT NULL,             -- 中文主词（展示主字段，可重复，非唯一）
  category   TEXT NOT NULL,             -- general|character|copyright|artist|meta（归一化后）
  popularity INTEGER,                   -- 生态热度（pixiv posts / danbooru post_count），排序用
  nsfw       INTEGER NOT NULL DEFAULT 0,-- 0=安全 1=敏感（本地软件不预设立场，展示层按设置隐藏）
  extra_json TEXT,                      -- 原始分类文本、双语热度、wiki 摘要等
  created_at TEXT NOT NULL,
  UNIQUE (source, source_key)
);
CREATE INDEX idx_dict_entries_zh ON tag_dict_entries(zh);
CREATE INDEX idx_dict_entries_popularity ON tag_dict_entries(popularity DESC);

-- 翻译：一词条多语言、多值（同语言内 primary/alt）
CREATE TABLE tag_dict_translations (
  entry_id TEXT NOT NULL,
  lang     TEXT NOT NULL,               -- zh|ja|en
  value    TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'alt', -- primary|alt（同语言内主译/备译）
  FOREIGN KEY (entry_id) REFERENCES tag_dict_entries(id)
);
CREATE INDEX idx_dict_translations_entry ON tag_dict_translations(entry_id);
CREATE INDEX idx_dict_translations_value ON tag_dict_translations(lang, value);

-- 别名：俗称/简称/罗马音/旧称/常见错拼，仅用于检索命中，不作为展示主词
CREATE TABLE tag_dict_aliases (
  entry_id TEXT NOT NULL,
  lang     TEXT NOT NULL,
  value    TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES tag_dict_entries(id)
);
CREATE INDEX idx_dict_aliases_value ON tag_dict_aliases(lang, value);
```

示例（验证实证，pixiv 数据）：**摄影/照片 概念簇**

| 词条（source_key） | zh（展示主词） | 翻译 | 来源 |
| --- | --- | --- | --- |
| pixiv `写真` | 摄影 | ja=`写真`，en=`Photo` | pixiv 对照表 |
| pixiv `Photo` | 照片 | ja=`写真`(alt)，en=`Photo` | pixiv 对照表 |
| pixiv `Gravure` | 写真（gravure） | en=`Gravure` | pixiv 对照表 |

输入"写真"命中上述多个词条并按热度排序返回——**中文是聚合键，不是唯一键**。

查询语义：**任意语言任意命中（词条主词/翻译/别名）→ 返回中文主词 + 全语言映射 + 同中文兄弟词条**。例如输入"写真"或"photo"或"照片"都能命中同一概念簇。

> 词条间关系（角色→作品、上位概念）可复用 D22 的 `tag_relations` 语义，但**首期不纳入词库**（见"暂不进入第一期"），避免与仓库 tag 关系混叠。

### 3. 分类体系：对齐二次元 tag 生态惯例

- `general`：通用视觉概念（姿势、服装、场景、发色、表情、画风、物体）。
- `character`：角色。
- `copyright`：作品 / IP（版权）。
- `artist`：作者。
- `meta`：工具 / 技术标记（AI 生成、手绘、分辨率、原图等）。

**数据源分类归一化映射**（管线清洗步骤，已按验证数据设计）：

- Danbooru `category` ID：0→general，1→artist，3→copyright，4→character，5→meta。
- pixiv `categories` 文本（逗号分隔多值）：`General/Design/Art`→general；`Character/Person`→character；`Game/Anime/Manga/Novel`→copyright；`Artist`→artist；其余/空→general。多值取首个可映射类别，原始文本保留于 `extra_json`。

首期数据范围聚焦 `general` + `character` + `copyright` 高频词；`artist`、`meta` 延后。

### 4. 数据来源与 pixiv 爬取可行性评估（核心决策）

#### 4.1 pixiv 直接爬取：技术可行，但合规风险与工程成本高，不推荐作为主数据源

调研结论（2025-2026 现状）：

- Pixiv **没有官方公开 API**。社区逆向的非官方接口（`https://www.pixiv.net/ajax/search/tags/{tag}`、`/ajax/illust/{pid}` 等）**需要登录态 `PHPSESSID` cookie**。
- Pixiv **强制请求频率限制**，单账号高并发批量请求有**封号/限号风险**（PixivFE 官方文档明确提示需多账号轮换）。
- Pixiv 服务条款（第 14 条"禁止行为"等）**未授权批量抓取**；社区实践停留在"个人学习研究 + 低频率访问"的灰色地带。
- 即便爬取成功，pixiv tag 本身**以日文为主**（部分英文/中文），**单 tag 不含可靠中文翻译**——无法直接满足"主中文"需求，仍需二次翻译加工。

**结论：pixiv 爬取不必要、不推荐。已验证存在每日更新的社区对照表（ffdkj/Pixiv_Tag-Chinese-English-Translation-Table，MIT 许可，数据源自 pixiv wiki 的公开 sitemap），直接满足"日文 tag + 中文译名 + 英文名"需求。**

#### 4.2 数据源分级（已验证，主源 = ffdkj 双对照表）

| 层级 | 来源 | 语言贡献 | 验证状态 |
| --- | --- | --- | --- |
| **主源 A（pixiv 侧）** | ffdkj/Pixiv_Tag-Chinese-English-Translation-Table（16.9 万条，posts≥100，每日更新） | ja/en 原始 tag + zh 译名 | ✅ 已下载验证（15.4MB，结构 `name/cn_name/en_name/posts/categories`，cn_name 空值率 0%） |
| **主源 B（danbooru 侧）** | ffdkj/Danbooru_Tag-Chinese-English-Translation-Table（32.8 万条，post_count≥10，每日更新） | en 标准 tag + zh 译名 | ✅ 已下载验证（23.1MB，结构 `name/category/cn_name/post_count`，cn_name 空值率 0%） |
| 实体权威名（zh） | Bangumi API（bgm.tv，开放） | 角色/作品中文权威名 | ⏳ 未验证（可选增强，防 LLM 翻译幻觉） |
| 精选核心集（zh/ja/en） | 人工校对 | 三语 | 规划中（数百~数千条高频词人工校验） |
| 备选源 | Hugging Face `deepghs/site_tags`（含 pixiv.net 全量 tag，csv/json/parquet/sqlite 四格式） | pixiv 原始 tag（无中文） | ✅ 目录可达（pixiv.net 下 tags.csv 21.8MB / tags.sqlite 38.3MB）；CDN 直连在本网络超时，作备选够用 |

> pixiv 主源 A 的 `en_name` 空值率 84.3%，英文缺口由主源 B 交叉补全（见"数据管线可行性验证"）；**自建 pixiv 爬虫仅在两个主源均不可用时才考虑**（见 4.3，已降级为最终兜底）。

#### 4.3 pixiv 自爬方案（最终兜底，仅在主源不可用时启用）

- 位置：`tools/` 下独立脚本（不内嵌运行时，符合 D20；产物是一次性生成的词库数据文件）。
- 约束：个人账号、低频率（数秒一次）、遵守 pixiv 服务条款、失败退避重试；产物仅供个人研究用途并入词库。
- 数据点：`/ajax/search/tags/{tag}`（tag 详情：件数、关联 tag）、作品页 tag + `translation` 字段（pixiv 官方 tag 翻译机制，第 22 条，含部分英译）。
- 输出：`pixiv_tags.json` → 导入词库日语列；中文列由主干数据交叉命中补全。

### 4.4 数据管线可行性验证（已执行，2026-09-15）

对主源 A/B 与备选源完成实测下载与结构/质量/交叉验证，结论：**数据管线完全可行，无需自爬**。

| 验证项 | 结果 |
| --- | --- |
| 主源 A（pixiv 表）可达性与结构 | ✅ GitHub raw 下载 15.4MB；表 `pixiv_tags(name, cn_name, en_name, posts, categories)`，169,438 行，与 README 一致 |
| 主源 A 质量 | ✅ `cn_name` 空值率 0%；日文 `name` 占比 44.3%（前 5 万条）；样本：`オリジナル→原创/Original`、`女の子→女孩子/Girl`、`巨乳→巨乳/Large Breasts`；`categories` 含 General/Character/Game/Anime/Manga 等 |
| 主源 A 英文缺口 | ⚠️ `en_name` 空值率 84.3%——需主源 B 交叉补全 |
| 主源 B（danbooru 表）可达性与结构 | ✅ GitHub raw 下载 23.1MB；表 `tags(name, category, cn_name, post_count)`，328,161 行 |
| 主源 B 质量 | ✅ `cn_name` 空值率 0%；样本：`1girl→单人女性`、`long_hair→长发`、`smile→微笑`、`highres→高分辨率`，质量良好 |
| **交叉命中（pixiv→danbooru）** | `cn_name`（中文）命中 22.5%（38,185 条）——**中文是两表最大交集**；`en_name` 命中 4.4%；`name` 直接命中 4.0%；至少一种命中 24.9%（42,119 条） |
| 词库规模估算 | pixiv 侧 169,438 + danbooru 侧（general/char/copyright 且 post_count≥100）53,194 - 中文交叉去重 ≈ **18 万词条**，SQLite 单文件约 40MB，本地承载无压力 |
| 备选源（site_tags） | ✅ HF 目录 API 可达（pixiv.net 下 tags.csv 21.8MB / tags.json 50.2MB / tags.parquet 5.4MB / tags.sqlite 38.3MB）；CDN 直连本网络超时，备选地位不变 |

**关键洞察（影响数据模型）**：pixiv 与 danbooru 是**两套独立 tag 体系**，名称级映射覆盖率低（约 25%），但**中文翻译是天然桥梁**——正符合"主中文"设计：词条以原始 tag 为锚，中文作展示主词，跨表融合走中文命中。同时实证"照片≠写真"的生态差异（pixiv 的 `写真` 译为"摄影"，中文"照片"对应 pixiv 的 `Photo`），说明词库应忠实记录生态真实映射，人工核心集再做中文用户习惯的校正补充。

**验证产物**（临时目录，供管线开发参考）：`danbooru_tags.sqlite`、`pixiv_tags.sqlite` 及验证脚本 `check_sqlite.py`、`check_pixiv.py`、`cross_hit.py`。

### 5. 与现有 tag 体系集成

| 集成点 | 行为 |
| --- | --- |
| **AI 打标归一化**（`hp-ai`） | 候选 tag（en/ja）回写前查词库：命中 → 以**中文主词**落库并保留原文于 `extra_json`；未命中 → 原样落库并标记 `unmapped`（供后续扩充词库）。词库不改变 D6/D21 的人工/自动分离与撤销机制。 |
| **打标输入建议**（`TagInput`） | 用户输入任意语言，建议列表展示"中文主词 + 次要语言对照"；选择后仍以中文主词落库。 |
| **跨语言检索**（`file.query`） | 检索词查词库展开为全语言集合 → 匹配仓库 tag 名称。首期可作为查询增强，不改数据库 schema。 |
| **tag 表展示**（`TagTablePanel`） | 词条命中的仓库 tag 显示中文主词（展示层映射）；未命中的 tag 原样显示。词条图标可复用 D24 的层级树视觉。 |
| **词库访问** | `hp-store` 新增词库仓储（只读为主）；Tauri 命令形态见"实现期开放点"。 |

### 6. 词库生命周期

- **内置词库**：精选核心集（人工校对）+ 高频扩展集，随应用分发（只读基础包）。
- **版本升级**：全局配置库记录词库 schema 版本；检测到新版本词库时整包替换文件（或增量导入，见开放点）。
- **用户自定义词条**：写入词库的 `source=manual` 层，与内置层分离；升级不丢失用户词条。

## 数据规模与质量策略（已确认：一步到位导入全量）

- **全量导入**：开发期数据管线一次拉取并清洗主源 A（pixiv 对照表 16.9 万条，posts≥100）与主源 B（danbooru 对照表 32.8 万条，按 `category` 过滤 general/character/copyright 且 `post_count≥100` 得 5.3 万条），经中文交叉融合后**约 18 万词条**（SQLite 单文件约 40MB，本地承载无压力）。
- **英文补全**：pixiv 词条 `en_name` 缺口（84.3%）由 danbooru 交叉命中补全（中文命中 22.5%）；补不上的保留英文空值（次要语言缺失可接受）。
- **精选核心集**：在全量之上人工校对高频常用词（数百~数千条）作为 `source=manual` 层，保证开箱质量与三语准确；并校正中文用户习惯与生态映射的差异（如"照片/写真"语义）。
- **NSFW**：词库收录但带 `nsfw` 标记；展示层按应用设置隐藏（本地管理软件不预设过滤立场）。
- **质量维护**：`source` 字段追踪词条来源；`manual` > `pixiv`/`danbooru` 的覆盖优先级；词库更新保留用户纠错（`manual` 覆盖不随内置层替换丢失）。

## 落地顺序建议（已确认：一步到位导入全量）

1. **数据模型落地**：词库 SQLite 文件 + `hp-store` 词库仓储（词库独立于仓库库，无迁移冲突）。
2. **数据管线**：开发期脚本下载 ffdkj 双对照表 → 清洗（分类归一化、热度过滤）→ 中文交叉融合 → 英文补全 → 生成内置词库数据文件 → 随应用分发。自建 pixiv 爬虫与 `site_tags` 仅为兜底。
3. **AI 打标归一化**：`hp-ai` 回写前查词库，中文主词落库。
4. **精选核心集校对**：人工校验高频词条，覆盖数据管线产出的低质量翻译，校正生态映射与中文习惯差异。
5. **打标输入建议与 tag 表展示映射**：打通 `TagInput` 与 `TagTablePanel`。
6. **跨语言检索**：`file.query` 词库展开。

## 暂不进入第一期

- 词条间关系（角色→作品等）——D22 的 `tag_relations` 已覆盖仓库内关系；词库关系图谱延后。
- `artist` / `meta` 分类词条。
- 运行时词库在线更新（网络能力与 D20 本地化原则冲突，延后评估）。
- 视频 tag 词库（D17 之后随 AI 打标扩展）。

## 风险与边界

- **数据再分发许可**：主源 A/B 均为 MIT 许可（已确认），可随应用分发并注明来源；备选源 `site_tags` 的再分发许可未核实，仅作备选。**自建 pixiv 爬虫存在条款风险，已从方案中剔除为最终兜底。**
- **翻译质量**：社区翻译表（LLM 生成）存在错译；通过人工核心集 + 用户纠错（`manual` 覆盖）兜底。
- **生态映射与中文习惯的差异**：实证 pixiv 的 `写真` 译为"摄影"、中文"照片"对应 `Photo`——词库忠实记录生态真实映射，中文习惯差异由精选核心集校正，不强行改写数据源。
- **词库与仓库 tag 解耦**：展示层映射可能造成"仓库存 'photo'、界面显示 '照片'"的认知差——通过 AI 归一化 + 输入建议逐步收敛，不强制改存量数据。
- **主源更新依赖**：两个主源为个人维护的每日更新仓库，存在停更风险；词库产物随应用版本固定，更新周期与应用发布周期解耦。

## 实现期开放点（非架构决策）

- 词库 SQLite 文件位置与命名（全局数据目录 vs 应用资源目录）。
- 词库升级机制：整包替换 vs 增量同步；版本号粒度。
- 多语言检索是否引入 SQLite FTS5 全文索引。
- 归一化匹配规则：大小写、下划线/空格、罗马音（如 "hatsune miku" vs "hatsune_miku" vs "初音ミク"）。
- 词库访问的 Tauri 命令形态：独立 `dict.*` 命令域 vs 并入 `tag.*`。
- 数据管线技术选型：Rust bin 子 crate vs Python 脚本（`tools/` 下）。验证脚本已用 Python 3.13 完成数据可行性验证，管线实现可直接复用其逻辑。
