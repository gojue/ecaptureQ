# Official protocol dependency

Updated 2026-11-21. The official Protobuf v2 packages and the `--stream-listen`
collector option are available in [eCapture v2.12.0](https://github.com/gojue/ecapture/releases/tag/v2.12.0).

| Item | Current integration baseline |
| --- | --- |
| Module | `github.com/gojue/ecapture/v2` |
| Release tag in go.mod | `v2.12.0` |
| Generated package | `github.com/gojue/ecapture/v2/protobuf/gen/v2` |
| Official validation helper | `github.com/gojue/ecapture/v2/protobuf/v2` |
| WebSocket subprotocol | `ecapture.v2` (required; no v1 fallback) |

`go.sum` records the release checksums. Normal builds need no adjacent checkout,
private workspace or local replace. eCaptureQ imports only the official protocol
types and validation helpers.

Run independent checks on the designated validation VM:

```sh
GOWORK=off go mod download
GOWORK=off go mod verify
GOWORK=off go mod tidy -diff
GOWORK=off make release-check
```

The mandatory release gate checks v2 descriptors, Go race tests, vet and the
pure Go server build.

## Wails verification

Pinned `github.com/wailsapp/wails/v3 v3.1.0`, official module-proxy revision
`4b454e443f6f11ccb64679c5c3d3f3bf5e6fb440`. This stable module was downloadable;
its `go.mod` requires Go 1.26.0. The documentation still showed v3.0.0 installation
examples when checked, so the implementation was verified against v3.1.0 source.

References: [official installation](https://v3.wails.io/getting-started/installation/),
[application API](https://v3.wails.io/reference/application/),
[v3.1.0 source](https://github.com/wailsapp/wails/tree/v3.1.0/v3).
The shared Handler is attached through AssetOptions, with Wails resource transport
(`wails://localhost` on macOS/Linux, `http://wails.localhost` on Windows), not Server
mode. This avoids a second listener and keeps browser/server dependencies minimal.
