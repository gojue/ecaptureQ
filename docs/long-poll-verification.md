# HTTP 长轮询验证 — 2026-11-11

分支：`feat/startup-update-check`。所有流量来自本地合成 Protobuf 来源；验证期间未连接真实探针或修改外部服务。代码随后已纳入本地提交 `bc8e83a`，本记录另行补充提交。

## 改动范围

- Web 与 Desktop 共用 `/api/changes` 和前端等待循环，无新增监听端口或传输依赖。
- 等待最多 10 秒，保持 Web 服务原有 15 秒写超时；无变化返回无正文的 204，不遍历记录。
- 状态版本与记录版本分离；暂停时仅更新状态，恢复时读取当前页。每个 Handler 最多容纳 128 个变更请求。
- 会话变化使旧游标失效；版本检查和订阅原子完成，取消、超时和服务关闭均释放等待。

## 已执行

| 检查 | 结果 |
| --- | --- |
| `GOWORK=off go run ./scripts/check-protocol` | 通过，官方字段 18–20 |
| `GOWORK=off go test -race ./internal/app ./internal/httpapi -run '^TestChange'` | 通过，版本、广播、取消、超时、容量限制、关闭与两种路径前缀 |
| `GOWORK=off go test -race ./...` | 除原有 `TestSourceManifestProvenance/null` 外通过；未报告数据竞争 |
| `GOWORK=off go vet ./...` | 通过 |
| `node --test test/*.test.mjs` | 72 项通过 |
| JavaScript 语法和 `git diff --check` | 通过 |
| Web 服务构建 | 通过 |
| Chrome `/` | 通过；空闲时不重复请求工作区，暂停与恢复正常 |
| Chrome `/ecaptureq-web/` | 通过；合成来源连接、分页详情、暂停期间不请求工作区、恢复正常 |
| macOS arm64 Desktop | 使用 Apple clang/SDK 构建成功；启动并连接合成来源，无 TCP 监听；SIGTERM 退出码 0 |

全量 Go 测试中的失败已在未修改的 HEAD 源码副本上复现：配置加载接受 JSON `null`，而原有测试要求拒绝。本次未修改该配置逻辑或弱化测试。

## 未执行的验收

Computer Use 未获准访问 eCaptureQ，未完成原生页面长轮询、暂停/恢复、导出、剪贴板、外链和窗口关闭按钮的交互验收。原生进程启动及退出检查不代表这些交互已通过。

未执行 Windows/Linux 桌面运行、真实反向代理部署或真实探针 E2E；两个浏览器路径的验证使用本地 HTTP 服务及合成数据。
