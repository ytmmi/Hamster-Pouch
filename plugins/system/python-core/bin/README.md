# bin/

`python-core.exe` 是**本地构建产物**，不入库（见 `.gitignore` 的 `plugins/**/bin/*.exe`）。

构建：

```
cargo build -p hp-plugin-host --bin python_core --release
cp target/release/python_core.exe plugins/system/python-core/bin/python-core.exe
```

`plugins/system/python-core/plugin.manifest` 的 `entry` 指向 `bin/python-core.exe`；源码在 `crates/hp-plugin-host/src/bin/python_core.rs`。随包分发由 `tools/package-build.mjs` 负责（缺启动器即打包失败）。
