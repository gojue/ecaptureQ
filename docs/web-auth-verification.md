# Web 认证验证 — 2026-11-11

分支：`feat/startup-update-check`。仅修改本地源码和示例配置；未修改外部采集服务或反向代理，未部署。测试只使用内置模拟数据和本地合成 Protobuf 来源。

## 行为

- 示例配置包含初始用户 `ecapture` 的随机盐密码哈希，密码验证与指定初始密码一致。哈希使用标准库 PBKDF2-HMAC-SHA256、600,000 次迭代、16 字节随机盐、32 字节输出，参数参考 [OWASP 密码存储指南](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#pbkdf2)。
- 仅 Web 入口安装认证中间件，保护工作区、详情、状态、长轮询、配置及来源管理。Desktop 直接使用共用 Handler；认证配置仍随来源配置原样保留。
- 12 小时固定会话、128 会话上限、登录限速和校验并发限制；注销/过期取消等待请求，并在首次写响应前重新校验会话。
- 配置响应不暴露认证字段，配置无效时 Web 启动失败。修正了配置解析接受 JSON `null` 的原有缺陷，没有修改或跳过原有拒绝测试。

## 已执行

| 检查 | 结果 |
| --- | --- |
| `GOWORK=off go test -race ./...` | 全部通过，包括原先失败的 `TestSourceManifestProvenance/null` |
| `GOWORK=off go vet ./...`、`go mod tidy -diff` | 通过，未新增模块版本或校验和；已有 `x/term` 改为直接依赖用于隐藏密码输入 |
| `node --test test/*.test.mjs` | 73 项通过 |
| JS 语法、gofmt、`git diff --check` | 通过 |
| 官方协议门禁 | 字段 18–20 通过 |
| Web 构建和 `--hash-password` 标准输入 | 通过，生成结果独立校验 |
| Chrome 认证模式 `/` | 匿名 API 拒绝、错误密码、登录、完整 UI 回归、退出均通过 |
| Chrome 认证模式 `/ecaptureq-web/` | 同上，并通过配置保存、合成来源连接、实时更新、暂停及恢复 |
| Chrome 未启用认证 | 原有 UI 回归通过；退出按钮隐藏 |
| 登录页窄屏 | 390 像素视口无横向溢出，实际截图已检查 |
| macOS arm64 Desktop | Apple clang/SDK 生产构建成功；加载同一份含认证字段的配置、连接合成来源，无 TCP 监听；SIGTERM 退出码 0 |

浏览器测试在本机 HTTP 上显式使用 `secureCookie: false`。Secure、HttpOnly、SameSite、Cookie Path、过期/撤销/轮换、容量限制、跨实例会话隔离及等待请求取消均由 Go 测试覆盖。浏览器测试的 Node HTTP 响应清理问题已修正，重跑后两个认证场景完整退出。

## 未执行

未实际部署 HTTPS 反向代理，未等待完整 12 小时（到期行为由缩短期限的测试覆盖）。未执行 Windows/Linux 桌面运行或真实探针 E2E。macOS 原生界面自动化此前未获准访问 eCaptureQ，本次仅完成构建、配置隔离测试与进程生命周期检查，未执行原生导出、剪贴板、外链等交互。
