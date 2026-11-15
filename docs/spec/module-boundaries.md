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

**媒体显示 URL：解析与转换各只有一处**（D208）：`convertFileSrc` 曾散在 9 个文件、13 处，`imageUrl` / `thumbUrl` /
`previewUrl` 又各自手抄一份「结果表 + 在途表 + 失败清空」。现在 `apps/desktop/src/app_ui/shared/assetUrl.ts` 是
`convertFileSrc` 的**唯一**调用点（`assetUrl` / `assetUrlOrNull` / `assetUrlOrEmpty` 三种空值口径），
`shared/urlCache.ts` 的 `createUrlResolver(keyOf, load)` 是结果缓存 + in-flight 去重的**唯一**骨架（`load` 抛错不写缓存，
下次重试），`shared/mediaUrl.ts` 是媒体 URL 的**唯一**解析口（`resolveSourceUrl` 给原图/音视频；
`resolveMediaUrlOutcome` 给「图片且需要内嵌预览」时走 `preview.get`、其余走原图，返回 `{ url, error }` 而不是抛错）。
**正文分页状态机只有一份**（D209）：`panels/bookreader/useReaderBook.ts` 与 `panels/viewer/useViewerBookContent.ts` 曾各写一遍
同一份状态机（世代号、在途旗、空页不追加、失败翻译、`hasMore` 判定、`loadMore` 幂等、换书重置）。现在状态机只在
`apps/desktop/src/app_ui/shared/useBookPages.ts`：`useBookPages()` 返回 `pages / loading / error / hasMore / segmentStart /
jumpTarget / loadMore / jumpTo / generation`，`jumpTo` 起新世代让在飞的旧响应作废；两个游标字段不可合并（`segmentStart`
是段起点，`jumpTo` 才改它，`loadMore` 不改）。阅读器只保留目录取数（`book.toc`）与两游标的对外形状，查看器只挑五个字段。
门禁：`check:panels` 的「按需取下一页」「切书即丢页」「段起点不被 `loadMore` 改动」三条改读共享钩子，并反向断言两个消费方
不再出现 `generationRef` / `api.bookContent(` / `setPages(`。
**树面板的共享件各只有一份**（D210）：折叠箭头曾在 `AlbumPanel.tsx` / `SourcePanel.tsx` / `markMenu.tsx` 各写一遍
（三份 `tree-chevron-icon`），文件夹图标两份；相册树规则（树组装、有效媒体属性、包含/层级判定、拖放落点分派）
又与渲染、右键菜单、拖拽事件混在同一个 1096 行组件里。现在图标只在 `apps/desktop/src/app_ui/panels/shared/icons.tsx`
（`ChevronIcon` / `FolderIcon`），相册规则只在 `apps/desktop/src/app_ui/panels/album/tree.ts`（零 JSX），
`AlbumPanel.tsx` 1096 → 948 行。门禁 `check:tree-panels`（7 条）：图标不得在别处出现、树规则不得回流组件、
三个树面板必须从 `shared/icons` 取图标、两棵树不得再内联 `<svg>`。

**播放器公共件各只有一份**（D211）：时间格式曾在 `panels/music/time.ts` 与 `MediaPlayerPanel.tsx` 各写一遍（逐字相同），
`clampVolume` 在两个播放面板各一份（只差兜底常量），喇叭图标两套几何，音乐字形 160 行塞在 1016 行的 `MusicStage.tsx` 里。
现在 `apps/desktop/src/app_ui/panels/shared/time.ts` 是时间格式的唯一实现（`formatMs` / `formatClock` / `formatRemaining`），
`panels/shared/volume.ts` 的 `clampVolume(value, fallback)` 是音量夹紧的唯一实现（兜底默认值由调用方传：视频 100、音乐各自常量），
`panels/shared/icons.tsx` 的 `VolumeIcon({ volume, size, muteMark })` 是喇叭的唯一实现，音乐字形只在 `panels/music/icons.tsx`。
门禁 `check:player-shared`（4 条）：三类公共件不得在别处定义、两个播放面板必须从 `shared/` 取、`MusicStage` 不得再内联 `<svg>`。
原 `shared/imageUrl.ts` 已删除；`bookMetaCache` 也从手抄缓存迁到骨架。判据同样是位置：`check:media-url` 钉住
「`convertFileSrc(` 只出现在 `assetUrl.ts`」「`imageUrl.ts` 不得复活」「`new Map<string, Promise<` 只出现在 `urlCache.ts`」
「四个播放/查看器面板不得自己 `api.filePath(`」，`check:panels` 的查看器断言同步改指 `resolveMediaUrlOutcome`。

**面板订阅口与设置热加载各只有一份**（D212）：dockview 的 `onDidActiveChange` / `onDidVisibilityChange` 曾在
`shared/panelForeground.ts`、`shared/settingValue.ts`、`panels/imageviewer/useViewerSettings.ts`、`panels/ColorPanel.tsx`、
两个播放面板、`panels/imageviewer/ImageViewerPanel.tsx` 各订阅一遍（6 处手抄：各自接线、各自 dispose、各自决定「激活且可见」还是
「可见即可」），而「四条触发源」（同窗口广播 / 后端 `setting.changed` / 窗口 `focus` / 面板重新激活）在 `settingValue.ts` 与
`useViewerSettings.ts` 是**逐字相同**的 18 行。现在 `apps/desktop/src/app_ui/shared/panelActivity.ts` 的
`usePanelActivity(panelApi, onChange)` 是唯一订阅口（回调给 `{ isVisible, isActive }` 两个维度，判据仍由调用方定：媒体预览冻结只看
`isVisible`，设置热加载要 `isVisible && isActive`），`shared/settingValue.ts` 的 `useSettingReload(reload, panelApi)` 是四条触发源的
唯一实现（查看器只传自己的取数函数）。门禁：`check:settings` 新增两条——递归扫描 `app_ui` 后 `onDidActiveChange(` /
`onDidVisibilityChange(` 只许出现在 `panelActivity.ts`；`useSettingReload` 必须同时含四条触发源，查看器不得再出现 `listenHp("setting.changed"`
或 `addEventListener("focus"`（56/56，变异：往 `ColorPanel.tsx` 插一句 `p.onDidActiveChange(() => {})` → 55/56 并指名该文件）。

**仓库级 UI 文本项的存放口径只有一处**（D213）：`commands/interface_pages.rs`（D124）与 `commands/panel_marks.rs`（D134）原本各写一遍
「校验 repoId → `global_guard` → `global` → `get_setting` / `set_setting` 拼 `{prefix}.{repoId}`」，也各自决定「空白读回算不算未设置」「写入要不要 trim」——
这类口径一旦分叉，同一份 JSON 在两个面板上会出现「存了但读回是空」。现在两处都只声明前缀，取库、拼键、空值判定全部经
`apps/desktop/src-tauri/src/commands/shared/repo_blob.rs` 的 `get_repo_blob` / `set_repo_blob`（内部 `with_global`，D198 口径）。
门禁：`check:db-boundary` 第十七条——两个命令文件必须同时出现两个入口，且不得再出现 `global_guard(` / `global(` / `global_mut(` / `fn ensure_repo_id`
（17/17，变异：往 `panel_marks.rs` 追加一句 `global_guard(state)?` → 16/17 并指名该条）。

**时间戳文本只有一份实现**（D214）：`created_at` / `updated_at` / `installed_at` / `fetched_at` 是同一批 `TEXT` 列上的字符串，
由四张库的写入路径、插件安装的 `LOCK`、AI 输出与桥接层各自生成。此前有 8 处各写一遍 `OffsetDateTime::now_utc().format(&Rfc3339)`
（`hp-ai` / `hp-album` / `hp-db` / `hp-plugin-host` / `hp-scanner` / 桥接 `commands/ai.rs` 与 `commands/plugin.rs` / 扫描基准示例），
一旦有人换成 `YYYY-MM-DD HH:MM:SS`，跨表比较与按时间排序就出错，而且只在两个写入者写过同一行时才暴露。落点选
`crates/hp-core/src/time.rs` 而不是 `hp-db`：`hp-db` 带 `rusqlite`，而 `hp-ai` / `hp-album` / `hp-scanner` / `hp-plugin-host` 与桥接层都不依赖 SQLite，
却都要生成时间戳。`hp_db::now_iso` 保留为转调（既有调用方不动）。门禁：`check:db-boundary` 第十八条——全仓（除 `time.rs`）不得出现 `Rfc3339`、
不得再定义 `fn now_iso`、不得直接 `OffsetDateTime::now`，且 `hp-db/src/util.rs` 必须转调（18/18，变异：往 `hp-album/src/sync.rs` 追加一份 `fn now_iso` → 17/18 并指名该文件）。

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
- **文件级拆分也要有门禁钉住**（D215）：`crates/hp-media/src/thumbnail/` 把 1142 行单文件拆成 `mod.rs`（模块文档 + 再导出）/ `atomic.rs`（`temp_sibling` 与 `commit` 的唯一实现）/ `video.rs`（首帧与 `blackframe` 过滤链）/ `image_pipeline.rs`（档梯、预览、WebP 编码）/ `tests.rs`；外部 `crate::thumbnail::…` 路径一字未改，`check:media-structure` 5 条断言钉住「原单文件不得复活 + 五份齐全 + rename / temp_sibling / blackframe 各只有一处」。同一口径也用在 `crates/hp-book/src/epub_text/`（D216：1190 行 → `mod.rs` 143 / `blocks.rs` 294 / `spine.rs` 52 / `tests.rs` 725，`check:book-structure` 5 条钉住「原单文件不得复活、公开入口落点、用例只在 tests.rs、每份 ≤ 800 行」）。桥接层同理（**D217**）：`apps/desktop/src-tauri/src/commands/file.rs` 1032 行拆成 `file/mod.rs` 337 / `file/preview.rs` 391 / `file/task.rs` 323，`check:file-structure` 6 条钉住「原单文件不得复活、取图助手只在 preview.rs、两条长任务只在 task.rs」；**`#[tauri::command]` 生成的 `__cmd__*` / `__tauri_command_name_*` 只在定义它的模块里**，靠 `pub(crate) use` 再导出函数对 `generate_handler!` 无效，`main.rs` 必须写子模块路径（否则 `E0433: cannot find __cmd__thumb_get in preview`）。
- **校验规则按族分文件**（D218）：`crates/hp-core/src/blueprint_validate.rs`（1008 行）曾把五族硬错误判定挤在一份里——节点字段与引用、类目与面板声明、同触发多状态冲突、边与求值链、分层规则——「加一条规则该写在哪」没有答案，且距 `check:line-count` 的 1200 行上限只剩不到两百行。拆成目录后每族一份：`mod.rs`（`NodeIssue` + `validate_graph` / `validate_graph_with` 路由）/ `fields.rs`（`validate_node_with` / `validate_node_fields`）/ `classes.rs`（`find_panel_class_violations` / `class_owner_panel_id`）/ `state.rs`（`ActionState` / `find_state_conflicts` / `mutually_exclusive` / `is_visible_op`）/ `edges.rs`（`validate_edge_with` / `validate_expr` / `find_cycle` / `dfs_cycle`）/ `layers.rs`（`validate_layers`）。跨文件只走 `pub(super)`（`find_state_conflicts` / `find_panel_class_violations` / `class_owner_panel_id`），`pub(crate)` 的四个入口路径一字未改。`check:core-structure` 6 条钉住「原单文件不得复活、六份齐全、每族定义只在它自己的文件里、`mod.rs` 仍把五族串成一次图级校验、每份 ≤ 800 行」。
- **规则测试按规则族分片**（D219）：`crates/hp-core/src/blueprint_tests_rules.rs` 单份 **1182 行**，距 `check:line-count` 的 1200 行硬上限只差 18 行——再给一条新校验规则补两三个用例就会撞门禁，而它是 `include!` 进 `mod tests` 的片段（自己不写 `use`，靠宿主模块的导入）。拆成 `blueprint_tests_rules/` 四个分片：`overlay_and_marks.rs`（8 例：浮层包含、类目开关、标记归位与三类历史软告警）/ `edges_and_graph.rs`（8 例：schema 闸门、悬空边与端点类型、成环、互斥组多默认可见、引用类型、表达式、触发域不匹配）/ `panels_and_classes.rs`（4 例：`has_class` 分级、类目媒体域、浮层子项、未知类型分流）/ `layers_and_builtins.rs`（6 例：层兜底、孤儿动作、`name` 往返、未接通、内置父子表对称、内置规则输出类型）。`blueprint_tests.rs` 里四条 `include!` 展开进同一个 `mod tests`——**拆的是文件，不是模块**，私有项照旧可测。`check:core-structure` 由 6 条增至 **9 条**：原单文件不得复活 + 四片齐全、四条 `include!` 一条不缺、用例数不少于 26 且每片 ≤ 800 行。
- **面板激活即取键盘焦点只有一份实现**（D220）：用户报的两条"功能坏了"其实是同一个毛病的两面。① 媒体播放器根节点在 `pointerdown` 里同步调 `panel.api.setActive()`——面板 DOM 因此重新挂载/重排，浏览器随即取消 `mousedown` 兼容事件，**原生 `<input type="range">` 的拖拽永不启动**（进度条、音量条都拖不动）；② 点标签切面板后焦点留在标签元素上，面板根的 `onKeyDown` 收不到键（方向键被 dockview 拿去移动标签）。修法：激活即取焦点只留 `apps/desktop/src/app_ui/shared/panelFocus.ts` 的 `usePanelFocusOnActivate(panelApi, rootRef)`（图像查看器、媒体播放器、音乐播放器共用），判据表在纯逻辑模块 `shared/focusTarget.ts`（键位模块按历史名字转出，门禁仍可直接 import）；根节点点击**只聚焦**、禁止调 `setActive()`。两个细节缺一条就"看起来实现了、实际按不动"：鼠标点标签那一刻焦点还在**上一个**标签（`[role="tablist"]` 内），只靠判据表会永远拦下——所以按 `pointerdown` 时间戳区分"指针点进来"与"键盘在标签条里按 Enter"；取焦点必须延后一帧并在帧内重读激活态。门禁 `check:player-shared` 4 → **7** 条（三个面板都调同一钩子、全仓不得再用 `panelApi.setActive()`、进度条左端按 `formatClock` 显示 `0:00` 而不是 `formatMs` 的 `--:--`），`tools/panels/imageviewer.mjs` 的三道收敛断言改指共享钩子 + 判据模块。
- **插件注册视图的键名分两层，且两侧都有钉子**（D221）：真机（2026-11-15）打开仓库就抛 `TypeError: Cannot read properties of undefined (reading 'map')`——`refreshPluginRegistrations` 读 `contributions.node_types`，而线上是 `nodeTypes`，错误发生在 `registerPluginPanels` 之前，**整批插件注册（面板 / 蓝图节点 / 设置分节）一次都没生效**；夹具是手写驼峰字面量，所以只有真机能看见（与缺陷 0042 的 `nextCursor` 同族）。两层命名各有出处：**桥接层视图**按桥接层约定走驼峰（`panels` / `nodeTypes` / `settingsSections`，每项 `pluginId` / `titleKey` / `hasClass` / `blueprintNode` / `readOnly`），**内嵌的插件声明**（`settings[]`、`mount`、节点声明的 `label_key` / `name_from_layer` / `provides_name` / `evaluation_role`）保持 manifest 的蛇形（`docs/spec/plugin-standard.md` 第 4 节）。修法分四层：① `commands/plugin_contributions.rs` 的四个结构体一律 `#[derive(Serialize)] #[serde(rename_all = "camelCase")]`（`NodeContributionItem` 原缺）；② `shared/types/plugin.ts` 按线上键名重写，并把"两层"的理由写进文件头（防止下一个人"统一"掉）；③ 形状翻译抽成**纯映射** `apps/desktop/src/app_ui/core/pluginContributionsMap.ts`（`toPanelSpec` / `toNodeSpec` / `toSettingsSection`，不碰注册表也不调 IPC），副作用留在 `core/pluginRegistryHost.ts`；④ 门禁 `tools/check-plugin-wire.mjs` 5 条：四个结构体带 `rename_all`、后端有用例把序列化键名钉死、前端类型用驼峰且不再出现桥接层蛇形键、**用真实线上样本（驼峰外壳 + 蛇形内嵌）驱动纯映射**、消费方按驼峰读且不再自带一份解析。第一个是"读源代码"，第四个是"读行为"——后者才拦得住"类型改对了、映射仍在读旧名字"。
- **阅读位置靠几何判定，不靠单点取点**（D222）：用户报「翻页不改变页脚进度」，真机实测页脚恒显 `当前进度 0.00% 本章进度 0.0% 章节数 1 / 13`（`.br-flow` 的 `transform` 明明在按 793px 步进）。根因在 `apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx` 的 `reportPosition`：它用 `document.elementFromPoint(x, y)` + `closest("[data-page-index]")` 取「正在读哪一项」，而这个点在分页模式下先后落到过页边距、被平移的 `.br-flow` 之外、纸张的 24px 内边距，最后即便挪进内容盒也会落进正文栏顶部 30–40px 的首行留白（标题上边距 / 图片块留白）——真机上同一个点一次命中 `br-flow`、一次命中 `br-paper`，`visibleIndex` 于是恒为 -1。改法是把「问点」换成「问几何」：视口内容左缘 `paper.left + margin` 落在哪一项的并集盒里，那一项就是正在读的项；跨栏项的并集盒横跨它全部栏（真机页 8 实测 `left 265 / right 29162`），因此「视口左缘在项内」恰好等价于「这一项读了一部分还没读完」，与页内比例 `(vpLeft - left) / width` 的分母同源。纯函数 `apps/desktop/src/app_ui/panels/bookreader/readerView.ts` 的 `readerVisiblePageIndex({ vpLeft, vpTop, vpBottom, pages })`（`:832`）负责取舍（跳过整项在左/在右、纵向不相交；同一左缘取序号小者；无命中 -1），`ReaderStage` 只负责把每项 `getBoundingClientRect()` 喂进去（`:355`）；滚动模式没有平移，仍用取点（`readerProbePoint`，`:778`，文档已注明只服务滚动）。门禁 `tools/panels/book-reader.mjs` 的 ③ 从「探测点两轴的算术」改成「几何取值的五个用例 + 分页分支不得再取点」，并把老的位置探测 check 改成钉 `paperRect` / `viewportLeft` 与 `readerVisiblePageIndex({)`。教训：`elementFromPoint` 只回答「这个像素上是谁」，而排版里的空白（页边距、行距、标题上边距）不承载语义——位置类判据要量盒子，不要量点。
- **缺失文件退出回填队列**（D223）：真机状态栏每次打开仓库都挂着「图片尺寸已补齐：0 张（失败 2）」，查库发现那两行指向的文件早已从磁盘删掉（`age fx/125520392_p3.jpg`、`age fx/125781221_p1.jpg`），而 `files.missing_status` 全库都是 0——`set_file_missing` 从来没有调用方，于是「读头失败」被当成「暂时读不到」，每次启动重试同一批永远读不到的行。判据要分层：**父目录在、文件不在 = 删掉了**（记 `missing_status = 1` 并跳过本轮），**父目录也不在 = 源离线**（保持 `NULL`、仍按失败重试，插上移动硬盘就能补）。只改一侧不够：`crates/hp-repo/src/file_repo.rs` 的 `count_pending_dimensions` 与 `next_pending_dimensions` 都必须加 `missing_status = 0`，否则标记写完下次照样被查出来重试。标记会自愈——`file_repo.rs:190` 的扫描 upsert 里 `missing_status = excluded.missing_status`，文件重新出现时写回 0。`check:file-structure` 由 6 条增至 **7 条**（`if !abs.exists() {`、父目录判据、`db.set_file_missin- **缺失文件退出回填队列**（D223）：真机状态栏每次打开仓库都挂着「图片尺寸已补齐：0 张（失败 2）」，查库发现那两行指向的文件早已从磁盘删掉（`age fx/125520392_p3.jpg`、`age fx/125781221_p1.jpg`），而 `files.missing_status` 全库都是 0——`set_file_missing` 从来没有调用方，于是「读头失败」被当成「暂时读不到」，每次启动重试同一批永远读不到的行。判据要分层：**父目录在、文件不在 = 删掉了**（记 `missing_status = 1` 并跳过本轮），**父目录也不在 = 源离线**（保持 `NULL`、仍按失败重试，插上移动硬盘就能补）。只改一侧不够：`crates/hp-repo/src/file_repo.rs` 的 `count_pending_dimensions` 与 `next_pending_dimensions` 都必须加 `missing_status = 0`，否则标记写完下次照样被查出来重试。标记会自愈——`file_repo.rs:190` 的扫描 upsert 里 `missing_status = excluded.missing_status`，文件重新出现时写回 0。`check:file-structure` 由 6 条增至 **7 条**（`if !abs.exists() {`、父目录判据、`db.set_file_missing(&row.file_id, 1)?;` 三处接线 + 两个查询都得过滤 `missing_status = 0`）。
- **窄面板下两栏按面板宽度切分，放不下就上下分栏**（D224）：真机把阅读器面板拖到 205px 宽后，左栏按 `min(260px, 70%)` 占 132px、右栏仍是固定 `240px` 并贴右，两栏**重叠 183px**（`z-index` 同为 20，右栏压在左栏上），四个标签页被压成 27px、`elementFromPoint` 命中的是右栏标题，目录直接点不动。问题不在某一栏太宽，而在两栏没有**共同的宽度预算**：左栏的 70% 兜底只解决了「别盖住正文」，右栏根本不随面板收窄。修法三层：① `.br-body` 加 `container-type: inline-size`（`apps/desktop/src/app_ui/shared/styles.css:2974`），让两栏的百分比与容器查询量的是同一个盒子；② 两栏宽度都写成 `min(固定值, 百分比)` 且**百分比之和 ≤ 100**（左 `58%` `:2999`、右 `42%` `:3005`）——任何宽度下都不可能横向交叠；③ `@container (max-width: 300px)`（`:3012`）把两栏改成**上下分栏**（各 `width: 100%`，一侧 `top` 一侧 `bottom`）——并排到每栏只剩百来像素时书名与选项行全是省略号，而「目录」与「选项」本来就是两条互不依赖的阅读路径。门禁 `tools/panels/book-reader.mjs` 的 ①b（`:150`）把这三层一起钉死，并做行为判定（百分比之和 ≤ 100、`br-body` 是 `inline-size` 容器、窄屏块里两栏都 `width: 100%` 且一侧 `top` 一侧 `bottom`）；变异实测：右栏改回固定 `240px` ⇒ ①b 立刻 FAIL。
- **tag 的删除入口补在桥接层，删除语义不搬家**（D225）：领域层 `crates/hp-repo/src/tag_repo.rs:77` 的 `delete_tag` 早就是完整删除——事务内先清 `file_tags` / `file_auto_tags` / `tag_relations`，最后 `DELETE FROM tags WHERE id = ?1`，只有真的删到行才提交，删不到报 `tag 不存在`——并且有两个用例在跑；但 `apps/desktop/src-tauri/src` 里**一个调用方都没有**：界面上 tag 只能新建/重命名/移动/摘挂，**唯独不能删**，建错的 tag 只能改名后永久留在 `tags` 表里。修法刻意只补一层：`apps/desktop/src-tauri/src/commands/tag.rs:363` 的 `tag_delete` 是一行转调（`db.delete_tag(&tag_id)`），级联顺序**不在桥接层重写**——顺序是领域层的事，两处各写一遍必然有一处走偏；`apps/desktop/src-tauri/src/main.rs:223` 注册；前端 `apps/desktop/src/app_ui/shared/api/tag.ts:77` 的 `tagDelete` 加在 `tagRename` 之后；`apps/desktop/src/app_ui/panels/TagTablePanel.tsx:213` 的 `deleteNode` 先 `window.confirm` 再调命令，菜单项在「重命名」之后（`:485`）。因为是不可撤销操作，确认框放在请求**之前**（门禁钉住了这个顺序）。门禁在 `tools/panels/tagtable.mjs`：菜单文案与 `api.tagDelete` 接线、四个落点（菜单 → `tagDelete` → `tag_delete` → `delete_tag` → `main.rs` 注册）齐备、四条文案三语齐备；变异实测：把 `main.rs` 的注册删掉 ⇒ 立刻 FAIL。
- **蓝图面板窄到装不下画布与检查器时改成上下排**（D226）：真机把蓝图面板停进 213px 宽的停靠组后，`.bp-main` 仍是 `row` 而检查器固定 `width: 232px; flex-shrink: 0`，画布被挤成 **1px 宽**、检查器还溢出面板——画布是这个面板的主工作面，等于面板不可用。修法是把 `apps/desktop/src/app_ui/shared/styles.css` 的 `.bp-panel`（`:4194`）声明成 `container-type: inline-size`，再在 `@container (max-width: 560px)`（`:4324`）里改成上下排：`.bp-main` 纵向且不再吃剩余高度（`:4325`）、`.bp-canvas` 先拿 `min-height: 360px`（`:4331`）、检查器整宽排在下面（`:4340`，选择器写成 `.bp-main > .bp-inspector` 见下）。阈值 560px 是算出来的：`560 − 面板内边距 16 − 间隙 6 − 检查器 232 ≈ 306px`，再窄画布又跌破 300px。
  **两个坑**：① 检查器是 flex item（`min-width: auto`），只写 `width: auto` 会被内容的 min-content 撑回 232px，必须 `width: 100% + min-width: 0`；② 基础规则 `.bp-inspector { width: 232px }` 在文件里排在容器查询**之后**，同特异度下后来居上会把改写整条盖掉（真机实测踩过一次），所以窄面板那条用两段类的后代选择器提特异度。门禁 `tools/panels/blueprint-layout.mjs` 三条断言（查询容器在面板自己身上 / 窄面板真的纵向且画布 ≥300px 高、检查器整宽且特异度够 / 阈值与固定宽的算术），`check:panels` 493 → **496**；变异实测：删掉 `container-type` ⇒ ① 立即 FAIL。
- **滚动模式的阅读位置也改成问几何，阅读区里再也不取点**（D227）：D222 只把分页模式从「单点取点」换成量几何，滚动模式仍留着 `elementFromPoint`（探测点 = 内容框 `.br-flow` 左边 + 40、上缘 +2，约 `(297, 97)`）——真机上**左栏 `.br-rail-left` 的矩形是 `[233, 95, 260, 644]`，探测点整个被左栏盖住**，命中 `br-book-head`，`closest("[data-page-index]")` 得 `null`，`visibleIndex = -1`，页脚在扫 0 / 2000 / 5000 / 8000 / 12000 / 18000 七档 scrollTop 时恒显 `当前进度 0.00% 本章进度 0.0% 章节数 1 / 13`；收起两栏后虽然会动，但同一个点仍会落到 `vr-content`（无页号）、首行留白或 `br-page` 之间的空隙——与分页模式栽的三次同族。修法是把 `readerProbePoint` 整个删掉（分页 D222、滚动 D227 之后，阅读器里不再有任何 `document.elementFromPoint`），新增 `apps/desktop/src/app_ui/panels/bookreader/readerView.ts:787` 的 `readerScrollVisiblePageIndex({ vpTop, pages })`：取「上缘不超过视口顶线（`.br-stage` 的 `top`）的项里 `top` 最大者」，项之间有间隔时它就是跨过顶线的那一项（语义与区间包含一致，且不会因间隔返回 `-1`）；视口顶线在所有项之上（顶部留白 / 还没进正文）取最靠上的项；同一 `top` 平局取序号小者；一项都没有返回 `-1` 交给调用方的既有回落。`ReaderStage.tsx` 的 `reportPosition`（`:334` 起）现在**只量一次几何、喂两个轴**：`const elements = Array.from(flow.querySelectorAll<HTMLElement>("[data-page-index]"));`（`:348`）→ `const pages = elements.map(...)`（`:349`）→ 分页走 `readerVisiblePageIndex`（`:360`）、滚动走 `readerScrollVisiblePageIndex({ vpTop: hostRect.top, pages })`（`:366`），页内比例仍是 `(hostRect.top - pageRect.top) / pageRect.height`（`:408` 起），两个分支用同一句 `elements.find(...)` 找回元素。门禁 `tools/panels/book-reader.mjs` ③（`:281`）补四个滚动用例（跨顶线 / 顶线在所有项之上 / 同 `top` 平局 / 空数组）与两条反向断言（正文里不得再有 `document.elementFromPoint(` 与 `readerProbePoint(`），`check:panels` 仍是 496 条。真机复测（页脚随 scrollTop 前进）：栏收着 0 / 5000 / 60000 / 160000 ⇒ `0.00% / 47.64% / 66.00% / 78.75%`（章节 1 / 5 / 8 / 11），栏摊开（左 260 + 右 240）读数完全一致——左栏遮挡不再是变量。
- **面板激活即取键盘焦点是每个带键盘操作面板的必修项**（D228）：D220 只给图像查看器、媒体播放器、音乐播放器三个面板接了 `usePanelFocusOnActivate`，其余带面板级键盘操作的面板漏在外面——真机点标签切进**媒体预览**后 `document.activeElement` 仍是 `DIV.dv-tab dv-active-tab`，`Ctrl+A` 全选无反应（选中 0 个），`panels/MediaPreviewPanel.tsx` 的快捷键处理器只在条目容器自身有焦点时才收得到；**图书阅读器**同理，不先手工 focus 就发 `ArrowRight` 页脚恒 `0.00% / 0.0% / 1 / 13`、`.br-flow` 的 `transform` 恒 `translateX(0px)`；**蓝图**画布虽然在自己的 `onPointerDown` 里 `canvasRef.current?.focus()`，但「点标签切进来」这条路根本没有指针落在画布上。修法是把钩子接到键盘操作真正发生的那一层，而不是统一挂面板根：媒体预览把快捷键从三个条件渲染的条目容器（随视图切换卸载）**上移到面板根** `apps/desktop/src/app_ui/panels/MediaPreviewPanel.tsx:622-627`（`ref={rootRef} tabIndex={0} onKeyDown={handlePanelKeyDown}`，原 `handleContainerKeyDown` 改名，容器上的 `tabIndex`/`onKeyDown` 全部去掉——挂两处会双触发）；阅读器把 `api?: PanelRenderCtx["api"]` 透传给 `ReaderStage`，在 `hostRef`（即 `.br-stage`，方向键处理器所在处）上取焦；蓝图把 `ctx.api` 从 `core/panelRegistry.tsx:99` 一路传到 `BlueprintCanvas`，在 `canvasRef` 上取焦（面板根 `.bp-panel` 与阅读器根 `.br-root` **都不加** `tabIndex`——焦点目标必须与键处理器同一节点，否则出现「焦点在根、Delete 不生效」的二义）。门禁 `tools/check-player-shared.mjs` 的 `panelsWithFocus` 由 3 个变 **6** 个、钩子断言由定值字符串改成正则 `/usePanelFocusOnActivate\((?:panelApi|api), \w+Ref\)/`（阅读器/画布的形参名不同）；`tools/panels/media-preview.mjs`、`book-reader.mjs`、`blueprint-layout.mjs` 各补两条（接线 + 焦点落在真正带键盘处理的节点上、`tabIndex={0}` 全文件只出现一次），`check:panels` 496 → **502**。真机复测：三个面板点标签后 `document.activeElement` 分别是 `DIV.panel.mp-panel` / `DIV.br-stage …` / `DIV.bp-canvas`，Ctrl+A 选 27 个 `.mp-cell.selected`、Escape 归 0，ArrowRight 使页脚 `0.00%`→`2.46%` 且 `translateX(-793px)`。教训：**`tabIndex={0}` 是必要条件不是充分条件**——同一份「点标签切进来」的路径上，键盘处理器挂在哪个节点，钩子就必须把焦点取到哪个节点。
- **自定义标记必须有删除入口，否则建错的名字永远留在菜单里**（D229）：源 / 相册面板的「添加标记」子菜单里，自定义标记只有「＋ 新建自定义标记」一个写入口（`apps/desktop/src/app_ui/shared/panelMarks.ts:383` 的 `addCustomMark`），序列化只读——没有任何一处能把名字从 `custom` 清单里摘掉，也没有任何一处能回收它打到各对象上的 `custom:<名称>` token，于是打错一个字的名字就永久占着菜单，与 D225 之前 tag 建错只能改名同族。修法是在纯逻辑层补 `apps/desktop/src/app_ui/shared/panelMarks.ts` 的 `removeCustomMark(state, scope, rawName)`（插在 `addCustomMark` 之后）：名字归一化后不在 `state.custom[scope]` 里时**返回原状态原引用**（幂等，也让上层 `persistMarks` 不必判空），否则从清单里过滤掉该名，并用 `removeTokenFromTable` 对 `marks` / `auto` / `dismissed` 三张表**级联摘掉**`customMarkToken(name)`（空数组条目直接丢弃，与 `writeTokenList` 同口径）。菜单侧 `apps/desktop/src/app_ui/panels/markMenu.tsx` 的 `renderRow` 加第 5 个可选参数 `onRemove?`，只有自定义标记行传它（系统标记树的 `renderRow(node.id, markLabel(node.id, t), depth, childIds)` 不传——系统标记属于蓝图标记清单，不该在菜单里删），行尾渲一个 `.menu-item.small` 的 ✕（`e.stopPropagation()` 必有，否则点 ✕ 会顺带勾选该行）；`removeCustom` 先 `window.confirm(t("mark.menu.customRemoveConfirm", { name }))` 再 `onPersist(removeCustomMark(marks, scope, name))`，删除后菜单保持打开（与勾选同一套交互，不 `onClose()`）。门禁 `tools/panels/tagtable.mjs` 补三条：真跑 `removeCustomMark` 断言「名字与三张表 token 一起摘掉 / 同目标上别的标记不受牵连 / 另一个 scope 不动 / 重复删返回同一引用 / 空名返回原引用」、接线断言（`window.confirm` 必须在 `onPersist(removeCustomMark(` 之前、系统标记行不得传 `onRemove`）、三语键齐备。真机复测：右键 bbb 相册 → 添加标记 ▸ → 点 ✕ ⇒ 确认框「删除自定义标记「临时取消D229」？它在所有对象上的打标会一起移除，无法撤销。」，确认后状态栏「已删除自定义标记「临时取消D229」」，`panelMarks.<repoId>` 里 `custom.albums` 从 `["aaa","临时取消D229"]` 回到 `["aaa"]`、bbb 的 token 从 `["media","custom:临时取消D229"]` 回到 `["media"]`；把 `window.confirm` 打桩成返回 `false` 时只弹确认框、清单与 token 均不变。
- WASM 运行时为 `wasmi`（D42）；插件只允许受控查询宿主函数，且输出必须是可序列化数据。
- 系统/受信动态库插件使用 C ABI + 版本化结构体；`community`/`local-dev` 不允许动态库。
- 插件分发通道、签名与 Python 核心见 `docs/rfc/0009-plugin-distribution.md`；控件标准见 `docs/spec/control-standard.md`（**「浮动控件」已于 2026-09 取消**，浮层由蓝图 `overlay` 容器承载，其显隐由蓝图规则决定）。
- AI 自动组内高置信更新必须生成撤销记录；**不得覆盖人工 tag**（D21）。
- 内置 MCP 服务（D119）是桥接层内的**传输适配**，不是新的一层：`apps/desktop/src-tauri/src/mcp/` 把 MCP 请求翻成既有 `#[tauri::command]` 调用，因此 MCP 与界面走**同一条**下行路径（`Tauri -> crates -> 数据/文件`），不新增 crate、不给 crates 增加对外接口，也不允许绕开命令层直连数据库或文件系统。传输层用标准库 `TcpListener` + 每连接一线程（**不引入 axum / hyper**），并通过 `Handler` trait 与 Tauri 解耦，使端到端用例能在真实 socket 上跑。
