# 控件通道示例插件（`control-demo`）

**用途**：真机验收**控件受控取数通道**（`docs/spec/control-standard.md` 第 5 节）与
**控件事件回传链**（第 6 节）。它是本仓库唯一一个"面板能真正拿到数据"的插件——
`plugins/system/palette` 与 `plugins/examples/hello` 都只随包分发清单、**没有可执行入口**，
打开它们只会得到错误态。

## 这个面板覆盖了什么

| 控件 | `bind` | `returns` | 事件 |
| --- | --- | --- | --- |
| `list`（`items`） | `panel:items` | `rows` | `click` → `apply`、`double_click` → `pick` |
| `progress`（`count`） | `panel:count` | `scalar` | — |
| `keyValue`（`summary`） | `panel:summary` | `object` | — |
| `notice`（`empty_hint`） | — | — | 带 `visible_when`（`panel:items` 为 `empty` → **本次为假，不显示**） |
| `notice`（`nonzero_hint`） | — | — | 带 `visible_when`（`panel:count` 为 `truthy` → **本次为真，显示**） |
| `button`（`pick`） | — | — | `click` → `pick` |

两个 `visible_when` **一真一假**：这样"谓词确实拿到了数据并求值"是可判定的——
两提示都显示或都不显示，都说明谓词没接上数据。

三种 `returns` 各有一个绑定——缺一种，那条形态就测不到。

## `bin/control-demo.exe` 不在仓库里（有意）

与 `external-cli/mpv` 同理：**可执行文件不入库**，需要本地构建一次。它的源码就是
测试夹具 `crates/hp-plugin-host/src/bin/fake_panel_plugin.rs`（同一份代码既当
`tests/` 的被测对端，也当本示例——这样"示例能跑"与"测试通过"不会各说各话）。

```powershell
# 在仓库根目录执行
cargo build -p hp-plugin-host --bin fake_panel_plugin --release
New-Item -ItemType Directory -Force plugins\examples\control-demo\bin | Out-Null
Copy-Item target\release\fake_panel_plugin.exe plugins\examples\control-demo\bin\control-demo.exe
```

> `crates/hp-plugin-host/tests/m7_panel_data.rs` 里有一条
> `demo_schema_passes_the_real_validator_with_the_demo_manifest_declarations`：
> 它用 hp-core 的**真校验器**复算本插件的 schema 与上面这份 `data_queries` / `events`
> 声明是否对得上。**改任一侧都要同时改另一侧**，否则真机上表现为"面板打不开"，
> 而那很容易被误判成取数通道坏了。

## 怎么装

1. 插件面板 → **选择文件夹** → 选本目录（`plugins/examples/control-demo`）→ **安装**。
2. 在目标仓库里**启用**并授权 `ui.panel`。
3. 打开面板「控件通道示例」。

信任等级恒为 `local-dev`（来源由宿主判定，manifest 自称无效——RFC 0009）。
