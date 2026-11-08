# eCaptureQ 全新一代

**用 eCapture 采集，用 eCaptureQ 分析。** eCapture 负责采集与 TLS 解密，
eCaptureQ 连接它的 WebSocket 数据源，关联并展示应用消息。新版提供共享
分析界面的桌面版与 Web 版，支持 macOS、Windows 和 Linux。

产品关系概念图、中文下载、入门、数据源连接和界面截图见 [README](README.md)，
也可阅读[官网 eCaptureQ 介绍](https://ecapture.cc/q/zh/)。
开发者请阅读独立的 [编译指南](docs/compilation.md) 和
[开发指南](docs/development.md)，全部文档见 [文档索引](docs/README.md)。
从旧版开始使用新版，请先阅读 [新版使用与升级说明](docs/upgrade.md)。

旧 Tauri/Rust/React 实现、SQL 过滤、集成采集管理和 Android UI 不属于当前
版本；SQL 过滤将按新数据模型重新实现。此入口不再描述旧版行为。
