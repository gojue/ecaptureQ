# 从源码编译 eCaptureQ

普通用户可直接下载 [GitHub Releases](https://github.com/gojue/ecaptureQ/releases) 中匹配操作系统和 CPU 架构的产物，安装与连接方法见 [README](../README.md)。本页面向需要编译、调试或制作安装包的开发者。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Go | 1.26.0 或更新版本，具体基线见 [go.mod](../go.mod) |
| Wails | 由 Go modules 固定为 **v3.1.0**，不使用 v2 API，无须另外安装 Wails CLI |
| 前端 | 原生 HTML/CSS/JavaScript，直接嵌入 Go 程序，无 npm 打包步骤 |
| 测试工具 | Node.js 24.14+、Python 3.9+；浏览器回归需要 Chrome/Chromium |
| 构建脚本 | POSIX shell；macOS 签名脚本使用 Bash。Windows 可用 Git Bash，或使用下文 PowerShell 命令 |
| Makefile 入口 | 使用 `make` 命令时需要 GNU make；也可直接执行本页中的 Go 与构建脚本命令 |

Web 服务使用纯 Go 构建，不需要 GTK、WebKit、Xcode 或其他桌面 SDK。Desktop 在目标系统上构建，使用该系统的原生 WebView：

| 桌面系统 | 编译环境 | 运行依赖 |
| --- | --- | --- |
| macOS | Xcode/Command Line Tools，`xcrun` 可找到 clang 与 macOS SDK | 系统 WebKit；构建最低目标设为 macOS 12.0，较旧系统仍需实际运行验证 |
| Windows | Go、Git Bash（使用脚本时） | Microsoft Edge WebView2 Runtime |
| Linux | C 编译器、pkg-config、GTK4 和 WebKitGTK 6.0 开发库 | GTK4 和 WebKitGTK 6.0 运行库 |

Ubuntu 24.04 桌面构建依赖可安装为：

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libgtk-4-dev libwebkitgtk-6.0-dev
```

这套平台规则属于 UI 项目。eCapture 探针的编译、运行和内核要求仍由 [eCapture 编译文档](https://github.com/gojue/ecapture/blob/master/docs/compilation.md) 维护；构建 macOS/Windows 客户端不意味着可以在这些平台运行探针。

## 获取代码与公开依赖

```sh
git clone https://github.com/gojue/ecaptureQ.git
cd ecaptureQ
```

Go 模块路径为 `github.com/gojue/ecaptureq`。协议直接导入官方 `github.com/gojue/ecapture/v2/protobuf/gen/v1`，当前依赖固定到公开提交 `f6c0df58575c` 对应的 `v2.10.1-0.20261108050605-f6c0df58575c`。它包含进程参数与 TLS 所需的 Event 字段 18–20，详见 [依赖核验](upstream-status.md)。

正常构建无须相邻 eCapture checkout、`replace` 或 `go.work`，也无须自行生成 Protobuf：

```sh
GOWORK=off go mod download
GOWORK=off go mod verify
GOWORK=off go run ./scripts/check-protocol
```

以下 `VAR=value command` 示例适用于 macOS/Linux shell 与 Git Bash；PowerShell 使用 `$env:VAR = "value"`。如果环境中手工设置了过时的 `GOROOT`，先移除该覆盖，再让 Go 使用匹配的工具链。

## 编译 Web 服务

macOS/Linux：

```sh
GOWORK=off CGO_ENABLED=0 make server
./bin/ecaptureq-server --addr 127.0.0.1:28257 --mode mock
```

打开 `http://127.0.0.1:28257/`。Windows PowerShell：

```powershell
$env:GOWORK = "off"
$env:CGO_ENABLED = "0"
go run ./scripts/check-protocol
go build -trimpath -o bin/ecaptureq-server.exe ./cmd/server
.\bin\ecaptureq-server.exe --addr 127.0.0.1:28257 --mode mock
```

也可直接运行 `go run ./cmd/server --mode mock`。修改嵌入的前端资源后，重新运行或构建程序。

## 编译 Desktop

在目标操作系统上运行统一脚本：

```sh
GOWORK=off sh scripts/build-desktop.sh
```

也可使用 `make desktop`。脚本先检查官方协议，再以 `desktop,production` 构建标签生成应用。

| 系统 | 产物 | 启动方法 |
| --- | --- | --- |
| macOS | `dist/eCaptureQ.app` | `open dist/eCaptureQ.app` |
| Windows | `dist/eCaptureQ.exe` | 双击，或在 PowerShell 执行 `.\dist\eCaptureQ.exe` |
| Linux | `dist/eCaptureQ` | `./dist/eCaptureQ` |

Windows 没有 Bash 时，可用 PowerShell 编译同样的可执行文件：

```powershell
$env:GOWORK = "off"
go run ./scripts/check-protocol
go build -trimpath -tags desktop,production -ldflags "-s -w -H windowsgui" -o dist/eCaptureQ.exe ./cmd/desktop
```

开发运行使用 `go run -tags desktop ./cmd/desktop --mode mock`。桌面直接嵌入共享 UI 和 Handler，无须另启动 Web 服务，也不默认额外监听 TCP 端口。

macOS 编译脚本会重建 `dist/eCaptureQ.app`，不保留旧包中的资源或签名。分发前单独执行默认的免费 ad-hoc 签名：

```sh
bash scripts/sign-macos.sh dist/eCaptureQ.app adhoc
```

此模式不需要证书或 Apple 会员，也不调用 Apple 公证服务；签名校验通过不代表 Gatekeeper 会自动信任应用。首次启动方法见 [README](../README.md)，正式 Developer ID 签名的显式启用条件见 [发布指南](releases.md)。

## AMD64 与 ARM64

Web 服务可以使用 Go 原生交叉编译，例如：

```sh
GOWORK=off CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -o bin/ecaptureq-server-linux-arm64 ./cmd/server
GOWORK=off CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
  go build -trimpath -o bin/ecaptureq-server-windows-amd64.exe ./cmd/server
```

`GOOS` 支持 `linux`、`darwin`、`windows`，发布目标的 `GOARCH` 为 `amd64`、`arm64`。Desktop 使用目标系统和架构的原生 runner 编译；不要把服务器的纯 Go 交叉编译方法直接套用于依赖 SDK 的桌面入口。

GitHub Actions 已配置三平台、两种架构的 Web 与 Desktop 构建。Android/iOS 暂未纳入构建或发布矩阵。

## 验证与打包

```sh
make check
make release-check
```

开发验证范围、合成数据源和浏览器检查见 [开发指南](development.md)。制作单个平台的分发包，例如在 macOS ARM64 上：

```sh
python3 scripts/package-release.py --kind server --os darwin --arch arm64
bash scripts/sign-macos.sh dist/eCaptureQ.app adhoc
python3 scripts/package-release.py --kind desktop --os darwin --arch arm64 --signing adhoc --dmg
```

打包脚本读取已编译的程序，校验其目标架构，在 `dist/packages/` 生成压缩包与校验和；不会把整个工作目录放入产物。标签触发、版本一致性检查、完整产物清单和发布过程统一维护在 [发布指南](releases.md)。
