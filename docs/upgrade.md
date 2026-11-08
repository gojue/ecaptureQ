# eCaptureQ 新版使用与升级说明

eCaptureQ 沿用原产品名称和 `gojue/ecaptureQ` 仓库，采用全新的 Go + Wails
实现。当前准备的预发布版本为 `1.0.0-alpha.2`；可下载状态以 Releases 页面为准。本说明描述新实现的使用
边界，不承诺旧 Tauri 客户端的功能或配置兼容。

## 首次启动

1. 按 [README](../README.md) 下载并运行新版；需要从源码构建时参考
   [编译指南](compilation.md)。所需官方协议已固定到公开
   [上游提交](upstream-status.md)，构建不需要相邻 eCapture 源码或本地 workspace。
2. 默认模拟模式可独立浏览样例。连接真实数据时，在 Linux 采集主机上另行
   运行支持相应事件字段的 eCapture，再向新版添加它的 WebSocket 地址。
3. 使用来源面板、`--ecaptureq` 或 `--sources` 重新配置来源。新来源清单的
   格式见 [示例](../config/sources.example.json)，其中的启动命令仅供展示。
4. 需要保存来源时选择自己的 JSON 清单文件。未指定清单时新增来源只保留
   在当前实例中；捕获记录和日志始终是有界内存缓存，不作为持久化历史。

旧版配置、SQL 表达式和会话不会自动导入。新版不读取、覆盖或删除旧应用的
配置目录；不要把旧配置 JSON 直接当作新的来源清单。当前没有自动升级器，
也未声明旧安装包到新安装包的无缝覆盖升级通过验收。

macOS 新版桌面包默认使用 ad-hoc 签名，未经 Apple 公证。首次打开或更新后，
系统可能要求重新确认；不保证保留旧 Developer ID 版本的系统授权。先核对
下载来源和校验和，再按 [README](../README.md) 中的逐应用首次打开步骤处理。

## 新版范围

- eCaptureQ Web 是浏览器访问的 Go HTTP 服务。
- eCaptureQ Desktop 是 Wails 原生窗口，直接连接数据源，无须另启 Web 服务。
- 每个运行实例独立拥有来源和缓存；Web 与 Desktop 不共享会话。
- 当前支持数据源管理、实时/模拟切换、消息关联、协议详情、搜索与筛选、
  标记、导出和主题等，完整语义以 README 和实现为准。
- 旧版 SQL 过滤将作为未来新功能重新设计；当前搜索框不执行 SQL。
- 本版不捆绑或管理 eCapture 探针进程，不提供旧版集成采集；Android 和 iOS
  客户端支持待定。
  桌面可连接远端 Linux 的 eCapture；macOS/Windows 客户端不会让探针在这些
  系统上运行。

## 仓库与发布状态

新实现已合并到原 eCaptureQ 仓库的默认分支 `main`。GitHub 仓库地址、Stars、
关注者和 Issues 继续保留在同一个仓库。发布下载以 Releases 页面为准；
不要将旧 Tauri 版本的包与新版 `desktop` / `server` 包混用。维护者审核后推送
匹配版本的标签，才会触发新版构建和发布，具体流程见 [发布指南](releases.md)。
