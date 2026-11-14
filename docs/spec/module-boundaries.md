# 模块技术规范：顶层边界

状态：正式草案。本文只定义模块边界、命令/事件类别和扩展点，不定义具体函数签名。

## 总体分层

```text
React 面板层
  - 只负责呈现、交互、布局、命令发起、事件订阅
Tauri 桥接层
  - 参数校验、权限检查、调用 Rust crate、转发事件
Rust 核心层
  - 领域规则、扫描、哈希、相册、存储、文件操作、插件宿主、AI 抽象
数据/文件层
  - 全局配置库、仓库 SQLite、媒体源真实文件、缩略图/缓存
```

## Rust crate 边界

- `hp-core`：纯领域模型与错误类型；不依赖 Tauri/SQLite/文件系统。
- `hp-db`：SQLite 连接骨架——`PragmaSet` 组合（WAL / busy_timeout / 外键）、前向迁移执行器、关库检查点，以及 `store_err` / `now_iso` / `uuid` / `require_nonempty` 四个小工具。**只放骨架，不放 schema、SQL 与迁移清单**；不依赖任何领域 crate（`hp-repo` / `hp-global` / `hp-dict` 依赖它，反向禁止，`check:db-boundary` 断言）。
- `hp-repo`：仓库库（每仓库一个 SQLite 文件）的表结构、SQL、迁移清单与领域仓储（`RepoDb` + 各 `*_repo`）；连接经 `hp-db` 打开；不依赖 `hp-global` / `hp-dict`（反向禁止，`check:db-boundary` 断言）。D186 从 `hp-store` 拆出，D188 起调用方直接依赖本 crate。
- `hp-global`：全局配置库（仓库注册表、应用设置、面板布局、插件注册表行）的表结构、SQL、5 份迁移清单与事务（`GlobalDb`）；连接经 `hp-db` 打开；**不依赖 `hp-repo` / `hp-dict`**（反向禁止，`check:db-boundary` 断言）。D187 从 `hp-store` 拆出，D188 起调用方直接依赖本 crate；`hp-plugin-host` 是全仓唯一「只要全局库、不要仓库库」的 crate，直接依赖本 crate。
- `hp-pathrule`：媒体源内**相对路径的纯规则**——`is_excluded_path`（前缀命中自己与全部后代，不命中 `a/bc`）与 `retain_visible_paths`；**无 IO、无 SQLite、无序列化**，也不依赖任何库 crate（`check:db-boundary` 断言）。D187 从 `hp-repo` 摘出：`hp-album`（媒体库视图）与 `hp-scanner`（逐文件判定）都要用它，不该为一次 `&str` 比较而依赖整个仓储层。SQL 侧的同口径谓词仍在 `crates/hp-repo/src/source_exclusion_repo.rs`（`substr(...) = e.relative_path || '/'`），两侧必须逐字一致。
- `hp-dict`：tag 词库（`TagDictDb` + 四库 `TagLibDb` / `TagLibSet` / `MergeIndex`）的表结构、SQL、迁移清单与事务；连接一律经 `hp-db` 打开；不依赖 `hp-repo` / `hp-global`（反向禁止，`check:db-boundary` 断言）。D188 从 `hp-store` 拆出：`hp-store` 至此只剩再导出，已整个删除，调用方（含桥接层）直接依赖三个领域 crate。
- `hp-scanner`：扫描媒体源、监听变化、生成索引任务；媒体类型判定（扩展名优先 + 内容兜底）；不直接改 UI。
- `hp-hash`：内容哈希与感知哈希；只输出哈希值与算法元数据。
- `hp-album`：固定相册、跟随源同步规则、成员维护、相册查询。
- `hp-fsops`：媒体源间真实文件操作；所有硬盘变更必须可记录，撤销范围属于实现期开放点。
- `hp-plugin-host`：插件包发现、git/本地路径安装、锁定版本、按仓库启用与能力授权、信任等级校验、宿主 API。**运行形态执行体（`external-process` 常驻生命周期 / `dynamic-library` / `wasm`）尚未实现**——当前 `host.rs` 的 `load` 只做校验与 `LoadOutcome`；有执行路径的是**一次一问一答**的控件 schema / 取数 / 事件通道（`crates/hp-plugin-host/src/channel.rs`），以及 **`python` 形态**（`crates/hp-plugin-host/src/python_core.rs`：宿主执行随包 **Python 核心** system 插件的 `bin/python-core.exe --run <版本目录>/<entry>`，解释器随包、不依赖用户系统 Python；Python 插件自身默认仍 `community`）。**不要把三形态"生命周期"读成已具备**（同文第 99、100 行并列了这两条待办）。
- `hp-ai`：AI 打标提供方抽象、任务排队、结果回写；不内置具体厂商 SDK；第一期仅处理图片（D17）。
- `hp-media`：媒体子进程管理（libmpv，单实例常驻、崩溃重启）、播放控制、ffprobe 元数据探测、ffmpeg 抽帧宿主、**音频波形图生成**（`waveform.rs`，ffmpeg `showwavespic` → 透明背景 PNG，按内容哈希缓存；2026-10-17 / D115）；外部进程调用带超时与错误降级。

## 前端边界

- `apps/desktop/src`：应用装配、路由/工作区、面板容器。
- 所有应用内系统文字必须走 i18n（`t(key, params)`，三语键集一致），禁止硬编码（D27）；面板标题等由框架持有的文案在语言变化后需显式刷新。
- `packages/ui`：可复用组件，不知道仓库业务。
- 面板按功能拆分：仓库面板、媒体源面板、相册面板、网格/列表、查看器、图像查看器、元数据、tag/评分、色彩参考、任务队列、插件面板。
- 面板状态分两类：
  - 会话状态：当前选中、筛选、排序，默认可不持久化。
  - 布局状态：面板位置、大小、可见性，按仓库持久化到全局配置库表，每行带 `repo_id`。

## 命令类别草案

- `repo.*`：创建/打开/关闭/备份仓库；重命名/删除仓库、设为默认仓库。
- `layout.*`：面板布局预设（保存/列出/读取/重命名/删除/设为默认，按仓库隔离 D1）。
- `source.*`：挂载（UI 经原生文件夹对话框选取目录，默认以文件夹名为源名）/ **完全卸载**（删源 + 索引 + 派生数据，单事务）/ 重命名别名（仅添加后）/ 扫描媒体源。
- `file.*`：查询文件（支持媒体类型过滤）、重新校验、读取元数据。
- `album.*`：创建固定/跟随相册、设置媒体属性、维护成员、执行同步。
- `tag.*` / `rating.*`：仓库内 tag 与评分。tag 侧含 `tag.tree`（层级树，含交叉标记）、`tag.createRoot|createChild|createSibling`、`tag.rename`、`tag.move`（拖拽=移动）、`tag.detach`（移到根）。
- `tag.relation.*`：tag 层级与关联（D22，关系图谱数据源）：新增/移除/列出关系、查询上级/下级。
- `fsops.*`：源间复制/剪切/移动；必须返回操作记录 ID。
- `task.*`：长任务进度、暂停、恢复、取消。**全部按 `taskId` 定位**（缺陷 0003）：同一时刻至多一条长任务（单任务闸门），控制请求命中不了当前任务时返回 `cancelled/accepted: false` 而不是作用到"当前那条"。暂停/恢复只对扫描成立。
- `media.*`：媒体播放控制（打开/播放/暂停/定位/停止）、媒体子进程状态查询。
- `color.*`：色彩参考提取（仅图片）、手动调整/锁定色值。
- `plugin.*` / `ai.*`：插件与 AI 任务入口；插件命令必须带仓库上下文并经过能力校验。
- `mcp.*`：**内置 MCP 服务**（D119）只有 `mcp.status`（查询运行状态与客户端接入信息）与 `mcp.reload`（按当前设置再应用一次）两条。**启停不给命令开第二个开关**——服务是否运行由设置项 `mcp.enabled` 单一决定，`setting.set` 写入 `mcp.*` 后自动应用。该服务是**桥接层内的传输适配**（`apps/desktop/src-tauri/src/mcp/`），不新增 crate、不引入 web 框架：MCP 工具一律直接调既有 `#[tauri::command]` 函数，因此不改变 `UI -> Tauri -> crates` 的依赖方向，也不给 crates 增加任何对外接口。
- 命令命名采用混合风格：核心域使用 `domain.action`，插件命令使用 `plugin.{pluginId}.{action}` 命名空间。

## 事件类别草案

- `scan.progress` / `scan.completed` / `scan.error`
- `source.unmount.progress` / `source.unmount.completed` / `source.unmount.error`（**完全卸载**的分阶段进度与结果，见 `commands-events.md` 3.2）
- `file.changed` / `file.missing` / `file.restored`
- `album.sync.progress` / `album.sync.conflict`
- `task.progress` / `task.cancelled`（草案；当前扫描取消走命令 `task.cancel`）
- `plugin.loaded` / `plugin.error`
- `ai.tagging.completed`
- `media.ready` / `media.ended` / `media.crashed`
- `color.extracted`

**长任务进度的界面约定**：扫描与卸载的进度共用同一个**界面居中浮窗**（`apps/desktop/src/app_ui/core/TaskOverlay.tsx`），
进度状态放**模块级 store**（`taskStore.ts`）而**不进 `AppContext`**——否则每个进度事件都会让所有面板重渲染并重跑库查询。
浮窗另有两条稳健性约定：① 长时间无进度时用 `task.status` 与后端**对账**，后端已空闲就自行收起并刷新（防止终止事件丢失后永远转圈）；
② 可取消任务提供取消、卡住时提供手动关闭，界面不会被任务锁死。

**模块级 store 的订阅表只有一份骨架**（D205）：`apps/desktop/src/app_ui/core/createStore.ts` 的 `createStore<T>(initial, equals)`
（值型：判等不通过才换引用、才通知）与 `createEventChannel<Args>()`（事件型：只广播当次载荷）。六个 store 模块
（`playerPlayStore` / `musicPlayStore` / `taskStore` / `mediaSortStore` / `settingChangeStore` / `render/surfaceStatsStore`）
只留各自的领域语义与 `useSyncExternalStore` 接线；「哪些字段算变化」仍留在知道字段集的模块里。`check:stores` 三条断言守
「不再自建订阅表 / 判等后提前返回 / 遍历订阅者快照」，并钉住视频与音乐是**两个独立实例**（D166）。

**同一个事实只有一份缓存：宽高比**（D206）：`apps/desktop/src/app_ui/shared/ratioCache.ts` 是 `fileId → 宽 / 高` 的唯
一缓存与通知口（`getCachedRatio` / `touchCachedRatio` / `setCachedRatio` / `seedCachedRatios` / `clearCachedRatios` /
`ratioCacheVersion` / `subscribeRatioChange`）。媒体预览（`panels/mediaPreviewCell.tsx`）与图像查看器的胶片栏
（`panels/imageviewer/viewerFilmstripLayout.ts`）此前各存一份，同一张图在两个面板各解码一次；现在谁先量到另一边立刻受益。
三条纪律写进模块文档：写入只经 `setCachedRatio`（校验 + 同值不写 + LRU + 版本号 + 通知）、批量播种静默（`seedCachedRatios`
不通知）、通知不合并（消费方成本口径不同：媒体预览按帧合并，胶片栏逐条更新自己那一格）。胶片栏保留历史函数名，用
`export const 历史名 = 共享名;` 转出（`export { a as b }` 不产生本地绑定，文件内部几何函数还要用）。`check:stores` 第 ④ 条
钉住「`shared/ratioCache.ts` 是唯一缓存」与「两个面板不得再出现 `const ratioCache = new Map<...>` / `const ratioListeners =`」——
判据只看这两个旧符号，否则同文件里 `idToIndex` 那种普通 Map 会被误伤。

**视图文件不持有模块级 store**（D207）：`panels/markMenu.tsx` 曾同时是渲染树、菜单交互与一段带 IPC 的模块级
store（`storeSnapshot` + 自建 `Set` 订阅表 + `ensureMarksLoaded` / `commitMarks` / `usePanelMarks`）。状态在视图文件里
没有单测入口，订阅表也与 D205 的骨架并行维护。现在 store 与 hook 都在 `apps/desktop/src/app_ui/core/panelMarksStore.ts`
（`createStore<MarksRecord>` + 只暴露 `state` 的稳定快照），`markMenu.tsx` 只剩 `MarkMenuTree` 与接线；
`panels/bookpreview/bookCoverCache.ts` 的「版本号 + 通知表」同样改由 `createStore<number>` 承担。判据是**位置**而不是
风格：`check:stores` 第 ⑤ 条钉住「`panels/markMenu.tsx` 不得再出现 `new Set<() => void>` / `storeSnapshot` /
`export function usePanelMarks`」与「两个面板必须从 `core/panelMarksStore` 取 hook」。

## 插件/AI 扩展点

插件首期只能做：

- 注册只读面板或受限操作面板。
- 通过宿主 API 查询当前仓库数据。
- 请求用户确认后调用有限文件操作。
- 创建**控件**：只能给 schema 与数据，由宿主映射到受信组件渲染；**普通控件挂在面板之下**；**「浮动控件」这一类别已于 2026-09 取消**（D44/D56）——"浮在布局之上的一层显示"改由蓝图 **`overlay`（浮层）容器**承载，浮层与布局块同级、显示高度在其之上（整体浮层覆盖，非独立窗口）；控件标准见 `docs/spec/control-standard.md`。

插件首期禁止：

- 直接访问 SQLite。
- 直接遍历媒体源写入文件。
- 未声明权限的网络访问。
- 阻塞 UI 线程或核心扫描线程。
- 创建自由 React 组件、自定义 CSS/配色，或创建独立窗口。

AI 打标接口首期只抽象（仅图片，D17）：

- 输入：文件 ID、图像访问句柄、模型/提供方配置、任务选项。
- 输出：候选 tag、置信度、来源模型、生成时间。
- 回写：**只写入自动 tag 组**（`file_auto_tags`），必须标记来源为 AI、记录置信度与生成时间；**不得修改人工 tag**（`file_tags`，D21）；自动组内高置信更新必须保留撤销记录。

## 实现注意

- Tauri 命令命名采用混合风格：核心域 `domain.action`，插件命令 `plugin.{pluginId}.{action}`。
- **宿主级状态只有一个加锁入口**（D194）：`AppState` 上的六个互斥量（`global_db` / `repo` / `panel_schema_cache` / `supervision` / `ai` / `tag_lib`）只在 `apps/desktop/src-tauri/src/commands/shared/`（`locks.rs` / `repo.rs`，D201 前是单文件 `shared.rs`）里 `.lock()`。锁序固定为「`state` 级先取、仓库句柄锁后取，`state` 级之间不嵌套」；毒锁一律映射成 `HpError::Store("…锁中毒")`，只有 MCP 的配置读取走 `try_global`（读不到按缺省、记一条日志）。`pnpm check:db-boundary` 有反向断言守着这条（shared.rs 之外直接 `.lock()` 即红）。全局库还多一道门：**「先 ensure 再 lock」只有 `global_guard(state)` 一处**，`lock_global` 只留给 shared.rs 内部（D195）。命令层面再收一层：**全局库的读 / 写各只在一次持锁内跑完**（`with_global` / `with_global_mut`，闭包一出作用域 guard 就落），慢 IO（如导出落盘）必须在锁外——`pnpm check:db-boundary` 有一条断言钉住 `commands/layout.rs` 的 12 个命令不许直接碰 `global_guard` / `global` / `global_mut`（D198）。仓库句柄同理：**按 id 匹配与装卸/改动必须在同一次持锁内**（`take_open_repo_if` / `with_open_repo_mut`），先读 `current_repo_id` 再单独持锁会留下「判断完被换库」的窗口——`repo.delete` 会关掉并删掉另一个库、`repo.rename` 会把名字写进另一个库的 meta（D199）。命令层取库一律走 `with_repo` / `with_repo_mut`：签名上的 `repoId` 不再是装饰——非空且与当前句柄不一致即 `not_found`（前端拿旧快照时宁可让它重载，也不返回语义模糊的空结果），后台任务在起线程前用 `ensure_repo_binding` 校验（D200）。
- **共享工具的落点**（D201）：`commands/shared.rs` 1095 行拆成 `commands/shared/{events,response,paths,taglib,locks,repo,files}.rs`，`mod.rs` 只做 `pub(crate) use <mod>::*;` 再导出，调用点零改动；门禁里「只允许在 `commands/shared.rs` 出现」的断言改成对**整个目录**求并集（`check:db-boundary` 的 `isSharedSource`、`check:event-names` 的 `SHARED_DIR`）。
- **仓库库取用只有一个入口**（D200/D202）：命令层一律 `with_repo` / `with_repo_mut`（持锁 + 取句柄 + 校验 `repoId` 三合一），后台任务起线程前用 `ensure_repo_binding` 校验；`let _ = repo_id;` 在 `commands/` 下已归零。不接收 `repoId` 形参的命令传空串（空 id = 没带，沿用当前句柄），不要为了「有参数」而伪造 id。`pnpm check:db-boundary` 第 ⑮ 条对 `commands/` 下所有取库文件反向断言（排除 `commands/repo.rs`，它装卸句柄本身）。
- **长任务的线程骨架只有一份**（D196）：登记、`spawn_blocking`、`catch_unwind`、收尾（`tasks.finish`）全在 `apps/desktop/src-tauri/src/commands/task_shell.rs` 的 `spawn_repo_task` / `spawn_task_at` 里；任务本身只提供 body 与三态事件映射。`pnpm check:task-shell` 有反向断言守着（commands 下别处出现 `catch_unwind` / `.tasks.start(` / `.tasks.finish(` 即红）。
- WASM 运行时为 `wasmi`（D42）；插件只允许受控查询宿主函数，且输出必须是可序列化数据。
- 系统/受信动态库插件使用 C ABI + 版本化结构体；`community`/`local-dev` 不允许动态库。
- 插件分发通道、签名与 Python 核心见 `docs/rfc/0009-plugin-distribution.md`；控件标准见 `docs/spec/control-standard.md`（**「浮动控件」已于 2026-09 取消**，浮层由蓝图 `overlay` 容器承载，其显隐由蓝图规则决定）。
- AI 自动组内高置信更新必须生成撤销记录；**不得覆盖人工 tag**（D21）。
- 内置 MCP 服务（D119）是桥接层内的**传输适配**，不是新的一层：`apps/desktop/src-tauri/src/mcp/` 把 MCP 请求翻成既有 `#[tauri::command]` 调用，因此 MCP 与界面走**同一条**下行路径（`Tauri -> crates -> 数据/文件`），不新增 crate、不给 crates 增加对外接口，也不允许绕开命令层直连数据库或文件系统。传输层用标准库 `TcpListener` + 每连接一线程（**不引入 axum / hyper**），并通过 `Handler` trait 与 Tauri 解耦，使端到端用例能在真实 socket 上跑。
