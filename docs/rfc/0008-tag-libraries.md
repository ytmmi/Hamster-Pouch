# RFC 0008：tag 库（总库 / 关系映射 / 分类映射 / 别名与多语言）

状态：**已实施（构建完成）**。已确认方向：四个 tag 库统一为「**库 1 概念总库 + 库 2/3/4 功能补充层**」结构，库 1 的实体锚点由「原始生态 tag」改为「**概念**」。**tag 库不再作为应用内置数据交付**：应用只内置轻量基底，完整词库（含全量 artist）改为**按需安装的扩展包**，以减小应用体积。库数据在逻辑上仍是**应用级共享**的只读参考数据（不随仓库隔离）。**扩展包按生态来源细分为多个包**（见 D36.2）；承载沿用代码已实现的 `static-data` 运行形态（见 D36.1 结案）。

> **实施记录（本次构建）**：权威 DDL 落在 `crates/hp-store/migrations/dict_lib/0001_init.sql`；管线为 `tools/tagdict/build_tag_lib.py`（概念化全量）、`build_base_lib.py`（基底裁剪 + 库 2 种子）、`package_extensions.py`（细分打包）；验证为 `verify_tag_lib.py`（全绿）。Rust 侧新增 `hp-core/src/tag_lib.rs`（四库领域类型）与 `hp-store/src/dict/`（`tag_lib_db.rs` 单库句柄 + `tag_lib_write.rs` 用户库写入 + `tag_lib_set.rs` 三层聚合查询层 + `tag_lib_merge.rs` 重复概念归并；2026-09 按 1200 行规则从单个 `tag_lib_db.rs` 拆开）。详见下文「实施结果」。

## 背景

用户在原有「多语言 tag 词库」（RFC 0006）之外，补充规划四个库：

| 来源文本 | 库 | 定位原文 |
| --- | --- | --- |
| `tag库.txt` | 库 1 tag 总库 | 「包含所有 tag，为 tag 总库」 |
| `tag关系映射库.txt` | 库 2 tag 关系映射库 | 「系统内置的 tag 关系映射，树状或网状结构…本库不记录单个 tag，只记录有关系的，是功能补充库」 |
| `tag分类映射库.txt` | 库 3 tag 分类映射库 | 「本库不记录未分类 tag，只记录分类的，是功能补充库」 |
| `tag别名，多语言映射库.txt` | 库 4 tag 别名与多语言映射库 | 「映射别名和多语言，每个语言（如果有）选一个为标准名，其他为别名」 |

关键语义：库 2/3/4 均自称「**功能补充库**」。因此四库**不是四个平级、各自独立的库**，而是「库 1 为全集基底，库 2/3/4 以库 1 的 tag 身份为外键的附加层」。用户示例：

```text
库 2（关系）                     库 3（分类）
VOCALOID                          艺术家：人名（人类创作）/ 绘画模型名（AI 创作，精确到基座）
    初音未来                      原作：IP、游戏、动画等
        雪未来                    角色：同名角色靠 IP 识别
        樱未来                        #爱丽丝#绝区零
        fufu                          #爱丽丝#蔚蓝档案
    镜音铃
    镜音连
    巡音流歌
风格
    二次元
        技法
            赛璐珞 / 平涂（薄涂）/ 厚涂 / 伪厚涂（半厚涂）
        视觉
            Q版 / 写实 / 线条

库 4（别名与多语言）：zh 碧蓝档案、蔚蓝档案；jp ブルーアーカイブ、ブルアカ；en BlueArchive、BA
                     每语言择一为标准名，其余为别名
```

用户另要求：库 2「和 tag 表控件的规则一样」（即 D22/D24 的多父级 DAG、同名即同一节点、交叉标记）。

后续补充约束（本文已据此修订）：**tag 库完整数据不随应用分发，改为按需安装的扩展包，以减小应用体积**。四库不再作为应用内置的 `tag_lib.sqlite` 随包分发；应用侧只保留轻量基底。**扩展包是否经插件系统承载与安装，延后到构建时再讨论**（见 D36.1）。

### 现状与实测（`tools/tagdict/output/tag_dict.sqlite`，81.6MB）

| 项 | 实测值 |
| --- | --- |
| `tag_dict_entries` 总行数 | 222,632（pixiv 169,438 + danbooru 53,194） |
| 不同中文主词 `zh` | 182,207 |
| **中文主词被 2 条以上词条共享** | **25,246**（character 类 11,515；danbooru 单源内 1,217 / 涉及 16,892 行） |
| 中文主词跨 `category` 出现 | 4,337 |
| `tag_dict_translations` | 268,528（ja 154,579 / en 113,949 / **zh 0**） |
| `tag_dict_aliases` | **0（表完全空）** |
| `category` 分布 | general 67,642 / character 115,203 / copyright 39,787 / **artist 0** |

数据源（`tools/tagdict/data/danbooru_tags.sqlite`，328,161 行）实测分类分布：general 52,532 / **artist 152,097** / copyright 19,994 / character 102,798 / meta 740。现行管线 `DANB_CATEGORIES = {0, 3, 4}` **整体丢弃了 artist**。

## 决策

### D33 库 1 实体锚点：概念（而非原始生态 tag）

- 库 1 一条记录 = **一个 tag 概念**，持稳定唯一 ID；概念的生态写法（pixiv name / danbooru name）作为**来源证据**挂在概念之下。
- 理由：RFC 0006 原「原始 tag 为锚、中文主词可重复」（`UNIQUE (source, source_key)`）实测导致 25,246 个中文主词指向多条词条，无法承载「每语言一个标准名」，也无法为库 2/3/4 提供稳定外键。
- **概念合并必须以 `category` 为第一分区键**：4,337 个中文主词跨 category 出现（同一中文词既是角色又是通用词），跨类合并会污染库 3 分类。
- 合并判据（顺序）：同 category 内 → 中文标准名一致 → 英文标准名一致 → 日文标准名一致。冲突不合并，保留为多义概念，由分类区分。
- 影响：库 1 实体数由 222,632 收敛至约 182,000（不含 artist）；库 2/3/4 全部以库 1 `tag_id` 为外键。

### D34 库 2 作用域：应用级共享（内置基底 + 可扩展），与仓库级 `tag_relations` 并存

- 库 2 的数据分为两层：**应用内置基底**（VOCALOID / 风格等必要默认关系，随应用发布、体量极小）与**扩展关系包**（大型生态关系，按需安装，机制同 D36 待定）。
- 无论哪一层，库 2 数据在逻辑上都是**应用级共享**（所有仓库可见、只读），因为它是参考关系而非用户编辑结果。
- 仓库级 `tag_relations`（D22/D23）继续承载用户在**本仓库**绘制的层级/关联，按仓库隔离、可编辑。
- 两者**语义不同、不可互替、不自动同步**：仓库 tag 不自动继承库 2 关系；库 2 仅用于展示映射、关系建议与内置参考树。
- 库 2 沿用 tag 表控件规则（D22/D24）：多父级 DAG、同名即同一节点、`hierarchy`/`related` 区分、交叉标记。

### D35 库 3 与库 1 的关系：分类维度 + 专属字段，不独立重复存 tag

- 库 1 是 tag 概念的**权威全集**；库 3 是库 1 之上「分类维度」的权威定义，并为三类各带专属字段。
- 理由：用户写明库 3「不记录未分类 tag，只记录分类的」——若库 3 独立成表会与库 1 重复存储同一批 tag。
- 分类专属语义（对齐用户原文）：
  - **艺术家**：人类创作记人名（`artist_kind=human`）；AI 创作记绘画模型名，**精确到基座**（`artist_kind=ai_model`，`base_model`）。
  - **原作**：IP / 游戏 / 动画等。
  - **角色**：**同名角色靠 IP 识别**，以 `work_tag_id` 指向原作概念。
- **artist 全量纳入，不做热度过滤**（已确认）：danbooru artist 152,097 条全部入 `tag_source`。`cn_name` 空值率实测 0%，151,458 个不同中文名。

### D36 库交付形态：内置轻量基底 + 按需安装的扩展包（不再内置完整词库）

- **已确认的方向**：**取消**原「应用内置完整 `tag_lib.sqlite`」方案。完整四库数据（含全量 artist）**不随应用分发**，改为**按需安装的扩展包**，以减小应用体积；应用只内置轻量基底。
- **三层交付**：
  1. **内置基底库**：随应用发布、体量极小（目标数 MB 内）。保证开箱可用（基础中文标准名、常用分类、默认关系），不含全量 artist。
  2. **扩展词库包**：完整四库数据（约 150–250MB，含 artist 152,097 条），**按需安装／更新／卸载**。承载方式与安装机制**待定**（见 D36.1）。
  3. **用户数据层**：用户自定义概念与关系写入**可写的用户库**（`lib_meta` 标记 `source=user`），与扩展包物理分离，保证包更新与卸载不丢用户数据。
- **查询层**对「内置基底 + 已装配的扩展包 + 用户库」做统一视图，调用方不感知数据来自哪一层。**此聚合层不依赖插件系统的最终形态，可先行落地。**
- RFC 0006 的 `tag_dict.sqlite` 保留作对照与回退；迁移落在 `crates/hp-store/migrations/dict_lib/`（`dict/` 既有迁移 forward-only，不修改）。

### D36.1 与插件系统的衔接：**已结案（构建时定案）**

- **状态：已结案。** 本条原为「延后到构建时再讨论」，其**重新打开条件已触发**（tag 库进入构建实施），现按当时约定在构建时一并定案。
- **定案内容**：扩展包**沿用代码中已实现的 `static-data` 运行形态**承载，不新增 `data-pack` 档位。理由：
  - `RuntimeKind::StaticData`（`"static-data"`）**已实现**（`hp-core/src/plugin_types.rs` 的取值域、`hp-core/src/plugin_validate.rs` 的「`entry` 非空不适用于 StaticData」、`hp-plugin-host/src/manifest.rs` 的「StaticData 形态不需要 entry」、`host.rs` 的 `entry_path = None`），且此前的扩展包已在用；
  - 若按原候选新建 `data-pack`，会与已实现的 `static-data` 语义重复，需先废弃既有路径，成本高于收益。
  - 原候选中的 `contributions=["taglib"]`、能力 `taglib.read`/`taglib.write` **未采用**：宿主负责读取词库数据、插件不直连数据库（RFC 0004 边界），因此扩展包**不声明能力、不声明贡献点**（`capabilities: []`、`contributions: []`）。
- **仍需保证的约束（已落实）**：数据包**不执行代码**（无 `entry`）；**宿主负责读取词库数据**；完整词库**不随应用分发**（`plugins-dist/` 按需安装，D36）。
- **遗留未结案项**（不阻塞构建，见「延后事项登记」）：~~数据包的**启用语义**（应用级 vs 插件系统的仓库级）~~ → **已结案（D36.9：数据包无状态、安装即启用，界面不给启用开关）**；仍开放的只剩**大文件安装方式**（现有安装器整目录复制）。

### D36.2 扩展包按生态来源细分（构建时定案）

- **已确认**：扩展包**可以是多个，对应多个细分**；细分维度取**生态来源**（pixiv / danbooru），而非 kind。
- **命名**：包名必须**具体、简洁、按细分内容取名**，不用「字典」这类泛称。实际交付：
  - `plugins-dist/tagdict-pixiv`（id `dev.hamsterpouch.extension.tagdict.pixiv`）——pixiv 生态，135,679 概念；
  - `plugins-dist/tagdict-danbooru`（id `dev.hamsterpouch.extension.tagdict.danbooru`）——danbooru 生态（含 artist 全量），190,808 概念。
- **跨包重叠是刻意行为**：两源都有的概念（实测 18,961 个）在两个包中各出现一次。聚合层本就允许同一概念多层出现，覆盖优先级按 D36「用户库 > 扩展包 > 内置基底」。
- **依赖闭包（实现要求）**：角色的 `tag_character.work_tag_id` 可能指向**另一来源包**里的原作概念。若不一并纳入，本包该列即悬空外键（实测 pixiv 包 2,291 条 / danbooru 包 1,060 条）。因此打包时按 `work_tag_id` 拉入**依赖原作概念**（实测 pixiv +379 / danbooru +303），并在 `tag.extra_json` 标 `dependency=true`、在 `lib_meta.dependency_concepts` 记数。

### D37 库 4 三语对等：中文标准名入统一结构

- 库 4 每 `(tag, lang)` 至多一个 `standard`，其余为 `alias`（另含 `romanization` / `misspelling` 等）。
- 修正实测缺陷：现有 `tag_dict_translations` 中 `zh` 行数为 0（中文只存在 `entries.zh` 列），违反「每语言选一个为标准名」的对等要求。新结构中中文以 `lang='zh', kind='standard'` 正式入表。
- 覆盖用户示例：`碧蓝档案`(zh standard) / `蔚蓝档案`(zh alias)；`ブルーアーカイブ`(ja standard) / `ブルアカ`(ja alias)；`BlueArchive`(en standard) / `BA`(en alias) —— 四者命中同一 `tag_id`。

### D36.3 多扩展包之间的重复概念归并（构建时新增）

- **场景**：用户安装了多个 tag 词典扩展包（`tagdict-pixiv` + `tagdict-danbooru` + 第三方包），同一 tag 概念会在多个包里各出现一次，查询时**同一概念显示成多条**。
- **两层去重**（缺一不可）：
  1. **按 `tag_id` 去重**（已有）：`tag_id` 由 `sha1(kind + 中文归一)` **确定性派生**，所以同一次构建切出的细分包，重叠概念天然同 ID。实测 pixiv/danbooru 两包按 `(kind, 中文标准名)` 重叠 **19,675** 个概念，其中 **19,624** 个 ID 完全相同，这一层就能覆盖。
  2. **按概念身份归并**（本次新增）：**不同构建版本或第三方包**的 `tag_id` 会不同（数据源更新导致中文标准名变化，或第三方用别的 ID 方案）。此时仅按 ID 去重不够，必须按**概念身份**归并。
- **概念身份** = `kind` + 归一化标准名（优先中文，其次 ja/en，最后任意语言的标准名）。归一化口径与管线一致：小写、下划线归一为空格、去首尾空白。**`kind` 不同不合并**（D33：同名可跨 kind 合法多义）。
- **归并规则**：
  - **代表 ID** 取**优先级最高层**的概念 ID（用户库 > 扩展包 > 内置基底）；同层内取热度最高者。其余 ID 作为**别名 ID**，查询时一并命中。
  - **字段合并**：名称与来源取并集（去重）；热度取最大；`nsfw` 取或；库 3 专属字段取优先级最高层里非空的那个。
  - **关系重写**：库 2 关系的两端 ID 重写为代表 ID，自环丢弃、重复边去重（多个包各自贡献同一层级边时合并）。
  - **无标准名的概念不参与归并**（按独立概念处理，避免误合）。
- **作用域**：归并只作用于**查询视图**，不改动任何数据包文件（数据包是只读资产，D36）。
- **实现**：`crates/hp-store/src/dict/tag_lib_merge.rs`（`MergeIndex` / `ConceptKey` / `MergedConcept`）；`TagLibSet::refresh_merge()` 在装配完全部扩展包后构建一次，之后 `find` / `suggest` / `merged_concept` / `relations_of` / `relation_nodes` 自动走归并。
- **实测（pixiv + danbooru 两包）**：归并后 **304,572** 个概念身份，识别并合并 **2,272** 条 ID 不同的重复概念（另有 19,624 条由 `tag_id` 去重覆盖）。装配与建索引耗时约 **5 秒**（一次全表扫描/层，不逐概念查库）。
  - **四层全装（基底 + pixiv + danbooru + tagrel-games）实测 304,575**：差值 3 来自基底库独有的 `manual` 种子概念（扩展包中不存在），非口径变化。
- **性能要求（实现约束）**：索引构建**必须**每层一次全表扫描（`all_concepts_brief` + `all_names_grouped`）。逐概念调用 `concept()` 会为每个概念跑 4 条子查询，30 万概念实测耗时 **149 秒**（优化后 4.9 秒）。

## 数据模型草案

统一前提：schema 由**内置基底库、扩展词库包、用户库**共用（三者同构，便于聚合查询）；所有补充库以 `tag.id` 为外键。数据包内的库为只读，用户库可写。

```sql
-- ===== 库 1：tag 总库 =====
CREATE TABLE tag (
  id          TEXT PRIMARY KEY,          -- 稳定身份，跨库引用键
  kind        TEXT NOT NULL,             -- artist|work|character|general|meta|unknown（库 3 维度）
  nsfw        INTEGER NOT NULL DEFAULT 0,
  popularity  INTEGER,                   -- 生态热度（多来源合并取最大）
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  extra_json  TEXT
);
CREATE INDEX idx_tag_kind ON tag(kind);
CREATE INDEX idx_tag_popularity ON tag(popularity DESC);

-- 生态来源：一个概念可有多个原始 tag 写法（pixiv / danbooru / bangumi / manual）
CREATE TABLE tag_source (
  tag_id     TEXT NOT NULL REFERENCES tag(id),
  source     TEXT NOT NULL,              -- pixiv|danbooru|bangumi|manual
  source_key TEXT NOT NULL,              -- 原始 tag 名
  popularity INTEGER,                    -- 该来源侧热度
  extra_json TEXT,
  PRIMARY KEY (source, source_key)
);
CREATE INDEX idx_tag_source_tag ON tag_source(tag_id);

-- ===== 库 4：别名与多语言映射 =====
-- 每 (tag_id, lang) 至多一个 kind='standard'，其余为别名
CREATE TABLE tag_name (
  tag_id  TEXT NOT NULL REFERENCES tag(id),
  lang    TEXT NOT NULL,                 -- zh|zh-Hant|ja|en|...
  value   TEXT NOT NULL,
  kind    TEXT NOT NULL,                 -- standard|alias|romanization|misspelling
  PRIMARY KEY (tag_id, lang, value)
);
CREATE INDEX idx_tag_name_value ON tag_name(lang, value);
CREATE UNIQUE INDEX idx_tag_name_standard ON tag_name(tag_id, lang) WHERE kind = 'standard';

-- ===== 库 3：分类映射（分类维度 + 专属字段） =====
-- 原作：IP / 游戏 / 动画等
CREATE TABLE tag_work (
  tag_id     TEXT PRIMARY KEY REFERENCES tag(id),
  short_name TEXT,                       -- 常用简称，如 BA
  medium     TEXT,                       -- game|anime|manga|novel|music|vocaloid|...
  extra_json TEXT
);

-- 角色：同名角色靠 IP 识别
CREATE TABLE tag_character (
  tag_id      TEXT PRIMARY KEY REFERENCES tag(id),
  work_tag_id TEXT REFERENCES tag(id),   -- 归属原作；爱丽丝#绝区零 与 爱丽丝#蔚蓝档案 由此区分
  extra_json  TEXT
);
CREATE INDEX idx_tag_character_work ON tag_character(work_tag_id);

-- 艺术家：人类记人名，AI 创作记绘画模型名（精确到基座）
CREATE TABLE tag_artist (
  tag_id      TEXT PRIMARY KEY REFERENCES tag(id),
  artist_kind TEXT NOT NULL,             -- human|ai_model
  person_name TEXT,                      -- artist_kind=human：人名
  base_model  TEXT,                      -- artist_kind=ai_model：绘画模型基座
  extra_json  TEXT
);
CREATE INDEX idx_tag_artist_kind ON tag_artist(artist_kind);

-- ===== 库 2：关系映射（树状 / 网状，规则同 tag 表控件） =====
CREATE TABLE tag_relation (
  id            TEXT PRIMARY KEY,
  from_tag_id   TEXT NOT NULL REFERENCES tag(id),  -- hierarchy 时 from 是 to 的上级
  to_tag_id     TEXT NOT NULL REFERENCES tag(id),
  relation_kind TEXT NOT NULL,                     -- hierarchy|related
  created_at    TEXT NOT NULL,
  UNIQUE (from_tag_id, to_tag_id, relation_kind)
);
CREATE INDEX idx_tag_relation_from ON tag_relation(from_tag_id);
CREATE INDEX idx_tag_relation_to ON tag_relation(to_tag_id);

-- ===== 元信息 =====
CREATE TABLE lib_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                    -- version|generated_at|sources|counts
);
```

用户示例落库示意：库 2 `VOCALOID → 初音未来`、`初音未来 → 雪未来/樱未来/fufu`（`hierarchy`）；`风格 → 二次元`、`二次元 → 技法/视觉`（「二次元」多子级 = 多叉/网状）；`技法 → 赛璐珞/平涂/厚涂/伪厚涂`。

## 数据管线改造（`tools/tagdict/`）——**已实施**

管线脚本（均以 `crates/hp-store/migrations/dict_lib/0001_init.sql` 为**唯一 DDL 权威源**，避免 schema 双写漂移）：

| 脚本 | 职责 |
| --- | --- |
| `build_tag_lib.py` | 概念化全量构建（四库）；`--split-by-source` 按生态来源切分细分包 |
| `build_base_lib.py` | 从全量库裁剪内置基底（按 kind 配额 + 库 2 种子强制纳入） |
| `package_extensions.py` | 把细分库打成 `plugins-dist/` 下的扩展包（manifest + README + CHANGELOG） |
| `verify_tag_lib.py` | 验收（用户示例、库 2 往返、D37 唯一性、外键、库 3 一致性） |

实施与原规划的差异（均已按用户确认执行）：

1. **纳入 artist（D35，全量）**：danbooru category `1` **152,097 条全部纳入**、不设 `post_count` 门槛。**修正原规划的一处错误**：原文写「pixiv `Artist` 类别同步纳入」，但**实测 pixiv 侧不存在 `Artist` 类别（0 行）**——其 categories 词表只有 Character/General/Game/Anime/Manga/Person/Design/Novel/Music/Art/Event/Quote/Doujin/Figure。**艺术家的唯一来源是 danbooru**（pixiv 规则保留以备数据源补齐）。
2. **概念合并（D33）**：按 `kind` 分区，分区内按 **zh 归一 → en 归一 → ja 归一** 级联合并（并查集）。**zh 归一指去括号后缀**（用户确认）：实测 47.6% 的中文名带 `（VOCALOID）` 这类后缀，不归一会让 `初音未来（VOCALOID）` 与 `初音未来` 分裂成两个概念、与库 2 示例冲突。
3. **三语对等（D37）**：中文标准名写入 `tag_name(lang='zh', kind='standard')`；每 `(tag, lang)` 至多一个 `standard` 由**部分唯一索引**强制。
4. **别名填充**：写 `tag_name(kind='alias')`。**两处实现要求（实测踩坑）**：
   - 括号后缀是**消歧限定符**而非别名。若无条件登记，检索「蔚蓝档案」会命中 **918 个**无关概念（`茶会（蔚蓝档案）` 的后缀被登记为 `茶会` 的别名）。故**仅当后缀不与任何既有概念名重合时才登记**，其余只留在 `extra_json.suffixes`（信息不丢，仍用于归属原作推断）。
   - 「已知名称」集合必须**跨语言**收集。只收 zh 名时，后缀 `ブルーアーカイブ`（某 work 的 ja 标准名）会被当作新别名登记到 **108 个**角色概念上。修复后 `蔚蓝档案` 命中 2、`碧蓝档案` 1、`ブルーアーカイブ` 1。
   - pixiv 的**汉字名**（`碧蓝档案` / `蔚藍檔案`）原先被误判为英文（无假名），导致错过已知集合；现按汉字识别归入 zh 别名。
5. **分类专属字段**：角色 → `work_tag_id`；AI 模型 → `base_model`。**仅无歧义时写 `work_tag_id`**：一个概念可能合并了多个作品的角色（`爱丽丝` 合并了 45 个作品的同名角色），多个后缀解析出不同 work 时留空、候选记入 `extra_json.work_candidates`，避免错误归属。
6. **库 2 初始数据**：**人工内置**，种子文件 `tools/tagdict/data/lib2_relations.json`（用户给出的 VOCALOID / 风格示例树）。种子中在扩展库不存在的节点（实测 3 个：`樱未来` / `fufu` / `赛璐珞`）以 `source=manual` 新建概念，保证示例树完整往返。
7. **双层切分**：基底按 **kind 配额**（general/character 各 3,000、work 1,500、artist 600）而非全局 Top-N——全局排序会被 15 万 artist 占满；库 2 种子节点及其祖先/后代**强制纳入**（否则内置关系树会指向基底库中不存在的 tag）。

## 实施结果（实测）

### 交付物

| 层 | 文件 | 概念 | 名称 | 体积 |
| --- | --- | --- | --- | --- |
| 内置基底库（DB-1） | `data/system/tag_lib_base.sqlite3` | 8,110 | 40,282 | **12.07 MB** |
| 扩展包 · pixiv（DB-2a） | `plugins-dist/tagdict-pixiv/data/tag_lib.sqlite` | 135,679 | 405,035 | **128.7 MB** |
| 扩展包 · danbooru（DB-2b） | `plugins-dist/tagdict-danbooru/data/tag_lib.sqlite` | 190,808 | 548,027 | **161.6 MB** |
| 用户库（DB-3） | `data/user/tag_lib_user.sqlite3` | 运行时创建 | — | — |
| 全量（构建中间产物） | `tools/tagdict/output/tag_lib.sqlite` | 306,844 | 844,280 | 268.3 MB |

### 全量库规模（对比规划预估）

| 表 | 行数 | 规划预估 |
| --- | --- | --- |
| `tag`（概念） | **306,844** | 约 33 万（含 artist） |
| `tag_source`（生态写法） | **374,729** | 374,729 ✅ 完全吻合 |
| `tag_name` | **844,280** | 未预估 |
| `tag_artist` | 142,959 | — |
| `tag_character` | 80,159 | — |
| `tag_work` | 31,497 | — |

- kind 分布：artist 142,959 / character 80,159 / general 52,229 / work 31,497。
- 概念数**低于预估的 33 万**，原因是去括号归一额外合并了 26,934 个概念（规划预估时未计入此项）。
- 体积 **268.3MB（全量）/ 128.7 + 161.6MB（细分）**，略高于规划预估的 150–250MB，符合「实测偏上沿」的预期。
- 角色归属原作：无歧义解析 **50,728 / 80,159**；多义留空 4,340；无信号 25,091。
- `work_tag_id` 补全仍依赖外部实体源（Bangumi 未验证），多义者已保留候选。

### 验收（`verify_tag_lib.py` 全绿）

- **用户示例四语命中同一概念**：`碧蓝档案` / `蔚蓝档案` / `ブルーアーカイブ` / `ブルアカ` / `BlueArchive` / `Blue Archive` → 全部命中 `tag-1a4deaf60eceb34a`（work），标准名为 zh`蔚蓝档案` / ja`ブルーアーカイブ` / en`Blue Archive`。
- **库 2 用户示例两棵树完整往返**：17/17 父子关系可还原（`VOCALOID → 初音未来 → {雪未来, 樱未来, fufu}`；`风格 → 二次元 → {技法, 视觉}` 及其子级）。
- **D37**：每 `(tag, lang)` 至多一个 `standard`；**外键完整性**无违规（含细分包的依赖闭包）；**库 3** 三张专属表全部指向对应 kind；库 2 无自环；库 2 与仓库级 `tag_relations` 表名不混用。

### 一处已知数据源噪声（不阻塞，按 D33 保持现状）

`BA` 未命中 work 概念，而是落在 general / character 上。根因：pixiv 把 `BA` 与 `Archive` 的 categories 标为 `General`，而同 `cn_name`（蔚蓝档案）的其余 10 行是 `Game`。按 D33「kind 为第一分区键、冲突不合并」，它们无法自动合并。**这是数据源的分类噪声，不是管线缺陷**；RFC 0008 验收条款中的 `BA` 示例因此未能满足。全库同类跨 kind 同名共 **12,029 组**（多为合法的多义概念，如某名字既是角色又是画师名），按 D33 保持不合并。

## 扩展包承载与安装（D36）——**已定案**（见 D36.1/D36.2）

### 分层与体积

| 层 | 内容 | 承载 | 随应用体积 |
| --- | --- | --- | --- |
| 内置基底库 | 基础中文标准名、常用分类、默认关系（VOCALOID / 风格示例层）、库结构 | `data/system/`（只读） | 12.07 MB |
| 扩展词库包 | 细分四库数据（pixiv / danbooru，danbooru 含 artist 全量） | `plugins-dist/`，`static-data` 形态，按需安装 | **0** |
| 用户数据层 | 用户自定义概念、别名、关系 | `data/user/tag_lib_user.sqlite3`（可写） | 极小 |

### 数据包形态（实际）

```text
tagdict-pixiv/           # 或 tagdict-danbooru/
  plugin.manifest        # runtime.kind = "static-data"；无 entry、无能力、无贡献点
  data/tag_lib.sqlite    # 四库数据（D33-D37 的 schema）
  README.md              # 数据来源与许可（ffdkj MIT）
  CHANGELOG              # 版本与计数
  SHA256SUMS             # 由 tools/sign-plugin.mjs 生成
  SHA256SUMS.sig         # Ed25519 签名（已签发，自验证通过）
```

- **不复制大文件（待定）**：现有安装器 `PluginInstaller` 会 `copy_dir` 整个源目录到 `<root>/<plugin_id>/<version>/`，对 250MB 数据包会翻倍占用磁盘。届时需改为**引用安装**（登记源路径 + 锁定 ref，不复制），或至少对 `data/` 免复制；具体随插件系统定案。
- **不做运行时联网**：沿用 RFC 0006 非目标与 D20——数据获取是用户显式触发的安装行为，非运行时爬取。

### 宿主侧装载与查询（草案）

- 应用启动时枚举**已装配**的词库来源，逐一以只读方式打开其 SQLite；查询层聚合，对调用方暴露统一 `lookup` / `suggest` / 关系与分类查询（与现 `TagDictDb` 接口同形）。
- 内置基底与用户库按同一方式并入查询层；`TagDictDb` 由「单库句柄」演进为「多来源聚合句柄」。此演进**不依赖插件系统的最终形态**，可先行。
- 用户写入只落用户库（可写），词库包保持只读，包更新与卸载不影响用户数据。

### 装配与生命周期（草案）

- **安装**：具体命令与来源形态随插件系统定案（见「实现期开放点」）。
- **启用/停用**：候选为**应用级**；若沿用插件系统现有的仓库级启用语义会产生冲突，需届时一并解决。
- **更新**：锁定版本 + 手动更新，保留旧版本目录，回滚即切回旧目录（若复用 RFC 0004 既有机制）。
- **卸载**：移除词库包，用户库保留；仓库 tag 不受影响（词库与仓库 tag 本为解耦）。
- **与内置基底冲突**：同一概念多层出现时以「用户库 > 扩展包 > 内置基底」优先，`lib_meta.source` 记录来源层。

## 版本与数据治理

- **版本记录**：每层各自记录 `lib_meta.version` / `generated_at` / `sources` / `counts`；查询层汇总展示。
- **升级粒度**：整包替换文件或增量导入（粒度属实现期开放点）；数据包版本与应用发布周期解耦（RFC 0006 风险项）。
- **用户数据不丢**：用户自定义在独立可写库，插件包升级/卸载均不触碰。
- **与 RFC 0006 关系**：`tag_dict.sqlite` 保留为对照与回退；本 RFC 确认后 RFC 0006 的实体锚点决策由 D33 取代、内置交付方式由 D36 取代，其余（应用级共享语义、与仓库 tag 解耦、AI 归一化集成点、许可结论）沿用。
- **许可再分发**：主源为 MIT（ffdkj 双对照表），扩展包须在 `README.md` 注明来源与许可（RFC 0006 风险项）。


## 集成点（不改仓库 schema）

以下集成点全部经由**聚合查询层**（内置基底 + 已启用扩展包 + 用户库），不直接依赖某一个库文件。

| 集成点 | 行为 |
| --- | --- |
| 仓库 tag → 库 tag | `tags.name` 与 `tag_name.value`（任意语言、standard 或 alias）名称命中，弱关联、不建外键（沿用 RFC 0006「词库与仓库 tag 解耦」） |
| AI 打标归一化（`hp-ai`） | 候选回写前查聚合层；命中 → 以中文标准名落库，原文进 `extra_json`；未命中 → 原样落库并标 `unmapped`（未安装扩展包时命中率下降） |
| 打标输入建议（`TagInput`） | 任意语言前缀命中，建议列表展示「标准名 + 次要语言对照 + 分类图标」 |
| 跨语言检索（`file.query`） | 检索词经库 4 展开为全语言集合，再匹配仓库 tag 名称 |
| tag 表展示（`TagTablePanel`） | 命中的仓库 tag 显示中文标准名；库 2 可作参考树（用户要求「规则一样」）；仓库级编辑仍走 `tag_relations` |
| 分类筛选 | 库 3 的 artist/work/character 维度可作为检索与展示的分类面 |
| 词库管理 | 扩展包的装配状态、覆盖率、启停入口（是否做成面板待定；若经插件系统承载则由插件贡献面板，走受控 schema 渲染） |

## 落地顺序

1. **T1 库 1 身份统一**：建立 `tag` / `tag_source` / `tag_name` 三表（先落入内置基底库）+ 管线改为概念化产出。验证：实体数收敛、同名角色不误合、旧 `TagDictDb` 测试迁到新结构后通过。
2. **T2 扩展包装配与聚合查询层**：多来源聚合查询（内置基底 / 扩展包 / 用户库）+ 扩展包的装配、版本记录、覆盖优先级。**本阶段不涉及插件系统**（仅定义好装配接口与数据边界）。验证：装配一个扩展包后查询层可见其词条；卸载后用户数据保留；应用体积不随扩展包增长。
3. **T3 库 4 别名与多语言**：三语 `standard` + `alias` 落全（含中文入表）；`lookup` / `suggest` 改查聚合结构。验证：`碧蓝档案 / 蔚蓝档案 / ブルアカ / BA` 命中同一 tag。
4. **T4 库 3 分类映射**：三张专属表 + 管线纳入 artist 全量并打成扩展包。验证：`爱丽丝#绝区零` 与 `爱丽丝#蔚蓝档案` 为两个 tag；`artist_kind` 区分人类/AI 且 `base_model` 到基座。
5. **T5 库 2 关系映射**：`tag_relation` + 内置基底示例数据（VOCALOID / 风格）+ 关系查询（父/子/交叉标记）。验证：用户两棵示例树完整往返；与仓库级 `tag_relations` 语义不混淆。
6. **T6 集成**：仓库 tag 名称映射、`TagInput` 建议、tag 表展示、跨语言检索。

## 风险

- **概念误合**：跨 kind 的中文标准名**不得**合并（实测 12,029 组跨 kind 同名，多为合法多义）。管线以 `kind` 为第一分区键，已验证。
- **同名角色**：`work_tag_id` 补全依赖外部实体源（Bangumi 未验证）。当前实测无歧义解析 50,728/80,159；**多义 4,340 个留空并保留候选**（`extra_json.work_candidates`），期间同名角色无法自动区分。
- **artist 全量体量（142,959 概念）**：会使库 1 规模与 `popularity` 排序语义显著变化（artist 热度与前几类不同量纲）；跨类别排序需分维度处理，不能直接混排。
- **D23 边界**：库 2 为应用级共享，D22/D23 的 tag 关系为仓库级隔离；两者并存，实现期必须防止混用同一张表或互相写入。已用**不同类型名**（`LibRelation` vs `TagRelation`）与**不同表名**（`tag_relation` vs `tag_relations`）在代码层隔离，并有测试断言。
- **零安装可用性**：tag 库改为按需安装后，未安装扩展包时只剩内置基底（8,110 概念）——AI 归一化、跨语言检索、tag 表展示映射的**覆盖率大幅下降**。这是已接受的取舍（D36），不是缺陷。
- **启用语义冲突（仍未结案）**：tag 数据是应用级共享，而插件系统现行为「启用是仓库级」；若经插件系统承载需解决该冲突，否则同一数据包在各仓库行为不一致。
- **大文件安装成本（仍未结案）**：现有安装器整目录复制，扩展包 128.7/161.6MB 会翻倍占用磁盘；需改引用安装或对 `data/` 免复制。
- **多来源聚合复杂度**：内置基底 + 多个扩展包 + 用户库的合并查询有优先级、去重与性能问题。当前实现为**逐库查询 + 内存合并**（非 `ATTACH`），覆盖顺序已定为「用户库 > 扩展包 > 内置基底」，概念行取最高优先级层、名称与来源做并集。
- **数据包供应链**：数据包无代码执行、风险低于代码插件，但仍可投毒词条数据（错误翻译、错误分类）；建议校验 `lib_meta` 与 schema 版本，并允许用户停用。当前扩展包已带 Ed25519 签名（`SHA256SUMS.sig`）。
- **数据源**：两个主源为个人维护的每日更新仓库，存在停更风险；产物版本随应用固定。

## 延后事项登记

D36.1 的**重新打开条件已触发并结案**（承载方式定案为 `static-data`，见 D36.1）。下表登记**仍未结案**的项。

| 延后项 | 说明 | 重新打开条件 |
| --- | --- | --- |
| 数据包的启用语义 | **已结案（D36.9，用户裁定）**：数据包**无状态、安装即启用**，既非应用级也非仓库级启用，界面不给启用开关 | —（已结案） |
| 大文件的安装方式 | 现有安装器整目录复制，对 128–162MB 扩展包会翻倍占用磁盘；需改引用安装或对数据目录免复制 | 实现安装通道时 |
| 扩展包的分发来源 | 本地 zip / 目录导入、URL 下载、git 引用三种形态未定；涉及 D20 本地化取舍 | 实现安装通道时，需用户拍板 |
| 扩展包是否走信任等级与签名 | 数据包无代码执行，风险低于代码插件。**当前实际**：manifest `trust.requested = community`，但包已用主线密钥签名（`SHA256SUMS.sig`）；是否提升为 `system` 待定 | 实现安装通道时 |

> 说明：D33-D37 的**全部内容**（库 1 概念锚点、库 3 分类映射、库 4 别名与多语言、库 2 关系语义、聚合查询层）**均已落地**，不受上述未结案项影响。

### D36.4 关系映射库-游戏扩展（库 2，已实施）

- **内容**：9 款游戏（原神 / 碧蓝航线 / 碧蓝档案 / 明日方舟 / 异环 / 鸣潮 / 绝区零 / 崩坏3 / 崩坏：星穹铁道）与其角色的层级关系。交付为 `plugins-dist/tagrel-games`（2,966 概念 / 3,024 关系 / 6.0MB，已签名）。
- **只实现一个语言，软件内算法匹配多语言**（用户要求）：种子 `tools/tagdict/data/lib2_games.json` **只写中文游戏名 + 匹配后缀**；日/英标准名与别名随概念一并携带，运行时按语言查 `tag_name` 即可（如 `甘雨` / `Ganyu` 命中同一 `tag_id`）。
- **角色名不带括号后缀**（用户要求）：角色节点用纯名（`甘雨`，不是 `甘雨（原神）`），**作品归属由 `tag_relation` 的关系边表达**（`原神 --hierarchy--> 甘雨`）。带括号的完整写法作为**别名**保留。
- **一个角色可有多个作品**（用户要求）：关系库**只展示关系、不区分作品**——一个角色节点可挂多个游戏父级（**D34 多父级 DAG**）。筛选时由调用方**按作品限定（AND）**收窄。实测多作品角色如 `卡提希娅`（鸣潮/碧蓝航线/崩坏：星穹铁道）、`椿`（鸣潮/蔚蓝档案）。
- **日常简称作别名**（用户要求）：全名角色补日常称呼，如绝区零的 `爱丽丝·泰姆菲尔德` 与蔚蓝档案的 `天童爱丽丝` **简称都是「爱丽丝」**。简称**天然有歧义**，因此登记为 `alias`（可被多个概念共享），不占用每语言唯一的 `standard`。搜「爱丽丝」命中多个角色，靠 AND 按作品精确定位。
  - 简称来源：① 种子显式声明（`character_aliases`，用于无法自动推断的，如 `天童爱丽丝`）；② 间隔号前缀（`爱丽丝·泰姆菲尔德` → `爱丽丝`）。实测补 402 条。
- **剔除合并聚合体**：D33 概念合并会把不同作品的同名角色并成一个概念（纯名 `爱丽丝` 合并了 **26 个作品**的角色）。它不是「某个角色」而是**同名角色的聚合**，挂到作品下是错的，故剔除。实测剔除 66 个。
  - **判据经两次修正（记录以免回退）**：① 不能只看后缀数而不看语义——`甘雨` 有 4 个后缀但都是**同一游戏的形态限定**（`young` / `twilight_blossom`），按 >=3 会误剔；② 只数「映射到本扩展目标游戏的后缀数」也不够——`爱丽丝` 的 26 个后缀里只有 2 个命中目标游戏，会被漏掉。**最终判据：danbooru 来源的 `_(作品)` 后缀总数 >= 6**（正常角色 1–4 个）。
- **`work_tag_id` 处理**：不改写为游戏概念（单值字段装不下多作品角色）；但**清空指向本包外概念的悬空值**（实测 8 条），否则构成外键违规。归属一律由关系边承担。
- **多信号匹配**（`tools/tagdict/build_game_relations.py`），按可靠性分级：
  1. **danbooru `角色_(作品)` 命名约定**——生态标准写法，最可靠（实测 1,465）
  2. **括号后缀**——来自别名（如 `甘雨（原神）`）（实测 1,560）
  3. **既有 `tag_character.work_tag_id`** 启发式归属（实测 65）
- **扩展性**：新增游戏只需在 `lib2_games.json` 的 `games` 数组加一项（中文名 + 后缀），重跑脚本即可。

### D36.5 扩展包按类型分类命名（词典 / 关系）

- **问题**：原先三个扩展包都叫 `taglib-*`，**看不出区别**（用户反馈）。词典扩展承载「词库内容」，关系扩展承载「库 2 关系边」，二者语义不同。
- **命名约定**（已确认）：

| 前缀 | 类型 | 内容 | 现有包 |
| --- | --- | --- | --- |
| `tagdict-*` | **词典扩展** | 概念、多语言名称、分类、别名（按生态来源细分） | `tagdict-pixiv` / `tagdict-danbooru` |
| `tagrel-*` | **关系扩展** | 库 2 关系映射（概念之间的层级/关联边） | `tagrel-games` |

- 目录名、插件 id（`dev.hamsterpouch.extension.tagdict.*` / `…tagrel.*`）与显示名（`tagdict · pixiv 词典（日语生态）`）**三处都带类型前缀**，任一处都能看出类型。
- **装配方式不变**：两类都是**同构四库 schema**，宿主一律进聚合层，查询层不区分数据来自哪一类。分类只用于**命名与展示**。
- **数据文件名统一为 `data/tag_lib.sqlite`**：宿主按固定名装配，不再因包而异（历史上关系包用 `tag_lib_games.sqlite`，导致宿主按固定名**静默装不上**——见 D36.6）。

### D36.6 纯数据扩展包「装不上」的根因与修复

- **现象**：`plugins-dist/` 下的扩展包**全部装不上**（用户反馈）。
- **根因（两处，均已修）**：
  1. **`entry` 校验对 `static-data` 也生效**：解析层（`hp-plugin-host` 的 `parse_manifest`）对 StaticData 显式把 `entry` 置为空串（「StaticData 形态不需要 entry」），而 `hp-core` 的 `validate_structure` **无条件**要求 `entry` 非空 → 所有纯数据包在校验阶段被拒。**修复**：`entry` 非空校验跳过 `StaticData`（其它形态仍强制）。
  2. **宿主硬编码数据文件名**：`attach_tag_lib_extensions` 只找 `data/tag_lib.sqlite`，而关系包当时叫 `tag_lib_games.sqlite` → 静默装配不上。**修复**：打包统一为 `tag_lib.sqlite`；宿主兼容回退（固定名不存在时接受目录内**唯一**的 `tag_lib*.sqlite`；多个则跳过并提示，不猜），且只装配 `tagdict-*` / `tagrel-*` 目录。
- **签名**（用户要求）：三个扩展包均已 Ed25519 签名。注意 `install` 路径对**无签名包是降级而非报错**，所以必须有测试显式断言签名有效——已加 `crates/hp-plugin-signing/tests/verify_dist_packages.rs`（用 Rust 侧权威验签器逐一验证真实产物）。
- **回归测试**：`crates/hp-core/src/plugin_tests.rs` 的 `static_data_package_validates_without_entry`（单测，由 `plugin.rs` 的 `mod tests` 以 `include!` 挂载）+ `crates/hp-plugin-host/tests/tag_extension_install.rs`（用真实产物走完整安装路径）。

### D36.7 装配层「层数虚高」的两个剩余根因与修复（2026-09-30 运行时验证发现）

> 前一轮已修「跨来源去重用目录名」（改用 manifest 的插件 id）。本轮**实际运行开发包**验证
> 「`layers` 必须为 4」时，又发现**两条独立**的层数虚高路径。二者都不是"去重键口径"问题，
> 因此上一轮的修复覆盖不到。

1. **同一插件的多个版本目录被全部装配**：安装目录的装配循环对 `versions/` 下**每个**版本目录各装配一次。
   该处注释写的是「取字典序最后一个（版本号升序的近似）」，**代码却循环了全部**——注释与实现相反。
   触发条件是**升级插件**：`PluginInstaller` 按 D2 保留旧版本目录以便回滚，于是装过两个版本后
   同一扩展被装配两次。**实测**（`dev-20260930-211431`，每插件两个版本目录）：**10 层**。
   **修复**：从最新版本往前找，取第一个真正带数据文件的版本目录，只装配它。
   回归测试 `only_newest_version_of_a_plugin_is_attached`。
2. **分发目录侧未登记去重键**：来源 2（`<exe>/plugins-dist/`）装配成功后**没有**把插件 id 写进 `seen`，
   因此分发目录内若有**两个目录自称同一插件**，第二个仍会再装配一次。**修复**：与安装目录侧同口径登记。
   回归测试 `same_extension_in_both_sources_is_attached_once`。
   > **本项已被 D36.8 取代**：整条「来源 2」都不该存在，因此"给它补去重键"是在修一个不该有的东西。
   > 该测试已删除，由 `distribution_dir_is_not_an_assembly_source` 替代。

- **实测对照（同一份开发包，扩展同时存在于安装目录与分发目录）**：

  | 构建 | 安装目录版本数 | 层数 |
  | --- | --- | --- |
  | `dev-20260930-211431`（含前一轮修复） | 1 | **7** |
  | `dev-20260930-211431` | 2 | **10** |
  | `dev-20260930-213320`（本修复） | 1 或 2 | **4** ✅ |

- **为什么上一轮没发现**：只做了编译与门禁验证，**没有真正运行应用**；且 `cargo test --workspace`
  **完全不编译 `apps/desktop/src-tauri`**（该 crate 自带 `[workspace]`），装配逻辑因此零测试覆盖。
- **附带修复**：`apps/desktop/src-tauri` 的**单元测试目标此前根本无法编译**——
  `commands/plugin_panel_data.rs` 的 `test_state()` 漏了 tag 库引入的新字段 `AppState.tag_lib`
  （`E0063`）。加测试时才发现；现已补齐，该 crate 现有 **27 个单测**可通过
  （`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`）。
- **新增回归测试**（`apps/desktop/src-tauri/src/commands/shared.rs`，均用**真实产物**）：
  - `base_plus_three_extensions_attach_as_four_queryable_layers` —— 走真实 `PluginInstaller`
    安装到 `<plugin_root>/<id>/<version>/` 后从**安装目录**装配：层数恰为 4，**且扩展里的 tag 立即可查**
    （防"读错目录"与"层数对但数据没进去"）；
  - `distribution_dir_is_not_an_assembly_source` —— 安装目录为空时聚合层不得多出任何一层（D36.8）；
  - `only_newest_version_of_a_plugin_is_attached` —— 多版本目录只装配一个。
- **一处已知局限（不阻塞，登记备查）**：「取最新版本」是**目录名字典序**的近似，而词库装配
  **不读注册表**、因此不知道 `plugin.rollback` 切回了哪个版本。若用户回滚到旧版本，词库仍装配
  最新目录那份数据。这属于 D36.1「启用语义未结案」的同类问题（词库装配与应用级/仓库级状态
  尚未打通），需要时与「应用级启用入口」一并解决；当前数据包内容随版本差异极小，实际影响可忽略。

### D36.8 分发目录不是装配来源（2026-09-30 第二次运行时验证发现）

- **现象（用户反馈）**：**一个扩展都没安装**时，插件面板顶部状态行已显示
  「词库：304575 个 tag（**4 层**，合并重复 2272 条）」，而同一界面的「扩展」菜单里
  **没有任何扩展**——两处自相矛盾，且与 D36「完整词库不随应用分发、按需安装」相反。
- **根因**：`attach_tag_lib_extensions` 有**两个**装配来源：
  1. 安装目录 `<plugin_root>/<id>/<version>/`（权威）；
  2. **回退**：`<exe>/plugins-dist/`。

  来源 2 是错的。`plugins-dist/` 是**可供安装的包**的存放处（用户在插件面板里选中它来安装），
  不是"已安装"的判据。`tools/package-build.mjs` 会**刻意**把三个已签名扩展包一并放进开发包的
  `plugins-dist/`（便于就地安装），于是"一个都没装"也会命中来源 2 → 1 基底 + 3 = **4 层**。
  来源 2 是上一轮「装配读错目录」缺陷的**遗留物**：当时把权威来源改成安装目录后，
  又把错误来源作为"兼容回退"保留了下来。
- **修复**：**删除来源 2**，装配只认安装目录。判据与 D36 一致：**没安装就不该有数据**。
  连带删除已无用的 `tag_lib_extension_root()`，以及 D36.7 的
  `same_extension_in_both_sources_is_attached_once`（该用例考察"同一扩展在两个来源各出现一次"，
  来源只剩一个后前提不成立）。
- **实测对照（同一份开发包，均未安装任何扩展）**：

  | 构建 | `plugins-dist/` | 装配后的状态行 | 结论 |
  | --- | --- | --- | --- |
  | `dev-20260930-220057`（本修复前） | 3 个包（296MB） | **4 层 / 304575** | ❌ 幻影数据 |
  | `dev-20260930-224003`（本修复后） | 3 个包（296MB） | **1 层 / 8108** | ✅ 只剩内置基底 |

  `8108` 而非基底库实际的 `8110` 个概念：归并索引按 D36.3 的**概念身份**又合并了 **2** 条
  重复身份（日志里的"合并重复 2 条"），与"扩展未装配"无关。已实测基底库 `tag` 表
  共 8,110 行（general 3,008 / character 3,002 / work 1,500 / artist 600）。
- **为什么前两轮都没发现**：D36.6/D36.7 都在**已安装**扩展的前提下验证层数，而
  "一个都没装"这个状态**没人测过**；且开发包**故意**带着这 3 个包，使来源 2 永远有东西可装配，
  缺陷因此长期不可见。
- **要点区分**：`plugins-dist/` 仍是**安装来源目录**（用户从它安装），只是**不再是装配来源**。

### D36.9 数据包「无状态」：安装即启用，没有独立启用状态（用户裁定 2026-09-30）

- **问题（用户反馈）**：装了 `tagdict-*` / `tagrel-*` 之后，「扩展」菜单里**什么都不出现**
  ——只有插件面板列得出来。原因是「扩展」菜单由 `panel_catalog` 供给，它只发
  `kind = panel` 的贡献点，而数据包按 D36.1 声明 `contributions: []`，**结构上不可能命中**。
  这与当年 `hello` / `control-demo`「装了没反应」是**同一个缺陷**，只是换了一批包。
- **连带发现的语义谎言**：插件面板给每个包都画了仓库级「启用/禁用」按钮，但
  `attach_tag_lib_extensions` **完全不读启用状态**（`build_tag_lib_set` 注释写明
  "装配**全部已安装**的扩展，不按仓库启用状态过滤"），`plugin.installLocal` 的注释同样是
  "装完即重装配（数据是应用级共享，不依赖仓库启用状态）"。也就是说：**对数据包，
  启用/禁用是空操作**，界面却在提供这个开关。
- **用户裁定**：**tag 扩展无状态，安装即启用**；「扩展」菜单**也要显示** tag 扩展，
  **放在最底下**，并且**不给启用按钮**。
- **落地**：
  - `PluginHost::panel_catalog` 由「面板目录」改为「**扩展目录**」：**没有面板贡献点的
    插件也占一行**（`panel = None`），并新增 `runtime_kind` 与 `stateless` 字段；
    排序上带面板的在前、**无面板的整组在最后**（界面直接按序渲染，不必自己排）。
  - `stateless` 的判据是 `runtime_kind == static-data`——纯数据包不执行代码、
    不声明能力与贡献点，因此没有可"启用"的东西。
  - 界面：`MenuBar.tsx` 把 `panel === null` 的行渲染成**只读行**
    （`menu-sep` 分隔 + "· 安装即启用"），**不画开关**；`PluginPanel.tsx` 对
    `runtime_kind === "static-data"` 的包同样只显示状态，**不给**启用/禁用与加载按钮。
  - 文案三语齐备：`plugin.statelessState`（面板状态）/ `plugin.statelessHint`（菜单后缀）。
- **因此「应用级 vs 仓库级」这个二选一不成立**：数据包既不是应用级启用、也不是仓库级启用，
  而是**没有启用语义**。D36.1 遗留的"数据包启用语义"问题按此结案；
  D36.1 仍开放的只剩**大文件安装方式**（现有安装器整目录复制）。
- **不影响代码插件**：有 `entry`/贡献点的插件，启用语义仍是**仓库级**（按仓库隔离、
  启用即授权）。两种行由 `panel` 是否为 `null` 区分，互不干扰。
- **回归测试**：`hp-plugin-host/tests/m9_panel_catalog.rs` 的
  `data_extensions_are_listed_last_and_have_no_enable_state`——数据包的插件 id 刻意
  排在代码插件**之前**，用来证明"排在最后"靠的是"无面板"这个判据，而不是 id 字典序的巧合。

## 界面展示（用户要求，2026-09 登记）——**已实施并运行时验证**

| 项 | 数据来源 | 落地 |
| --- | --- | --- |
| **合并了多少条重复** | `TagLibSet::duplicate_stats() -> Option<(usize, usize)>`（归并后概念数, 重复数） | `taglib.status` 命令（走统一响应包装 D76）暴露装配状态：`loaded` / `layers` / `conceptCount` / `duplicateCount`；插件面板顶部状态行展示（`PluginPanel.tsx`，i18n 键 `plugin.taglibSummary` 三语齐备） |
| **共多少个 tag** | `MergeIndex::merged_count()`（跨层去重后）；`lib_meta.counts` 记有各层明细 | 同上命令一并暴露；状态行**同时显示**「归并后概念数」与「合并重复数」 |

**界面文案**（`zh-CN`）：`词库：{concepts} 个 tag（{layers} 层，合并重复 {duplicates} 条）`；
未装配基底库时为 `词库未装配（缺内置基底库）`（`plugin.taglibEmpty`）。

**运行时实测（2026-09-30，开发包 `dev-20260930-213320`）**：装配 3 个扩展后状态行为
`词库：304575 个 tag（4 层，合并重复 2272 条）`。

**运行时实测（2026-09-30，D36.8 修复后复核，开发包 `dev-20260930-224003`）**：
同一份开发包在**未安装**任何扩展时为 `1 层 / 8108`（D36.8），**已安装** 3 个扩展时为
`4 层 / 304575`——修复前该包在"一个都没装"时误报 `4 层 / 304575`。

> **概念数口径**：RFC D36.3 记录的 **304,572** 是 **pixiv + danbooru 两包**的归并结果
> （`306,844` 个 ID 去重并集 − `2,272`）。实际运行时还装配了 `tagrel-games`，而基底库另有
> **3 个**扩展包中不存在的 `manual` 种子概念（`樱未来` / `fufu` / `赛璐珞`，见
> 「管线改造」第 6 条），故四层全装的正确值是 **304,575**。两个数字都对，区别只在装配了几个包。
> 同理，**只装基底**时为 `8108`（基底库 `tag` 表 8,110 行 − 2 条重复概念身份）。

> 这两项属于**集成工作**，不阻塞四库数据与归并机制本身（二者均已实现并有测试覆盖）。
> `tag_dict.suggest` 命令已实现且已注册，但**前端暂无调用方**——`TagInput` 的候选建议
> （RFC 0008 T6 集成点）尚未接线，属未完成的集成项，不是缺陷。

## 实现期开放点（非架构决策）

- ~~内置基底库的具体范围与目标体积~~ → **已定**：按 kind 配额（general/character 3,000、work 1,500、artist 600）+ 库 2 种子强制纳入，实测 8,110 概念 / 12.07MB。
- ~~多来源聚合的实现方式~~ → **已定**：查询层逐库合并（非 `ATTACH`），见 `TagLibDb` / `TagLibSet`。
- `tag_dict.sqlite` 的退役时机（并存期长度）：旧库与 `TagDictDb` 当前保留作对照与回退，`data/system/tag_dict_base.sqlite3` 已由 `tag_lib_base.sqlite3` 取代。
- ~~库 2 内置关系的录入方式~~ → **已定**：人工 JSON 种子 `tools/tagdict/data/lib2_relations.json`。
- 库 3 `work_tag_id` 的补全来源（Bangumi / 人工 / 生态启发式）与优先级——当前用「括号后缀 + 无歧义才写」的生态启发式。
- 别名来源与自动提取规则（略称、罗马音、错拼的判定）——当前只做「生态写法 + 括号后缀（不重合时）+ 汉字名」，未做略称/罗马音/错拼的专门推断。
- 多语言检索是否引入 SQLite FTS5 全文索引。
- 概念合并的自动化程度（管线全自动 vs 人工核心集校正）。
- 库访问的 Tauri 命令形态：独立 `taglib.*` 命令域 vs 并入 `tag.*`。
- 升级机制：整包替换 vs 增量同步；版本号粒度。
