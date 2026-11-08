# Python 核心

以 system 插件形态提供 Python 运行环境，使 **Python 插件可以源码分发**——Python 源码即产物，用户侧无需编译（RFC 0009 决策 2 / D39）。

本插件是**宿主基础设施**：它不提供任何面板、蓝图节点或设置项，只为宿主提供「拉起 Python 插件」的能力。装好即用，不要求按仓库启用。

## 形态

- `runtime.kind = external-process`，入口 `bin/python-core.exe`（本地构建产物，不入库）。
- 声明 `native.code`：本插件自身即原生程序，并随包携带原生解释器。
- 原生依赖（D43）：`runtime/python.exe`、`runtime/python314.dll`、`runtime/python314.zip`；随包校验，缺失即拒绝加载。
- `contributions` / `data_queries` / `events` 均为空：它不对宿主贡献任何扩展点。
- `trust.requested = system`：随应用安装包分发、跟随应用版本，需主线仓库构建人员签名（D40）。来源不由 manifest 声明（RFC 0009）。

## 宿主如何使用它

宿主**不**直连 `runtime/python.exe`，而是在每次需要 Python 形态插件的查询时执行：

```
bin/python-core.exe --run <插件版本目录>/<entry>
```

由本插件负责：按自身 exe 位置定位随包解释器、把解释器与插件脚本绑进 Job Object（宿主 kill 本进程时解释器不残留）、以插件版本目录为工作目录、stdio 直通（一行进一行出，与其它 external-process 插件同一协议）。

Python 插件自身默认 `community`（安装后可提升），按仓库启用与能力授权照常校验，不因其为脚本而放宽；每插件独立进程。

## 获取与构建

| 产物 | 命令 |
| --- | --- |
| 解释器（`runtime/`） | `node tools/fetch-python-runtime.mjs`（URL + SHA256 固定在 `tools/python-runtime.lock.json`，摘要不符即拒绝解压） |
| 启动器（`bin/python-core.exe`） | `cargo build -p hp-plugin-host --bin python_core --release` 后复制到 `bin/python-core.exe` |
| 签名（`SHA256SUMS` + `.sig`） | `node tools/sign-plugin.mjs plugins/system/python-core` |

运行期不联网（D20）：解释器随应用安装包分发，不经由用户系统 Python，也不在运行期下载。

## 参照

- `docs/rfc/0009-plugin-distribution.md`：分发通道、签名、Python 核心要求。
- `docs/rfc/0004-plugin-system.md`：「Python 核心」一节。
- `docs/architecture/decision-checklist.md`：D20（依赖内化）、D39（Python 核心）、D40（system 签名）、D43（原生依赖声明）。
