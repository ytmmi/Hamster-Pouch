# 仓鼠颊文件架构草案

状态：正式草案。本文记录已经由用户确认的方向；实现期开放点不得反向修改这些决策。

## 已确认约束

- 产品：Windows 本地资源管理软件，第一阶段围绕图像 + 视频管理（音频仅写占位行，未知类型不索引，见 D11）。
- 技术栈：Tauri + React + TypeScript。
- Rust 侧：Cargo workspace 多 crate。
- 顶层结构：前后端 workspace 分离。
- 数据库：全局配置库 + 每仓库一个 SQLite 文件。
- 前端包管理器：pnpm workspace。
- `packages/shared-types` 由 Rust 类型生成。
- UI 面板布局按仓库持久化，写入配置库表；不按单一全局布局覆盖所有仓库。
- 插件形态：混合插件系统；AI 打标默认外部进程，3D 模型预览等性能敏感能力可使用动态库；插件可通过 git 安装，且存在系统插件。
- 文件规则：
  - 代码单文件禁止超过 1200 行。
  - 文件职责单一。
  - 禁止在内部嵌套实现无关职责。
  - 按功能分类，不允许大量代码文件堆在同一个文件夹。
  - 文档不受 1200 行限制，但应保持可检索、可分段维护。
- 依赖与构建链本地化（D20）：所有依赖、包、构建链凡是能部署在项目内的一律项目内化；确实无法项目内化的必须告知用户。

## 文件组织原则（强制）

本节是"职责单一 / 按功能分类"的**可执行判据**；AI 编码协作者与 code review 都必须遵守，不得以"文件没超 1200 行"为由跳过。

### 1. 单文件单一职责

- 一个文件只服务**一个功能域**（一个实体、一个仓储、一类命令、一个面板，或一个横切关注点）。
- 判据：能用一句不含"和 / 以及 / 与"的话描述该文件职责。若必须并列多个域（如"tag 和评分和色彩和文件操作"），**必须拆分**。
- 禁止把无关职责塞进同一文件的内部模块、内部 `mod` 或深层闭包来规避拆分。

### 2. 按功能分文件夹（判据：同级是否杂乱，而非数量）

- 是否需要分子目录，取决于**同级文件的职责是否杂乱、能否一眼归类**，**与文件数量无关**。
  - 若同目录文件已按清晰维度命名且内聚（如 `panels/` 下都是 `XxxPanel`、`shared/api/` 下都是按域拆分的 API 封装），**即使数量较多也不拆**——按数量强行分层只会制造无谓层级。
  - 只有当同目录**混放了不同职责、命名无规律、难以归类**时，才建子目录归类。
- 分层优先按**领域**（`repo` / `global`、`album` / `file` / `media`），其次按**角色**（`commands` / `core` / `shared` / `panels`）。
- **禁止**把无关职责的文件平铺在同一目录（例如把命令、类型、组件、工具混在一个 `src/` 根）。
- 新文件必须落入职责相符的目录；没有合适目录时先建目录，再落文件。

### 3. 落地下限（当前结构示例）

```text
crates/hp-store/src/
  lib.rs
  migrate.rs          # 共享迁移执行器
  util.rs             # 共享工具
  repo/               # 仓库库（每仓库一个 SQLite 文件）
    repo_db.rs        # 连接 / 迁移 / schema 版本
    source_repo.rs    file_repo.rs   album_repo.rs
    tag_repo.rs       tag_relation_repo.rs  tag_tree.rs
    rating_repo.rs    color_repo.rs
    ops_repo.rs       ai_undo_repo.rs
    blueprint_repo.rs # 蓝图（整文档 JSON，RFC 0007；写库前归一化 schema 版本 + 打开时一次性迁移回写）
    source_tree.rs
  global/             # 全局配置库
    global_db.rs      plugin_repo.rs
    blueprint_template_repo.rs  # 应用级共享的蓝图模板
  dict/               # tag 词库（独立 SQLite 文件，应用级共享，RFC 0006）
    dict_db.rs        # 连接 / 迁移 / 多语言查询（TagDictDb）
  migrations/         # 迁移 SQL（forward-only，发布后禁止修改；权威文本在这些文件里）
    repo/             # 仓库库：0001_init … 0007_album_member_file_index.sql（当前版本 = 7）
    global/           # 全局配置库：0001_init … 0004_layout_layers.sql（当前版本 = 4）
    dict/             # tag 词库：0001_init.sql
                      # 注意：**没有** `dict_lib/` 目录——实际只有 repo/ global/ dict/ 三个。
                      #   `docs/spec/database-schema.md` 第 5 节把迁移目录写成四者（含 `dict_lib/`），待该规范修正。
  tests/              # 集成测试 + 夹具（default_blueprint.json、blueprint_factory/）

  main.rs             # 入口装配 + AppState
  embed_window.rs     # Win32 原生渲染子窗口宿主（D14）
  commands/           # Tauri 命令桥接（按领域拆分）
    shared.rs
    repo.rs  source.rs  album.rs
    tag.rs   rating.rs  color.rs  file.rs
    media.rs layout.rs
    plugin.rs ai.rs fsops.rs
    blueprint.rs        # 蓝图命令桥接（含 blueprint.changed 广播）

apps/desktop/src/app_ui/
  core/               # 应用装配 / 上下文 / 面板注册表 / 单面板宿主 / 蓝图求值引擎
    blueprintEngine.ts  # 蓝图求值（解析层校验 + 事件→fires/guards→动作序列）
    panelRegistry.tsx   # **面板注册表 → dockview 组件表**（`PANEL_DEFS` / `DOCK_COMPONENTS`；
                        #   RFC 0010 决策 4 要接入插件面板的动态注册路径）
    settingChangeStore.ts # 设置变更的**同窗口**广播（「全部设置」写完即通知面板；
                        #   跨窗口仍走后端 `setting.changed` 事件）
  settings/           # **「全部设置」系统界面**（RFC 0010 决策 7；应用级系统界面，不受蓝图引擎管辖）
    SettingsApp.tsx     # 左侧大类/二级 + 右侧分节设置 + 顶部搜索
    settingsRegistry.ts # 设置注册表（宿主项 + 面板项 + 插件项；`kind` 只取控件输入类）
  menu/               # 顶部功能条、右键菜单
  shared/             # waveform、TagInput、SwitchToggle（胶囊开关：**所有**勾选框的唯一实现）、
                      #   panelLayout（布局 JSON 规范化）、settingValue（设置值读取 + 四条触发源热加载：宿主项与面板项共用）、
                      #   format（显示格式纯函数：体积自适应 KiB/KB、日期三格式、时长/码率/帧率）、
                      #   styles、api/（按域）、types/（按域）、thumbUrl
    blueprintRuntime.ts   # 生效蓝图加载/升级/回退（含解析层校验与回退提示）+ 当前层与每层布局 + 热更新订阅
    blueprintLayout.ts    # 蓝图 → dockview 对账（**只对账当前层**；默认可见标签、组收起/展开与尺寸记忆）
    blueprintSync.ts      # 保存布局时把 dockview 结构增量同步进蓝图（D59）
    blueprintRevision.ts  # 跨窗口"已保存"令牌
    blueprintLint.ts      # 由图结构派生「未接通」节点（画布灰显）
    control/              # 控件标准的宿主侧（受控渲染；`docs/spec/control-standard.md`）
      ControlPanelView.tsx  # 面板级入口：解析 + 两级校验通过才渲染，失败降级为错误态
      ControlNodeView.tsx   # 单节点渲染（可见性求值 + 节点级错误边界 + 递归子节点）
      ControlRenderer.tsx   # `kind` → 受信组件映射（26 种，`Record<ControlKind,…>` 保证不漏）
      controlRenderCoverage.ts # 渲染覆盖清单（纯数据，供 `pnpm check:controls` 断言，避免静默缺口）
      controlTokens.ts      # 档位字段 → 设计 token（不写死像素、不引入自定义配色）
      controlData.ts        # 数据快照、谓词求值、行/标量取值 helpers
      controlTypes.ts       # 宿主渲染上下文（主题/i18n/数据/事件/状态注入）
  panels/             # 各功能面板（同类组件，平铺即可；含 PluginPanel、TagTablePanel、BlueprintPanel）
    imageviewer/      # 图像查看器（多文件功能域：主面板 / 舞台 / 导航器 / 胶片栏 / 信息栏
                      #   + 纯逻辑模块 viewerZoom·viewerPlacement·viewerFormat
                      #   + 面板设置 useViewerSettings 与浏览序列 useViewerSequence）
                      #   设置热加载走四条独立触发源：本地广播 / setting.changed / 窗口焦点 / 面板激活
    ViewerPanel.tsx   # 查看器（大图/视频/音频预览；**顶部基础信息栏**由面板设置 infoBarEnabled 控制）
    MetadataPanel.tsx # 元数据面板（索引字段 + EXIF/ffprobe 摘要；消费宿主设置 ui.sizeUnit/dateFormat/dateShowTime）
    metadataInfo.ts   # 元数据面板的**纯解析**（ffprobe 原始 JSON、EXIF 摘要 → 尺寸/时长/编码/码率/帧率）
    BlueprintPanel.tsx      # 蓝图编辑器主面板（含当前层状态）
    BlueprintCanvas.tsx     # 节点画布（拖拽/连线/平移缩放/右键直线刀痕；**只渲染当前层**）
    BlueprintInspector.tsx  # 节点属性面板（浮层 visible/height/size/anchor/offset/shadow/radius/hide_label）
    BlueprintLayerBar.tsx   # 层工具条（切换/新增/重命名/删除/排序 + 无根层标记）
    blueprintNodeFactory.ts # 新节点工厂（key/引用由上级推导、**兜底引用只在本层内找**）
    blueprintPorts.ts       # 端口与边类型契约（**由 `packages/config` 的节点定义表投影**而来）
    blueprintLabels.ts      # 节点本地化显示层（显示名/摘要/字段标签；画布与属性面板共用）
    blueprintLayers.ts      # 层操作纯函数（新增层自带界面根/重命名唯一/排序/补根）
    blueprintDelete.ts      # 软删除（节点）+ 层硬删除 removeLayer（D55）
    blueprintSlots.ts       # 画布槽位（就近空槽）
    blueprintArrange.ts     # 「一键整理」纯算法（BFS 分层、按列树状展开）
    blueprintGeometry.ts    # 纯几何（视口换算/贝塞尔采样/刀痕命中）
    blueprintStructure.ts   # 由当前布局生成结构骨架（单层）+ 跨窗口结构快照
  dialogs/            # 独立窗口对话框
  i18n/               # 多语言（zh-CN / zh-TW / en；键集一致，支持 {name} 插值）

apps/desktop/src/test_ui/
  TestUiApp.tsx       # 功能测试 UI 入口
  api/                # 按域拆分（与 app_ui 同构）
  types/              # 按域拆分
  panels/             # 各测试面板（同类组件，平铺即可）
```

### 4. 校验方式

- `tools/check-line-count.mjs`：递归遍历 `apps/**/src`、`crates/**/src`、`packages/**/src`，任一 `.ts/.tsx/.rs` 超过 1200 行即失败（跳过 `node_modules`/`target`/`dist`/`gen`）。
- 目录组织在 code review / AI 生成后人工检查：新文件是否落入职责相符的功能目录、同级是否出现职责混杂（**不看数量**）。
- 违反原则的改动不得合并；先重组再提交。

> **行数契约的适用范围**：`check-line-count` 目前只扫 `src` 目录，因此 `crates/**/tests/` 下的集成测试与
> `tools/**` 的开发期脚本**不在门禁内**；它们仍受"单文件单一职责"约束，但不按 1200 行硬拦。
> 单文件接近/超过 1000 行时**必须**检查是否该拆，且**不得**靠 `include!`/内部 `mod` 把职责藏起来绕过拆分。
> 已有两次这种检查，结论不同、都写在文件头里：
> - `crates/hp-core/src/blueprint.rs`（曾 996 行：图文档 + 枚举 + 节点结构 + 校验 + 软告警 + 存储行）→ **拆**成
>   `blueprint.rs` / `blueprint_types.rs` / `blueprint_node.rs` / `blueprint_row.rs` / `blueprint_validate.rs` /
>   `blueprint_warnings.rs`（各自一句话职责，互相不重叠）；
> - `crates/hp-core/src/blueprint_tests.rs`：**第一版结论是"不拆"**（只服务"蓝图"一个功能域）；
>   但随规则增长它涨到 **1217 行、越过 1200 硬上限**，于是改为：`blueprint_tests.rs` 只作为
>   `mod tests` 外壳（12 行），测试项按"视图/结构类"与"校验/规则类"分到
>   `blueprint_tests_structure.rs`（~620 行）与 `blueprint_tests_rules.rs`（~460 行），
>   用 `include!` 展开进同一个测试模块——**拆的是文件，不是模块**，私有项照旧可测。

## 顶层目录草案

```text
HamsterPouch/
  apps/
    desktop/                  # Tauri 桌面应用壳，尽量薄
      src/                    # React UI：core / menu / shared / panels / dialogs / i18n
      src-tauri/              # Tauri 命令入口、窗口/菜单/事件桥接；命令按领域放 commands/
      package.json
      tauri.conf.json
  crates/
    hp-core/                  # 领域模型：仓库、媒体源、虚拟相册、图像、tag、评分
                              # （蓝图域按职责分文件：blueprint.rs 图文档 / blueprint_types.rs 取值域 /
                              #   blueprint_node.rs 结构 / blueprint_row.rs 存储行 /
                              #   blueprint_validate.rs 硬错误 / blueprint_warnings.rs 软告警 /
                              #   blueprint_migrate.rs 版本迁移 / blueprint_tests.rs 测试夹具）
                              # （控件域：control_types.rs 取值域与**类型注册表** / control.rs schema 结构·解析·校验）
                              # （面板域：面板**分类**与**声明参数**取值域（`category` / `has_class` /
                              #   `blueprint_node` / `mount`，RFC 0010 决策 4，随面板注册表实现落地））
                              # （插件域：plugin.rs 清单与信任·运行形态 / plugin_contribution.rs 贡献点取值域）
    hp-store/                 # SQLite 访问、迁移、事务；内部按 repo/ 与 global/ 分层
    hp-scanner/               # 媒体源扫描、变更检测、索引任务
    hp-hash/                  # 内容哈希、感知哈希、哈希算法版本记录
    hp-album/                 # 固定相册成员、跟随源同步规则、相册查询
    hp-fsops/                 # 源间复制/剪切/移动/重命名等真实文件操作
    hp-plugin-host/           # 插件生命周期、权限、宿主 API
    hp-ai/                    # AI 打标接口抽象、任务队列、结果回写边界
    hp-media/                 # 媒体子进程管理、播放控制、ffprobe 元数据、ffmpeg 抽帧宿主
    hp-dto/                   # 跨层 DTO（前端 shared-types 由这些类型生成；`src/lib.rs` 按域分组、
                              #   `src/bin/generate.rs` 负责导出）。桥接层必须直接用这里的类型
    # hp-core/examples/check-blueprint.rs：蓝图体检小工具（stdin 读 JSON，打印解析/硬错误/软告警），
    #   不属于产品运行路径；`check-line-count` 只扫 `src`，因此它不受 1200 行门禁约束。
  packages/
    ui/                       # 可复用面板组件、布局组件、设计 tokens
    shared-types/             # 由 Rust 类型生成的前端共享类型，生成文件必须标记来源
                              #   （marker：`// @generated by hp-dto (ts-rs) — DO NOT EDIT` + source + regenerate）
    config/                   # 前端共享配置、常量、面板注册表类型、布局类型
      panels.ts               # **面板注册表**（RFC 0010 决策 4：内置 13 个 + 插件可注册；`category` /
                              #   `has_class` 有无类目 / `blueprint_node` / `settings` / `mount` / `origin`）
      settings.ts             # 应用设置键与默认值（「全部设置」设置注册表，`docs/spec/settings-standard.md`）
      blueprint.ts            # 蓝图图文档类型 / 分层工具 / 解析层校验 / 用户保存与旧默认识别（取值域再导出）
      blueprintValues.ts      # 蓝图**取值域**（枚举清单与固定常量 + 判定函数；被 blueprint.ts 再导出）
      blueprintNodes.ts       # 蓝图**节点定义表**（节点标准第 2 节：字段/取值域/父子/事件；画布与解析共用）
      blueprintOverlay.ts     # 浮层外观档位与相对定位纯函数（RFC 0007：这类纯函数落在 config）
      blueprintDefault.ts     # 内置默认蓝图 DEFAULT_BLUEPRINT（Rust 夹具的唯一来源）
      controlKinds.ts         # 控件取值域（26 种 kind / 事件谓词表 / 各类档位清单）
      controlRegistry.ts      # 控件**类型注册表**（每种 kind 的专属字段/事件/是否容器）
      control.ts              # 控件 schema 类型、解析层校验、业务级校验、事件载荷
      index.ts                # 包入口：`export *` 汇总上面各模块（消费方只认包入口）
  plugins/
    system/                   # 系统插件源码与打包输入（随应用发布；运行时插件目录在 app_data/plugins）
      python-core/            # 待办：Python 核心 system 插件（提供 Python 环境，使 Python 插件可源码分发）
    examples/                 # 插件示例与接口夹具，不放核心逻辑
    # 插件分发与打包产物不入库：Rust 插件走 .zip 二进制包（RFC 0009）
  external-cli/               # 外部 CLI 程序（ffmpeg 等编解码工具），随应用捆绑发布（D14）
  docs/
    architecture/             # 文件架构、总体架构、决策清单
    rfc/                      # 决策记录（0001–0010；0010 = 面板与蓝图节点注册）
    spec/                     # 模块技术规范（control-standard / panel-standard / settings-standard /
                              #   blueprint-node-standard / plugin-standard / commands-events / module-boundaries …）
    roadmap/                  # 实施路线图
    issues/                   # **缺陷与已知问题登记**（编号 NNNN；准入判据见该目录 README：
                              #   违反已确认决策/已定稿规范，或造成数据损坏。「还没做」属 roadmap 不属此列）
  tools/                      # 开发脚本、校验脚本、迁移检查
                              # 自检脚本（`pnpm check:*`）：蓝图 runtime/delete/engine/nodes/geometry/slots、
                              #   控件标准 `control-check.mjs`（Rust↔TS 注册表、渲染覆盖、文档一致性）、
                              #   **布局结构 `layout-check.mjs`**（grid.root 必须是 branch 等 dockview 不变量）、
                              #   行数与文档状态。节点/控件夹具目录**只由脚本产出**，不手工维护。
                              #   **`check-status.mjs`**（`pnpm check:status`）：守护 `docs/architecture/
                              #   implementation-status.md` 的机械一致性（§1↔§2 计数与状态分布、状态取值、
                              #   `路径:行号` 引用可解析且在界内）；权威描述见该文档第 5 节。
                              # 修数据工具（默认 dry-run，需 `--apply` 才写库，写前自动备份到 `backups/`）：
                              #   `fix-layer-layout.mjs`（给缺布局的层补该层专属布局）、
                              #   `fix-blueprint-home.mjs`（把某层标为主界面并清掉"上次所在层"）。
  Cargo.toml
  package.json                # pnpm workspace 根配置
```

## 依赖方向草案

允许方向：

```text
apps/desktop -> packages/ui -> packages/shared-types
apps/desktop -> src-tauri -> crates/*
crates/hp-* -> hp-core
hp-scanner/hp-album/hp-ai -> hp-store
hp-media -> hp-store（元数据/抽帧结果缓存）+ hp-core（媒体任务模型）
hp-plugin-host -> hp-core + hp-store 的稳定接口
hp-fsops -> hp-core + hp-store
hp-dto -> hp-core（跨层 DTO；由 ts-rs 生成 packages/shared-types）
```

禁止方向：

- `hp-core` 依赖任何 Tauri、React、SQLite、文件系统细节。
- UI 直接读写 SQLite；必须经过 Tauri 命令/事件。
- 插件直接操作数据库或文件系统；必须经过宿主 API。
- 插件创建自由 React 组件、自定义 CSS/配色或独立窗口；控件（面板**内部**的标准 UI 单元）必须走 `docs/spec/control-standard.md`。**注册权（RFC 0010 决策 2）**：插件**可以**注册**面板**与**蓝图节点类型**（纯声明式，命名空间 `plugin.<plugin_id>.<local_id>`，不落库），**不可以**注册**控件**（26 种 `kind` 是宿主内置白名单）。**「浮动控件」类别已于 2026-09 取消**，浮层由蓝图的 `overlay` 容器承载。
- `src-tauri` 内堆积业务规则；它只做参数校验、权限检查和调用 crate。

## 1200 行规则的执行方式

- 任一代码文件接近 1000 行时，必须在 code review 或 AI 生成后检查是否应拆分。
- 拆分优先级：按领域职责拆 > 按算法步骤拆 > 按 UI 区块拆。
- 不允许为了规避行数把逻辑塞进 `.ts/.rs` 的深层嵌套闭包或内部模块。
- 文档、生成的类型文件、锁文件不受该规则限制，但生成文件必须标记来源。

## 实现注意

- 面板布局表放全局配置库，每行带 `repo_id`；读取布局时必须按当前仓库过滤。
- 桌面应用构建走 `pnpm app:build`（= `tauri build --no-bundle`），**不要直接用 `cargo build --release`**：前者会重新打包 `apps/desktop/dist` 前端产物并嵌入二进制，后者在前端已构建过时会认为资产未变而**静默沿用旧的内嵌产物**，表现为"改了前端但运行的是旧界面"。
- 前端资产文件名带内容哈希，重建后旧哈希文件会被删除；若 WebView2 缓存了旧 `index.html`，可能引用已删除的 chunk 而白屏，排查时可清理 `%LOCALAPPDATA%\<identifier>\EBWebView`。
- 打包运行（无 devtools）下排查前端链路的诊断通道：前端调用 `debug_log` 命令，日志追加到应用数据目录 `debug.log`。
- git 插件更新保留旧插件包目录；回滚是目录切换，不依赖网络。
- 系统/受信动态库插件使用 C ABI + 版本化结构体；`community`/`local-dev` 不允许动态库。
- WASM 插件有资源限额、按仓库授权、纯数据输出，并只允许受控查询宿主函数；运行时为 `wasmi`（D42）。
- 来源由宿主判定，manifest 不得自称 `system`；`system` 等级必须持主线仓库构建者签名（D40）。
- Rust 插件走 `.zip` 二进制包，不做源码分发；Python 插件由 Python 核心提供环境后走源码分发（D38/D39）。
- 插件控件标准先于插件 UI 实现落地：`docs/spec/control-standard.md`（「浮动控件」已于 2026-09 取消，浮层改由蓝图 `overlay` 容器承载）。
- **面板注册表与蓝图节点注册表不得用"先到先得"消歧**（RFC 0010）：插件注册项**必须**是 `plugin.<plugin_id>.<local_id>`，宿主内置项用裸 id，形式本身保证不冲突；宿主不接受任何覆盖内置项的路径。
- **插件缺失不得绑架用户数据**（RFC 0010 决策 6）：蓝图里引用了未安装/未启用插件注册的面板或节点类型时，按**未接通**处理——软告警 + 画布灰显 + **允许保存** + 节点与边原样保留 + 插件恢复后自动恢复。**不要**把它做成硬错误。
- **「全部设置」不是蓝图层**（RFC 0010 决策 7）：它是应用级系统界面，**不进 `blueprints` 表、不受蓝图引擎管辖、不参与 `panel_layouts`**；设置值只写全局库 `app_settings`，不新增库表。
- 插件运行时目录不使用 Windows Roaming 目录（插件与原生依赖可能数百 MB）。
- 文件变更监听采用 watcher + 定期全量校验；watcher 事件丢失必须触发重扫。
