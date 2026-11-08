# eCaptureQ

eCaptureQ 全新一代网络协议分析 UI，继续使用 [gojue/ecaptureQ](https://github.com/gojue/ecaptureQ) 原仓库与产品名称。新版完整采用 Go + Wails 实现，提供 **eCaptureQ Web** 和 **eCaptureQ Desktop** 两个运行入口，共享三栏 HTML/CSS/JavaScript 界面、连接、解码、关联、缓存和筛选逻辑。

本次重写替换旧 Tauri/Rust/React 实现，功能、界面和配置以本 README 为准。旧版 SQL 过滤、集成采集进程管理和 Android UI 不属于当前版本；SQL 过滤将在未来按新数据模型重新实现。旧配置不会自动导入，首次使用需要重新配置数据源，详见 [新版使用与升级说明](docs/upgrade.md)。

eCapture 负责探针、捕获、解密与标准事件发布；eCaptureQ 不包含采集器运行实现。桌面可连接远端 Linux 的 eCapture；macOS/Windows 桌面支持不代表探针支持这些系统。分别运行的服务与桌面各有自己的缓存和数据源，会话不跨实例共享。

> 官方协议依赖已固定到公开提交 [`f6c0df58575ca3027ef5baf74c4488c94a263169`](https://github.com/gojue/ecapture/commit/f6c0df58575ca3027ef5baf74c4488c94a263169)，对应 Go pseudo-version `v2.10.1-0.20261108050605-f6c0df58575c`，包含 Event 字段 18–20。构建直接下载官方生成包，不需要相邻 eCapture checkout 或本地 `go.work`。详见 [依赖核验记录](docs/upstream-status.md)；具体测试与平台范围见 [验证记录](docs/verification.md)。

当前预览开发版本为 `1.0.0-alpha.1`，尚未发布。本地迁移分支的代码替换不代表 GitHub 默认分支、旧发布或旧分支已被改动。

## 环境与构建

- Go 1.26.0+；模块为 `github.com/gojue/ecaptureQ`。
- 原生前端无 npm 构建步骤；Node.js 24+ 用于测试。
- Web 服务是纯 Go，可 `CGO_ENABLED=0` 构建，无 GTK/WebKit 依赖。
- 桌面固定 Wails **v3.1.0**，macOS 需 Xcode，Windows 需 WebView2，Linux 需 GTK4 与 WebKitGTK 6.0 开发库。按目标系统本机构建；签名、公证和安装包发布不在本次范围。
- 若 Go 安装环境设置了旧 `GOROOT`，先移除该环境覆盖，允许 Go 自动选择所需工具链。

直接从本仓库构建；Go 会下载 `go.mod` 固定的公开依赖：

```sh
make server
./bin/ecaptureq-server --addr 127.0.0.1:28257 --mode mock
# 打开 http://127.0.0.1:28257/

make desktop
# macOS: open dist/eCaptureQ.app
# Windows: dist/eCaptureQ.exe
# Linux: ./dist/eCaptureQ
```

也可直接开发运行：

```sh
go run ./cmd/server --mode mock
go run -tags desktop ./cmd/desktop --mode mock
```

桌面直接把共享 Handler 接入 Wails Asset Server，打开原生窗口，无须另开浏览器或手动启动后台服务，也不默认开放 TCP 监听端口。应用关闭会取消接收、拨号和重连并等待后台任务退出。桌面导出使用保存对话框，剪贴板和外链走薄原生适配；浏览器使用下载、剪贴板及新窗口能力。

桌面单次导出上限为 64 MiB，剪贴板上限为 4 MiB；超限会提示缩小筛选范围，不会静默改用另一种导出方式。

## 数据源与配置

默认模拟模式不需要采集器。点击顶部「实时 / 模拟」切换；`--mode` 只设置初始展示，只要配置了端点，后台接收始终继续。

```sh
./bin/ecaptureq-server --mode live --ecaptureq ws://127.0.0.1:28256/
# --ecaptureq 可重复，最多 16 个独立来源
# macOS 桌面带参数运行：
./dist/eCaptureQ.app/Contents/MacOS/eCaptureQ --mode live --ecaptureq ws://127.0.0.1:28256/
```

此例 UI 监听 28257，采集 WebSocket 使用 28256，避免同机端口冲突。连接远端 Linux 时使用可达的端点或现有 SSH 隧道；本应用不会自动登录主机、启动探针或执行登记的命令。

顶部显示已连接数 / 总来源数，面板独立显示连接、重试和日志。运行中可手动添加来源；新增接口要求同源 JSON 与 `X-Ecapture-UI: 1`。无 CORS；桌面仅明确适配 Wails 内部 origin。支持 ws/wss，拒绝 URL 用户凭据、查询和片段；采集器原生 ws 可由现有 TLS 终止入口提供 wss。

```sh
cp config/sources.example.json sources.local.json
# 编辑为自己的端点；也可从内容为 [] 的文件开始
./bin/ecaptureq-server --sources sources.local.json --mode live
```

`--sources` 支持最多 128 KiB 的 JSON 数组。新增来源会原子写回配置；外部修改冲突或保存失败会显示错误且不新增连接。命令行来源仍由命令行提供；未指定文件时来源仅在本次实例内保存。配置只保存连接与登记元数据，不保存捕获记录。启动命令仅展示，登记模块/版本不冒充事件提供的事实。

可配置：`--addr`（仅 Web）、`--base-path`、`--mode`、`--ecaptureq`、`--sources`、`--max-records`、`--max-memory-mib`、`--max-frame-mib`、`--exclude-http-path-prefix`；运行 `--help` 查看完整说明。

## 子路径部署

所有资产、fetch、下载和平台 API 使用相对路径。支持根路径及子路径：

```sh
./bin/ecaptureq-server --addr 127.0.0.1:28257 \
  --base-path /ecaptureq-web/ --exclude-http-path-prefix /ecaptureq-web/
```

访问 `/ecaptureq-web` 会保留查询参数并跳转到尾斜杠路径。见 [Nginx 示例](deploy/nginx.conf.example)：代理保留子路径和外部 Host，勿误加 proxy_pass 尾斜杠。对外暴露时在整个前缀（含 API）部署访问保护。本次没有修改任何已运行的 Nginx 或采集服务。

自身流量排除使用前缀及 `X-Ecaptureq-UI` 响应标记。仅设置前缀才启用这项排除；它不依赖生产域名。

## 采集模式与协议

完整 HTTP 消息使用 eCapture 的 `-m text --text-source pcapng`，例如对自己的 Go 程序采集：

```sh
sudo ./bin/ecapture gotls --elfpath /absolute/path/to/go-app \
  -m text --text-source pcapng -i lo \
  --ecaptureq ws://127.0.0.1:28256/
```

接口名和 ELF 路径需要匹配实际流量。HTTP/3 使用相同的 GoTLS 解密路径；Redis、MQTT 分别显式选择 `--text-protocol redis` 或 `--text-protocol mqtt`，原始 QUIC 流/数据报使用 `--text-raw`。这些选项取决于采集器及 SDK 的实际支持，不会因为 UI 中有查看器就自动识别任意明文端口。

| 协议 | 实时查看与关联 |
| --- | --- |
| HTTP/1.x | 完整请求/响应；同一来源、连接及接收代次内按顺序关联 |
| HTTP/2、HTTP/3 | 完整消息按连接与 Stream ID 关联；缺少流标识时保留独立记录 |
| QUIC | STREAM、FIN、RESET、DATAGRAM、方向、偏移、加密级别与原始字节；保留空数据报 |
| MySQL | mysqld 查询事件、SQL、捕获长度、截断与 `dispatch_command` 返回值 |
| Redis | RESP2/3 值、请求编号关联、错误、Null、Push、Attribute；原始请求与响应分别保留 |
| MQTT | MQTT 3.1.1 控制报文、Topic、QoS、Packet ID、DUP、RETAIN 与业务载荷 |
| 其他 / 原始 | 未映射、格式不完整、增量 HTTP 或原始事件，保留载荷和元数据供检查 |

`text + pcapng` 的完整应用消息已经由上游解密和重组；本服务只解析交付的消息表示并进行关联，不重组网络包。
结构化事件沿用现有 EVENT 中的元数据 JSON + hex 载荷表示。`Event.type` 是 eCapture 事件类别，不是应用协议编号。

有请求且捕获到 Host/authority 才显示可复制的 cURL；缺少 authority 时显示真实网络端点，不推算请求 URL。只有响应时明确显示请求未捕获。二进制正文与 RESP 值保留 hex，不以替换字符损坏字节。
MySQL 派发返回值不等于 SQL 执行结果，本工具不提供结果集或事务成功判断。Redis 的 `invalidate` 推送展示缓存失效键，不当作 Pub/Sub Channel。MQTT QoS、DUP、ACK 观察值不构成投递成功保证。

## 归属、时间与容量边界

- 实时 PID/进程名来自事件元数据。配套采集器和 SDK 从 pcapng 以太网 trailer 保留真实 PID/Comm；旧 SDK 仍可能提供 `PID=0/PName=decryptor`，这表示未知进程，以来源分别分组，不反解 opaque UUID 猜测 PID。OpenSSL hook 和 MySQL 等带 PID 的事件可直接按进程筛选。
- HTTP/Redis 合并请求响应时保留不同的响应端进程；loopback 两端均被观察到时，可按任一进程筛选同一条配对记录。只观察到一个本机端点时使用上游提供的归属；缺失或冲突仍为未知。
- 普通 Protobuf 时间戳只有秒级精度，实时耗时显示为空。结构化事件内若有更精确的时间戳则保留它，但不伪造毫秒级请求耗时。
- `EVENT`、`PROCESS_LOG`、`HEARTBEAT` 分开处理。运行日志不混入请求列表。断线自动退避重连，并隔离重连前后的关联；上游没有捕获事件回放，因此无法补齐断线期间的数据。
- 默认保留 65,536 条记录、最多 192 MiB 的记录 JSON（先达到任一上限时淘汰最旧记录；不是进程 RSS 上限），可用 `--max-records`、`--max-memory-mib` 调整。单 WebSocket 帧默认限制 8 MiB，用 `--max-frame-mib` 调整。
- 单载荷显示限制 256 KiB，超过时明确标记为部分内容；关联等待队列、RESP 解析深度和节点数也受限。记录保留字节限制不是整个进程的 RSS 上限。
- `dropped` 是 UI 服务拒绝的非法或超大记录数，`evicted` 是超出保留范围而淘汰的记录数；两者都不是内核或上游丢包计数。
- 工作区与日志仅保留在内存，重启服务会清空实时记录。导出 JSON 保存的是当前筛选结果。

## 模拟模式与交互

模拟模式保留 9 个进程、60 条样例，覆盖七种协议及空数据报、截断 SQL、Redis 推送与 MQTT 标志位等边界。样例与实时数据不会混合。
支持进程/协议/主机/异常/JSON 组合筛选、全文搜索、星标、格式化/原文/Hex、复制、导出、深浅主题和拖动栏宽。协议按钮仅显示当前筛选范围内实际出现的协议；列表上方显示可逐个移除的条件和「清除全部」，进程标题旁也可单独清除进程筛选。
星标可从左侧「已标记」集中查看，仅保留在当前页面会话，刷新页面或切换数据模式会清空；不会阻止服务端容量淘汰。
`Cmd/Ctrl + K` 聚焦搜索，列表中上下方向键切换记录；窄屏支持筛选侧栏与详情返回。

「开始模拟」每 2.8 秒追加一条虚构样例，最多 300 条；重置恢复初始 60 条。模拟关联与耗时均为虚构字段。
HTTP 页签依次为「请求、响应、连接」。「未配对」仅表示当前尚未关联最终响应，不能据此推断服务端仍在处理或请求超时。连接页分别展示事件关联到的「进程名」和「进程 PID」，不从进程元数据推断客户端/服务端角色。进程命令来自采集时的 argv 快照（需要支持参数捕获的采集器和 Decryptor v1.4.2+），按该条记录展示可读概览；末尾空项折叠，中间空参数保留，需要时用引号区分参数。argv 字节没有 argc，无法仅凭末尾 NUL 区分进程标题的零填充和真正的尾部空参数，因此该折叠只影响概览，原始字节完整保留；两个本机进程分别显示，缺失时不从其他记录或 Web 主机的 procfs 猜测。最多捕获 256 字节，截断时明确提示，原始字节以 base64 保留在 JSON 中。

查看压缩正文时，浏览器按 `Content-Encoding` 逆序解码 gzip、deflate（含 raw deflate 兼容） 和 br；优先使用 `DecompressionStream`；WebView 缺少算法或 Blob.stream 时调用同一 Go 服务的有界解码回退。「解压后 / 原始压缩」可切换表示，原文、Hex 与复制均遵循当前选择。解码只发生在选中的消息上，保留原始捕获字节与导出内容，不增加工作区传输体积。每层解压上限 2 MiB，总处理超时 5 秒，最多缓存 4 个正文；损坏、截断、超限或浏览器不支持时明确提示并保留原始内容。

HTML 预览使用只读、禁用脚本和外部资源的 sandbox iframe；捕获内容不可操作页面链接。

## HTTP API 与共享结构

| 路径 | 语义 |
| --- | --- |
| GET /api/workspace?mode=mock | 独立模拟数据及来源状态 |
| GET /api/workspace?mode=live&view=page | 服务端筛选、每页最多 200 条摘要 |
| GET /api/record?id=... | 按需读取正文，已淘汰返回 404 |
| GET /api/status、/api/sources | 来源、容量计数与日志 |
| POST /api/sources | 新增并可持久化来源，需要专用 header 和同源检查 |
| GET /api/health | 模式、服务状态 |
| POST /api/decode-body | 选中捕获字节的解压回退，不抓取 URL |
| GET /api/platform | 桌面原生能力（浏览器 404 后使用浏览器能力） |
| POST /api/platform/export、clipboard、open-url | 仅桌面；限制大小与 URL，使用同样的写入校验 |

路径均位于选定 base-path 下。完整 workspace API 也可读取全部保留记录；实际前端使用分页摘要和详情接口，不一次传输全部保留正文。这些是新实现的 HTTP API，不兼容旧 Tauri 命令接口。共享源码位于 `internal/app`、`internal/httpapi`、`frontend`；Wails 依赖只在带 desktop tag 的入口，平台 API 可独立测试。

HTTP 图片从捕获字节生成本地 Blob，不重新请求被捕获 URL；SVG 仅作为 img 展示。压缩图片先解压。损坏、截断或能力缺失显示原因。后端 fallback 支持 gzip、zlib、raw deflate、Brotli，输入/输出均有界，每层输出最多 2 MiB，前端总 deadline 5 秒；后端最多 4 个并发解码。

连接页直接读取官方 Event.tls，展示实际提供的版本、密码套件、SNI、ALPN、组、签名算法、JA3/JA4。SNI 不从 HTTP Host 推断；指纹取首次线上 ClientHello，ECH Outer 会标明。缺失值保持未知。真实上报须由含相关发布变更的采集器及其 Decryptor v1.4.3+ 提供，UI 不导入 Decryptor。

## 验证

```sh
make check
# 公开依赖验收（显式禁用本地 workspace）
make release-check
# 合成 Protobuf WebSocket（无需探针）
go run ./scripts/ws-fixture --addr 127.0.0.1:28359
# 浏览器回归，需要系统 Chrome/Chromium 和已启动的 Web 服务
node test/browser-smoke.mjs http://127.0.0.1:28257/
node test/browser-smoke.mjs http://127.0.0.1:28258/ecaptureq-web/
```

测试覆盖合成官方 pb 接收、多源/重连隔离、关联和缺失消息、缓存边界、分页及详情、argv/TLS、来源持久化/校验、子路径、解压与本地图片、原生适配和关闭清理。CI 使用 GOWORK=off，不依赖相邻 checkout；协议门禁检查官方字段名称、编号与类型，防止依赖回退或字段不兼容。

[实际验证记录与未验证项](docs/verification.md)、[迁移来源](docs/migration.md)、[架构和开发规则](AGENTS.md)。真实 eBPF 采集联调需要受授权的 Linux 环境；模拟查看器和合成 WebSocket 测试不能证明任意真实流量都可采集解析。

许可证：Apache-2.0；保留 [LICENSE](LICENSE)、[NOTICE](NOTICE) 及原版权。
