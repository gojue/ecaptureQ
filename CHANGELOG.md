# 更新日志

本文按版本倒序记录面向用户的主要变化，依据仓库标签、提交记录及实现整理。
历史版本日期采用对应标签的提交日期；预发布版本单独列出。`v0.x` 属于旧 Tauri
实现，其功能不代表当前版本仍然支持。

## v1.1.0 — 2026-11-13（待发布）

### 新增

- Web 可选用户名/密码登录：通过配置文件的 `auth` 启用，支持退出登录、会话过期和登录限速；新增 `ecaptureq-web --hash-password` 生成密码哈希。Desktop 不启用此认证。
- 启动时检查官方 GitHub Releases，发现更新的稳定版后在 Logo 附近显示入口；仅提示下载，不自动安装。
- 配置文件新增 `headerCenter` 页头富文本和 `hiddenDomains` 域名后缀过滤；命中的 HTTP 流量在入库前丢弃，省略或留空域名列表时沿用内置默认值。
- eCaptureQ Web 新增 Linux LoongArch（`loong64`）DEB/RPM 安装包；不包含 loong64 桌面版。

### 改进与修复

- 实时界面改用长轮询接收变更通知，仅在记录变化时重新获取当前页，减少空闲时的请求和重复查询；暂停仍只暂停界面刷新。
- 单条记录载荷截断上限由 256 KiB 提高到 256 MiB，减少较大消息的提前截断；WebSocket 消息大小和总缓存限制仍独立生效，并不保证可接收或保留 256 MiB 消息。
- 更新应用 Logo、平台图标、README 展示及截图；中英文切换改为一键切换。
- 修复浏览器冒烟测试的导航就绪竞态和 Chrome 退出后的 stderr 清理，提升 CI 稳定性。

### 升级注意

- **CLI 参数不兼容变更**：eCaptureQ 的 `--addr` 改为 `--listen`，`--ecaptureq` 改为 `--data-source`，旧名称不再接受。上游采集器 `ecapture` 的 `--ecaptureq` 参数不变。
- **配置格式不兼容变更**：`--sources` 文件由 JSON 数组改为对象。请将原数组放入 `sources` 字段，例如 `[]` 改为 `{"sources":[]}`，再按需添加页头、隐藏域名和 Web 登录配置。
- 未配置 `auth` 时 Web 仍免登录。随包提供的示例配置启用登录，公开初始账号为 `ecapture` / `ecaptureQ`，部署前请更换密码；默认安全 Cookie 需要 HTTPS，本机纯 HTTP 调试需显式设置 `auth.secureCookie: false`。

配置与部署细节见[使用参考](docs/reference.md)和[配置示例](config/sources.example.json)。
主要变更：[品牌更新 #64](https://github.com/gojue/ecaptureQ/pull/64)、[loong64 Web 包 #65](https://github.com/gojue/ecaptureQ/pull/65)、[功能与配置更新 #66](https://github.com/gojue/ecaptureQ/pull/66)、[浏览器测试 #67](https://github.com/gojue/ecaptureQ/pull/67)、[导航竞态修复 #68](https://github.com/gojue/ecaptureQ/pull/68)。

## v1.0.0 — 2026-11-08

本节汇总相对 v0.3.0 的主要变化，包含下方两个预发布版本的工作。

- 使用 Go + Wails v3 重写，提供共享分析界面的 eCaptureQ 桌面版和 eCaptureQ Web；使用官方 eCapture Protobuf 事件。
- 支持多数据源连接与重连、请求/响应关联，以及 HTTP/1.x、HTTP/2、HTTP/3、QUIC、MySQL、Redis、MQTT 协议详情；展示事件提供的进程命令、TLS 和 JA3/JA4 信息。
- 提供搜索与筛选、页内标记、JSON 导出、正文格式化/Hex/解压及本地图片预览；采用有界内存缓存、分页摘要和按需详情。
- 增加中英文即时切换、深浅主题、可拖动分栏和来源元数据编辑，改善连接信息展示与 WebKit 控件表现。
- macOS 桌面和 Web 改用 Intel / Apple Silicon universal 包；Linux 提供 DEB/RPM，Windows 提供 ZIP。下载包统一采用 `ecaptureq-` / `ecaptureq-web-` 前缀和汇总 `SHA256SUMS`。
- macOS 默认 ad-hoc 签名，未经 Apple 公证；新增使用指南、实际 UI 截图及独立的编译、开发、发布文档。
- **迁移边界**：不再包含旧版 SQL 过滤、集成采集器启动和 Android UI；旧配置及会话不会自动导入。eCapture 采集器需独立运行，来源应在新版中重新配置。

[完整变更](https://github.com/gojue/ecaptureQ/compare/v0.3.0...v1.0.0)

## v1.0.0-alpha.2 — 2026-11-08

- macOS CI 和发布默认改为无需 Apple 证书的 ad-hoc 签名，避免已有或过期的签名密钥隐式启用 Developer ID 签名。
- Developer ID 签名与公证需显式选择；失败时终止构建，不静默回退，并在包元数据中区分实际签名状态。

[完整变更](https://github.com/gojue/ecaptureQ/compare/v1.0.0-alpha.1...v1.0.0-alpha.2)

## v1.0.0-alpha.1 — 2026-11-08

- 首次发布 Go + Wails 重写版，共享 Web/桌面核心，接入公开固定版本的官方 Protobuf 包，构建不依赖相邻 eCapture 源码。
- 引入多来源隔离、消息关联、有界存储、协议详情、原生桌面能力及 Web 子路径部署。
- 重建三平台构建和发布流程；README 改为用户指南，加入模拟/合成数据的实际 UI 截图，并将文档与图片纳入安装包。

[完整变更](https://github.com/gojue/ecaptureQ/compare/v0.3.0...v1.0.0-alpha.1)

## v0.3.0 — 2025-12-07

- 新增数据包流的自定义 SQL 过滤。
- 引入 Prettier，统一代码格式。

[完整变更](https://github.com/gojue/ecaptureQ/compare/v0.2.2...v0.3.0)

## v0.2.2 — 2025-11-23

- 改进 WebSocket 取消与连接清理，修复配置更新问题。
- 调整 GitHub Release 流程，移除草稿发布选项。

[完整变更](https://github.com/gojue/ecaptureQ/compare/v0.2.1...v0.2.2)

## v0.2.1 — 2025-10-16

- 载荷改为按需加载，减少列表加载开销。
- 修复 macOS 用户目录相对路径的读写权限问题。

[完整变更](https://github.com/gojue/ecaptureQ/compare/v0.2.0...v0.2.1)

## v0.2.0 — 2025-10-13

- WebSocket 数据格式从 JSON 迁移到 Protobuf。
- 新增配置持久化，修复配置初始化问题并更新使用文档。

[完整变更](https://github.com/gojue/ecaptureQ/compare/v0.1.5...v0.2.0)

## v0.1.5 — 2025-09-27

- 补充 macOS entitlements，更新依赖和安装包配置。
- 完善安装与使用说明。

[完整变更](https://github.com/gojue/ecaptureQ/compare/v0.1.1...v0.1.5)

## v0.1.1 — 2025-08-24

- 增加 ARM 架构构建支持，调整 Ubuntu ARM CI 工作流。

[完整变更](https://github.com/gojue/ecaptureQ/compare/v0.1.0...v0.1.1)

## v0.1.0 — 2025-08-19

- 首个带版本标签的 Tauri 客户端，提供网络消息浏览、协议解析及后端载荷解码。
- 支持动态设置、解耦连接模式和 WebSocket 自动重连，完善采集会话生命周期与退出清理。
- 修复时间戳处理，改进响应式布局、滚动和移动端界面；建立跨平台构建及发布流程。

[版本源码](https://github.com/gojue/ecaptureQ/tree/v0.1.0)
