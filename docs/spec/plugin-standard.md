# 插件标准（manifest 权威契约 + 贡献点 + 能力 + 宿主 API）

状态：正式草案。本文把 RFC 0004（插件系统顶层决策）与 RFC 0009（分发策略）落成**可实现的 manifest 契约**：字段全清单、取值域、宿主校验规则、贡献点形态与宿主 API 版本策略。已确认决策（D2–D6、D38–D45）不因本文改变；本文只补实现所需的字段与校验口径。

**来源与信任不由 manifest 决定**（RFC 0004 决策 17 / RFC 0009）：manifest 的 `source` 一律**忽略**，`effective_trust` 只接受宿主按实际安装方式判定出的来源。**2026-09（缺陷 0008 已修）**：`source` 已**不再被解析**——`PluginManifest` 根本没有来源字段，`effective_trust` 的入参是只能由宿主构造的 `HostSourceKind`（见第 6 节）；manifest 里写 `"source": { "kind": "system" }` 只是一个被忽略的未知键。

## 1. manifest 权威与落点

| 关注点 | 权威实现 |
| --- | --- |
| 领域模型与运行形态/信任/能力校验 | `crates/hp-core/src/plugin.rs` |
| manifest 解析与包发现 | `crates/hp-plugin-host/src/manifest.rs` |
| 来源判定与信任推导 | `crates/hp-plugin-host/src/trust.rs`（RFC 0009：现仍读 manifest 自称，**待改**） |
| 安装（本地路径 / git / 归档包） | `crates/hp-plugin-host/src/install.rs` |
| 注册表与按仓库状态 | `crates/hp-store/src/global/plugin_repo.rs`、`plugin_repo_state` |
| 桥接命令与事件 | `apps/desktop/src-tauri/src/commands/plugin.rs` |
| 控件 schema（面板**内部** UI） | `docs/spec/control-standard.md`（控件通道）；`contributions` 见第 4 节 |
| **面板注册表**（插件可注册） | `docs/spec/panel-standard.md`（RFC 0010 决策 4） |
| **蓝图节点类型注册表**（插件可注册） | `docs/spec/blueprint-node-standard.md` 第 2.3 节（RFC 0010 决策 5/6） |
| **设置注册表**（插件可增加设置） | `docs/spec/settings-standard.md`（RFC 0010 决策 7） |

**注册权边界（RFC 0010 决策 2）**：插件**可以**注册**面板**与**蓝图节点类型**，**不可以**注册**控件**（26 种 `kind` 仍是宿主内置白名单，D62 不变）。三者的声明参数列表分别在 `docs/spec/panel-standard.md`、`docs/spec/blueprint-node-standard.md` 第 2.3 节、`docs/spec/control-standard.md` 第 4 节。

## 2. 插件包结构

```text
plugin-package/
  plugin.manifest        # 清单（本文权威契约）
  plugin.sig             # 主线构建者签名（system 必需，Ed25519，RFC 0009）
  SHA256SUMS             # 包内文件摘要（完整性；真实性由 plugin.sig 提供）
  bin/ | lib/ | py/      # 入口（外部进程可执行文件 / 动态库 / Python 脚本）
  assets/                # 图标、语言资源、模型权重等
  README.md
  LOCK                   # git 安装时记录 url + rev + mirror_url + 获取时间
  schema/panel.<id>.json # 可选：面板**内部控件 schema** 的**离线兜底**（运行时通道失败时使用）
```

- `entry` **必须相对版本目录解析**，禁止绝对路径、盘符路径或任意命令（RFC 0009「实现注意」）。
- 原生依赖（DLL / 模型权重）必须在 manifest 的 `native_dependencies` 中声明，**缺失即拒绝加载**，不静默降级（D43）。
- 归档包（`.zip`）解包必须应用 D41 防护：拒绝绝对路径/盘符、`..` 段、符号链接与联接、zip 炸弹、大小写同名覆盖。

## 3. `plugin.manifest` 字段定义

### 3.1 必需字段

| 字段 | 类型 | 取值域 / 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | string | `^[a-z0-9][a-z0-9._-]{2,63}$`，全局唯一 | 反向域名风格（`dev.hamsterpouch.palette`）；作为命令命名空间 `plugin.{id}.{action}` |
| `name` | string | 非空 | 展示名（允许中文）；不参与 i18n 键规则 |
| `version` | string | 语义化版本 `MAJOR.MINOR.PATCH` | 与版本目录名一致 |
| `min_host_version` | int ≥ 1 | ≤ 当前 `HOST_API_VERSION` | 高于当前宿主即拒绝安装（更新前预检，RFC 0009） |
| `runtime.kind` | string | `external-process` / `wasm` / `dynamic-library` | 自声明、宿主强校验（RFC 0004 决策 3） |
| `entry` | string | 相对路径，非空 | 进程入口 / 动态库 / wasm / Python 脚本 |
| `capabilities` | string[] | 第 5 节白名单 | 能力制（RFC 0004 决策 4） |
| `api_version` | int ≥ 1 | 当前 `HOST_API_VERSION` | 插件实现的宿主 API 版本；与 `min_host_version` 一起构成兼容区间 |
| `contributions` | object[] | 第 4 节形态 | 贡献点（面板/命令/查看器/AI 提供方/元数据字段/数据查询/**蓝图节点类型**/**设置项**） |
| `trust.requested` | string | `system` / `trusted` / `community` / `local-dev` | **仅请求**；实际等级由来源判定（第 6 节） |

### 3.2 可选字段

| 字段 | 类型 | 取值域 / 约束 | 说明 |
| --- | --- | --- | --- |
| `description_key` | string | i18n 键 | 说明文字走 i18n（D27），不内联长文 |
| `publisher` / `license` / `homepage` | string | 任意字符串 | **仅供展示**，不参与信任判定（RFC 0009） |
| `native_dependencies` | string[] | 包内相对路径 | 缺失即拒绝加载（D43） |
| `data_queries` | object[] | `{ name, returns }` | 控件 `bind` 的合法查询名（`returns` ∈ `rows`/`object`/`scalar`）；未声明即拒绝该绑定（控件标准第 5 节） |
| `events` | object[] | `{ id, payload? }` | 控件事件回传的合法事件 id，与 `on` 映射配合（控件标准第 6 节） |
| `settings` | object[] | `{ key, kind, title_key, default?, scope?, requires_capability? }` | 插件设置项；`kind` **只能取控件的输入类**（`switch`/`textInput`/`numberInput`/`select`/`slider`/`checkbox`），其余 `kind` 即硬错误。值存应用设置（`app_settings`），按插件隔离，落库键强制 `plugin.<plugin_id>.` 前缀（`docs/spec/settings-standard.md` 第 5、7 节） |
| `min_app_version` | string | 语义化版本 | 应用版本下限；不满足即拒绝安装 |
| `source` | object | 忽略 | **兼容字段**：不参与信任判定（RFC 0004 决策 17） |

### 3.3 示例

```jsonc
{
  "id": "dev.hamsterpouch.palette",
  "name": "调色板",
  "version": "0.1.0",
  "min_host_version": 1,
  "api_version": 1,
  "runtime": { "kind": "external-process" },
  "entry": "bin/palette.exe",
  "capabilities": ["ui.panel", "repo.read"],
  "contributions": [
    {
      "kind": "panel",
      "id": "plugin.dev.hamsterpouch.palette.palette",   // 面板 id **必须**命名空间化（见下方注）
      "title_key": "panel.palette",
      "category": "system",              // 五大面板分类之一（panel-standard 第 3 节）
      "has_class": false,                // 有无类目：本面板内部不按类型分条目
      "blueprint_node": "control",       // 在蓝图里由哪种节点承载（须命中已注册节点类型）
      "read_only": true
    },
    { "kind": "command", "id": "reload", "title_key": "palette.reload" },
    {
      "kind": "blueprintNode",           // RFC 0010 决策 5/6：注册蓝图节点类型（纯声明）
      "id": "palette.swatch",
      "type": "plugin.dev.hamsterpouch.palette.swatch",
      "label_key": "palette.node.swatch",
      "role": "structural",
      "fields": [{ "name": "name", "type": "string" }],
      "parents": ["layout_block"],
      "children": [],
      "events": []
    },
    {
      "kind": "settingsSection",         // RFC 0010 决策 7：增加设置项
      "id": "palette.settings",
      "title_key": "palette.settings.title",
      "category": "plugin",              // 五大**大类**之一（不是第 4.3 节的插件分类）
      "settings": [
        { "id": "grid_size", "kind": "numberInput", "title_key": "palette.gridSize", "default": 4 },
        { "id": "sort", "kind": "select", "title_key": "palette.sort", "default": "hue",
          "options": [
            { "value": "hue", "title_key": "palette.sort.hue" },
            { "value": "name", "title_key": "palette.sort.name" }
          ] }
      ]
    }
  ],
  "data_queries": [{ "name": "colors", "returns": "rows" }],
  "events": [{ "id": "apply_color" }],
  "trust": { "requested": "local-dev" }
}
```

> **示例更正（2026-09）**：本示例此前仍是 RFC 0010 之前的旧形态（面板用裸 id `palette.panel`、无 `category`/`has_class`/`blueprint_node`、无 `blueprintNode` / `settingsSection` 实例），与第 4 节和「命名空间」一节冲突。现已改为**当前契约**的形态。
>
> **命名空间只作用于两类 id**（RFC 0010「命名空间」）：
>
> | 对象 | `id` 规则 | 示例 |
> | --- | --- | --- |
> | **面板** | **必须** `plugin.<plugin_id>.<local_id>` | `plugin.dev.hamsterpouch.palette.palette` |
> | **蓝图节点类型** | **必须** `plugin.<plugin_id>.<local_id>`（字段是 `type`，另有独立的贡献点 `id`） | `plugin.dev.hamsterpouch.palette.swatch` |
> | 其它贡献点（`command` / `viewer` / `settingsSection` / …） | 贡献点 `id` 只需**插件内唯一** | `reload`、`palette.settings` |
>
> 蓝图里的 `panel_id` 与节点 `type` 因此对插件项使用**完整**命名空间 id；**设置项的落库键**由宿主强制加 `plugin.<plugin_id>.` 前缀（不是贡献点 `id` 本身）。

## 4. 贡献点（`contributions`）

统一形态：`{ "kind": <贡献点类型>, "id": <命名空间内唯一 id>, ... }`。`id` 只允许 `^[a-z][a-z0-9._-]{0,63}$`；同一插件内 `(kind, id)` 唯一。

| `kind` | 必需字段 | 可选字段 | 用途与约束 |
| --- | --- | --- | --- |
| `panel` | `id`、`title_key`、`category`、`has_class`、`blueprint_node` | `settings`、`capabilities`、`mount`、`read_only`（默认 `true`）、`icon`、`default_size` | **注册面板**（RFC 0010 决策 4）。完整声明参数列表与取值域见 `docs/spec/panel-standard.md` 第 4 节；`has_class` = 有无类目，`blueprint_node` 必须命中已注册的节点类型，`settings` 供「全部设置 → 面板」分节渲染。面板内部的控件 schema 仍经运行时通道获取（控件标准第 2 节）。`read_only = false` 需 `repo.write` 并按仓库授权 |
| `command` | `id`、`title_key` | `capability` | 注册 `plugin.{pluginId}.{id}` 命令；宿主校验启用状态与能力 |
| `viewer` | `id`、`title_key`、`media_type` | — | 声明可处理某 `media_type` 的查看器；`media_type` ∈ `image`/`video`/`audio` |
| `aiProvider` | `id`、`model_kind` | `local`（默认 `true`） | AI 提供方；需 `ai.infer`；第一期仅图片（D17） |
| `metadataField` | `id`、`title_key`、`value_kind` | `media_type` | 元数据面板附加字段（只读展示）；不写仓库数据 |
| `dataQuery` | `name`、`returns` | — | 与顶层 `data_queries` 等价（两者都接受，合并去重） |
| `blueprintNode` | `id`、`type`、`label_key`、`role`、`fields`、`parents`、`children`、`events` | `ports`、`severity`、`evaluation_role` | **注册蓝图节点类型**（RFC 0010 决策 5/6）。`type` 必须为 `plugin.<plugin_id>.<local_id>` 形式；声明参数列表与约束见 `docs/spec/blueprint-node-standard.md` 第 2.3、2.4 节。**纯声明**：不得携带自定义渲染、任意 CSS/像素或任意表达式；校验规则只能从宿主固定最小集里选 |
| `settingsSection` | `id`、`title_key`、`category`、`settings` | — | **增加设置项**（RFC 0010 决策 7）。归入「全部设置」的既有大类（`category`），**不能新增或改名大类**；`settings[]` 形状与 `docs/spec/settings-standard.md` 第 5 节完全一致，落库键强制 `plugin.<plugin_id>.` 前缀 |

规则：

- **贡献点不构成权限**：贡献点只声明"我想挂什么"，实际可用性仍由「插件是否在该仓库启用 + 该能力是否授权」决定（RFC 0004 决策 6/14）。
- **命名空间由形式保证，不靠消歧**：注册项 id **必须**是 `plugin.<plugin_id>.<local_id>`（面板、蓝图节点类型），因此跨插件/跨宿主天然不冲突，**不需要**运行时"加前缀消歧"（RFC 0010「命名空间」）。未用该形式即硬错误。
- **注册权边界**：插件**可以**注册**面板**与**蓝图节点类型**，**不可以**注册**控件**（26 种 `kind` 是宿主内置白名单，D62 不变）；贡献点里出现控件 `kind` 声明一律忽略并记录（RFC 0010 决策 2）。
- 插件**不能**通过贡献点创建自由 React 组件、独立窗口、自定义 CSS/配色（D44 边界），也不能直接编写蓝图（RFC 0007 非目标）。插件注册的**蓝图节点类型必须纯声明**（无自定义渲染/逻辑，RFC 0010 决策 6）。
- 插件注册的面板可被蓝图以 `control`（**面板**）节点引用，`panel_id` 用**完整** `plugin.<plugin_id>.<local_id>`（`docs/spec/panel-standard.md` 第 6 节）。
- **插件缺失时的行为**：插件未安装/未启用/宿主 API 不兼容时，蓝图里由它注册的节点类型按**未接通**处理——软告警 + 画布灰显、**允许保存**、节点与边原样保留、插件恢复后自动恢复（RFC 0010 决策 6）；面板引用同理。

## 5. 能力（`capabilities`）白名单

| 能力 | 高危 | 默认授予（仓库启用时） | 说明 |
| --- | --- | --- | --- |
| `ui.panel` | 否 | **是** | 注册面板；在面板内创建控件（含浮层内容）需要它 |
| `repo.read` | 否 | 否 | 经宿主 API 查询当前仓库数据 |
| `repo.write` | 否 | 否 | 写入仓库解释数据（tag/评分等），必须携带仓库上下文 |
| `fs.read` | 否 | 否 | 读取媒体源文件（经宿主句柄，不直接遍历） |
| `fs.write` | **是** | 否 | 真实文件写入；必须生成操作记录 |
| `network` | **是** | 否 | 网络访问 |
| `ai.infer` | 否 | 否 | AI 推理（结果只写自动 tag 组，D21） |
| `native.code` | **是** | 否 | 原生代码（动态库必需） |

- 高危判定口径：`native.code` / `fs.write` / `network`（RFC 0004）。
- 新增能力必须同时更新本表、`hp-core` 的 `Capability` 与前端面板文案；**不得**让插件用未列出的能力字符串。
- 能力字符串用点分小写（`repo.read`），不使用驼峰。

## 6. 来源、信任与运行形态校验

信任推导（RFC 0009，**以宿主判定来源为准**）：

```text
AppBundle   -> system   （仍需验签 plugin.sig，D40；随包不等于免签）
Git{url,rev}-> community（请求 trusted 时用户显式提升并记录）
Archive{sha}-> community（签名者为主线构建者时 system）
LocalPath   -> local-dev（永不提升）
```

**类型级约束（缺陷 0008 的修复口径，2026-09）**：来源只能由**安装入口**决定，落地为
`crates/hp-plugin-host/src/trust.rs` 的 `HostSourceKind`——唯一构造入口是
`HostSourceKind::from_install_source(&InstallSource)`（`Bundled → system`、`Git → git`、
`LocalPath → local-path`）与 `HostSourceKind::bundled()`；`effective_trust` 只接受该类型。
配合 `PluginManifest` **没有**来源字段，把 manifest 自称的来源送进信任推导**编译不过**。
注册表 `source_kind` 列与 `trust_level` 同源于这一次宿主判定（`PluginInstaller::install_registry_row`）。

宿主校验规则（安装时与加载时都执行）：

1. `id` / `name` / `version` / `entry` 非空；`id` 合法且未与既有插件冲突。
2. `min_host_version` ≤ 当前 `HOST_API_VERSION`，否则拒绝安装（预检，不装完才失败）。
3. `runtime.kind = dynamic-library` → 必须声明 `native.code`；且信任等级必须是 `system` / `trusted`，否则拒绝加载（D4）。
4. `community` / `local-dev` 只能使用 `external-process` 或 `wasm`。
5. 请求高危能力但信任等级不足或该仓库未授权 → 拒绝加载或要求用户显式升级授权；越权调用 API → 拒绝并记录事件。
6. `native_dependencies` 未随包或摘要不符 → 拒绝加载（D43）。
7. manifest 自称 `source.kind` → **不解析、不参与** `effective_trust`（`PluginManifest` 无来源字段）。
8. 任何信任等级提升、签名校验结果都写入事件与操作记录（D40/D45）。

## 7. 宿主 API 版本策略

- 宿主 API 版本常量：`HOST_API_VERSION`（当前 `1`），`min_host_version` 与 `api_version` 都对齐它。
- **破坏性变更升大版本**（删除/改名字段、改变语义、收紧能力）；新增可选字段保持向后兼容，不升版本。
- 版本不兼容时：安装期拒绝并说明原因；加载期复核，不满足即拒绝加载。
- 控件 schema 的 `api_version`（控件标准第 1 节）与本章同源；两条通道不得各自定版本号。
- WASM 宿主导入函数的名称/签名/内存归属/序列化格式**必须先定义再实现**（RFC 0004 实现注意），随宿主 API 版本一起冻结。

## 8. 分发与版本目录

| 通道 | 形态 | 信任上限 | 更新 |
| --- | --- | --- | --- |
| 应用安装包 | 随包源码 + 安装期登记 | `system`（须验签） | 跟随应用版本 |
| git | 锁定 commit/tag 的目录 | `community`（可提升 `trusted`） | 手动检查 + 确认 |
| 归档包 `.zip` | 预编译二进制 + 摘要 | `community`；有主线签名为 `system` | 手动检查 + 确认 |
| 本地路径 | 目录 | `local-dev` | 手动替换 |

- 版本目录：`<plugin_root>/<plugin_id>/<version>/`；回滚 = 切回旧目录（D2），注册表须记录 `active_version`（**待补**，RFC 0009）。
- 不存在自动后台更新（RFC 0004 决策 5）；`.zip` 内**禁止**安装脚本（RFC 0009）。
- 插件运行时目录不使用 Windows Roaming 目录（体积原因）。

## 9. 验证

- **`cargo test -p hp-core`**：清单结构校验（空字段、动态库必须 `native.code`、动态库信任等级、宿主 API 版本、`api_version`）、贡献点（id 规则、重复、`title_key` 完备性、`media_type`、`returns`、所需能力未声明）、数据查询名与事件 id 合法性/重复。
- **RFC 0010 新增断言**：
  - `panel` 贡献点的必需声明参数齐全（`category` / `has_class` / `blueprint_node`），取值域合法，`blueprint_node` 命中已注册的节点类型；`settings[].kind` 只能取控件输入类。
  - `blueprintNode` 贡献点：`type` 必须是 `plugin.<plugin_id>.<local_id>` 形式；声明参数完整；**不得**携带自定义渲染/逻辑字段；`fields` / `parents` / `children` / `ports` 引用必须命中已注册类型与边类型。
  - `settingsSection` 贡献点：`category` 必须是既有的五个大类之一（**不得新增或改名大类**）；落库键前缀强制 `plugin.<plugin_id>.`；与宿主设置项同名 id 一律拒绝（不覆盖、不合并）。
  - **注册权边界**：贡献点里出现控件 `kind` 注册一律忽略并记录。
  - **命名空间**：插件注册项与宿主内置裸 id 不可能冲突（形式保证），且不存在"先到先得"的覆盖路径。
  - **插件缺失容错**：卸载/禁用插件后，蓝图里由它注册的节点类型与面板引用按未接通处理——**可保存**、原样保留、恢复后自动恢复。
- **`cargo test -p hp-plugin-host`**：manifest 解析（标准对象形态 + 旧字符串形态兼容）、包发现、示例插件与系统插件包校验、`plugin.load` 生命周期。
  - **来源与信任的调用方级回归（缺陷 0008，2026-09）**：`tests/m5_example_plugins.rs` 的
    `local_path_install_cannot_self_declare_system_trust` 走**安装入口的宿主侧实现**
    （`PluginInstaller::install_registry_row`，即 `plugin.installLocal` 调的那条路径），断言
    「本地路径安装一个自称 `source.kind = system`、声明 `native.code` 的包 →
    注册表 `trust_level = local-dev`、`source_kind = local-path`，且 `enable_for_repo(native.code)` 被拒」。
    把修复回退（信任改回读 manifest 自称）该测试即**变红**（已验证）。
  - `bundled_system_plugin_gets_system_trust_from_host_decision` 断言随包分发的
    `plugins/system/palette` 由 `InstallSource::Bundled` 得到 `system`——与 manifest 是否自称无关。
- **`pnpm check:panels` / `check:blueprint-nodes` / `check:settings`**：三张注册表与各自规范文档、与本文贡献点形态的一致性（详见各规范第 8/10 节）。
- 示例与系统插件包（`plugins/examples/hello`、`plugins/system/palette`）已升级为标准形态（类型化贡献点 + `data_queries` + `events` + `api_version`），作为 manifest 的接口夹具。

## 10. 待实现缺口（与 RFC 0009 一致）

- ~~`trust.rs` 仍读 manifest 自称的 `source.kind` → 必须改为宿主判定，并加"本地路径自称 system 不得获得 system"回归测试。~~ → **已修（2026-09，缺陷 0008）**：manifest 不再解析 `source`，信任只接受宿主判定的 `HostSourceKind`，调用方级回归测试已落地且可失败（详见第 6 节与第 9 节）。**余留**：随包安装入口（`InstallSource::Bundled`）暂无桥接命令，`system` 等级目前只能经宿主侧 API 得到；`system` 的 `plugin.sig` 验签仍未实现（D40）。
- `plugin.load` 仍为生命周期骨架：三种运行形态都无执行体；WASM `wasmi` 未接入；`external-process` 无监督（重启退避 / 不健康标记 / `plugin.error`）。
- 注册表无 `active_version`，回滚不切换活跃版本；无 `.zip` 通道与签名校验；`InstallSource::Git` 无 git 拉取逻辑与桥接命令。
- ~~控件 schema 运行时通道（控件标准第 2 节）尚未接线~~ → **`external-process` 通道已于 2026-09 落地**（`crates/hp-plugin-host/src/channel.rs`、命令 `plugin.panelSchema` / `plugin.validateControl`；`wasm` 与 `dynamic-library` 两条通道仍待各自运行形态）。本文的 `contributions` / `data_queries` / `events` 形态为**契约先行**——manifest 侧已全部解析校验，但 `data_queries` 的**取数通道**与 `events` 的**回传命令**仍未实现。
- **RFC 0010 缺口（2026-09 更新：原列的 4 条已全部落地）**：
  - ~~面板注册表仍是常量清单（`PANEL_IDS`），没有插件注册路径；插件面板不进 `PANEL_DEFS` / `DOCK_COMPONENTS`~~ → **已落地**：`packages/config/src/panels.ts`（`BUILTIN_PANEL_SPECS` / `registerPluginPanels` / `panelSpec`）+ `apps/desktop/src/app_ui/core/panelRegistry.tsx`（`allPanelDefs` / `useDockComponents`），并由 `pluginRegistryHost.ts` 在启用/禁用时登记与注销。
  - ~~蓝图节点类型仍是封闭枚举（`NodeType` 10 值），没有 `blueprintNode` 贡献点解析与查表校验；"未知 `type` 分流"（硬错误 vs 未接通软告警）未实现~~ → **已落地**：`NodeType::Other(String)` + `crates/hp-core/src/blueprint_registry.rs` + `manifest.rs` 的 `blueprintNode` 解析（含键白名单）+ 校验/软告警分流。
  - ~~「全部设置」系统界面、设置注册表与 `settingsSection` 贡献点均未实现；现有三项设置尚无统一界面~~ → **已落地**：`apps/desktop/src/app_ui/settings/`（`SettingsApp` + `settingsRegistry`）、`packages/config/src/settings.ts` 的设置注册表、顶部「更多设置」入口，三项设置已迁入。
  - ~~三张注册表的一致性门禁（`check:panels` / `check:settings`、`check:blueprint-nodes` 的扩展断言）未接入~~ → **已落地**：`pnpm check:panels`（23 项）、`check:settings`（43 项）、`check:blueprint-nodes` 42 → **55 项**。
- **RFC 0010 之后的口径（D76–D80）—— 已全部落地（2026-09）**：D76 统一响应包装 `{ ok, data?, error? }` 与结构化 `HpError{code}`（契约侧 **113 条全部「已包装」、0 条「裸返回」**，`pnpm check:commands` 双向守护）；D77 事件载荷统一驼峰（10 个事件 DTO + 前端全部监听点同批改）；D78 `file.query` 键集游标分页；D79 补 `api/tag.ts` 的六条关系命令封装。另注：D80 已把 `setting.registry` / `setting.search` / `panel.registry` / `panel.settings` **改判为前端函数**，不再作为命令。
