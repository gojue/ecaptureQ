# eCaptureQ 文档

第一次使用请从 [项目 README](../README.md) 开始：下载安装、连接 eCapture、浏览协议消息及导出数据。eCapture 负责采集与解密，eCaptureQ 提供 Web 和 Desktop 分析界面；两者的平台与运行职责分别说明。

## 使用与部署

- [配置、协议与行为参考](reference.md)：CLI、来源配置持久化、子路径部署、协议详情、缓存限制、正文预览与 HTTP API。
- [新版使用与升级说明](upgrade.md)：旧版配置处理、新版范围与独立会话。
- [来源配置示例](../config/sources.example.json)：公开占位配置，不包含采集数据或启动凭据。
- [Nginx 子路径示例](../deploy/nginx.conf.example)：保留路径前缀和外部 Host 的反向代理配置。

## 编译与开发

- [编译指南](compilation.md)：公开依赖、Go/Wails 版本、三平台构建环境、Web/桌面产物和 AMD64/ARM64。
- [开发指南](development.md)：共享架构、协议单一来源、数据关联边界、调试与测试。
- [合成 Protobuf WebSocket 来源](../scripts/ws-fixture/README.md)：无需探针验证接收、重连、多源、正文与 TLS 展示。
- [仓库开发规则](../AGENTS.md)：代码边界、平台要求和验证原则。

## 构建、发布与验证

- [版本更新日志](../CHANGELOG.md)：待发布版本的变化、升级注意事项与历史版本摘要。
- [CI、构建与发布](releases.md)：工作流触发、完整产物矩阵、版本标签、校验和以及 macOS 签名/公证。
- [依赖核验记录](upstream-status.md)：官方 Protobuf 包、所需 Event 字段和公开版本来源。
- [实际验证记录](verification.md)：已执行检查、平台范围和仍未验证的原生/真实采集项目。
- [本次 UI 验证](ui-verification.md)：连接展示、三栏默认宽度、官网配色与即时中英文切换的验收范围。
- [品牌更新验证](branding-verification.md)：新 Logo、各平台图标、README 概念图与截图的验证范围。
- [迁移来源](migration.md)：本次实现的源码与仓库沿革。

使用者应以 README 和使用参考为入口；编译、测试、发布细节留在相应独立文档。历史迁移记录用于追溯，不替代当前功能说明。修改行为或移动文档时，同步更新入口链接和可执行示例。
