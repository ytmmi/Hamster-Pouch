# RFC 0008：tag 库（总库 / 关系映射 / 分类映射 / 别名与多语言）

状态：正式草案。已确认方向：四个 tag 库统一为「**库 1 概念总库 + 库 2/3/4 功能补充层**」结构，库 1 的实体锚点由「原始生态 tag」改为「**概念**」。**tag 库不再作为应用内置数据交付**：应用只内置轻量基底，完整词库（含全量 artist）改为**按需安装的扩展包**，以减小应用体积。库数据在逻辑上仍是**应用级共享**的只读参考数据（不随仓库隔离）。**扩展包的承载与安装机制（是否经插件系统）延后到构建时再讨论**（见 D36.1），本文档只记录该约束与候选方案。

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

### D36.1 与插件系统的衔接：**延后到构建时再讨论**

- **状态：延后（不在本次规划内定案）。** 插件系统本身仍在规划中；tag 词库如何接入插件系统（贡献点、运行形态、能力命名、启用语义、安装方式）**均在构建时结合插件系统的最终设计一起讨论**，本文档只登记约束与候选方案，**不构成已确认决策**。
- 需要保证的约束（供届时的插件系统设计参考）：
  - 数据包**不执行代码**，风险低于代码插件；
  - **宿主负责读取词库数据，插件不直连数据库**（保持 RFC 0004 的插件边界）；
  - 完整词库**不随应用分发**，按需安装（D36 已确认的方向）。
- 候选方案（**设计草案，未定案**，见下文「插件扩展级交付（D36）」节）：
  - 贡献点 `contributions=["taglib"]`、运行形态 `RuntimeKind::DataPack`、能力 `taglib.read`/`taglib.write`；
  - 数据包启用为**应用级**（若沿用 plugin 系统现有的仓库级启用语义会产生冲突，需届时一并解决）；
  - 大文件走**引用安装**（现有安装器整目录复制会翻倍占用磁盘）。
- **重新打开条件**：插件系统定案时，或 tag 库进入构建实施时，二者先到者触发。

### D37 库 4 三语对等：中文标准名入统一结构

- 库 4 每 `(tag, lang)` 至多一个 `standard`，其余为 `alias`（另含 `romanization` / `misspelling` 等）。
- 修正实测缺陷：现有 `tag_dict_translations` 中 `zh` 行数为 0（中文只存在 `entries.zh` 列），违反「每语言选一个为标准名」的对等要求。新结构中中文以 `lang='zh', kind='standard'` 正式入表。
- 覆盖用户示例：`碧蓝档案`(zh standard) / `蔚蓝档案`(zh alias)；`ブルーアーカイブ`(ja standard) / `ブルアカ`(ja alias)；`BlueArchive`(en standard) / `BA`(en alias) —— 四者命中同一 `tag_id`。

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

## 数据管线改造（`tools/tagdict/`）

在 `build_tag_dict.py` 四步流程上扩展。管线产出**两个目标**：内置基底库（小）与扩展词库包（完整），均使用同一 schema。

1. **纳入 artist（D35，全量）**：`DANB_CATEGORIES` 放开 category `1`，danbooru artist **152,097 条全部纳入**、不设 `post_count` 门槛；pixiv `Artist` 类别同步纳入。这是库 3 艺术家的数据来源，**只进扩展包**（不内置，避免撑大应用体积）。
2. **概念合并（D33）**：锚点由「原始 tag」改为「概念」。先按 `category` 分区，再按 zh→en→ja 标准名依次合并；冲突不合并。
3. **三语对等（D37）**：中文标准名写入 `tag_name(lang='zh', kind='standard')`；日/英标准名与各自别名分别落 `standard` / `alias`。
4. **别名填充**：`tag_dict_aliases` 现为 0 行，改为写 `tag_name(kind='alias')`；来源为同一概念的其他生态写法、日文略称（ブルアカ）、罗马音、中文异名（蔚蓝档案）。
5. **分类专属字段**：角色 → `work_tag_id`（归属原作，需 Bangumi 等实体权威源补全，RFC 0006 已列为可选增强，首期可留空并允许人工补）；AI 模型 → `base_model` 基座归一。
6. **库 2 初始数据**：**人工内置**（用户给出的 VOCALOID / 风格示例那一层），进内置基底、随应用分发；不由管线自动推导层级，避免噪声。
7. **双层切分（新）**：管线按阈值切出内置基底范围（如中文主词热度 Top-N + 默认关系树 + 常用分类），其余全量内容打包为扩展词库包。

预计规模：pixiv 169,438 + danbooru（53,194 + artist 152,097）= **374,729 条原始来源行**；概念化后库 1 实体约 33 万（含 artist）。扩展包 150–250MB，内置基底目标数 MB 内。

## 扩展包承载与安装（D36）——**设计草案，未定案**

> **本节是与插件系统衔接的设计草案，不是已确认决策**（见 D36.1「延后」）。插件系统仍在规划中，接入方式（贡献点、运行形态、启用语义、安装方式）在构建时一并讨论。本节内容供届时的插件系统设计参考。

### 分层与体积

| 层 | 内容 | 承载 | 随应用体积 |
| --- | --- | --- | --- |
| 内置基底库 | 基础中文标准名、常用分类、默认关系（VOCALOID / 风格示例层）、库结构 | 应用资源目录（只读） | 极小（目标数 MB 内） |
| 扩展词库包 | 完整四库数据（含 artist 152,097 条、全量别名与多语言） | 待定（插件包存储，见下） | **0（按需安装）** |
| 用户数据层 | 用户自定义概念、别名、关系 | 可写用户库（`source=user`） | 极小 |

原「应用内置完整 `tag_lib.sqlite`（150–250MB）」方案取消，应用体积回到基线。

### 数据包形态（草案）

```text
taglib-<name>/
  plugin.manifest         # 候选：runtime.kind=data-pack；contributions=["taglib"]
  data/tag_lib.sqlite     # 四库数据（D33-D37 的 schema）
  data/CHANGELOG          # 版本与来源说明
  README.md               # 数据来源与许可（ffdkj MIT 等）
  LOCK                    # 若走 git 引用，记录 URL + 锁定 ref
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

- **概念误合**：跨 category 的 4,337 个中文主词若越过 category 合并会污染库 3；合并必须以 category 为第一分区键。
- **同名角色（11,515 个中文主词）**：`work_tag_id` 补全依赖外部实体源（Bangumi 未验证），首期留空需人工补，期间同名角色无法自动区分。
- **artist 全量体量（152,097 条）**：会使库 1 规模与 `popularity` 排序语义显著变化（artist 热度与前几类不同量纲）；跨类别排序需分维度处理，不能直接混排。
- **D23 边界**：库 2 为应用级共享，D22/D23 的 tag 关系为仓库级隔离；两者并存，实现期必须防止混用同一张表或互相写入。
- **零安装可用性**：tag 库改为按需安装后，未安装扩展包时只剩内置基底——AI 归一化、跨语言检索、tag 表展示映射的**覆盖率大幅下降**。必须明确这是已接受的取舍，否则会被当成缺陷。
- **插件系统依赖（已延后）**：扩展包的**承载与安装机制**取决于插件系统的最终设计，而插件系统仍在规划中。若在插件系统定案前先实施 tag 库，需先定义独立的装配接口，避免与插件系统耦合；反之若插件系统先定案，则应回到 D36.1 一并确认。
- **启用语义冲突（待定）**：若最终决定经插件系统承载，需解决 tag 数据（应用级共享）与插件系统现有「启用是仓库级」语义的冲突；否则同一数据包在各仓库行为不一致。
- **大文件安装成本**：现有安装器整目录复制，250MB 数据包会翻倍占用磁盘；必须走引用安装或对 `data/` 免复制（D36）。
- **多来源聚合复杂度**：内置基底 + 多个扩展包 + 用户库的 `ATTACH` / 合并查询会带来优先级、去重与性能问题；聚合层需明确覆盖顺序。
- **数据包供应链**：数据包无代码执行、风险低于代码插件，但仍可投毒词条数据（错误翻译、错误分类）；建议校验 `lib_meta` 与 schema 版本，并允许用户停用。
- **数据源**：两个主源为个人维护的每日更新仓库，存在停更风险；产物版本随应用固定。

## 延后事项登记（构建时再讨论）

本节集中登记**已明确延后**的决策，避免实现期误当成已定架构。

| 延后项 | 说明 | 重新打开条件 |
| --- | --- | --- |
| 扩展包的承载与安装机制 | 是否经**插件系统**承载（贡献点、运行形态、能力命名、安装命令、版本目录管理、回滚）全部待定；本文只登记约束与候选方案（D36.1） | 插件系统定案时，或 tag 库进入构建实施时（二者先到者） |
| 数据包的启用语义 | tag 数据是应用级共享，而插件系统现行为「启用是仓库级」；若经插件系统承载必须解决该冲突 | 同上 |
| 大文件的安装方式 | 现有安装器整目录复制，对 150–250MB 扩展包会翻倍占用磁盘；需改引用安装或对数据目录免复制 | 同上 |
| 扩展包的分发来源 | 本地 zip / 目录导入、URL 下载、git 引用三种形态未定；涉及 D20 本地化取舍 | 构建时，需用户拍板 |
| 扩展包是否走信任等级与签名 | 数据包无代码执行，风险低于代码插件；是否套用 `system`/`trusted`/`community`/`local-dev` 分级待定 | 同上 |

> 说明：以上延后**不影响** D33-D37 的其余内容。库 1 概念锚点、库 3 分类映射、库 4 别名与多语言、库 2 的关系语义、以及**聚合查询层**都可以独立先行落地（聚合层只依赖装配接口，不依赖插件系统）。

## 实现期开放点（非架构决策）

- 内置基底库的具体范围与目标体积（多少常用词、是否含默认关系树）。
- 多来源聚合的实现方式（SQLite `ATTACH` vs 查询层逐库合并）。
- `tag_dict.sqlite` 的退役时机（并存期长度）。
- 库 2 内置关系的录入方式（人工 JSON/CSV 源文件 vs 直接 SQL 种子）。
- 库 3 `work_tag_id` 的补全来源（Bangumi / 人工 / 生态启发式）与优先级。
- 别名来源与自动提取规则（略称、罗马音、错拼的判定）。
- 多语言检索是否引入 SQLite FTS5 全文索引。
- 概念合并的自动化程度（管线全自动 vs 人工核心集校正）。
- 库访问的 Tauri 命令形态：独立 `taglib.*` 命令域 vs 并入 `tag.*`。
- 升级机制：整包替换 vs 增量同步；版本号粒度。

> 与扩展包承载/安装相关的开放点（分发来源、是否免复制、版本目录管理）已上移至「延后事项登记」，统一在构建时与插件系统一并讨论。
