# 命令与事件契约

状态：正式草案。本文定义命令与事件的载荷契约，供 Tauri 桥接层与前端共享类型实现参考；载荷字段可按实现细化，但不得修改已确认决策（D6 AI 覆盖规则、D7 命令命名）。

## 1. 命名规则

- 核心域命令使用 `domain.action` 风格（决策 D7），例如 `repo.open`、`source.scan`、`album.sync`。
- 插件命令使用 `plugin.{pluginId}.{action}` 命名空间。
- 所有插件命令必须携带仓库上下文，并经过启用状态与能力授权校验（RFC 0004）。
- Tauri 桥接层只做参数校验、权限检查、调用 crate、转发事件；不承载业务规则。

## 2. 通用载荷约定

- 请求/响应均为 JSON；响应统一包装为 `{ ok, data?, error? }`。
- 所有长任务返回任务 ID，并通过 `task.*` 与进度事件推进。
- 真实文件操作（`fsops.*`）必须返回操作记录 ID。

```ts
// 统一错误模型
interface HpError {
  code: string;      // validation | not_found | permission | plugin | io | conflict
  message: string;
  details?: Record<string, unknown>;
}
```

### 2.1 迁移状态与推进方式（D76，2026-09）

**现状（2026-09 更新）**：**基础设施与第一批命令已落地**——
`apps/desktop/src-tauri/src/commands/shared.rs` 提供 `ApiResponse<T>` / `ApiError` / `api_from_hp`，
`crates/hp-core/src/error.rs` 的 `HpError::code()` 给出 D76 的**闭集错误码**，
前端 `apps/desktop/src/app_ui/shared/api/response.ts` 提供统一解包层 `unwrapApi` 与
`code → i18n` 文案映射（三套语言都有 `error.code.*` 键）。
**已按新口径落地**：`setting.get/set/list/reset`（见 3.13）与 `plugin.panelSchema` / `plugin.validateControl`（见 3.11）。
**其余命令仍裸返回**（错误一律 `String`，`hp_err_to_string`），逐条差异见 `docs/architecture/command-event-drift.md` 与第 3 节各表的「迁移状态」列。

**两处**有意的**排序调整**（不改 D76 的批次口径，只说明实际执行顺序）：

- `setting.*` 提前落地：契约 3.13 的规则③（插件项不满能力返回 `permission`）**只有在结构化错误下**才对前端可判定，因此这一组必须先于 `repo/layout` 批完成包装；
- `plugin.panelSchema` / `plugin.validateControl` 是**新增命令**，按上表"新增命令一律直接按新口径实现"处理，因此 `plugin.*` 呈现「两条已包装、其余裸返回」的**显式半迁移态**——每行都标注了状态，不属于模糊态。

**决策**：**保留本节契约**（不改文档去迁就代码），并按下述方式推进：

| 规则 | 内容 |
| --- | --- |
| 新增命令 | `setting.*` / `panel.*` 及 RFC 0010 相关命令**一律直接按新口径实现**（包装 + `HpError`），不留技术债 |
| 旧命令迁移批次 | **file → album → source → tag → media → plugin → blueprint → ai → fsops → repo/layout**；每批同时改后端桥接层与前端 `api/*` 封装与类型 |
| **文档标注义务** | 迁移完成前，第 3 节每条命令**必须**标注其当前是「已包装」「裸返回」还是「未实现（契约先行）」，**不得**让文档停在"说了包装、实际裸返回"的模糊态 |
| 错误文案 | `HpError.message` **仅作诊断**；前端**不得**直接显示它，必须按 `code` 走 i18n 键渲染（D27：三套语言，主流错误串直显会导致错误提示无法切换语言） |

### 2.2 事件载荷字段名统一驼峰（D77，2026-09）—— ✅ 已落地

- 全部事件 DTO 统一 `#[serde(rename_all = "camelCase")]`；前端事件类型随之改驼峰（`apps/desktop/src/app_ui/shared/types/events.ts`）。
- 理由：命令侧的 Tauri v2 IPC 参数本就是 camelCase ↔ snake_case 自动映射，事件统一驼峰后**全局只留一套心智**；本节第 4 节事件表一直是驼峰，无需改动。
- **落地情况（2026-09）**：本批给 10 个事件 DTO 补上该属性——
  `commands/source.rs` 的 6 个（`scan.progress` / `scan.completed` / `scan.error` /
  `source.unmount.progress` / `source.unmount.completed` / `source.unmount.error`）、
  `commands/album.rs` 的 2 个（`album.sync.progress` / `album.sync.conflict`；2026-09 追加 `album.sync.failed`，同带该属性）、
  `commands/color.rs` 的 `color.extracted`、`commands/repo.rs` 的 `setting.changed`；
  `blueprint.changed` / `plugin.changed` / `plugin.error` **原本就合规**。
- **前端同批改完**：`events.ts` 全部改驼峰；监听点 `core/taskStore.ts`（6 条）、
  `panels/ColorPanel.tsx`、`shared/blueprintRuntime.ts`、`core/AppUiApp.tsx`、
  `settings/SettingsApp.tsx` 一并核对（`test_ui` 的三个面板同步）。
- **不经 Rust DTO 的事件**：`repo.changed` / `panel.restore` 由**前端自己 emit**（一直是驼峰）；
  `media.surface.click` 是空载荷。三者不受本规则影响。
- **防回归**：`pnpm check:commands` 断言「每个 `emit(..., Dto {` 的结构体定义都带该属性」
  且 `events.ts` 里没有蛇形字段。

## 3. 命令目录

### 3.1 `repo.*`

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `repo.create` | 创建仓库 | `{ name, dbPath? }` | `{ ok, data: { repoId } }` | **已包装** | **D76 批次 `repo/layout`（最后一批，2026-09）已迁移**。线上 `data` 是 `{id,name,schema_version}`；空名 → `validation`；路径非合法 UTF-8 也报 `validation`（原先 `.expect("路径非 UTF-8")` 会 panic，已改） |
| `repo.open` | 打开仓库 | `{ repoId }` | `{ ok, data: { repoId, name, schemaVersion } }` | **已包装** | 线上 `data` 是 `{id,name,schema_version}`；仓库不存在 → `not_found` |
| `repo.close` | 关闭仓库 | `{ repoId }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`（序列化为 `null`） |
| `repo.list` | 列出已注册仓库 | `{}` | `{ ok, data: { items } }` | **已包装** | 线上 `data` 是裸 `RepoListItem[]` |
| `repo.backup` | 备份仓库库 | `{ repoId, destPath }` | `{ ok, data: { backupId } }` | **已包装** | 线上 `data` 是裸字符串；空目标路径 → `validation`；建目录/复制失败 → `io`；**前端封装本批一并补上**（此前只有代码没有封装） |
| `repo.rename` | 重命名仓库 | `{ repoId, name }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`；空名 → `validation`；若改的是当前打开仓库，同时同步仓库库 meta |
| `repo.delete` | 删除仓库（仅注册与仓库库文件） | `{ repoId }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`；仓库不存在 → `not_found` |
| `repo.setDefault` | 设为默认仓库（启动自动打开） | `{ repoId }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()` |
| `repo.getDefault` | 读取默认仓库 ID | `{}` | `{ ok, data: { repoId \| null } }` | **已包装** | 线上 `data` 是裸 `string \| null` |

关键错误：`not_found`（仓库不存在）、`conflict`（仓库库损坏需重建/导出）、`io`（路径不可写）。

`repo.delete` 删除当前打开仓库时先关闭；不删除真实媒体源文件（D26）。

### 3.1.1 `layout.*`（面板布局预设）

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `layout.save` | 保存/覆盖命名布局（**该层一份**） | `{ repoId, name, layoutJson, layerKey?, blueprintIds? }` | `{ ok, data: { id, name, layer_key, blueprint_ids, updatedAt } }` | **已包装** | **D76 批次 `repo/layout`（最后一批，2026-09）已迁移**。线上 `data` 元素字段为蛇形 `updated_at` |
| `layout.list` | 列出该仓库命名布局**层行**（最新在前） | `{ repoId }` | `{ ok, data: { items } }`（同一 `name` 每层一行） | **已包装** | 线上 `data` 是裸 `LayoutItem[]`，元素字段为蛇形 `updated_at` |
| `layout.get` | 读取**该层**布局 JSON（该层无行时回退层无关行） | `{ repoId, name, layerKey? }` | `{ ok, data: { layoutJson \| null } }` | **已包装** | 线上 `data` 是裸 JSON 串 `\| null` |
| `layout.rename` | 重命名布局预设（作用于该名字的全部层行） | `{ repoId, name, newName }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`；空新名 → `validation`；默认布局名同步更新 |
| `layout.delete` | 删除布局预设（作用于该名字的全部层行） | `{ repoId, name }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`；删的是默认布局时清空默认标记 |
| `layout.setDefault` | 设为该仓库默认布局 | `{ repoId, name }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()` |
| `layout.getDefault` | 读取默认布局名 | `{ repoId }` | `{ ok, data: { name \| null } }` | **已包装** | 线上 `data` 是裸 `string \| null` |
| `layout.blueprints` | 读取布局绑定的蓝图 id（预设级） | `{ repoId, name }` | `{ ok, data: { blueprintIds } }` | **已包装** | 线上 `data` 是裸 `string[]`；布局不存在 → `not_found` |

布局按仓库隔离（D1）；**每层一份布局**（D53：`layer_key`），保存/套用都针对**当前层**；
重命名/删除会同步维护默认布局标记（D26）；`layerKey` 缺省 = 层无关行（兼容旧预设）。

### 3.2 `source.*`

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `source.mount` | 挂载媒体源（UI 只传选取的文件夹路径） | `{ repoId, localPath, alias?, parentSourceId? }` | `{ ok, data: { sourceId } }` | **已包装** | **D76 批次 `source` 已迁移**（2026-09）。线上 `data` 是完整 `SourceItem`（文档写 `{ sourceId }`）；空路径 → `validation` |
| `source.unmount` | **完全卸载**媒体源（后台任务，不可恢复） | `{ repoId, sourceId }` | `{ ok, data: { taskId } }` | **已包装** | 异步命令用 `ApiAsync`；线上 `data` 是裸 `taskId` 串。空 `sourceId` → `validation`；已有任务在跑 → `conflict`；未打开仓库 → `not_found`。任务的失败经 `source.unmount.error` 事件上报 |
| `source.unmount.preview` | 完全卸载影响预估（只读，供警告弹窗） | `{ repoId, sourceId }` | 见下 | **已包装** | 线上 `data` 的相册元素字段为 `album_id`（文档写 `albumId`） |
| `source.rename` | 重命名别名（**仅添加后**） | `{ repoId, sourceId, alias }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`（序列化为 `null`） |
| `source.scan` | 扫描/索引媒体源 | `{ repoId, sourceId, full? }` | `{ ok, data: { taskId } }` | **已包装** | 异步命令用 `ApiAsync`；线上 `data` 是裸 `taskId` 串；已有任务在跑 → `conflict` |
| `source.list` | 列出媒体源 | `{ repoId }` | `{ ok, data: { items } }` | **已包装** | 线上 `data` 是裸 `SourceItem[]` |
| `source.tree` | 列出媒体源目录树 | `{ repoId }` | `{ ok, data: { nodes } }` | **已包装** | 线上 `data` 是裸 `SourceTreeNode[]` |

> **本批的 D76 落地细节**：`source.*` 七条 + `task.*` 四条（见 3.7）一并包装；
> 两个长任务命令（`source.scan` / `source.unmount`）是**异步命令**，用 `ApiAsync`
> （Tauri 对含引用的 async 命令强制要求 `Result`，包装仍落在成功值里）。
> 错误码口径：空路径 / 空 ID → `validation`；未打开仓库 → `not_found`；
> **已有任务正在进行 → `conflict`**（原先是裸串，前端无法区分"忙"与"参数错"）；
> 仓库锁中毒 → `io`。事件里的 `error` 字段仍是诊断串（事件契约形状不变）。

`source.unmount.preview` → `{ fileCount, albums[{ albumId, name, members }], memberCount, tagCount,
ratingCount, colorCount, aiUndoCount, syncAlbumCount, childSourceCount }`。

**完全卸载语义（用户已确认的口径）**：`source.unmount` 是后台任务，带进度浮窗，
在**一个事务**里删除该源在本仓库的**全部数据**，最后删除源记录：

| 表 | 处理 |
| --- | --- |
| `files`（`source_id`） | 删除文件索引 |
| `file_tags` / `file_auto_tags`（`file_id`） | 删除人工 / 自动 tag 关联（`tags` 词条实体保留） |
| `ratings` / `color_refs`（`file_id`） | 删除评分与色彩参考 |
| `album_member`（`file_id`） | 删除相册成员关系 |
| `ai_tag_undo`（`file_id`） | 删除 AI 覆盖撤销记录（可撤销的 tag 已不存在） |
| `album_sync_rule` / `album_sync_state`（`source_id`） | 删除规则与状态；对应跟随相册 **kind 降级为 `fixed`**（否则相册会指向已删除的源） |
| `sources.parent_source_id`（自引用） | **子源摘挂**为顶层源（子源是独立对象，不连带删除） |
| `sources` | 删除源记录本身 |

**磁盘上的真实文件一律不动**（D26）。刻意保留的仓库级数据：`tags` / `tag_relations`（tag 词条与关系）、
`albums`（用户对象，成员已清空）、`blueprints`、`repo_meta`、`ops_history`（操作审计留痕），
以及按内容哈希寻址、跨源共享的缩略图缓存。

删除顺序自下而上（子表 → `files` → 其它引用 `sources` 的表 → `sources`），
因为 `foreign_keys = ON`。取消时**整个事务回滚**（不会留半清理状态）；重试幂等。

卸载前必须先 `source.unmount.preview` 取影响面，并弹**警告弹窗**（与进度浮窗同款卡片样式）
如实告知将删除的条目数与受影响相册。

事件：`source.unmount.progress`（`phase` ∈ `counting`/`syncRules`/`children`/`derived`/`files`/`source`，
`total = 0` 表示该阶段总数未知）、`source.unmount.completed`
（`{ cancelled, files, tags, ratings, colors, members, syncAlbums, childSources }`）、`source.unmount.error`。

**历史"离线"能力仍在**（不删数据的 `RepoDb::unmount_source`：`mounted = 0`），仅供**历史离线行**与
恢复场景使用，界面上的「卸载」走完全卸载。相关读取规则不变，且是历史数据的兜底：

- `source.list` / `source.tree` 只返回在线源（`mounted = 1`）。
- `file.query` 与相册可见成员（`AlbumService::visible_members`）过滤离线源。
- 跟随源相册的根源离线时同步为空操作（否则 `mirror` 会误清空相册）。
- `source.mount` 遇到同仓库内路径相同且**当前离线**的行会复用它（翻回在线、保留原别名），
  避免重建源 ID 导致旧索引与解释数据变成取不回的孤儿。

添加媒体源由**原生文件夹对话框选取目录**触发，UI **不传 `alias`**：源名称默认取所选文件夹名（`source_tree` 在 `alias` 为空时回退到路径末级段）。别名的创建入口只在「已添加的媒体源」条目上（`source.rename`），添加时不可填别名。`alias` 参数保留在命令契约中以兼容桥接层与嵌套源场景。

### 3.3 `file.*`

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `file.query` | **游标分页**查询文件 | `{ repoId, filter?, cursor?, limit? }` | `{ ok, data: { items, nextCursor } }` | **已包装** | 代码 `commands/file.rs` 的 `file_query`；**D76 批次 `file` 已迁移 + D78 游标分页已落地（2026-09）**。`filter` = `{ mediaType?, sourceId?, dirPrefix? }`；`limit` **只是页大小**；把 `nextCursor` 原样回传即可续页，`null` = 末页。**排序键 = `(relative_path, source_id, id)` 升序**（`relative_path` 单独不是全序：同名不同源会并列）。游标是**不透明字符串**（当前编码 `{路径字节长度}`+US+路径+US+sourceId+US+id，先读长度再按字节切，因此路径里出现分隔符也不歧义）；非法游标 → `validation`，**不静默从头开始**。键集游标在翻页途中库内容变动时**不漏项/不重复**（原 `offset` 分页会），用例 `crates/hp-store/tests/m2_source_file.rs` 的 `cursor_pagination_is_stable_under_inserts` |
| `file.reverify` | 重新校验单个文件 | `{ repoId, fileId }` | `{ ok, data: { verifyStatus } }` | **已包装** | 代码 `commands/file.rs` 的 `file_reverify`；线上 `data` 是**裸状态串**（文档写 `{ verifyStatus }`，差异随 D78/D76 收尾一并处理） |
| `file.metadata` | 读取文件元数据 | `{ repoId, fileId }` | `{ ok, data: { size, mtime, hash, mediaType, ... } }` | **已包装** | `data` 是 `FileMetadataResult` 对象，字段为蛇形：`content_hash`（文档 `hash`）、`source_id`、`relative_path`、`media_type`、`verify_status`、`media_info_json`、`exif_json` |
| `file.path` | 取文件绝对路径（供前端 `convertFileSrc` 预览） | `{ repoId, fileId }` | `{ ok, data: { path } }` | **已包装** | 线上 `data` 是裸路径串；前端 `api/file.ts` |
| `thumb.get` | 按需生成并取缩略图绝对路径（前端 `convertFileSrc` 预览） | `{ repoId, fileId }` | `{ ok, data: { path \| null } }` | **已包装** | 线上 `data` 是 `string \| null`；`null` = 无内容哈希 / 生成失败 / 不支持的类型，前端降级为占位；缓存命中直接返回，**当前**缓存键为内容哈希（第 7 节「缩略图请求形状与缓存键」开放点仍未定稿）；前端 `api/file.ts` |
| `file.rename` | 重命名文件（**磁盘重命名** + 更新索引相对路径） | `{ repoId, fileId, newName }` | `{ ok, data: { file } }` | **已包装** | 新名不得为空/含路径分隔符（→ `validation`），目标已存在 → `conflict`；前端 `api/file.ts` |
| `file.trash` | 批量移入系统回收站，并从索引移除 | `{ repoId, fileIds }` | `{ ok, data: { removed } }` | **已包装** | 线上 `data` 是裸计数（`u32`）；前端 `api/file.ts` |
| `file.reanalyze` | 重新分析单个文件（重算哈希 / 缩略图 / 媒体信息 / **调色板**）并更新索引 | `{ repoId, fileId }` | `{ ok, data: { taskId } }` | **已包装** | **后台任务**（2026-09 用户口径："右键分析文件要和源全量同款弹窗"）：登记 `TaskKind::Analyze` → 独立仓库库连接上跑 `rescan_file(full: true)`，进度浮窗/取消/完成状态全部复用 `scan.progress` / `scan.completed` / `scan.error` 事件族（`taskStore` 只认事件不认命令）。单文件分析**没有暂停点**，故进度帧带 `pausable: false`（浮窗不显示暂停按钮）；取消只在**开工前**生效（与源扫描"每文件之间检查"同款）。前端 `api/file.ts` |

> **本批的 D76 落地细节（批次 `file`，2026-09）**：全部命令改为返回
> `{ ok, data?, error? }`；`未打开仓库` → `not_found`、文件不存在 → `not_found`、
> 未知媒体类型 / 名字非法 → `validation`、目标已存在 → `conflict`、
> 磁盘/回收站/父目录失败 → `io`。`thumb.get` 是**异步命令**：Tauri 的
> `#[tauri::command]` 对含引用的 async 命令强制要求返回 `Result`，因此它用
> `ApiAsync<T>`（`commands/shared.rs`）——包装仍落在**成功值**里（恒 `Ok`），
> 前端只需一套 `unwrapApi`。界面侧的错误显示改为 `errorTextOf(t, e)`：
> 已迁移域按 `code` 走 i18n，**未迁移域仍是裸串**时原样显示（不丢信息），
> 该域迁移后自动收敛。

`filter` 可含 `mediaType`（`image`/`video`/`audio`/`multimedia`），用于相册显示过滤（D10）与源视图筛选。

`file.rename` / `file.trash` 是**真实磁盘操作**，当前**不留操作记录**（无 `opRecordId`），与第 3.6 节 `fsops.*`「真实文件操作必须返回操作记录 ID」的口径不一致；缺口如实记录，是否补记录属另议（见 `docs/architecture/command-event-drift.md`）。`file.trash` 只删除索引行，不连带清理 tag/评分/相册成员。

**`file.query` 分页形态（D78，2026-09）**：按本表实现 **`cursor` / `nextCursor`**（`limit` 为页大小），**不**改用 `limit`/`offset`。理由：`offset` 分页在库内容变动时会漏项/重复，而前端列表、蓝图对象作用域与元数据面板都依赖该查询。代码现状是扁平过滤参数 + 裸数组、无游标（见 `docs/issues/0005`），属**能力级缺口**，需 `hp-store` 查询层配合。

### 3.4 `album.*`

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `album.create` | 创建相册 | `{ repoId, name, kind, mediaType?, parentAlbumId?, sourceId?, fileIds? }` | `{ ok, data: { albumId } }` | **已包装** | 代码 `commands/album.rs` 的 `album_create`；**D76 批次 `album` 已迁移**（2026-09）。线上 `data` 是 `{ album_id }`（蛇形）；另接受 `syncMode` / `includeSubsources` / `filterJson`。空名 / 未知 `kind` / 跟随源缺 `sourceId` → `validation` |
| `album.setMediaType` | 修改媒体属性 | `{ repoId, albumId, mediaType }` | `{ ok, data: { removedCount, opRecordId } }` | **已包装** | 线上 `data` 是 `{ removed_count, op_record_id }`（蛇形）；未知媒体属性 → `validation` |
| `album.addMember` | 手动加成员 | `{ repoId, albumId, fileIds }` | `{ ok, data: { added } }` | **已包装** | 线上 `data` 是 `{ added }`（与文档的 `{ ok: true }` 形状不同，差异随收尾统一） |
| `album.removeMember` | 移除成员 | `{ repoId, albumId, fileIds }` | `{ ok, data: { removed } }` | **已包装** | 线上 `data` 是 `{ removed }` |
| `album.sync` | 执行同步 | `{ repoId, albumId }` | `{ ok, data: { taskId } }` | **已包装** | 线上 `data` 是裸 `taskId` 串；异步命令用 `ApiAsync`（Tauri 对含引用的 async 命令强制 `Result`，包装仍落在成功值里）。空 `albumId` → `validation`；**结果分三种事件**（2026-09 按缺陷 0004 定稿）：整体失败走 `album.sync.failed`，逐文件冲突走 `album.sync.conflict`（带真实 `fileId`），计数汇总走 `album.sync.progress` |
| `album.list` | 列出仓库下全部相册 | `{ repoId }` | `{ ok, data: { items } }` | **已包装** | 线上 `data` 是裸数组；元素 `AlbumItem` 为蛇形：`repo_id` / `parent_album_id` / `media_type` / `member_count` / `created_at` / `updated_at`（`member_count` 逐相册单独计数）；前端 `api/album.ts` |
| `album.members` | **游标分页**列出相册**可见成员**（按有效媒体属性过滤，离线源被排除） | `{ repoId, albumId, cursor?, limit? }` | `{ ok, data: { items, nextCursor } }` | **已包装** | **2026-10 改为游标分页**（缺陷 0018）：旧实现返回裸 `AlbumFileItem[]` 且**无上限**——5 万成员的相册会把全部行读进内存，前端还会为每个成员建一个 `IntersectionObserver`（`mediaPreviewCell.tsx`）。现与 `file.query` **同形**（D78 先例）：`limit` 只是页大小（默认 500，上限 `ALBUM_MEMBERS_MAX_LIMIT` = 1000），把 `nextCursor` 原样回传即可续页、`null` = 末页。**排序键 = `(added_at, file_id)` 升序**（`added_at` 可能同值，必须带 `file_id` 才是全序）。游标是**不透明字符串**（编码同 `FileQueryCursor`：先写长度再写值），非法游标 → `validation`、**不静默从头开始**。媒体属性过滤（D10 含嵌套继承）与离线源排除**语义不变**，只是下推到了 SQL；相册不存在 → `not_found`（不返回空列表）。元素字段为蛇形 `source_id` / `relative_path` / `media_type`；前端 `api/album.ts`。**内部仍保留** `AlbumService::visible_members`（全量、无上限），供确实需要全量的逻辑使用，**界面取数不得用它** |
| `album.rename` | 重命名相册 | `{ repoId, albumId, name }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`（序列化为 `null`），空名 → `validation`；前端 `api/album.ts` |
| `album.delete` | 删除相册（**成员关系与同步规则一并清理**） | `{ repoId, albumId }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`（序列化为 `null`）；前端 `api/album.ts` |

- `mediaType` 缺省为 `multimedia`（D10）；`album.setMediaType` 会移除不匹配成员，移除前 UI 确认并写操作历史（返回 `opRecordId`）。
- `album.addMember` 对不匹配相册 `media_type` 的文件返回 `validation` 并拒绝（D10）。
- 固定型无同步规则；跟随源型按 `add_only|mirror` 维护成员（RFC 0002）。`album.setMediaType` 对跟随型相册联动更新 `album_sync_rule.media_type`（D13）。

### 3.5 `tag.*` / `rating.*`

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `tag.add` | 添加人工 tag | `{ repoId, fileIds, tagName }` | `{ ok, data: { ok: true } }` | **已包装** | **D76 批次 `tag` 已迁移**（2026-09；`rating.*` 一并）。线上 `data` 是 `()`；空 tag 名 → `validation` |
| `tag.remove` | 移除人工 tag | `{ repoId, fileIds, tagName }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()` |
| `tag.forFile` | 列出文件 tag | `{ repoId, fileId }` | `{ ok, data: { manual, auto } }`（人工/自动两组，D21） | **已包装** | 线上 `data` 是 `{manual,auto}`，元素字段为蛇形 |
| `tag.relation.add` | 建立 tag 关系（层级/关联） | `{ repoId, fromTagId, toTagId, relationKind }` | `{ ok, data: { relation } }` | **已包装** | `data` 是 `TagRelationItem`（蛇形 `from_tag_id` / `to_tag_id` / `relation_kind` / `created_at`）；未知 `relationKind` → `validation`；前端 `tagRelationAdd`（2026-09 补齐，见下方 D79 说明） |
| `tag.relation.remove` | 删除 tag 关系 | `{ relationId }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`；前端 `tagRelationRemove` |
| `tag.relation.list` | 列出仓库 tag 关系 | `{ repoId }` | `{ ok, data: { relations } }` | **已包装** | 线上 `data` 是裸数组；前端 `tagRelationList` |
| `tag.relation.parents` | 列出直接上级 | `{ tagId }` | `{ ok, data: { tags } }` | **已包装** | 线上 `data` 是裸数组；前端 `tagRelationParents` |
| `tag.relation.children` | 列出直接下级 | `{ tagId }` | `{ ok, data: { tags } }` | **已包装** | 线上 `data` 是裸数组；前端 `tagRelationChildren` |
| `tag.tree` | 读取 tag 层级树 | `{ repoId }` | `{ ok, data: { nodes } }`（含 `is_cross` 交叉标记） | **已包装** | 线上 `data` 是裸数组 |
| `tag.createRoot` | 新建根 tag | `{ repoId, name }` | `{ ok, data: { tag } }` | **已包装** | `data` 是 `TagItem` |
| `tag.createChild` | 新建子 tag | `{ repoId, parentTagId, name }` | `{ ok, data: { tag } }` | **已包装** | `data` 是 `TagItem` |
| `tag.createSibling` | 新建同级 tag（共享上级；同名则复用 → 交叉） | `{ repoId, refTagId, name }` | `{ ok, data: { tag } }` | **已包装** | `data` 是 `TagItem` |
| `tag.rename` | 重命名 tag | `{ tagId, name }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()` |
| `tag.move` | 移动 tag（拖拽 = 移动） | `{ tagId, newParentId? }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`；跨仓库/成环由领域层拒绝 |
| `tag.detach` | 解除全部层级上级（移到根） | `{ tagId }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`；前端 `tagDetach` |
| `tag.list` | 列出仓库内**全部 tag 实体**（D23 按仓库隔离） | `{ repoId }` | `{ ok, data: { items } }` | **已包装** | 线上 `data` 是裸数组；元素 `TagItem` 为蛇形：`id` / `repo_id` / `name` / `color`（无层级信息，层级走 `tag.tree` / `tag.relation.*`）；前端 `api/tag.ts` |
| `rating.set` | 设置评分 | `{ repoId, fileId, rating }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`；越界评分 → `validation` |
| `rating.get` | 读取文件评分 | `{ repoId, fileId }` | `{ ok, data: { rating \| null } }` | **已包装** | 线上 `data` 是 `i64 \| null`；`null` = 该文件无评分行（**不是** 0 分）；前端 `api/rating.ts` |

tag 实体按仓库独立（D23）；人工 tag 与自动 tag 的关联使用独立表，同名可共存（D21）；tag 关系为多父级 DAG，是关系图谱数据源（D22）。

- `tag.tree` 中多父级 tag 在每个上级下各出现一次并标记 `is_cross`（前端以浅蓝色标示，D24）。
- `tag.createChild` / `tag.createSibling` 若同名 tag 已存在，则**复用该实体并建立层级**（即建立交叉），不重复创建。
- `tag.move`：`newParentId` 有值则替换层级上级；为空则移到根。会校验跨仓库与成环（不能移到自己的下级）。
- **D79 前端封装补齐（2026-09）**：这 6 条关系/摘挂命令（`tag.relation.add/remove/list/parents/children`、`tag.detach`）后端**早已实现**，缺的只是 `apps/desktop/src/app_ui/shared/api/tag.ts` 的封装，现已补上（D79 决定「保留契约 + 补前端封装」）。
  - **口径说明（比 D79 多一条）**：D79 只明列五条（`remove`/`list`/`parents`/`children`/`detach`），`tag.relation.add` 在对账里被归到「名称或载荷不一致」（`docs/architecture/command-event-drift.md:141`），但该行备注已注意到"前端 `api/tag.ts` 未封装"。**没有 `add` 就只能删不能建**，其余五条因此不可用，故一并补齐——这是把同类的封装缺口一次补齐，**不改 D79 的任何决定**。
  - 这 6 条**已随 `tag` 批次一起完成 D76 迁移**（2026-09）：现在标 `已包装`，并由 `pnpm check:commands` 双向守护（文档标已包装 → 代码必须真包装；标裸返回 → 代码不许已包装）。

### 3.6 `fsops.*`

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `fsops.copy` | 源间复制 | `{ repoId, fileIds, targetSourceId, targetPath? }` | `{ ok, data: { opRecordId, affected } }` | **已包装** | **D76 批次 `fsops` 已迁移**（2026-09）。线上 `data` 是 `{ op_record_id, affected }`（文档只写 `{ opRecordId }`）；`opRecordId` **必须返回**（真实文件操作要留操作记录）；前端 `api/fsops.ts` |
| `fsops.move` | 源间剪切/移动 | `{ repoId, fileIds, targetSourceId, targetPath? }` | `{ ok, data: { opRecordId, affected } }` | **已包装** | 同上；移动保留解释数据（tag/评分/相册成员跟随原 ID） |

内容哈希一致则 tag/评分/相册成员不丢失（RFC 0001）。操作必须可记录。

### 3.7 `task.*`

**并发与幂等口径（2026-09，缺陷 0003 修复后定稿）**：

1. **单任务闸门**：同一时刻**至多一条长任务**（扫描或卸载）。新任务在闸门被占用时返回 `conflict`（`已有任务正在进行中…`），不会排队或并行。
2. **一切按 `taskId` 定位**：`task.cancel` / `task.pause` / `task.resume` 都**必须**带 `taskId`（契约从第一天就是这么写的；实现此前用全局标志，已修正）。后端按 `task_id` 登记控制块，请求只作用于**命中的那一条**。
3. **幂等，不把竞态当错误**：目标不是当前任务（已结束 / 从未存在，例如浮窗按钮与任务收尾的竞态）时，取消返回 `cancelled: false`、暂停/恢复返回 `accepted: false`，**HTTP 层仍是成功**；只有空 `taskId` 才是 `validation`。
4. **暂停/恢复只对扫描成立**：卸载的清理循环在单事务里推进、没有暂停点，对它暂停返回 `accepted: false`（不是错误）。扫描的暂停在**下一个文件处理前**生效。
5. **取消是协作式的**：置位取消标志后，任务在下一个检查点收尾，并**照常发出终止事件**（`scan.completed` 带 `cancelled: true` / `source.unmount.completed` 带 `cancelled: true`）——取消不是错误。

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `task.cancel` | 取消**指定**长任务 | `{ taskId }` | `{ ok, data: { cancelled } }` | **已包装** | **2026-09 已修（缺陷 `docs/issues/0003`）**：`commands/source.rs` 的 `task_cancel(task_id, …)`；`cancelled` = 请求是否命中当前任务（`false` = 任务已结束，**不是错误**）；空 `taskId` → `validation`；前端 `api/source.ts` 的 `taskCancel(taskId)` |
| `task.pause` | 暂停**指定**扫描任务 | `{ taskId }` | `{ ok, data: { accepted, paused } }` | **已包装** | **2026-09 已修（缺陷 0003）**：只有扫描可暂停，其余一律 `accepted: false`；`paused` = 调用后的挂起状态（受理后为 `true`）；**前端已封装**（`taskPause(taskId)`），浮窗按任务给出暂停按钮 |
| `task.resume` | 恢复**指定**已暂停的扫描任务 | `{ taskId }` | `{ ok, data: { accepted, paused } }` | **已包装** | **2026-09 已修（缺陷 0003）**：受理后 `paused` 恒为 `false`——单看 `paused` 无法区分"已恢复"与"任务已结束"，故并列回报 `accepted`；前端 `taskResume(taskId)` |
| `task.status` | 长任务快照（前端进度浮窗的对账依据） | `{}` | `{ ok, data: { busy, taskId, kind, paused } }` | **已包装** | 线上另有 `taskId` / `kind`（`scan` \| `analyze` \| `unmount`；**2026-09 追加 `analyze`** = `file.reanalyze` 的单文件分析任务）/ `paused`（仅扫描任务有值，无任务为 `null`）：浮窗重建后要先问清"当前是哪条任务"才能按 `taskId` 操作（缺陷 0003）；浮窗若因界面线程繁忙丢掉终止事件，可据 `busy` 收起「永远转圈」的浮窗；前端 `api/source.ts` 的 `taskStatus()` |

### 3.8 `ai.*`

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `ai.tagging.submit` | 提交 AI 打标 | `{ repoId, fileIds, providerConfigId, options }` | `{ ok, data: { taskId } }` | **已包装** | **D76 批次 `ai` 已迁移**（2026-09）。线上 `data` 是 `Vec<String>`（文档写单值 `taskId`）；**前端未封装**（当前无调用方） |
| `ai.config.create` | 创建 AI 提供方配置引用（**不保存密钥明文**） | `{ provider, model?, configJson }` | `{ ok, data: { config } }` | **已包装** | 线上 `data` 是 `AiConfigItem`（蛇形 `config_json` / `created_at`）；**应用级**（全局库），不带 `repoId`；未打开全局库 → `not_found`；前端未封装 |
| `ai.config.list` | 列出 AI 提供方配置 | `{}` | `{ ok, data: { items } }` | **已包装** | 线上 `data` 是裸数组、应用级、无参数；前端未封装 |
| `ai.config.remove` | 删除 AI 提供方配置 | `{ configId }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`、应用级；前端未封装 |
| `ai.tagging.status` | 查询单个打标任务状态 | `{ taskId }` | `{ ok, data: { task \| null } }` | **已包装** | 线上 `data` 是 `{task_id,status} \| null`；`null` = 队列中无该任务；前端未封装 |
| `ai.tagging.run` | 执行队列中的打标任务并返回汇总 | `{}` | `{ ok, data: { processed, written, overwritten, undoIds } }` | **已包装** | 线上 `data` 是 `AiRunSummary`（蛇形 `undo_ids`）；骨架阶段用占位提供方，不产生候选 tag；前端未封装 |

AI 输入/输出/回写遵循决策 D6 + D21：输入含文件 ID、图像访问句柄、模型/提供方配置、任务选项；输出含候选 tag、置信度、来源模型、生成时间；回写**只写自动组**（`file_auto_tags`）并标记来源/置信度/生成时间，**不得修改人工 tag**（`file_tags`），自动组内高置信更新必须生成撤销记录。

### 3.9 `media.*`

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `media.play` | 在面板中打开并播放 | `{ repoId, fileId }` | `{ ok, data: { sessionId } }` | **已包装** | **D76 批次 `media` 已迁移**（2026-09）。线上 `data` 是 `{ session_id }`，且会话 ID 实际取 `file_id`。**渲染目标未就绪时**错误码为 `conflict`，诊断串以 `EMBED_NOT_READY` 开头（不静默开独立窗口，见 `docs/issues/0001`） |
| `media.pause` | 暂停 | `{ paused? }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`；`sessionId` **可选且不参与定位**（后端按当前常驻子进程操作）。**异步命令**，用 `ApiAsync` |
| `media.seek` | 定位 | `{ positionMs }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`；`sessionId` 同上可选 |
| `media.stop` | 停止播放（**保留常驻子进程**；释放渲染目标走 `media.embed.release`） | `{}` | `{ ok, data: { ok: true } }` | **已包装** | 只停播放、**保留常驻子进程**；`sessionId` 同上可选 |
| `media.togglePause` | **原子**切换暂停/继续（单击画面 = 暂停/继续 的处理入口） | `{}` | `{ ok, data: { has_session, paused } }` | **已包装** | 后端一次锁内「读 pause → 取反写入」；`has_session=false`（无子进程/已停止/已播完）时前端转 `media.play` |
| `media.processStatus` | 查询媒体子进程状态 | `{}` | `{ ok, data: { alive, pipe } }` | **已包装** | 线上 `data` 是 `{alive,pipe}`，字段名与文档的 `{ alive, version }` 不同 |
| `media.playbackState` | 读取播放进度快照（进度条实时同步） | `{}` | `{ ok, data: { alive, position_ms, duration_ms, paused, ended } }` | **已包装** | 数据来自 mpv `observe_property` 推送（后台读取线程），**用 `try_lock` 非阻塞**（前端 500ms 轮询，不能用 `lock` 与 `media.play` 抢锁）；前端 `api/media.ts` |
| `media.embed.rect` | 创建或更新**面板级原生渲染子窗口**（物理像素） | `{ x, y, width, height }` | `{ ok, data: { ready } }` | **已包装** | 线上 `data` 是裸 `bool`；首次创建、其后仅更新几何；`true` = 嵌入就绪；无 `repoId`（渲染目标不属于仓库）；窗口失败 → `io` |
| `media.embed.release` | 销毁面板级渲染子窗口（面板关闭时调用） | `{}` | `{ ok, data: { ok: true } }` | **已包装** | 只销毁原生子窗口，**不停常驻 mpv 进程**（那走 `media.stop`）；无 `repoId` |
| `media.embed.visible` | 显示/隐藏面板级渲染子窗口（**面板切到后台标签时必须隐藏**） | `{ visible }` | `{ ok, data: { ready } }` | **已包装** | 线上 `data` 是裸 `bool`；窗口尚未创建时返回 `false`（隐藏是空操作，不算错误）；**原生子窗口不受 DOM/CSS 约束**，不显式隐藏就会盖住面板原区域（"视频没了但一块区域点不动"） |
| `media.embed.clickThrough` | 设置渲染子窗口是否把鼠标事件**穿透**给下层 WebView（**旧路径，默认关闭**） | `{ enabled }` | `{ ok, data: { ready } }` | **已包装** | 默认**不穿透**（2026-09 真机修正：`HTTRANSPARENT` 只转发到同线程窗口，WebView2 输入窗口不保证同线程，穿透在真机上不可靠）；现在点击由渲染子窗口自收并广播 `media.surface.click`；窗口未创建返回 `false` |

> **本批的 D76 落地细节（批次 `media`）**：11 条命令**全部是异步命令**（它们要拿
> `state.media` 锁，而 `media.play` 会在持锁期间做最长 5s 的启动等待；普通 `fn` 命令
> 在主线程执行会直接卡死界面），因此统一用 [`ApiAsync`]——包装仍落在**成功值**里。
> 错误码口径：mpv 可执行文件缺失 / 子进程与管道失败 / 嵌入窗口 Win32 失败 → `io`；
> 未打开仓库 / 文件不存在 → `not_found`；渲染目标未就绪 → `conflict`（诊断串保留
> `EMBED_NOT_READY` 前缀）。**注意**：自 2026-09 播放器面板改用 DOM `<video>` 后，
> 这批命令**已无前端调用方**（`api/media.ts` 保留但休眠）；本批只做形状迁移，不改行为。

媒体子进程为单实例常驻（D14）；崩溃自动重启。渲染目标挂到面板容器，面板关闭时释放句柄。

> **2026-09 决策更新：本组命令进入休眠（`media.*` 仍注册可用，播放器面板不再调用）**。
> 播放器面板已改为与查看器同构的 **DOM `<video>`**（见 `docs/rfc/0005-media-capabilities.md`）：
> libmpv 原生窗口嵌入在真机上反复失败（原生窗口漂浮在「全部设置」等 DOM 浮层上方、
> 点击穿透不可靠），用户要求"参考查看器的视频部分"。蓝图双击视频改为
> `playerPlayStore.requestPlayerPlay(fileId)` → 面板用 `filePath` + `convertFileSrc`
> 加载 DOM `<video>` 并播放；单击画面 = 暂停/继续、切标签自动暂停、播完回首帧暂停、
> 进度条全部由 `<video>` 元素事件驱动。下列「渲染子窗口」各条均为**已退役路径的记录**。

**渲染子窗口的显隐必须由前端驱动**（2026-09 补充，已随 DOM `<video>` 方案退役）：它是
Win32 原生子窗口，不随 WebView 里面板的隐藏/卸载而消失；`media.embed.rect` 只改几何、
**不再**带 `SWP_SHOWWINDOW`（否则几何同步会把隐藏后的窗口又唤醒），显隐一律走
`media.embed.visible`。**应用级浮层**（如「全部设置」）打开时也要隐藏渲染子窗口
（Win32 窗口永远盖在 WebView 之上，否则视频漂浮在浮层上方）——曾以 `appOverlayStore`
广播浮层开合、面板订阅后隐藏/恢复。

**点击由渲染子窗口自收并广播事件**（2026-09 真机修正，已退役）：曾把默认穿透改为渲染
子窗口自收点击（`WM_LBUTTONUP` 广播 `media.surface.click`），面板监听后调
`media.togglePause` 做**原子**切换。DOM `<video>` 方案下点击由浏览器原生派发到面板，
`media.surface.click` 事件与 `media.togglePause` 均不再被使用（命令保留）。

**播放器面板的交互（2026-09 用户裁决，仍有效）**：面板**不放**播放/暂停/定位/停止按钮；
**单击画面 = 暂停 / 继续**（DOM `<video>` 实时 `.paused`，无状态过期），画面下方一根
**进度条**（可拖动定位，实时同步进度）。画面区**不显示**「单击暂停/播放」提示文字。
进度来自 `<video>` 的 `timeupdate` / `loadedmetadata` 事件；面板**不能**用"自己发起过
播放"来判断是否有会话，因为蓝图双击是宿主直接发起播放的。

**`media.*` 命令必须都是 `async fn`（2026-09 修复）**：`#[tauri::command]` 对普通 `fn`
用 `ExecutionContext::Blocking`，命令体**在主线程执行**；而本组命令会做阻塞操作
（`media.play` 等 mpv 建管道最长 5s、其余要抢同一把 `media` 锁）。若在主线程上阻塞，
整个界面会卡死（实测：从媒体预览连续双击两次必现）。因此这些命令统一 `async fn`，
阻塞部分交给 `spawn_blocking`；触碰 `state.media` 锁的命令都走同一条阻塞线程池。

嵌入窗口几何使用**主窗口客户区坐标、物理像素**（`apps/desktop/src/app_ui/shared/types/media.ts:35` 注释）；渲染目标从独立窗口切到面板嵌入时，后端会重启常驻子进程以应用新 `--wid`（`commands/media.rs:89-95`）。

### 3.10 `color.*`

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `color.extract` | 浏览时按需提取调色板（仅图片） | `{ repoId, fileId }` | `{ ok, data: { taskId } }` | **已包装** | **D76 批次 `repo/layout/color` 已迁移**（2026-09）。异步命令，用 `ApiAsync`；线上 `data` 是裸 `taskId` 串。非图片在**后台**报 `validation` 并广播空调色板的 `color.extracted`（提取失败按空结果收敛，不阻塞界面） |
| `color.set` | 手动调整/锁定色值 | `{ repoId, fileId, colorJson }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()` |
| `color.get` | 读取文件色彩参考 | `{ repoId, fileId }` | `{ ok, data: { colorJson \| null } }` | **已包装** | 线上 `data` 是 `string \| null`；`null` = 该文件尚无色彩参考；存的是 `color_json` 全文（提取后形如 `{"version":2,"colors":[...],"locked":false}`；`version` 是**缓存格式版本**，与 `hp_media::PALETTE_FORMAT_VERSION` 同源，前端 `shared/paletteJson.ts` 据此把旧版本缓存当「未提取」自动重算，`locked:true` 的手动锁定结果不受版本影响）；前端 `api/color.ts` |

色彩参考仅图片（D18）；自动提取结果可被手动调整覆盖；按仓库隔离。**面板侧口径（D81）**：色彩参考面板只保留调色板（8 色色带），点击色块显示色值并可复制（格式由 `color.valueFormat` 切换），调色板由**全面分析**（源扫描 / 源全量重扫 / 「重新分析该文件」）顺带提取，界面不再触发提取（`color.extract` 保留但无界面调用方，见 D82）；`color.set` 的手动锁定暂无面板入口但命令与数据保留。

### 3.11 `plugin.*`

插件命令统一走 `plugin.{pluginId}.{action}` 命名空间，请求体必须含 `repoId`，由宿主校验该插件在当前仓库已启用且已获对应能力授权（RFC 0004）。

以下是**宿主侧插件管理命令**（实现在 `apps/desktop/src-tauri/src/commands/` 下的插件域文件：`plugin.rs`（安装 / 发现 / 版本）、`plugin_lifecycle.rs`（启用 / 禁用 / 状态 / 加载）、`plugin_contributions.rs`（注册视图）、`plugin_control_channel.rs`（`plugin.panelSchema` / `plugin.validateControl`）、`plugin_control_event.rs`（`plugin.controlEvent`），另有两条自成一体的通道 `plugin_catalog.rs`（`plugin.panelCatalog`）与 `plugin_panel_data.rs`（`plugin.panelData`）；注册于 `main.rs`）。它们操作**全局**插件注册表与应用数据目录下的插件根，因此 `plugin.*` 中只有按仓库生效的那几条带 `repoId`：`plugin.enable` / `plugin.disable` / `plugin.state` / `plugin.load` / `plugin.controlEvent` 带，`plugin.list` / `plugin.discover` / `plugin.installLocal` / `plugin.installBundled` / `plugin.versions` / `plugin.rollback` **不带**。上面第 1 节「请求体必须含 `repoId`」的规则约束的是**插件自身实现**的 `plugin.{pluginId}.{action}` 命令，不适用于本表的管理命令。

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `plugin.list` | 列出已安装插件 | `{}` | `{ ok, data: { items } }` | **已包装** | **D76 批次 `plugin` 已迁移**（2026-09）。线上 `data` 是裸数组；元素 `PluginItem` 为蛇形：`trust_level` / `source_kind` / `source_ref` / `runtime_kind` / `installed_at`；应用级、无参数；前端 `api/plugin.ts` |
| `plugin.discover` | 扫描目录下的插件包（**不安装**） | `{ dir }` | `{ ok, data: { items } }` | **已包装** | 线上 `data` 是裸数组；元素仅 `id` / `name` / `version`；无状态、无应用数据目录访问；前端 `api/plugin.ts` |
| `plugin.installLocal` | 安装本地路径插件包并注册 | `{ path }` | `{ ok, data: { plugin } }` | **已包装** | **来源与信任由宿主判定**：注册表 `source_kind` / `trust_level` 同源于 `InstallSource::LocalPath`（本地路径恒为 `local-path` / `local-dev`），manifest 自称的 `source` 一律忽略（RFC 0009 / 缺陷 0008），推导在 `crates/hp-plugin-host/src/install.rs:161`；落盘到插件根后写全局注册表；前端 `api/plugin.ts` |
| `plugin.installBundled` | 安装**随应用分发**的 system 插件包（`plugins/system/*`）并登记注册表 | `{}` | `{ ok, data: { root, items } }` | **已包装** | **命令不带参数**：既不接受路径也不接受插件 id——"能指定安装位置"的 `system` 入口等于把缺陷 0008 从后门放回来。来源与信任由宿主判定，同源于 `InstallSource::Bundled`（恒为 `system`），推导在 `crates/hp-plugin-host/src/install.rs`（`install_registry_row` / `install_or_reuse_registry_row` 共用同一处推导）；逐项 `status` ∈ `installed` / `alreadyInstalled`（**幂等**：同版本目录按 RFC 0004 不可变，复用而不覆盖）/ `skipped`（目录内没有 `plugin.manifest`）/ `failed`（单项失败不阻塞其余，`message` 为诊断串）；元素字段为**蛇形**（`plugin_id`），与 `plugin.list` 的管理命令同口径（命令返回值不是事件载荷，不受 D77 约束）。**根目录解析**：`HP_BUNDLED_PLUGINS_DIR` 优先 → 否则自工作目录 / 可执行文件目录向上查找 `plugins/system`。**打包边界（未落地）**：`apps/desktop/src-tauri/tauri.conf.json` **尚无** `bundle.resources`，故打包产物里不含该目录，随包分发是后续工作；找不到根目录 → `not_found`。安装**不广播** `plugin.changed`（同 `plugin.installLocal`：刚装上的插件尚未按仓库启用）。前端 `api/plugin.ts:pluginInstallBundled`，触发点 `apps/desktop/src/app_ui/panels/PluginPanel.tsx` |
| `plugin.controlEvent` | 把**控件交互**回传给插件（控件标准第 6 节 / D63） | `{ repoId, panelId, controlId, event, eventId, value?, target? }` | `{ ok, data: { panel_id, plugin_id, control_id, event, event_id, method } }` | **已包装** | **命令形态是 2026-09 的落地裁决**：本契约第 6 节写的字面命令名 `plugin.{pluginId}.{eventId}` 要求**动态注册**，而 Tauri 命令是**静态注册**的。因此拆成两段——「前端 → 宿主」用这一条**通用**命令，「宿主 → 插件」仍发**契约的字面方法名** `plugin.{pluginId}.{eventId}`（`crates/hp-plugin-host/src/channel.rs:52` 的 `CONTROL_EVENT_METHOD_PREFIX` / `:55` 的 `control_event_method`）。**插件侧看到的协议与规范一致**，偏差只落在宿主命令这一层。<br>**载荷**：插件侧参数与第 6 节逐字一致（`{ panel_id, control_id, event, value?, target? }`）——**事件 id 由方法名承载、不进载荷**，因此没有扩展载荷结构。<br>**fail-closed 校验（全在宿主侧，不靠前端自证）**：面板归属 + 该插件在该仓库已启用且已获 `ui.panel`（复用 `panel_owner_enabled`）；`event` 必须是宿主谓词表六个之一（`cancel` 不在表内）；`eventId` 必须在 manifest `events` 里**声明过**；`value` 只收标量。失败码：未启用/未获能力 → `permission`、无归属 → `not_found`、事件名非法 / id 未声明 / `value` 非标量 → `validation`、入口缺失 / 超时 / 超限 / JSON-RPC error → `plugin`。<br>**未声明在 schema `on` 里的事件不调用本命令**（调用方先判映射，缺失即记一次忽略，规范第 6 节）。<br>**交付代价如实记录**：沿用 `external-process` 的一次一问一答，**每次点击起一个插件进程**；常驻进程与重启退避/不健康标记（`external-process` 监督）仍未实现。<br>**同时作为蓝图事件源上报**：同名触发词（`click` / `double_click` / `selection_change`）上报 `BlueprintEngine`，`control` 节点按既有 `panel_id` 匹配（`BlueprintTargetRef.panelId`，选择加入式 → 不带 `panelId` 的上报零回归）；**`controlId` 不参与匹配**（那是 2026-09 已取消的 D56「浮动控件」绑定口径）。<br>代码 `apps/desktop/src-tauri/src/commands/plugin_control_event.rs:73`，注册 `apps/desktop/src-tauri/src/main.rs:187`；前端 `api/plugin.ts:pluginControlEvent`，接线点 `apps/desktop/src/app_ui/panels/PluginPanelHost.tsx:96`，事件映射 `apps/desktop/src/app_ui/shared/control/controlEvents.ts` |
| `plugin.enable` | 按仓库启用并授权能力 | `{ repoId, pluginId, grants }` | `{ ok, data: { state } }` | **已包装** | 线上 `data` 是 `PluginStateItem`（蛇形 `plugin_id` / `repo_id`）；`grants` 取值受能力枚举校验，未知能力 → `validation`；启用后广播 `plugin.changed`；前端 `api/plugin.ts` |
| `plugin.disable` | 按仓库禁用插件 | `{ repoId, pluginId }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`；禁用后广播 `plugin.changed`；前端 `api/plugin.ts` |
| `plugin.state` | 查询插件在某仓库的启用与授权状态 | `{ repoId, pluginId }` | `{ ok, data: { state \| null } }` | **已包装** | 线上 `data` 是 `PluginStateItem \| null`；`null` = 该仓库从未启用过该插件；前端 `api/plugin.ts` |
| `plugin.load` | 加载插件（**生命周期骨架**） | `{ repoId, pluginId }` | `{ ok, data: { pluginId, repoId, runtimeKind, apiVersion, grants } }` | **已包装** | 线上 `data` 是 `PluginLoadItem`，字段为蛇形 `plugin_id` / `repo_id` / `runtime_kind` / `api_version`；前端 `api/plugin.ts` |
| `plugin.versions` | 列出某插件在磁盘上已安装的版本 | `{ pluginId }` | `{ ok, data: { versions } }` | **已包装** | 线上 `data` 是裸 `string[]`；无 `repoId`；前端 `api/plugin.ts` |
| `plugin.rollback` | 回滚到指定已安装版本（**目录切换，不依赖网络**） | `{ pluginId, version }` | `{ ok, data: { path } }` | **已包装** | 线上 `data` 是裸目录路径串；无 `repoId`；版本目录不存在 → `not_found`；前端 `api/plugin.ts` |
| `plugin.panelSchema` | 向插件查询面板控件 schema（请求名 `ui.panel.schema`，控件标准第 2 节 / D61） | `{ repoId, panelId }` | `{ panelId, pluginId, pluginVersion, apiVersion, schemaJson, cached }` | **已包装** | 代码 `commands/plugin_control_channel.rs:221`；**D76 新增命令走新口径**（`{ ok, data?, error? }`）。失败（超时 2s / 输出 >256 KiB / JSON-RPC error / 入口缺失 / 插件未启用或未获 `ui.panel`）→ `error.code = plugin`（未启用为 `permission`、无归属为 `not_found`）并广播 `plugin.error`；结果按 `(plugin_id, panel_id, plugin_version)` 缓存且**只缓存成功**（`crates/hp-plugin-host/src/channel.rs`）。当前只支持 `external-process`，`wasm`/`dynamic-library` 返回 `plugin` 错误。面板归属由注册表反查（`hp_plugin_host::PluginHost::find_panel_owner`），不靠 id 字符串切分；前端 `api/plugin.ts:pluginPanelSchema`，消费点 `apps/desktop/src/app_ui/panels/PluginPanelHost.tsx:52` |
| `plugin.panelData` | 面板 `bind` 的**受控取数**（请求名 `ui.panel.query`，控件标准第 5 节） | `{ repoId, panelId, selectedFileId?, binds: [{ kind, name, args? }] }` | `{ panelId, pluginId, pluginVersion, results, missing }` | **已包装** | 代码 `commands/plugin_panel_data.rs`（`plugin_panel_data` + `fetch_panel_data`）；**D76 新增命令走新口径**。`results` 的键是**宿主构造**的快照键 `"{kind}:{name}"`（与前端 `makeControlDataSnapshot` 的查键、Rust `PanelQuerySpec::snapshot_key` 三处逐字一致——`check:controls` 有断言）。`missing` 是插件**未返回**的键：按空结果渲染空态，**不是错误**。**fail-closed**：`bind.name` 必须在 manifest `data_queries` 声明过（未声明 → `validation`），`bind.kind` 是闭集 `panel`/`selection`（`repo` 未开放）。**一次问完**（全部 `bind` 装在一次请求里）；**不缓存**（数据陈旧风险与 schema 不同）。失败口径与 `plugin.panelSchema` 相同（2s / 256 KiB / `plugin.error`）；`binds` 为空时**不起进程**，直接返回空结果。**范围边界**：不校验单条结果与 manifest `returns` 的匹配（`PanelOwner` 只带查询名）。前端 `api/plugin.ts:pluginPanelData`，消费点 `apps/desktop/src/app_ui/panels/PluginPanelHost.tsx` |
| `plugin.panelCatalog` | 「扩展」菜单的**目录**：已安装插件贡献的**面板**或**纯数据扩展**（无面板），**含未启用**的 | `{ repoId }` | `{ ok, data: { items } }` | **已包装** | 代码 `commands/plugin_catalog.rs`（`plugin_panel_catalog` → `hp_plugin_host::PluginHost::panel_catalog`）；**D76 新增命令走新口径**。**与 `plugin.contributions` 是两条不同口径，不要合并**：那个只报该仓库**已启用**的插件（注册表用——启用即授权能力，属安全口径），本命令报**全部已安装**的并附带 `enabled`，让"装了但没启用"在界面上可见。**起因是真实缺陷**：装完插件后「扩展」菜单里什么都不出现、界面也无任何提示，只能得出"装了没反应"（`hello` / `control-demo` 都踩过；**纯数据扩展包又重演过一次**——它们按 D36.1 声明 `contributions: []`，只按面板过滤就永远不出现）。元素字段驼峰：`pluginId` / `pluginName` / `trustLevel` / `runtimeKind` / `panel`（`{ id, titleKey }`，**`null` = 该插件不贡献面板**，即数据扩展）/ `enabled` / `stateless`（**无启用语义**：纯数据包装完即生效，界面**不得**画启用开关，RFC 0008 D36.9）。**排序由后端保证**：带面板的在前，无面板的整组在**最后**（界面据此把数据扩展放在菜单底部）。宿主 API 版本不兼容的插件整条缺席（不是错误）。前端 `api/plugin.ts:pluginPanelCatalog`，消费点 `apps/desktop/src/app_ui/menu/MenuBar.tsx`（面板行：灰显 + 右侧启用开关；数据扩展行：只列、无开关） |
| `plugin.validateControl` | 业务级控件校验（控件标准第 7 节 / D62） | `{ panelId, schemaJson }` | `{ errors, warnings }` | **已包装** | 代码 `commands/plugin_control_channel.rs:246`；**D76 新增命令走新口径**。复用 `crates/hp-core/src/control.rs` 的 `ControlSchema::validate`（不另写口径）；JSON 不可解析时以 `errors` 返回而**不是**命令级失败，故 `ok: true` 不等于 schema 可用；声明表（`data_queries` / `events`）来自 `find_panel_owner`，面板无归属插件时声明表为空（fail-closed）；前端 `api/plugin.ts:pluginValidateControl` |

### 3.12 `blueprint.*`

蓝图命令（RFC 0007；载荷经 `hp-dto` 生成 shared-types）。所有命令带 `repoId`，按仓库隔离。

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `blueprint.list` | 列出仓库蓝图 | `{ repoId }` | `{ ok, data: { items } }` | **已包装** | **D76 批次 `blueprint` 已迁移**（2026-09）。线上 `data` 是裸数组 |
| `blueprint.get` | 读取蓝图文档 | `{ repoId, blueprintId }` | `{ ok, data: { blueprint \| null } }` | **已包装** | 线上 `data` 是裸 JSON 串；行不属于该仓库时按"不存在"处理 |
| `blueprint.getDefault` | 读取**库存**默认蓝图文档（D58） | `{ repoId }` | `{ ok, data: { blueprintJson \| null } }`（无库存默认 → `null`；**常量回退与补种由前端运行时完成**，见 RFC 0007 决策 2） | **已包装** | 线上 `data` 是裸 `string \| null` |
| `blueprint.create` | 新建蓝图（可带结构骨架/模板） | `{ repoId, name, fromTemplateId?, blueprintJson? }` | `{ ok, data: { blueprint } }` | **已包装** | 线上 `data` 是 `BlueprintItem`；空名 → `validation`、模板不存在 → `not_found`、文档校验不过 → `validation` |
| `blueprint.save` | 整文档保存（校验后） | `{ repoId, blueprintId, name?, blueprintJson }` | `{ ok, data: { updatedAt } }` | **已包装** | 线上 `data` 是 `BlueprintItem`（文档写 `{ updatedAt }`）；未给 `name` 时沿用库中现有名称；校验不过 → `validation` |
| `blueprint.delete` | 删除蓝图 | `{ repoId, blueprintId }` | `{ ok, data: { ok } }` | **已包装** | 线上 `data` 是 `()`（序列化为 `null`）；行不属于该仓库 → `not_found` |
| `blueprint.setDefault` | 设为默认 | `{ repoId, blueprintId }` | `{ ok, data: { ok } }` | **已包装** | 线上 `data` 是 `()` |
| `blueprint.validate` | 校验图文档 | `{ repoId, blueprintJson }` | `{ ok, data: { errors, warnings } }` | **已包装** | **`ok: true` 不等于文档有效**：硬错误在 `data.errors`（服务端复算结果），前端必须自己看 `errors`；只有"命令层失败"（未打开仓库等）才走 `error` |
| `blueprint.currentLayer.get` | 读取该仓库的当前层（D54） | `{ repoId }` | `{ ok, data: { layerKey \| null } }` | **已包装** | 线上 `data` 是裸 `string \| null` |
| `blueprint.currentLayer.set` | 记住该仓库的当前层（D54，多窗口后写覆盖） | `{ repoId, layerKey }` | `{ ok, data: { ok } }` | **已包装** | 线上 `data` 是 `()` |
| `blueprint.template.list` | 列出全局模板 | `{}` | `{ ok, data: { items } }` | **已包装** | 线上 `data` 是裸 `BlueprintTemplateItem[]` |
| `blueprint.template.install` | 模板复制进仓库 | `{ repoId, templateId, name? }` | `{ ok, data: { blueprint } }` | **已包装** | 线上 `data` 是 `BlueprintItem`；模板不存在 → `not_found`；未给 `name` 时用 `templateId` 作名字 |

- **`validate` 必须同时返回 `errors` 与 `warnings`**（硬错误拒绝保存；`warnings` 为"未接通"软告警，不阻塞）。
- **生效蓝图优先级（D58）**：当前布局绑定的第一个蓝图 → 该仓库 `is_default` → 内置默认。
- **层（D51/D53/D54）**：层是文档内部结构，命令载荷仍是**整文档**；层的增删改名排序由**前端编辑器**完成（不新增层的 CRUD 命令），**当前层**按仓库持久化走 `blueprint.currentLayer.get/set`（应用设置键 `blueprint.currentLayer.{repoId}`，D54）。
- **布局 → 蓝图自动同步（D59）**：`layout.save` 会增量补 `control`/`group` 节点与 `contains` 边（D59：不用 `memberOf`），并**广播 `blueprint.changed`**；该行为可开关（默认开）。

### 3.13 `setting.*`（「全部设置」系统界面，RFC 0010 决策 7）

「全部设置」是**应用级系统界面**（`docs/spec/settings-standard.md`）：**不按仓库隔离**，因此本组命令**不带 `repoId`**（例外见下），读写全局库 `app_settings` 键值对。

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `setting.get` | 读取单个设置值 | `{ key, repoId? }` | `{ ok, data: { value \| null } }` | **已包装** | `commands/repo.rs` 的 `setting_get`（D76 口径：`{ ok, data?, error? }`）；值在线上是**字符串**，逻辑类型由注册表 `kind` 在前端解码（`decodeSettingValue`）；`repoId` 仅对 `scope = "repo"` 项有意义（键 `{key}.{repoId}`），**其余项忽略**；未知键 → `validation` |
| `setting.set` | 写入单个设置值（标量） | `{ key, value, repoId? }` | `{ ok, data: { ok: true } }` | **已包装** | `commands/repo.rs` 的 `setting_set`；**四条规则全部在宿主执行**（见下方规则节）：未知键 → `validation`、按注册表 `kind` 校验值、插件项未获 `requires_capability` → `permission`、仅 `scope = "repo"` 项拼 `repoId`；写入后广播 `setting.changed` |
| `setting.list` | 列出全部设置值（渲染「全部设置」用） | `{ repoId? }` | `{ ok, data: { items: [{ key, value }] } }` | **已包装** | `commands/repo.rs` 的 `setting_list`；`app_settings` 的**原始转储**（含 `repo.default` 等宿主内部键），不做注册表过滤——过滤会让"未设置 vs 设成缺省"无法区分 |
| `setting.reset` | 重置某设置项为默认值（删除该键） | `{ key, repoId? }` | `{ ok, data: { ok: true } }` | **已包装** | `commands/repo.rs` 的 `setting_reset`；未知键/`scope` 口径与 `setting.set` 完全一致；并广播 `setting.changed` |
| ~~`setting.registry`~~ | ~~取设置注册表~~ | — | — | **已改判：非命令** | **不实现为 Tauri 命令**（2026-09 裁决，见下方规则） |
| ~~`setting.search`~~ | ~~搜索设置项~~ | — | — | **已改判：非命令** | 同左；搜索必须匹配**当前语言**文案，Rust 侧无 i18n |

规则：

- **`setting.registry` / `setting.search` 改为前端函数，不是命令（2026-09 裁决）**：
  - 原因一：设置注册表 = **TS 静态声明**（`packages/config/src/settings.ts` 的宿主项 + `panels.ts` 的面板项）+ **插件贡献**（已由既有 `plugin.contributions` 命令送到前端）。做成命令必须在 Rust 侧重新推导一遍同样的数据 —— 纯重复，且会立刻漂移。
  - 原因二：**搜索必须匹配 `title_key` 的当前语言文案**（`docs/spec/settings-standard.md` 第 6 节），而 i18n 资源在**前端**；Rust 侧没有该数据，`setting.search` 作为命令在架构上不成立。
  - 落点：`apps/desktop/src/app_ui/settings/settingsRegistry.ts`（`sectionsOf` / `searchSettings`）。**注册表不落库、不经命令**。
- **现状与迁移（重要）**：`setting.get` / `setting.set` **原本就存在**（键与值都是字符串）且已在 2026-09 **就地迁移**为标量值 + `repoId` 分仓键；`setting.list` / `setting.reset` 同批实现。逐条差异见 `docs/architecture/command-event-drift.md` 第 1.11 节。
- **值一律标量**（string / number / bool）；**不接受**嵌套对象或任意表达式（与 D32 同口径）。**存储**是 `app_settings` 的 TEXT（最小形式：`true`/`false`/十进制/原文），**线上**（`setting.get` 的 `value`）是 **JSON 标量或 `null`**（`null` = 未设置；形状见 `commands/repo.rs:28`-`30` 的 `SettingValueResult`）。逻辑类型由注册表的 `kind` 决定，前端 `decodeSettingValue` 解码；Rust 侧 `decode_setting_value`（`:54`）只是**未指定 `kind` 时的保守兜底**，不会篡改字符串设置。
- **`scope = "repo"` 的设置项**按仓库隔离，键为 `{key}.{repoId}`；这类项的命令请求体**必须**带 `repoId`，其余项**不得**带（带了即忽略）。
- **插件设置键强制加前缀**：`plugin.<plugin_id>.`，由宿主拼接，插件不能自定义前缀（`docs/spec/settings-standard.md` 第 7 节）。
- **未知键**：`setting.set` 拒绝（`validation`），避免把 `app_settings` 当任意键值存储用。
- **插件项不满能力**时 `setting.set` 返回 `permission`；界面按注册表的 `requires_capability` 置灰。
- **✅ 四条规则于 2026-09 全部落地（宿主执行，不是前端自证）**。落点：`crates/hp-core/src/setting_registry.rs`（**注册表校验镜像** + `validate_setting_value` + `scoped_storage_key`，含单测）、`crates/hp-plugin-host/src/host.rs` 的 `PluginHost::find_setting_decl`（插件项按 manifest 反查）、`apps/desktop/src-tauri/src/commands/repo.rs` 的 `resolve_setting_target` / `ensure_setting_capability` / `prepare_setting_write`。
  1. **未知键拒绝** → `resolve_setting_target`：宿主/面板项取镜像，插件项取 manifest 声明，都没有即 `validation`（"未知设置键"）；
  2. **按 `kind` 校验** → `validate_setting_value`：`switch`/`checkbox` 要布尔、`numberInput`/`slider` 要数值、`textInput` 要字符串、`select` 必须命中声明里的 `options`（**空 `options` 的 `select` 直接拒绝**——无法校验的枚举等于没有约束）；`null`/数组/对象一律拒绝（同 D32）；
  3. **插件项 `permission`** → `ensure_setting_capability` 用 `PluginHost::check_capability` 校验 `requires_capability`；**失败关闭**——拿不到 `repoId` 就无法判定该仓库的授权，同样返回 `permission`，不放行；
  4. **仅 `scope = "repo"` 项拼 `repoId`** → `scoped_storage_key`：`app` 项**忽略**传入的 `repoId`（原实现对任意键都拼，已删除），`repo` 项缺 `repoId` 即 `validation`（否则会静默写到应用级键上，跨仓库串值）。
- **注册表的权威声明仍在 TS，Rust 只镜像"校验所需事实"**（id / owner / kind / scope / options / requires_capability，**不含文案**）：D80 已裁决注册表不做成命令，但上面四条必须由宿主执行；镜像与 TS 声明的一致性由 `pnpm check:settings` **逐项断言**（宿主项 ↔ `SYSTEM_SETTING_DECLS`、面板项 ↔ `panelSettingDecls()`、以及"无多余声明"的反向断言），漂移会被门禁当场拦下。
- **两处**尚未落地**（如实记录，不属上面四条）**：
  1. 插件 `select` 设置项的 **`options` 尚未在 manifest 侧解析**（`PanelSettingDecl` 无该字段），因此宿主对插件 `select` 只能校验"是字符串"，**不假装**校验了枚举归属；TS 侧已按 D80 要求把 `select` 缺 `options` 判为硬错误。
  2. `setting.list` 仍返回**全部** `app_settings` 行（含 `repo.default` / `blueprint.currentLayer.*` 等宿主内部键）；界面按注册表挑选自己要用的行。
- 设置变更**不广播**仓库级事件（不触发蓝图/布局对账）；仅在同一窗口内以 `setting.changed` 通知「全部设置」界面自身刷新。

### 3.14 `panel.*`（**2026-09 裁决：不设命令组**）

本节原声明两条只读命令 `panel.registry` / `panel.settings`。**经 2026-09 裁决，二者均不实现为 Tauri 命令**，理由与 `setting.registry` / `setting.search` 同源（见 3.13 规则第一条）：

- **面板注册表是声明式数据**：宿主内置 13 项在 `packages/config/src/panels.ts`（`BUILTIN_PANEL_SPECS`），插件项经既有 `plugin.contributions` 命令到达前端并登记进注册表。做成命令必须在 Rust 侧重新推导同一份数据。
- **面板设置项 = 声明（TS）+ 当前值**：声明在面板 `settings[]`，当前值由 `setting.get` / `setting.list` 取。属前端组合，不需要专用命令。

| 原声明 | 裁决 | 前端落点 |
| --- | --- | --- |
| `panel.registry` | **非命令**（前端 API） | `packages/config/src/panels.ts`（`allPanels` / `panelSpec`）+ `apps/desktop/src/app_ui/core/panelRegistry.tsx`（`allPanelDefs`） |
| `panel.settings` | **非命令**（前端 API） | `apps/desktop/src/app_ui/settings/settingsRegistry.ts`（按面板分组/分节） |

仍然成立的三条口径（与是否设命令无关）：

- **注册表随插件包存在，不落库**；按该仓库的插件启用状态过滤插件项（未启用的项仍可见，但 `origin` 标注未启用，供界面置灰）。
- **控件 schema 不走本节**：面板内部的控件 schema 经控件标准的运行时通道获取（请求名 `ui.panel.schema`，D61；`docs/spec/control-standard.md` 第 2 节），两者不得混用。
- `has_class` 是「面板」与「类目」之间的唯一开关，蓝图属性面板据此过滤类目候选（`docs/spec/panel-standard.md` 第 5.1 节）。

> **`plugin.contributions` 才是跨层通道**：插件声明的面板/节点/设置分节经 `plugin.contributions`（阶段 4 新增）送到前端，由 `apps/desktop/src/app_ui/core/pluginRegistryHost.ts` 登记/注销三张注册表。**启用状态变化时以 `plugin.changed` 事件触发重建**。

### 3.15 `debug.*`（开发期诊断通道）

| 命令 | 用途 | 请求 | 响应 | 迁移状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `debug.log` | 追加一行诊断日志到应用数据目录 `debug.log` | `{ message }` | `{ ok, data: { ok: true } }` | **已包装** | 线上 `data` 是 `()`；无 `repoId`（不属于任何仓库）；写盘失败 → `io`。**2026-09 最后一批一并迁移**，桥接层至此不再有"把错误压成 String"的转换函数 |

**这是开发期诊断通道，不是业务命令**：打包运行（无 devtools）时前端据它把链路日志写进应用数据目录的 `debug.log`，文件位置固定、可直接查看，见 `docs/architecture/file-structure.md` 第「实现注意」节（`:250`、`:255`）。前端唯一的调用点是 `apps/desktop/src/app_ui/shared/blueprintRuntime.ts:91`（按需动态 `import` 后 `invoke`），**没有** `api/*.ts` 封装，因此不进前端命令封装的统计口径。

## 4. 事件目录

| 事件 | 载荷 |
| --- | --- |
| `scan.progress` | `{ taskId, sourceId, processed, total, phase, pausable }`（**2026-09 追加 `pausable`**：整源扫描为 `true`；**单文件 `file.reanalyze` 复用同一条事件**但为 `false`（没有暂停点）→ 浮窗据此不渲染暂停按钮。单文件分析的进度帧是 `total = 0` = 总数未知 → 不定进度条） |
| `scan.completed` | `{ taskId, sourceId, indexed, changed, missing }` |
| `scan.error` | `{ taskId, sourceId, error }` |
| `source.unmount.progress` | `{ taskId, sourceId, phase, processed, total }`（**2026-09 补入**：正文 §3.2 与代码早就有它，本节此前**漏列**；`phase` ∈ `counting`/`syncRules`/`children`/`derived`/`files`/`source`，`total == 0` 表示该阶段总数未知（界面按不定进度显示）。发射点 `apps/desktop/src-tauri/src/commands/source.rs:353`，DTO `source.rs:90`；前端监听 `apps/desktop/src/app_ui/core/taskStore.ts`） |
| `source.unmount.completed` | `{ taskId, sourceId, cancelled, members, files, tags, ratings, colors, syncAlbums, childSources }`（**2026-09 补入**，同上：本节此前漏列。`cancelled` 为真时整个事务回滚、什么都没删；发射点 `apps/desktop/src-tauri/src/commands/source.rs:290`，DTO `source.rs:101`） |
| `source.unmount.error` | `{ taskId, sourceId, error }`（**完全卸载的终止失败事件**；发射点 `apps/desktop/src-tauri/src/commands/source.rs:297`（清理失败）与 `:307`（工作线程 panic 终止，`error` 固定为「卸载线程异常终止」），DTO `source.rs:111`；前端监听 `apps/desktop/src/app_ui/core/taskStore.ts:179`） |
| `file.changed` | `{ repoId, fileId, change: modified|renamed|moved }`（**保留在契约，标注"待 watcher 接线"**：2026-09 取证发现 `crates/hp-scanner/src/watcher.rs` 的 `SourceWatcher` **没有任何生产调用方**（只有自己的单测），桥接层从不启动监听——所以这三条一直没实现**不是缺 emit，是缺接线**。D9/M2 本来就要求"实时监听 + 定期全量校验兜底"，因此**不从契约撤下**） |
| `file.missing` | `{ repoId, fileId }`（同上，待 watcher 接线） |
| `file.restored` | `{ repoId, fileId }`（同上，待 watcher 接线） |
| `album.sync.progress` | `{ taskId, albumId, added, removed, pinned }` |
| `album.sync.conflict` | `{ taskId, albumId, fileId, reason }`（**逐文件冲突**，2026-09 按缺陷 0004 归位：**一个冲突成员一条事件**，`fileId` 是**真实**成员 ID、不再有空串；`reason` 是稳定原因码——当前只有 `pinned_kept`（成员已被用户固定，`mirror` 本应移除却保留）。语义依据 RFC 0002「`mirror` 可能移除用户以为还存在的成员，需要 UI 明确提示」；同步**本身成功**，只是某些成员没被移除。发射点 `apps/desktop/src-tauri/src/commands/album.rs:328`-`341`，逐文件明细由 `crates/hp-album/src/sync.rs:104`-`107` 产出（`SyncConflict`）；前端监听 `panels/TaskPanel.tsx`、`test_ui/panels/AlbumPanel.tsx`） |
| `album.sync.failed` | `{ taskId, albumId, error }`（**整体失败**，2026-09 按缺陷 0004 **新增**：相册不存在 / 无同步规则 / 固定型相册 / 库错误等，与"单文件冲突"分开，避免两种语义挤在同一个事件名里。发射点 `apps/desktop/src-tauri/src/commands/album.rs:344`-`353`（DTO `AlbumSyncFailedEvent`）；前端监听 `panels/TaskPanel.tsx`（i18n 键 `task.albumSyncFailed`）） |
| ~~`task.progress`~~ | ~~`{ taskId, percent, message }`~~ **2026-09 裁决：从契约撤下**。理由：**语义与既有事件重叠**——分阶段进度已由 `scan.progress` / `source.unmount.progress` 承担，再设一条通用 `task.progress` 需要每个长任务同时维护两套进度口径；`task.status` 命令也已提供按 `taskId` 的查询。**不实现空事件**（"为了对齐数字补发射点"是本契约明确拒绝的做法） |
| ~~`task.cancelled`~~ | ~~`{ taskId }`~~ **2026-09 裁决：从契约撤下**。理由：取消已并入既有终止事件的 `cancelled` 字段（`scan.completed.cancelled` / `source.unmount.completed.cancelled`，见 §5），单独一条事件会与"取消不是错误"的口径重复；`docs/architecture/command-event-drift.md:263` 当时就据此把它记为"仅文档" |
| `plugin.loaded` | `{ pluginId, repoId }`（**2026-09 补发射点**：`plugin.load` 成功后广播（`apps/desktop/src-tauri/src/commands/plugin_lifecycle.rs:178`（调用点），发射点 `emit_plugin_loaded` `:75`）；失败是命令级错误，**不**伴随本事件。语义是**生命周期骨架**的"加载完成"（校验通过 + `LoadOutcome` 产出），**不代表**常驻进程已拉起——那属 `external-process` 监督（仍未实现）。前端监听 `apps/desktop/src/app_ui/panels/PluginPanel.tsx`：任何窗口加载完插件后刷新列表与启用状态） |
| `plugin.error` | `{ pluginId, repoId, error }`（**控件 schema 运行时通道失败事件**，2026-09 落地：超时 / 输出超限 / 协议错 / 入口缺失时广播，语义是「**该面板**渲染错误态，其它面板不受影响」（`docs/spec/control-standard.md` 第 2 节）。发射点 `apps/desktop/src-tauri/src/commands/plugin_control_channel.rs:26`（`emit_plugin_error`），调用点 `plugin_panel_schema`（`:221`）。`error` 是**诊断串**：前端不得直显，界面文案按命令响应里的结构化 `code` 走 i18n（D27/D76）） |
| `plugin.changed` | `{ repoId }`（**RFC 0010 阶段 4 新增，2026-09 入册**：**插件启用/禁用**后广播，前端据此**重建三张注册表**的插件部分，蓝图里由该插件注册的面板与节点类型随之「未接通」或自动恢复。注册项**不落库**，故事件只带"哪个仓库的启用状态变了"；发射点 `apps/desktop/src-tauri/src/commands/plugin_lifecycle.rs:57`，调用点 `:108`（enable）与 `:130`（disable），已带 `rename_all = "camelCase"`，符合 D77；监听 `apps/desktop/src/app_ui/core/AppUiApp.tsx:171`）<br>⚠️ **"安装后"不广播**（2026-09 对账更正）：`plugin_install_local`（`commands/plugin.rs:116`）与 `plugin_install_bundled`（`:271`）都**没有** `emit_plugin_changed` 调用点。功能上无缺口——刚安装的插件尚未按仓库启用，其注册项本就缺席；但**契约原文曾写"启用/禁用/安装后"，与实现不符，已改**。若日后要求"安装后立即刷新插件列表"，需在安装路径补发射点 |
| `blueprint.changed` | `{ repoId, blueprintId }` |
| `setting.changed` | `{ key }`（RFC 0010 决策 7：「全部设置」界面自身刷新用；**不参与**蓝图/布局对账） |
| `ai.tagging.completed` | `{ taskId, fileId, tags, confidence, sourceModel, generatedAt }`（**保留在契约，但 2026-09 裁决：暂不补发射点**。理由：`ai.tagging.run`（`apps/desktop/src-tauri/src/commands/ai.rs:168`）当前用的是 `PlaceholderProvider`（`:54`），其 `tag_image` **返回空候选**（`:64`-`65`）——现在发射这条事件等于**报一个什么都没标成的"完成"**，并给 `confidence` / `sourceModel` 填无意义的值。**待接入真实推理提供方（外部进程插件）后再补**。） |
| ~~`media.ready`~~ | ~~`{ sessionId, durationMs, videoInfo }`~~ **2026-09 裁决：从契约撤下（休眠）**。理由：与 `media.ended` / `media.crashed` 同批——`media.*` 命令、`embed_window.rs` 与 `hp-media` 播放器路径随缺陷 0001 改用 DOM `<video>` 而**退役休眠**（`docs/issues/0010`），主界面 0 处调用。**保留在契约里会让人以为视频播放事件可用**；真要复活播放器时按新方案重新入册。休眠代码的整体处置见 `docs/architecture/implementation-status.md` §2.7 #13 |
| ~~`media.ended`~~ | ~~`{ sessionId }`~~ **2026-09 裁决：从契约撤下（休眠）**，同上 |
| ~~`media.crashed`~~ | ~~`{ sessionId? }`~~ **2026-09 裁决：从契约撤下（休眠）**，同上 |
| `media.surface.click` | `{}`（空载荷）（**2026-09 补入并标注为休眠**：它由 **Rust** 发射——`apps/desktop/src-tauri/src/embed_window.rs:71`，属已退役的 libmpv 原生窗口路径（缺陷 0001 改为 DOM `<video>` 后退役，见 `docs/issues/0010`）。前端 `apps/desktop/src/app_ui/shared/types/events.ts:10` 有类型声明但**主界面 0 处监听**；`media.*` 的休眠处置见 `docs/architecture/implementation-status.md` §2.7 #13） |
| `color.extracted` | `{ taskId, fileId, palette }` |

> **目录完整性订正（2026-09）**：本表此前**漏列两条已实现事件**——`source.unmount.progress` 与 `source.unmount.completed`（正文 §3.2 有、代码也发射，只有本表没列）。已补入，并另补 `media.surface.click`（Rust 发射、属休眠路径）。因此**本表条目数由 22 变为 24**（+2 已实现）+ 1 条休眠事件；`docs/architecture/implementation-status.md` §2.7 #13 的基数随之订正。
>
> **10 条缺口的逐条裁决（2026-09，用户拍板）**：**撤下 5 条**——`task.progress` / `task.cancelled`（与既有进度/取消口径重叠）、`media.ready` / `media.ended` / `media.crashed`（随 `media.*` 退役休眠）；**补 1 条发射点**——`plugin.loaded`（`plugin.load` 已存在）；**暂不补 1 条**——`ai.tagging.completed`（占位提供方返回空候选，现在发射等于报假事件，待真实推理提供方）；**保留 3 条并标注"待 watcher 接线"**——`file.changed` / `file.missing` / `file.restored`（`SourceWatcher` 无生产调用方）。
>
> **撤下的条目一律划掉而不删行**，以便追溯"曾经声明过、为何撤下"。

> 按 D77，事件载荷的字段名在本契约中**一律 camelCase**；**2026-09 已全部落地**——所有事件 DTO 均带 `#[serde(rename_all = "camelCase")]`，前端 `shared/types/events.ts` 与全部监听点同为驼峰，由 `pnpm check:commands` 双向守护（缺陷 0009 已修复；逐条差异见对账报告，本文不展开清单）。

## 5. 长任务与取消

- 所有长任务（扫描、同步、AI 打标、备份）必须发出进度事件并支持取消。
- 扫描/索引任务支持暂停与恢复（路线图 M2）。
- 取消语义：已提交事务保持原子性，未执行部分停止；部分完成结果通过事件上报。

## 6. 权限与错误边界

- 参数校验失败返回 `validation`，不进入核心 crate。
- 插件越权调用返回 `permission` 或 `plugin`，并记录事件。
- 核心域权限不足返回 `permission`；资源不存在返回 `not_found`。
- 真实文件系统错误返回 `io`；状态竞争返回 `conflict`。

## 7. 实现期开放点（非架构决策）

- 分页参数与游标具体格式（`cursor` 类型）。
- 缩略图请求形状与缓存键。
- `filter` 查询的具体 DSL。
- 进度事件推送频率与批量策略。
- `plugin.{pluginId}.{action}` 命令请求体的细化字段。
