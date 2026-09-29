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
- `hp-store`：全局库、仓库库与 tag 词库连接、迁移、事务；向上暴露仓储接口（词库见 RFC 0006，`TagDictDb`）。
- `hp-scanner`：扫描媒体源、监听变化、生成索引任务；媒体类型判定（扩展名优先 + 内容兜底）；不直接改 UI。
- `hp-hash`：内容哈希与感知哈希；只输出哈希值与算法元数据。
- `hp-album`：固定相册、跟随源同步规则、成员维护、相册查询。
- `hp-fsops`：媒体源间真实文件操作；所有硬盘变更必须可记录，撤销范围属于实现期开放点。
- `hp-plugin-host`：插件包发现、git/本地路径安装、锁定版本、按仓库启用与能力授权、信任等级校验、宿主 API。**运行形态执行体（`external-process` 常驻生命周期 / `dynamic-library` / `wasm`）尚未实现**——当前 `host.rs` 的 `load` 只做校验与 `LoadOutcome`；唯一有执行路径的是**一次一问一答**的控件 schema 查询（`crates/hp-plugin-host/src/channel.rs`）。**不要把三形态"生命周期"读成已具备**（同文第 99、100 行并列了这两条待办）。
- `hp-ai`：AI 打标提供方抽象、任务排队、结果回写；不内置具体厂商 SDK；第一期仅处理图片（D17）。
- `hp-media`：媒体子进程管理（libmpv，单实例常驻、崩溃重启）、播放控制、ffprobe 元数据探测、ffmpeg 抽帧宿主；外部进程调用带超时与错误降级。

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
- WASM 运行时为 `wasmi`（D42）；插件只允许受控查询宿主函数，且输出必须是可序列化数据。
- 系统/受信动态库插件使用 C ABI + 版本化结构体；`community`/`local-dev` 不允许动态库。
- 插件分发通道、签名与 Python 核心见 `docs/rfc/0009-plugin-distribution.md`；控件标准见 `docs/spec/control-standard.md`（**「浮动控件」已于 2026-09 取消**，浮层由蓝图 `overlay` 容器承载，其显隐由蓝图规则决定）。
- AI 自动组内高置信更新必须生成撤销记录；**不得覆盖人工 tag**（D21）。
