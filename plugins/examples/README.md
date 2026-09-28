# examples 插件

插件示例与接口夹具，不放核心逻辑。

## 内容

- `hello/`：最小 external-process 插件示例（本地路径安装，`local-dev` 信任等级），
  声明 `ui.panel` + `repo.read`，用于验证宿主校验、按仓库启用与能力授权流程。
  **注意：它没有 `bin/hello.exe`**，打开其面板只会得到错误态（"入口不存在"降级）。
- `control-demo/`：**控件通道**示例（受控取数 `ui.panel.query` + 事件回传），
  面板真的会出数据（`rows` / `object` / `scalar` 三种 `returns` 各一个 `bind`，
  另带一个 `visible_when` 与两个事件）。它是**真机验收控件通道的唯一可用插件**，
  但同样**没有 `bin/control-demo.exe`**——可执行文件不入库，构建办法见该目录的 README。

示例插件只通过宿主 API 访问数据，不直接访问数据库或文件系统（RFC 0004）。
本地路径安装的信任等级固定为 `local-dev`，manifest 不得自称来源（RFC 0009）。
