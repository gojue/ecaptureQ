# Official protocol dependency

Checked on 2026-11-08. **The protocol publication blocker is resolved.** eCaptureQ
pins the downloadable official commit below; no local eCapture checkout or
workspace replacement is required for normal builds.

| Item | Verified value |
| --- | --- |
| Official commit | [`f6c0df58575ca3027ef5baf74c4488c94a263169`](https://github.com/gojue/ecapture/commit/f6c0df58575ca3027ef5baf74c4488c94a263169) |
| Module | `github.com/gojue/ecapture/v2` |
| Go-resolved pseudo-version | `v2.10.1-0.20261108050605-f6c0df58575c` |
| Package imported by the UI | `github.com/gojue/ecapture/v2/protobuf/gen/v1` |
| Module checksum | `h1:rWcIgeZkxeHe9EKOY58POrZpIHkKaSd7gHr9zLAjBfA=` |
| go.mod checksum | `h1:r25F5wSZ45pCrpO2LAN/DdfSekf6Z/w6KYO7+U1NpE8=` |

The version and checksums were returned by Go while downloading the full commit
from `proxy.golang.org`; the pseudo-version was not constructed manually.
`go.mod` and `go.sum` pin this public dependency without a local replacement.

## Required fields and forwarding

The downloaded official generated package contains:

| Event field | Number | Type |
| --- | --- | --- |
| `process_args` | 18 | `bytes` |
| `process_args_truncated` | 19 | `bool` |
| `tls` | 20 | `map<string,string>` |

The official `.proto`, generated Go package, semantic output model, decrypt sink
and eCaptureQ publisher were inspected. All five files match the migration
baseline `08458d6d077e92269bda0fda1918e5c49da67068` byte for byte. The sink preserves
observed argv and TLS snapshots, and the publisher forwards them into the official
Event fields. No protocol compatibility difference was found in that path.

Only the generated Protobuf package is used by this UI. The collector's probes,
eBPF/libpcap and Decryptor runtime remain outside the eCaptureQ runtime dependency
boundary. A downloadable protocol package does not by itself prove real capture
behavior or cross-platform desktop runtime support; see the separate
[verification record](verification.md).

## Build and dependency checks

```sh
GOWORK=off go mod download
GOWORK=off go mod verify
GOWORK=off go run ./scripts/check-protocol
GOWORK=off go test -race ./...
GOWORK=off go vet ./...
GOWORK=off go build ./cmd/server
GOWORK=off sh scripts/build-desktop.sh
```

The protocol gate remains required. It checks the names, numbers and types against
the official runtime descriptor, so incompatible future dependencies fail clearly.
CI and release checks explicitly use `GOWORK=off`. Optional upstream development
may use an ignored `go.work`, but that must not become a release dependency or be
reported as an independent build. Do not commit local replacements or machine paths.

## Historical blocker

Initial migration used a local workspace because published v2.10.0 and the earlier
public master `bc89a0ed0ea5da82f430e2e0dc2560ad8089b345` lacked fields 18–20. The
migration baseline `08458d6` was not publicly downloadable then. The new public
commit above supplies the previously missing generated protocol and forwarding
changes, resolving that publication issue. Earlier local-workspace verification
and the later public-dependency verification are distinguished in the test record.

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
