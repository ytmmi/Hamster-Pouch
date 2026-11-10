# RFC 0012：程序自更新（exe 原地替换 + 资产变更提示整包）

状态：正式草案。本文落实用户 2026-11-10 确认的口径，**只定义设计，不含实现**。实现落地前，
「关于」页仍是 D140 的形态：只有一次 `fetch` 检查 + 「去 GitHub 更新」跳 Release 页，
用户手动整包替换。

用户确认的三条口径：

1. **路线 = B（两种粒度并存）**：exe 单文件**原地自更新**（前端已烤进二进制，逻辑变更全在它里面）；
   `external-cli\` / `plugins\system\` / 内置基底词库有变更时**提示整包**，绝不在原地动这些文件夹。
2. **信任链 = manifest + sha256 入库**，由 CI 回写。**不引入代码签名**（证书成本 + 便携形态无安装器验签环节）。
3. **HTTP 客户端 = `ureq` + `native-tls`**：阻塞式 + 一个后台线程，走 Windows Schannel（系统证书库），
   不把 tokio 拖进一个纯桌面应用。这条推翻了 `docs/spec/commands-events.md:620` 的既有理由，
   那条注释在实现落地时必须同时改写。

## 1. 现状（实现前的事实基线）

| 事项 | 事实 | 锚点 |
| --- | --- | --- |
| 发布形态 | 便携文件夹，不是安装器：`tauri build --no-bundle` + 打包脚本手工铺 `data\system\` | `package.json:13`、`tools/package-build.mjs` |
| 产物 | `release\` 总 391 MB；exe 49,016,832 B；`external-cli\` 288 MB；`plugins\` 23 MB；`data\` 35 MB | 实测 `apps/desktop/src-tauri/target/release/release/` |
| 版本号 | `0.1.13-Alpha`，三处同源（`tauri.conf.json` / `Cargo.toml` / `package.json`），由 `tools/version.mjs` 读写；`pnpm app:build` 第一步自动 patch+1 | `tauri.conf.json:4`、`apps/desktop/src-tauri/Cargo.toml:3` |
| 现有更新能力 | 只有「发现」：前端直连 `api.github.com/repos/ytmmi/Hamster-Pouch/releases?per_page=100`，10 s 超时，纯函数判三态 | `apps/desktop/src/app_ui/settings/aboutUpdate.ts:172`（`RELEASES_API_URL`）、`:176`（`FETCH_TIMEOUT_MS`）、`:110`（`pickLatestRelease`）、`:151`（`evaluateUpdate`） |
| 关于页 | 状态文案 + 「检查更新」/「去 GitHub 更新」按钮 + `ui.autoCheckUpdate` 开关 | `apps/desktop/src/app_ui/settings/AboutPanel.tsx:27,111-116,193,218-224` |
| 数据住址 | `<exe 同目录>\data\`：`system\`（全局库 + 基底词库）、`user\`（每仓库一个库 + 封面）、`plugins\`、`thumbnails\`、`debug.log` | `apps/desktop/src-tauri/src/main.rs:87`（`resolve_data_dir`）、`commands/shared.rs:176-182`（`app_data_root`） |
| 启动/退出 | `main()` 里 `.plugin(dialog)` → `.setup` → `manage(state)` → `generate_handler!` → `.run(...)`；**没有 `RunEvent` 钩子** | `main.rs:120-358`（`:123` plugin、`:124` setup、末尾裸 `.run`） |
| 进程模型 | **无单实例锁**：双击图标会起第二个进程，两个进程抢同一个 `data\` | 全仓无 `single-instance` 依赖 |
| HTTP | `apps/desktop/src-tauri/Cargo.toml` 里**没有任何 HTTP 客户端**；`ureq` / `reqwest` 均未出现 | `commands-events.md:620` 把这一点当作「检查更新不走 Rust」的理由 |
| 发布链路 | 手动 `workflow_dispatch` → `pnpm app:build` → fail-closed 自检（exe / ffmpeg / mpv / plugins/system / 基底词库，mpv ≥ 50 MB 防 LFS 指针）→ `7z -mx=3` 打整夹 zip → `gh release create/upload --clobber` | `.github/workflows/release.yml` |
| 整包内容 | zip 里的 exe 就是 `target\release\` 那份被**复制**进去的同一个文件 | `tools/package-build.mjs:486`（`await cp(EXE, join(relDir, "hamster-pouch-desktop.exe"))`） |
| 前端可执行面 | `csp: null`：将来任何一处 XSS 都能在 WebView 里跑任意脚本 → 能调任意 IPC 命令 | `tauri.conf.json:23` |

五个已暴露的问题：

1. **只能发现、不能落地**：`outdated` 只给一个跳转链接，用户得自己找对文件夹、自己覆盖，还得先关程序。
2. **数据住在程序目录里**：`data\` 混着**该换的程序资产**（`tag_lib_base.sqlite3`）和**绝不能覆盖的用户数据**
   （`user\`、`plugins\`、`thumbnails\`、全局库）⇒ 整夹替换必须 fail-closed 白名单；这也是不能直接用
   `tauri-plugin-updater` 的根因（它在 Windows 只认 NSIS/MSI，等于改产品形态）。
3. **没有失败兜底**：无单实例、无退出钩子、无回滚材料。替换时 MCP 子进程与 mpv 可能还挂着文件。
4. **匿名 API 限流**：`api.github.com` 匿名 60 次/小时/IP，开机自动检查很容易撞，撞了就是 `error` 态。
5. **D140 的理由行会被推翻**：`:620` 那段「不改状态、不必为它引 HTTP 客户端」在自更新落地后不再成立。

> 溯源：D139（`docs/architecture/decision-checklist.md`）已确立「迁移后旧 exe 读不了新库 ⇒ 整包替换、
> 不新旧混跑」；本文的 exe 原地替换**必须**在同一口径下成立——见决策 6 的「迁移声明」。

## 2. 目标模型

### 决策 1：两种粒度，一条判定规则

| 变更内容 | 更新方式 | 判定依据 |
| --- | --- | --- |
| 应用逻辑 / 界面 / 命令（前端已烤进二进制） | exe 原地替换 | 版本号变化 |
| `external-cli\`（ffmpeg / mpv）、`plugins\system\`、`data\system\tag_lib_base.sqlite3` | **提示整包**，只给 Release 页链接 | `assets_rev` 不等 |

**只有一条规则**：`manifest.assets_rev !== 本地 assets_rev` ⇒ 该版本必须整包，不下载 exe。
不设第二个开关（例如手写的 `requires_full_package`）——两套真相必然漂移。

`data\user\`、`data\plugins\`、`data\thumbnails\`、全局库**永远不在任何自动更新的写集合里**。

### 决策 2：事实源 = 仓库根 `latest.json`

放仓库根、走 `raw.githubusercontent.com`，而不是 Release 资产或 REST API，三个理由：
不走 API 限流；走 CDN；**它在 git 历史里**——哈希的信任锚点才成立（改了要留痕）。

```json
{
  "schema": 1,
  "version": "0.1.14-Alpha",
  "published_at": "2026-11-10T12:00:00Z",
  "exe": {
    "url": "https://github.com/ytmmi/Hamster-Pouch/releases/download/v0.1.14-Alpha/hamster-pouch-desktop.exe",
    "size": 49016832,
    "sha256": "<64 位小写十六进制>"
  },
  "full_package": {
    "url": "https://github.com/ytmmi/Hamster-Pouch/releases/download/v0.1.14-Alpha/Hamster-Pouch-v0.1.14-Alpha-Windows-x64-Portable.zip",
    "sha256": "<64 位小写十六进制>"
  },
  "assets_rev": "<16 位小写十六进制，见决策 4>",
  "migrations": true,
  "notes_url": "https://github.com/ytmmi/Hamster-Pouch/releases/tag/v0.1.14-Alpha"
}
```

- `exe.sha256` 与 zip 里那份 exe 同源（`package-build.mjs:486` 复制的是同一个文件）⇒ **一个哈希管两处**。
- `full_package` 只用于**展示与人工核对**（「去 GitHub 更新」时告诉用户该下哪一个），v1 不自动下载。
  包名由 `tools/artifact-name.mjs` 统一提供（`Hamster-Pouch-v<version>-Windows-x64-Portable.zip`，D153），
  manifest 里的 URL **必须与之逐字一致**——两边各写一次名字，正是最容易悄悄错开的地方。
- **发布顺序是硬约束**：先传 Release 资产、后提交 `latest.json` 的改动。反过来的话用户会拿到 404 →
  落 `error` 态（fail-closed，不会误判「已是最新」），但会白白放出一批检查失败。
- CDN 缓存有分钟级延迟，新版本不保证立刻可见。这可以接受：检查失败不折叠成「已是最新」。
- 新增一个发布资产：**裸 exe**（`dist\hamster-pouch-desktop.exe`）。现在只上传整夹 zip，这是 B 路线的前提。

### 决策 3：信任链的边界（无签名能做到什么，做不到什么）

能防：传输篡改、半截文件、CDN 污染、Release 资产被替换（只要 manifest 没同步改，哈希对不上）。
**防不了**：仓库被接管（攻击者同时改 manifest 与资产）。这是不引入代码签名的**已知代价**，
缓解手段只有「manifest 在 git 历史里」——事后可审计、可追责，但拦不住当时。

实现上再加三条不依赖信任的硬约束：

1. 只接受 `https`，主机必须是 `github.com`，路径必须以 `/ytmmi/Hamster-Pouch/releases/download/` 开头。
2. 允许 GitHub 的 302 跳转（真实资产落在 `objects.githubusercontent.com`）；跳转目标**不**校验，
   因为**哈希是钉死的**——跳到别处也拿不到能过校验的字节。
3. 校验不通过一律删掉已下载内容，不产生可执行文件。

### 决策 4：`assets_rev` 由内容派生，不手写

手写日期/版本号一定会忘。改为**内容指纹**：

```
assets_rev = sha256( sorted("<相对路径>:<字节数>:<sha256>\n" for each asset) )[0..16]
```

覆盖：`external-cli/**`、`plugins/system/**`、`data/system/tag_lib_base.sqlite3`。
只纳入路径、字节数、内容哈希——不纳入 mtime、不纳入 `BUILD-INFO.txt`。

- **写入方**：`tools/package-build.mjs` 在铺完发布包后计算一次，写到 `<exe 同级>\data\system\assets-rev.txt`
  （随包发布；`pnpm app:package` 单独重跑也会刷新）。
- **读取方**：客户端只在**下载前**读一次这个文件，再算一份自己的指纹比对。**不在 `update.check` 里算**——
  对 324 MB 做哈希要秒级，不能拖住一次开机检查。
- 开发构建（`cargo build` / `tauri dev`，没跑过 `package-build`）没有这个文件 ⇒ 视为「未知」，
  跳过比对、界面标注「开发构建」，不误报整包。
- 比对口径是**不等即提示**，不分新旧方向：本地比 manifest 新（用户手工换过资产）同样提示整包。

### 决策 5：前端不得提供 URL 与哈希

`csp: null`（`tauri.conf.json:23`）意味着一次 XSS 就能调任意命令。如果 `update.download` 接受前端传入的
`url + sha256`，攻击者传自己的地址和自洽的哈希即可让应用「下载并安装任意 exe」——校验形同虚设。

因此：

- manifest 地址、主机白名单、`sha256` 的**来源**全部写死在 Rust（`include_str!` 或常量）。
- 前端能做的只有：`update.check()`、`update.download()`、`update.apply()`、`update.rollback()`，
  **参数里没有任何地址**。
- 版本比较的权威随之收到 Rust；`aboutUpdate.ts` 的 `parseReleasesJson` / `pickLatestRelease` /
  `evaluateUpdate` / `checkForUpdate` 退役（决策 12 给出退役范围）。

### 决策 6：下载

- 目标：`data\updates\staging\hamster-pouch-desktop.exe.part`（与目标同卷，后续靠 `rename` 落地而非跨卷复制）。
- **续传**：`.part` 存在且非空时带 `Range: bytes=<n>-`；响应 206 追加、200 则从头重写。
  中断后重试最多 3 次，退避 1 s / 4 s / 10 s。
- **超时**：连接 15 s；读 30 s 无字节即判停滞中断；**不设总时长上限**（47 MB 在慢链路上不该被判失败）。
- **进度**：写盘的同时按 ≤4 次/秒发 `update.progress`，载荷 `{ received, total, phase }`。
- **校验**：下载完成后对**整个文件**重算 sha256（不复用流式中间值，续传路径才不会算错），
  再比 `size`。两者都对才 `rename` 成 `pending.exe` 并写 `data\updates\pending.json`。
- 25 MB 以下剩余空间直接拒绝（写满磁盘会把用户的库写坏，这条比「更新失败」严重得多）。

`pending.json`：`{ version, sha256, size, downloaded_at, assets_rev }`。

### 决策 7：落地状态机与 `--apply-update`

```
staging\*.part --sha256 ok--> staging\pending.exe + pending.json
pending.exe --(target → target.old; pending → target)--> target
```

替换由 **staging 里的新 exe** 执行：旧进程 spawn 它、自己退出，它等父进程结束后动手。
这样不需要单独分发一个 updater 二进制，也不用让旧 exe 认识新参数。

**参数与分流点**（全部用 `std` + 已有的 `windows` 0.61，不初始化 Tauri）：

```
hamster-pouch-desktop.exe --apply-update --parent-pid <n> --source <pending> --target <target>
```

分流位置：`main()` 的**第一行**之前（`fn main()` 内最先判断 `argv[1] == "--apply-update"`），
早于 `tauri::Builder`、早于 `resolve_data_dir`、早于任何 `.manage`。

**为什么必须在 state 之前**：apply 模式碰到的目标文件可能正是别的版本铺的目录，任何
`data\` 读写（日志、库、缩略图）都会在「程序文件正在被换掉」的窗口里制造第二个故障点。

helper 的序列：

1. `WaitForSingleObject(parent)`，30 s 超时仍活着则放弃并退出（不强制杀父进程）。
2. 删掉上一轮的 `target.old`；`rename(target → target.old)`。
3. `rename(pending → target)`；失败退避重试 3 次。
4. 任一步失败 ⇒ `rename(target.old → target)` 还原、写 `data\updates\last-error.txt`、拉起 `target`、
   `exit(1)`。
5. 成功 ⇒ 拉起 `target`（无参数，工作目录 = 程序目录）、进入决策 8 的看护、`exit(0)`。

### 决策 8：回滚 = 同一条流水线换源 + 一次最小时长看护

**回滚不是另一套代码**：把 `target.old` 复制成 `staging\rollback.exe`，再用同一个 `--apply-update`
跑一遍（`--source staging\rollback.exe`）。复制这一步是必需的，否则「`target → target.old`」会把回滚源覆盖掉。

**看护（为什么不是常驻健康探测）**：helper 拉起新 exe 后，轮询 `data\updates\apply-ok.json` 最多 **60 s**：

- 出现 ⇒ 删 `target.old`、删 `pending.json` 与 staging、退出（此刻更新才算完成）。
- 超时 ⇒ 杀掉刚拉起的进程 → 把 `target` 改名 `target.broken` → `target.old` 改回 `target` →
  重新拉起 → 写 `last-error.txt`（含「已自动回滚」）→ 退出。

`apply-ok.json` 由新 exe 在 `main()` 开头（**写任何日志之前**、创建窗口之前）写入，前提是
`pending.json` 存在——正常启动的日常点击也会写它，但那时没有 `pending.json`，会被忽略。

这条不是「健康探测」：不查库、不查网络、不等窗口起来，只证明「新 exe 跑到了 `main()`」。
误判代价小（回滚到已知可用版本，用户再点一次更新即可）；不做它的代价大——发一个起不来的版本，
用户面对的是一个闪退的程序和一个没人知道该改回名的 `.old` 文件。

被回滚后的残骸保留在 `target.broken`，等下一次成功更新时才删。

### 决策 9：单实例 + 退出钩子（前置件，独立于更新也成立）

- `tauri-plugin-single-instance`（**第一个**注册的 plugin）：第二实例聚焦第一实例后退出。
  没有它，「更新时用户又双击了图标」就是两个进程抢同一个 `data\`，D139 的「不新旧混跑」当场破防。
- `RunEvent::ExitRequested` / `Exit`：停内置 MCP 服务、停 mpv / ffmpeg 子进程、关库（让 WAL 落地）。
  现在 `main()` 末尾是裸 `.run(...)`（`main.rs:358` 附近），这些全靠 OS 兜底。

两者都先于更新逻辑落地，可独立验证。

### 决策 10：命令面与事件

| 命令 | 请求 | 响应 | 说明 |
| --- | --- | --- | --- |
| `update.check` | `{}` | `{ current, latest, state, notes_url, assets_rev, migrations }` | `state ∈ latest \| outdated \| full-package-required \| unavailable \| error`；**无参数** |
| `update.status` | `{}` | `{ phase, received, total, version, error }` | 重启后恢复界面（「已下载待安装」不该丢） |
| `update.download` | `{}` | `{ ok }` | 目标版本由 Rust 自己从 manifest 决定，不接受参数 |
| `update.apply` | `{}` | `()`（命令返回后进程即退出） | 需要 `pending.exe` 与 `pending.json` |
| `update.rollback` | `{}` | `()` | 需要 `target.old` |

事件：`update.progress` `{ received, total, phase }`（`phase ∈ downloading | verifying`）。

全部 `ApiResponse` 包裹，登记 `docs/spec/commands-events.md` §3；`check:commands` 会强制两侧一致。

### 决策 11：关于页状态机

`idle → checking → (latest | outdated | full-package-required | unavailable | error)`
`outdated` 下：`idle → downloading(p) → ready → applying`

- `outdated` 的主按钮从「去 GitHub 更新」变成「下载更新」，下载完成后变「重启并更新」。
- `full-package-required` 保留原有的「去 GitHub 更新」跳转，并**明确说出原因**：
  「此版本更新了随包组件（播放器 / 词库），需要整包替换」。
- `migrations: true` 时在确认弹窗里加一句「此版本会升级数据库，更新后无法用旧版本打开」，
  并要求二次确认（v1 不做自动快照，见 §6）。
- 自动检查的触发时机不变（打开关于页时一次），`ui.autoCheckUpdate` 语义不变。

### 决策 12：版本比较收口（D140 的退役范围）

迁移后保留：`parseVersion` / `compareVersions` / `isNewerVersion`（纯函数、可离线断言，若前端还有别的
调用点就留着），`UpdateState` 类型按决策 11 扩展。

退役：`parseReleasesJson`（`:79`）、`pickLatestRelease`（`:110`）、`evaluateUpdate`（`:151`）、
`checkForUpdate`（`:176` 之后那个 `fetch` 包装）、`RELEASES_API_URL`。

**代价要说清楚**：D140 的「从 100 个 release 里挑最大」那段离线断言随之消失；同时新增一个失败模式——
`latest.json` 忘了回写，用户就永远收不到更新，而且看起来和「已是最新」一模一样。
用发布期门禁兜住（§5 第 3 条），这是本文唯一新增的「静默失效」通道，必须配门禁。

### 决策 13：设置项不变，联网行为收窄

- **不新增设置键**：`ui.autoCheckUpdate` 继续只管「打开关于页时检查一次」；下载 47 MB 必须用户点。
  `crates/hp-core/src/setting_registry.rs` 与 `packages/config/src/settings.ts` 镜像不动。
- 已在预览、未安装的 `pending.exe` 在重启后仍在（`update.status` 能读回来），但**不会**在启动时自动应用——
  应用永远由用户点。

### 决策 14：`data\updates\` 是运行态，不进发布包、不进同步快照

- 布局：`updates\staging\*.part`、`pending.exe`、`pending.json`、`apply-ok.json`、`last-error.txt`、
  `assets-rev.txt`（在 `data\system\`）——全部可丢，丢了只是「得重新下载」。
- `tools/package-build.mjs` 铺发布包时**不得**复制 `data\updates\`；`tools/sync-user-data.mjs` 的快照
  也不包含它（拿一份过期的 `pending.exe` 去恢复毫无意义）。

## 3. 影响面（实现清单）

**Rust / 依赖**

- `apps/desktop/src-tauri/Cargo.toml`：新增 `ureq`（`native-tls` 特性）、`sha2`、`tauri-plugin-single-instance`；
  `windows` 的 features 补 `Win32_System_Threading`（`WaitForSingleObject` / `OpenProcess`）。
  依赖本地化纪律（D20）要求这些 crate 进 vendor 白名单，按既有流程补。
- 新增 `apps/desktop/src-tauri/src/updater/mod.rs`（manifest 解析、白名单校验、比较）、
  `updater/download.rs`（Range 续传 + 校验）、`updater/apply.rs`（`--apply-update` 最小模式，只用 std + windows）。
- `apps/desktop/src-tauri/src/commands/update.rs`：四条命令 + `update.progress` 事件。
- `main.rs`：`--apply-update` 分流（`fn main()` 第一行）、单实例 plugin、`RunEvent` 退出钩子、
  `app-ok` 标记写入、命令注册。
- `hp_media::hidden_command`：helper 的 spawn 必须走它（GUI 子系统下裸 spawn 会闪控制台窗口，
  `check:hidden-console` 会拒绝）。

**前端**

- `apps/desktop/src/app_ui/settings/aboutUpdate.ts`：按决策 12 退役与保留。
- `apps/desktop/src/app_ui/settings/AboutPanel.tsx`：决策 11 的状态机与按钮。
- `apps/desktop/src/app_ui/shared/api/update.ts`（新）：四条命令的封装、`update.progress` 订阅。
- 三语 `i18n/{zh-CN,zh-TW,en}.ts`：新增约 12 个键（状态文案、整包原因、迁移警告、下载进度、确认弹窗）。

**工具与 CI**

- `tools/package-build.mjs`：算 `assets_rev` 写 `data\system\assets-rev.txt`；排除 `data\updates\`。
- `.github/workflows/release.yml`：
  1. 上传裸 exe 资产；
  2. 计算 exe / zip 的 sha256 与 `assets_rev`；
  3. 生成并提交 `latest.json`（**放在上传资产之后**）；
  4. 提交前断言：`latest.json.version` 必须等于 `tauri.conf.json` 的 `version`；
  5. `full_package.url` 里的包名必须逐字取自 `node tools/artifact-name.mjs --version "$VERSION" --zip`
     （D153 的**唯一命名源**），不许在这里再手拼一次——两边各写一次名字，正是最容易悄悄错开的地方。
- 新增 `tools/check-manifest.mjs`（`pnpm check:manifest`）：schema 合法、URL 主机/路径在白名单内、
  `sha256` 形如 64 位十六进制、版本串可解析、`assets_rev` 形如 16 位十六进制。
  本地 CI 只做静态断言（本地构建的哈希与发布产物必然不同，不能比）。

**文档**

- `docs/spec/commands-events.md`：§3 新增四条命令（`:613` 附近的「关于」小节）；`:620` 那段
  「为什么版本事实… / 为什么「检查更新」没有命令」要重写，不能留着自相矛盾的旧理由。
- `docs/architecture/decision-checklist.md`：实现落地时补 D 条（按现有编号续）。
- `docs/architecture/file-structure.md:730`（rfc 范围）。
- `docs/spec/database-schema.md`：**不动**（本文不新增表、不改库；`pending.json` 是文件不是库）。

## 4. 兼容、失败模式与回滚

| 失败点 | 现象 | 行为 |
| --- | --- | --- |
| manifest 拉不到 / 非 2xx / JSON 不合法 | 关于页 | `error` 态，**不**折叠成「已是最新」 |
| manifest 版本 ≤ 当前 | 关于页 | `latest` |
| `assets_rev` 不等 | 关于页 | `full-package-required`，不下载 exe |
| 下载中断 | `.part` 残留 | 下次续传；3 次退避重试后 `error` |
| sha256 / size 不符 | 校验失败 | 删 `.part`，`error`，不产生 `pending.exe` |
| 磁盘剩余 < 25 MB | 下载前 | 直接拒绝，`error` |
| `rename(target → .old)` 失败 | apply | 退避 3 次 → 还原 → `last-error.txt` → 拉起旧 exe |
| 新 exe 60 s 未写 `apply-ok.json` | 更新后 | 自动回滚到 `target.old`，残骸留 `target.broken` |
| 用户连不上网 | 全流程 | 与今天的失败形态一致：`error`，程序照常可用 |

**跨版本兼容**：exe 原地替换不改变 `data\` 的任何形状——但**新版可能迁移库**（`migrations: true`）。
迁移后旧 exe 读不了新库（D139），所以「回滚」只在**未发生迁移**时是安全的。这条必须在界面文案里说清：
`migrations: true` 的版本，回滚按钮置灰并注明「数据库已升级，无法回滚到旧版本」。

**回滚材料**：`target.old` 只保留到下一次成功更新；`target.broken` 保留到下一次成功更新。
**没有**「任意历史版本回退」——那需要保存多个旧 exe，属另一件事。

## 5. 验收标准

1. 门禁全绿：`pnpm check:commands`、`check:settings`、`check:hidden-console`、`check:version`、
   `check:line-count`、`check:encoding`、`check:doc-status`、新增 `check:manifest`、`cargo test`。
2. **端到端（核心验收）**：手工起一个本地 HTTP 服务冒充 `raw.githubusercontent.com`（改 hosts 或加测试用
   端点常量），跑通三遍：① exe-only 更新装好后版本号变化、`data\user\` 与 `data\plugins\` 字节不变；
   ② `assets_rev` 不等时只提示整包、不下载；③ 故意给一个坏 sha256，验证「删 `.part` + error」。
3. **失败路径**：把 `pending.exe` 换成一个立刻退出的假程序，验证 60 s 后自动回滚、程序仍可用、
   `last-error.txt` 有内容。
4. **发布门禁**：在 CI 上验证「忘记改 `latest.json` 的版本号」会让 release 工作流失败（这条是决策 12
   那个静默失效通道的唯一防线）。
5. **回归**：`ui.autoCheckUpdate` 关掉后打开关于页**不发任何请求**；开发构建（无 `assets-rev.txt`）
   不误报整包。

## 6. 不纳入本文（边界）

- **不自动下载 / 解压整包**：`full_package` 只用于展示与人工核对。侧载解压需要「解压到旁侧文件夹 + 让用户
  自己切过去」，那是另一个产品问题（快捷方式、数据搬家、旧夹清理），不在本轮。
- **不做扩展插件（`plugins-dist/*.zip`）的自动更新**：它们由用户手动安装，`data\plugins\` 不在写集合里。
- **不做增量 / 差分更新**：47 MB 的整包 exe 在现代网络上可以接受，差分要维护基线版本表，成本不划算。
- **不做更新通道（Alpha / Beta / stable）**：全部产物都带 `-Alpha`，后缀不参与比较（D140 口径不变）。
- **不引入代码签名**（见决策 3 的边界）。
- **不做更新前自动快照**：`migrations: true` 只做告知与二次确认。自动快照需要空间预算与清理策略
  （`data\user\repos\` 可能几十 MB 到 GB 级），单独开一件事做；在那之前迁移型更新仍是 D139 的口径——
  迁移前先 `node tools/sync-user-data.mjs` 留快照（开发机）。
- **不分发 updater 独立二进制**：apply 角色由新 exe 自己兼任（决策 7）。
- **不改便携形态**：不引入 NSIS/MSI，不使用 `tauri-plugin-updater`。
