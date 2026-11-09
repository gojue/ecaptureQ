# eCaptureQ 开发指南

用户安装与连接数据源见 [README](../README.md)，工具链和各平台构建命令见 [编译指南](compilation.md)。本页介绍代码边界、调试和验证要求。

## 一份业务核心，两种运行入口

| 目录 | 责任 |
| --- | --- |
| `cmd/server` | Go HTTP 服务、信号与退出处理，默认监听回环地址 |
| `cmd/desktop` | 带 `desktop` 构建标签的 Wails v3 入口、窗口和原生适配 |
| `internal/app` | 数据源连接、接收、映射、应用消息关联、缓存、筛选和生命周期 |
| `internal/httpapi` | 共用 HTTP Handler、参数校验、正文解码、路径前缀和同源规则 |
| `internal/platform` | 导出、剪贴板、外链的薄适配接口，不依赖窗口 API |
| `internal/cli` | Web 与 Desktop 共用的配置参数 |
| `frontend` | 两端共用的 HTML/CSS/JavaScript 与嵌入资源 |
| `test`、`scripts` | 前端回归、浏览器验收、协议检查、合成数据源、打包工具 |

Web 启动普通 HTTP 服务，Desktop 把同一 Handler 交给 Wails Asset Server。桌面不通过额外 TCP 服务承载页面；两端都使用相对路径 API。`internal/app` 不依赖 Wails，普通 `go test ./...` 和服务器构建不要求 GUI 开发库。

每个运行实例独立拥有来源和缓存。关闭服务时需要取消接收、拨号和重连任务，并等待后台 goroutine 退出。不要为桌面复制一套关联逻辑或另一份前端。

## 协议与采集边界

eCapture 负责探针、捕获、解密、网络流重组和标准事件发布。eCaptureQ 消费官方 `pb.LogEntry`、`pb.Event`，负责应用消息的展示和请求响应关联。

```go
import pb "github.com/gojue/ecapture/v2/protobuf/gen/v1"
```

不复制 `.proto`、`.pb.go` 或 wire descriptor，不实现另一套兼容协议。展示层可以使用自己的 Record、ViewModel 和 HTTP DTO。官方 Event 字段 18（`process_args`）、19（`process_args_truncated`）、20（`tls`）必须保留；缺失值不得猜测或伪造。

当前公开依赖和核查方法见 [upstream-status.md](upstream-status.md)。协议修改先在 eCapture 完成，UI 固定实际可下载的正式版本或公开 pseudo-version，并维护 `go.sum`。可在本地用忽略的 `go.work` 联调，但 CI 和发布必须 `GOWORK=off`；不得把相邻 checkout 变成正常构建前提。

本项目不引入探针、eBPF、libpcap 或 Decryptor 的运行实现，不执行来源配置中的启动命令。桌面支持 macOS、Windows、Linux，与采集器的平台支持范围是两件事。

## 运行与调试

先用内置模拟数据启动：

```sh
GOWORK=off go run ./cmd/server --addr 127.0.0.1:28257 --mode mock
# 在安装原生 SDK 的目标主机上运行桌面：
GOWORK=off go run -tags desktop ./cmd/desktop --mode mock
```

前端直接嵌入程序，没有前端 dev server 或自动热更新；编辑资源后重启 `go run`。不能用单独打开 HTML 文件的方式代替同源 API 和资源路径回归。

不需要探针即可测试官方 Protobuf WebSocket。分别在独立终端启动以下合成来源，再在 UI 中添加两个地址：

```sh
GOWORK=off go run ./scripts/ws-fixture --addr 127.0.0.1:28359
GOWORK=off go run ./scripts/ws-fixture --addr 127.0.0.1:28360 --disconnect-after 5
```

来源为 `ws://127.0.0.1:28359/` 和 `ws://127.0.0.1:28360/`。切到「实时」可验证图片、gzip 正文、进程参数、TLS 字段、多源隔离和断开重连。工具只生成明确标注的虚构事件，不抓包、不接触探针，也不访问事件中展示的目标 URL。详见 [合成来源说明](../scripts/ws-fixture/README.md)。

## 必须保持的语义

- 关联范围是来源、重连代次与连接身份。HTTP/1.x 按连接内顺序关联；HTTP/2、HTTP/3 还使用 Stream ID；不用 PID 或父子进程关系代替连接身份。
- 「未配对」只表示没有关联到另一侧消息；已淘汰请求不能被迟到响应复活，缺失信息不能补造。
- 后台持续接收；暂停按钮只暂停 UI 更新。每页读取 200 条摘要，详情按需请求，筛选覆盖当前全部保留记录。
- 数量和记录 JSON 计量上限先到者触发淘汰；192 MiB 不是 RSS 限制。页面星标不会保护记录免于淘汰，捕获记录和日志不持久化。
- 保留进程 PID、原始 argv、来源及 TLS 元数据。事件事实与手动登记信息分开呈现；不把进程名冒充客户端或服务端角色。
- 捕获内容是不可信输入。转义页面文本，隔离 HTML 预览，SVG 只能用图片元素显示，图片预览不能重新请求被捕获 URL。
- 来源写接口与原生能力接口共用同源校验；只明确适配 Wails 内部 origin，不全局放开 CORS。保留消息、载荷、解析深度、解压与导出限制。

具体默认值、API、协议查看器以及正文展示语义见 [行为参考](reference.md)。完整开发约束见 [AGENTS.md](../AGENTS.md)。

## 本地验证

```sh
make check
make release-check
```

`make check` 包含版本一致性检查、Go race 测试、Node 测试、Python 打包与发布门禁测试、Go vet 和前端语法检查。`make release-check` 显式禁用 workspace，验证官方协议、Go race/vet 和不依赖 GUI 的服务器构建。

提交 Go 代码前先格式化；CI 还检查完整 Go 源码格式及模块一致性：

```sh
gofmt -w cmd internal frontend scripts
GOWORK=off go mod tidy -diff
```

浏览器回归需要运行两个服务，分别验证根路径与反向代理前缀：

```sh
./bin/ecaptureq-web --addr 127.0.0.1:28257
./bin/ecaptureq-web --addr 127.0.0.1:28258 --base-path /ecaptureq-web/
```

上述服务分别占用终端；在另一个终端运行：

```sh
node test/browser-smoke.mjs http://127.0.0.1:28257/
node test/browser-smoke.mjs http://127.0.0.1:28258/ecaptureq-web/
```

测试默认使用系统 Chrome，也可通过 `CHROME_BIN` 指定 Chrome/Chromium 路径。它检查模拟/实时切换、协议详情、筛选、标记、主题、实际 JSON 下载、解压回退、HTML/SVG 安全边界和日志展开状态。浏览器退出及临时目录清理也是检查的一部分。

修改桌面入口或原生适配时，在可用目标平台验证窗口、文件保存/取消、剪贴板、外链、连接、重连和窗口关闭清理。编译通过、适配器单元测试通过与真实原生交互通过应分别报告。

## CI 与发布

`CI` 在分支 push 和 PR 上验证前端、三平台 Go 测试及浏览器行为，随后复用 `Build packages`，为 Linux、macOS、Windows 的 AMD64/ARM64 生成服务器与桌面产物，并为 Linux Web 额外生成 loong64 产物（纯 Go 交叉编译）。每个桌面目标在对应原生 runner 上构建。

`Release` 由推送匹配 `VERSION` 的 `v*` 标签触发，执行版本检查、同一套 CI、构建、签名条件与完整校验，再发布 GitHub Release。只在本地创建 tag 不会触发 GitHub Actions；完整操作及凭据要求见 [发布指南](releases.md)。不要用实际发版来代替日常验证。

合成来源和模拟页面无法证明任意真实流量都能被采集或解析。真实联调应在受授权的 Linux 采集环境执行，并记录采集器版本、模块、参数、事件内容和结果。已执行与未执行的验收范围见 [验证记录](verification.md)。
