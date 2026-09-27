# bin 目录

本目录放置插件外部进程入口（`entry` 指向的可执行文件）。

示例插件不随仓库提交二进制产物；`plugin.manifest` 中的 `entry` 仅声明预期路径，
真实构建产物由插件作者提供或由打包流程生成。

## 本地联调控件 schema 运行时通道

宿主按 `ui.panel.schema` 向插件子进程发**一行** JSON-RPC 请求、读**一行**响应
（2s 超时 / 256 KiB 输出上限，见 `docs/spec/control-standard.md` 第 2 节）。
`hp-plugin-host` 自带一个实现该协议的**测试夹具**，可直接拿来跑通「安装 → 启用 →
面板真实渲染」整条链路：

```powershell
cargo build -p hp-plugin-host --bin fake_panel_plugin
Copy-Item target/debug/fake_panel_plugin.exe plugins/examples/hello/bin/hello.exe
```

之后在「插件」面板安装 `plugins/examples/hello`、按仓库启用并打开该面板即可。
夹具的应答内容由 `HP_SCHEMA_FIXTURE_MODE` 选择（`ok` / `rpc_error` / `huge` /
`slow` / `garbage` / `silent`），可用于手工复现超时与超限的错误态。

**注意**：`bin/*.exe` 不入库；这一步只是开发期联调，不是发布流程。
