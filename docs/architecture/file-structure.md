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
    cover_repo.rs     # 文件**封面覆盖**（用户自设的颜色 / 图片，迁移 0009；批量取 + 取值校验）
    ops_repo.rs       ai_undo_repo.rs
    blueprint_repo.rs # 蓝图（整文档 JSON，RFC 0007；写库前归一化 schema 版本 + 打开时一次性迁移回写）
    source_tree.rs
    purge_repo.rs     # 卸载源的逐表清理清单（`DERIVED_TABLES`：**新增引用 files(id) 的表必须登记**）
  global/             # 全局配置库
    global_db.rs      plugin_repo.rs
    blueprint_template_repo.rs  # 应用级共享的蓝图模板
  dict/               # tag 词库（独立 SQLite 文件，应用级共享，RFC 0006）
    dict_db.rs        # 连接 / 迁移 / 多语言查询（TagDictDb）
    tag_lib_db.rs     # 四库**单库句柄**：打开 / 元信息 / 只读查询 / 行映射（TagLibDb）
    tag_lib_write.rs  # 四库**用户库写入**：概念（名称·来源·库 3 字段）与库 2 关系
    tag_lib_set.rs    # 四库**聚合查询层**：用户库 > 扩展包 > 内置基底的统一视图（TagLibSet）
    tag_lib_merge.rs  # 多扩展包之间的**重复概念归并**（MergeIndex，D36.3）
  migrations/         # 迁移 SQL（forward-only，发布后禁止修改；权威文本在这些文件里）
    repo/             # 仓库库：0001_init … 0009_file_covers.sql（当前版本 = 9）
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
    plugin.rs           # 插件包：列出 / 发现 / 安装（本地与随包）/ 版本与回滚
    plugin_lifecycle.rs # 插件按仓库启用 / 禁用 / 状态 / 加载（含 plugin.changed|loaded 发射点）
    plugin_contributions.rs # 三张注册表的插件注册视图（plugin.contributions）
    plugin_control_channel.rs # 控件通道地基（归属校验 / 受监督调用 / plugin.error）+ panelSchema / validateControl
    plugin_control_event.rs   # 控件事件回传链（plugin.controlEvent，控件标准第 6 节 / D63）
    plugin_catalog.rs   # 「扩展」菜单的目录通道（plugin.panelCatalog：面板 + 无面板的数据扩展）
    plugin_panel_data.rs # 面板 bind 的受控取数通道（plugin.panelData）
    blueprint.rs        # 蓝图命令桥接（含 blueprint.changed 广播）
    book.rs             # 图书元数据桥接（book.meta：EPUB 作者/简介/内嵌封面，磁盘缓存）
    ai.rs fsops.rs      # AI 打标桥接 / 文件操作桥接

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
                      #   stableCallback（恒定引用回调：让条目单元的 memo 真正生效；
                      #     媒体预览与图书预览共用一份）、
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
                      #   + 纯逻辑模块 viewerZoom·viewerPlacement·viewerFormat·viewerKeymap·viewerPreload
                      #   + DOM 工具 viewerDecode（换图前离屏解码：解码完成才原子替换 url+尺寸，缺陷 0028）
                      #   + 面板设置 useViewerSettings 与浏览序列 useViewerSequence
                      #   + 相邻图像预加载 useViewerPreload）
                      #   设置热加载走四条独立触发源：本地广播 / setting.changed / 窗口焦点 / 面板激活
                      #   键盘：按键映射与「取焦点判据」都在 viewerKeymap（左=上一张、右=下一张，
                      #   顺序即胶片栏序列；从其他面板进入时面板被程序激活，需自行取焦点）
                      #   换图：`ShownImage{url,natural,fileId}` 单一状态 + 每 URL 一个新 `<img>` 元素
                      #   （key+decoding=sync）；解码期间保留上一张画面——首帧不可能"半新半旧"（0026/0027/0028）
                      #   预加载：取哪些邻居在 viewerPreload（前台才取 / 大图不解码 / 同张只预热一次），
                      #   取图策略与缓存收敛在 shared/imageUrl.ts（HEIC 预览与当前图共用一份）
    ViewerPanel.tsx   # 查看器（大图/视频/音频预览 + **文本类正文阅读**；**顶部基础信息栏**
                      #   由面板设置 infoBarEnabled 控制）
                      #   文本类（media_type=text，txt/md/epub）交 panels/viewer/ 阅读区渲染，
                      #   判据用媒体类型而不是扩展名（免得与扫描器两份口径）
    viewer/           # 查看器的正文阅读区（2026-10-09：用户口径"查看器新增 txt / epub 查看"）
                      #   ViewerReader.tsx 阅读区装配（按宽度下发分栏/字号 CSS 变量；自己滚）
                      #   BookBlocks.tsx EPUB 块渲染（**不注入 HTML**：用 React 元素渲染
                      #     后端给的 heading/paragraph/image 纯数据块）
                      #   useViewerBookContent.ts 分页取数（滚动到底部附近才取下一页；
                      #     切书即丢页——用户口径"字符缓存不需要大、滚动时按需缓存"）
                      #   viewerReaderView.ts 纯逻辑（分栏阈值/字号/是否该取下一页；零依赖，
                      #     门禁直接 import。**注意**：不能叫 viewerReader.ts——与
                      #     ViewerReader.tsx 在 Windows 上大小写不敏感地撞名，tsc 报 TS1261）
    bookpreview/      # 图书预览（panel.bookpreview；文本类文件 txt/md/epub）                      #   BookPreviewPanel.tsx 主面板（工具条 + 三种视图容器 + 封面宽度滑条
                      #     + 右键菜单装配：复用 ../mediaPreviewMenu 与 ../mediaPreviewActions，
                      #     删除动作 `albumScoped: false`——文本类进不了相册成员列表）
                      #   BookCard.tsx 卡片模式单元（封面在上 + 文件名在下；文件名悬停滚轮横滚；
                      #     选中/右键回传面板：selected + onSelect + onContextMenu）
                      #   BookListRow.tsx 列表模式单元（封面在左 + 文件名/作者/简介，右栏填充剩余）
                      #   BookCoverCell.tsx 封面模式单元（一行多本；右栏固定为封面宽度 × 2）
                      #   BookRowInfo.tsx 列表/封面共用信息三行（作者：/简介：，简介溢出齐平封面底）
                      #   BookCoverArt.tsx 封面画面（文字封面打底 + 内嵌封面盖上，失败自然回落）
                      #   BookTextCover.tsx 文字封面（底色由作品名派生，同名恒同色）
                      #   bookPreviewView.ts 取值域与纯函数（零依赖，门禁直接 import）
                      #   bookPreviewData.ts 取数（file.query 过滤 mediaTypes:['text']；不按相册）
                      #   bookMetaCache.ts 元数据缓存（结果缓存 + in-flight 去重）
                      #   useBookMeta.ts 单本读取（只对需要内嵌封面的书发 book.meta）
                      #   --- 封面覆盖（用户口径 2026-10-09："txt 右键可以更换封面颜色或自定义图片"）---
                      #   bookCoverCache.ts 覆盖的批量缓存（按 **id 粒度**记账：翻页时 id 变多，
                      #     按仓库整体去重会让新一页的封面永远取不到）+ 版本号订阅
                      #   useBookCoverOverride.ts 单元侧同步读（不发命令；发命令是面板的事）
                      #   BookCoverMenu.tsx 右键菜单里的「更换封面」（预设色板 + 取色器 + 选图 + 恢复默认），
                      #     经共享菜单的 `extraItems` 插槽挂进来（不是第二份菜单）
    MetadataPanel.tsx # 元数据面板（索引字段 + EXIF/ffprobe 摘要；消费宿主设置 ui.sizeUnit/dateFormat/dateShowTime）
    metadataInfo.ts   # 元数据面板的**纯解析**（ffprobe 原始 JSON、EXIF 摘要 → 尺寸/时长/编码/码率/帧率）
    MediaPreviewPanel.tsx   # 媒体预览主面板（列表行渲染 + 三种视图容器 + 图片尺寸 CSS 变量）
    mediaPreviewData.ts     # 面板取数（全库游标翻页 + 排序后的条目流）
    mediaPreviewPaging.ts   # 游标翻页的纯逻辑（drainPages：严格前进 + 页数上限两道循环安全闸门）
    mediaPreviewSession.ts  # 面板设置读取与本会话覆盖（四条设置的缺省/覆盖口径）
    mediaPreviewToolbar.tsx # 顶部工具条（模式/类型/计数/尺寸滑条/视图与排序下拉）
    mediaPreviewActions.ts  # 文件操作动作（删除/重命名/复制路径/重新分析）
                            #   **两个面板共用**：媒体预览缺省按相册上下文分流（`albumScoped = true`），
                            #   图书预览传 `false`（文本类进不了相册成员列表，否则删除是静默空操作）
    mediaPreviewMenu.tsx    # 右键菜单（动作开关与渲染；**媒体预览与图书预览同一份实现**）
    mediaPreviewSelection.ts # 选中集与 `selection_change` 上报（令牌防过期 + 运行期 context）
    mediaPreviewCell.tsx    # 缩略图单元 + 宽高比测量 + ratioCache 版本号
                            #   缩略图**挂载即预热**（窗口即对称预加载带；`warmedThumbs` + `new Image()`
                            #   把取图与 `content-visibility` 的跳过渲染解耦，D89）
                            #   共享可见性观察器**只服务音频波形**（`decodeAudioData` 是实打实的 CPU）
    mediaPreviewDropdown.tsx # 工具条下拉
    mediaPreviewView.ts     # 取值域与纯函数
    mediaPreviewVirtual.ts  # 虚拟化的行/列模型（纯函数：切行、行高、列偏移、窗口区间、自适应断行）
    mediaPreviewVirtualRows.tsx # 行虚拟化的共享钩子（定高 / 测量 / 变量行高 + 滚动窗口）
    mediaPreviewScroll.ts   # 滚动位置恢复的纯逻辑（与后台翻页的时序冲突，缺陷 0018 第 6 轮）
    BlueprintPanel.tsx      # 蓝图编辑器主面板（**入口装配**：状态 + 文档命令 + 层工具 + 图编辑动作；
                            #   界面拼给下面四个区块组件；含当前层状态）
    BlueprintDocList.tsx    # 蓝图文档列表（新建/带结构创建开关/选中/设为默认/模板下拉）
    BlueprintToolbar.tsx    # 编辑器工具条（名称/保存/一键整理/恢复内置默认/删除/视图切换）
    BlueprintPalette.tsx    # 节点添加面板（可从调色板新增的节点类型）
    BlueprintJsonView.tsx   # JSON 文本视图（直接改 JSON + 解析回文档）
    BlueprintCanvas.tsx     # 节点画布（拖拽/连线/平移缩放/右键直线刀痕**批量删除**；**只渲染当前层**；挂右下角小地图）
    BlueprintMinimap.tsx    # 小地图（缩略当前层节点/连线 + 视口指示框；拖动即把视口中心移到该处）
    BlueprintInspector.tsx  # 节点属性面板（浮层 visible/height/size/anchor/offset/shadow/radius/hide_label）
    BlueprintLayerBar.tsx   # 层工具条（切换/新增/重命名/删除/排序 + 无根层标记）
    useBlueprintEditorState.ts # 编辑器界面状态（文档 / JSON 文本 / 选中项 / 视图模式 / 提示）
    useBlueprintDocuments.ts   # 蓝图文档的后端命令（列表 / 装载 / 保存 / 新建 / 删除 / 设为默认 / 恢复 / 静默保存）
    useBlueprintLayerTools.ts  # 层工具接线（切层 / 新增 / 重命名 / 排序 / 删除 / 设为主界面 + 无根层派生）
    useBlueprintGraphEdits.ts  # 图编辑动作接线（新增节点 / 改字段 / 软删除 / 删边 / 连线落引用 / 一键整理）
    useBlueprintUnlinked.ts    # 未接通节点的面板侧派生（画布灰显与顶部提示用的 key 集合）
    blueprintNodeFactory.ts # 新节点工厂（**只追加自身**：不补最小链、不跨链路挂钩；引用由显式上级推导、**兜底引用只在本层内找**）
    blueprintPorts.ts       # 端口与边类型契约（**由 `packages/config` 的节点定义表投影**而来）
    blueprintLabels.ts      # 节点本地化显示层（显示名/摘要/字段标签；画布与属性面板共用）
    blueprintNodeColors.ts  # 节点/边配色纯数据（画布与小地图共用同一份色板；未知/插件类型有中性兜底色）
    blueprintLayers.ts      # 层操作纯函数（新增层自带界面根/重命名唯一/排序/补根）
    blueprintDelete.ts      # 软删除（节点）+ 一次划线批量删除 `softRemoveMany`（原子）+ 层硬删除 removeLayer（D55）
    blueprintSlots.ts       # 画布槽位（就近空槽）
    blueprintArrange.ts     # 「一键整理」纯算法（BFS 分层、按列树状展开）
    blueprintGeometry.ts    # 纯几何（视口换算/贝塞尔采样/刀痕命中）
    blueprintMinimapGeometry.ts # 小地图纯几何（包围盒/等比缩放/坐标换算/视口矩形）
    blueprintStructure.ts   # 由当前布局生成结构骨架（单层）+ 跨窗口结构快照
    repoDisplay.ts          # 仓库面板的**当前仓库显示名**解析（纯函数：按 repoId 查名字，
                            #   查不到即占位符——**永不回落 repoId**，内部主键不是显示值）
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
> 已有四轮这种检查，结论都写在文件头里：
> - `crates/hp-core/src/blueprint.rs`（曾 996 行：图文档 + 枚举 + 节点结构 + 校验 + 软告警 + 存储行）→ **拆**成
>   `blueprint.rs` / `blueprint_types.rs` / `blueprint_node.rs` / `blueprint_row.rs` / `blueprint_validate.rs` /
>   `blueprint_warnings.rs`（各自一句话职责，互相不重叠）；
> - `crates/hp-core/src/blueprint_tests.rs`：**第一版结论是"不拆"**（只服务"蓝图"一个功能域）；
>   但随规则增长它涨到 **1217 行、越过 1200 硬上限**，于是改为：`blueprint_tests.rs` 只作为
>   `mod tests` 外壳（12 行），测试项按"视图/结构类"与"校验/规则类"分到
>   `blueprint_tests_structure.rs`（~620 行）与 `blueprint_tests_rules.rs`（~460 行），
>   用 `include!` 展开进同一个测试模块——**拆的是文件，不是模块**，私有项照旧可测。
> - 2026-09 第四轮（**按"900 行左右"逐个体检**，结论：七个文件都拆）：见下节「本轮拆分记录」。

## 本轮拆分记录（2026-09 第四轮）

触发口径：**所有 900 行左右（≥870 行）的 `src` 代码文件**逐个体检并按职责拆分。
`tools/check-line-count.mjs` 只扫 `src`，因此 `tools/check-panels.mjs`（1435 行）与
`tools/blueprint-node-check.mjs`（1048 行）**本轮不动**（门禁脚本自身没有测试保护）。

| 拆分前（行数） | 拆分后（各自一句话职责） |
| --- | --- |
| `crates/hp-store/src/dict/tag_lib_db.rs`（1167） | `tag_lib_db.rs` 四库单库句柄（打开 / 元信息 / 只读查询 / 行映射）· `tag_lib_write.rs` 用户库写入（概念与关系）· `tag_lib_set.rs` 跨层聚合查询层 · `tag_lib_db_tests.rs` 四库测试清单（`include!`） |
| `apps/desktop/src-tauri/src/commands/plugin.rs`（1153） | `plugin.rs` 插件包安装·发现·版本回滚 · `plugin_lifecycle.rs` 按仓库启用·禁用·状态·加载 · `plugin_contributions.rs` 三张注册表的插件注册视图 · `plugin_control_channel.rs` 控件通道地基与 schema/业务级校验命令 · `plugin_control_event.rs` 控件事件回传链 |
| `crates/hp-core/src/plugin.rs`（1053） | `plugin.rs` 清单结构与只读访问器 · `plugin_types.rs` 取值域（信任/来源/运行形态/能力/宿主 API 版本）· `plugin_validate.rs` 清单校验 · `plugin_row.rs` 存储行 · `plugin_tests.rs` 测试清单（`include!`） |
| `apps/desktop/src/app_ui/panels/MediaPreviewPanel.tsx`（965） | `MediaPreviewPanel.tsx` 主面板（列表行渲染 + 三种视图容器 + 尺寸 CSS 变量）· `mediaPreviewData.ts` 取数 · `mediaPreviewSession.ts` 设置读取与本会话覆盖 · `mediaPreviewToolbar.tsx` 顶部工具条 · `mediaPreviewActions.ts` 文件操作动作 · `mediaPreviewMenu.tsx` 右键菜单 · `mediaPreviewSelection.ts` 选中集与 `selection_change` 上报（既有：`mediaPreviewCell.tsx` / `mediaPreviewDropdown.tsx` / `mediaPreviewView.ts`）；**2026-10 缺陷 0018 P1-A 再拆三件**：`mediaPreviewPaging.ts` 游标翻页纯逻辑 · `mediaPreviewVirtual.ts` 行/列模型纯函数 · `mediaPreviewVirtualRows.tsx` 行虚拟化共享钩子；**第 6 轮**再拆 `mediaPreviewScroll.ts` 滚动恢复纯逻辑（`check:panels` 的 `MEDIA_FAMILY_FILES` 同步登记这四件） |
| `crates/hp-core/src/blueprint_registry.rs`（870） | `blueprint_registry.rs` 注册表与查询视图 · `blueprint_node_decl.rs` 节点声明取值域与结构 · `blueprint_node_decl_validate.rs` 声明校验与端口推导 · `blueprint_builtin_nodes.rs` 宿主内置 10 种定义表 |
| `apps/desktop/src/app_ui/panels/BlueprintPanel.tsx`（874） | `BlueprintPanel.tsx` 编辑器装配 · `BlueprintDocList.tsx` 文档列表 · `BlueprintToolbar.tsx` 工具条 · `BlueprintJsonView.tsx` JSON 视图 · `BlueprintPalette.tsx` 节点添加面板 · `useBlueprintEditorState.ts` 界面状态 · `useBlueprintDocuments.ts` 文档命令 · `useBlueprintLayerTools.ts` 层工具接线 · `useBlueprintGraphEdits.ts` 图编辑接线 · `useBlueprintUnlinked.ts` 未接通派生 |
| `apps/desktop/src/app_ui/core/AppUiApp.tsx`（872） | `AppUiApp.tsx` 外壳根组件 · `blueprintExecutor.ts` 蓝图动作执行器 · `useBlueprintRuntimeWiring.ts` 引擎生命周期接线 · `overlayHost.ts` 浮层宿主 · `panelDetach.ts` 面板脱窗 · `usePluginRegistrations.ts` 插件注册表重建 · `useShellSettings.ts` 界面偏好 · `useTaskWiring.ts` 任务浮窗接线 · `workspaceBootstrap.ts` 启动装载 · `defaultWorkspaceLayout.ts` 默认首屏布局 |

约定（本轮确立，后续拆分照此办理）：

- **域内再导出保持历史路径可用**：`hp_core::plugin::Capability`、`crate::blueprint_registry::NodeRole`
  这类历史路径由域入口 `pub use` 兜住，拆分对调用方**透明**；调用方无需跟着改 import。
- **测试文件用 `include!` 挂进原模块的 `mod tests`**（`plugin_tests.rs` / `tag_lib_db_tests.rs`）：
  拆的是文件不是模块，私有项照旧可测。
- **门禁跟着代码走**：`tools/control-check.mjs` 等按路径读取源码的断言，必须与被拆模块同批改指针
  （断言内容不变，只改它读哪个文件），否则门禁会因为"文件里找不到符号"而误报。

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
                              # （蓝图**节点类型注册表**域：blueprint_registry.rs 注册表与查询视图 /
                              #   blueprint_node_decl.rs 节点声明取值域与结构 /
                              #   blueprint_node_decl_validate.rs 声明校验与端口推导 /
                              #   blueprint_builtin_nodes.rs 宿主内置 10 种定义表）
                              # （控件域：control_types.rs 取值域与**类型注册表** / control.rs schema 结构·解析·校验）
                              # （面板域：面板**分类**与**声明参数**取值域（`category` / `has_class` /
                              #   `blueprint_node` / `mount`，RFC 0010 决策 4，随面板注册表实现落地））
                              # （插件域：plugin.rs 清单结构与只读访问器 / plugin_types.rs 取值域
                              #   （信任等级·来源·运行形态·能力·宿主 API 版本）/ plugin_validate.rs 清单校验
                              #   （结构 / 贡献点完备性 / 取值域 / 声明）/ plugin_row.rs 存储行 /
                              #   plugin_tests.rs 测试夹具 / plugin_contribution.rs 贡献点取值域）
    hp-store/                 # SQLite 访问、迁移、事务；内部按 repo/ 与 global/ 分层
    hp-scanner/               # 媒体源扫描、变更检测、索引任务
    hp-hash/                  # 内容哈希、感知哈希、哈希算法版本记录
    hp-album/                 # 固定相册成员、跟随源同步规则、相册查询
    hp-fsops/                 # 源间复制/剪切/移动/重命名等真实文件操作
    hp-plugin-host/           # 插件生命周期、权限、宿主 API
    hp-ai/                    # AI 打标接口抽象、任务队列、结果回写边界
    hp-media/                 # 媒体子进程管理、播放控制、ffprobe 元数据、ffmpeg 抽帧宿主
    hp-book/                  # 电子书元数据 / 封面 / **正文**解析（EPUB = ZIP + OPF；txt/md 需判编码）
                              #   自实现最小 ZIP 读取器（zip.rs）+ 极简 XML 取值（xml.rs）+
                              #   EPUB 元数据解析（epub.rs）+ 封面格式判定（cover.rs）+ 格式分发（meta.rs）；
                              #   **正文（2026-10-09）**：text.rs 纯文本判编码与分页（BOM → UTF-8 合法性
                              #   → chardetng → GBK 可解码性兜底；实测语料 14 本无一带 BOM、7 GBK + 7 UTF-8）、
                              #   epub_text.rs 把章节 XHTML 过**受控白名单**转成类型化块（**不返回 HTML**：
                              #   渲染它要么 dangerouslySetInnerHTML（不接受）要么白名单，白名单做在解析侧）；
                              #   **不引入 `zip` crate**（D20 依赖本地化），解压走已在依赖树里的 flate2
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
hp-book -> hp-core（只用 HpError/HpResult；纯文件格式解析，不碰数据库、不碰 Tauri）
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
