# eCaptureQ repository guide

## Scope and architecture

eCaptureQ is the next-generation Web and desktop UI for eCapture, replacing the
previous Tauri implementation in this same repository. eCapture owns Linux/Android
probes, capture, decryption and wire events; this project owns source connections,
application-message correlation, bounded storage and display. Never import probe,
eBPF, libpcap or Decryptor runtime packages. Never execute source launch metadata.

The only product is eCaptureQ, with Web and Desktop entries. Its canonical
repository remains `https://github.com/gojue/ecaptureQ` and its Go module is
`github.com/gojue/ecaptureQ`, preserving the repository's case. eCaptureW is only
the historical working name of the imported rewrite, not another active product.
Keep public names, import paths, app identifiers, artifact names and docs aligned.

- `cmd/server`: loopback HTTP entry; no GUI dependencies.
- `cmd/desktop`: Wails v3 entry, guarded by `desktop`; no default TCP listener.
- `internal/app`: one implementation of ingestion, mapping, retention and lifecycle.
- `internal/httpapi`: shared handlers, validation, body decoding and prefix mounting.
- `internal/platform`: testable native capability adapter; Wails stays in the entry.
- `internal/cli`: common options; `frontend`: one embedded vanilla HTML/CSS/JS UI.

## Protocol is owned upstream

Import only `github.com/gojue/ecapture/v2/protobuf/gen/v1`. Do not copy `.proto`,
generated `.pb.go`, wire descriptors or create a compatible private protocol.
Record and API DTOs are presentation models. Require official Event fields 18
(`process_args`), 19 (`process_args_truncated`), and 20 (`tls`) without inventing
missing values. The published dependency is pinned to
`v2.10.1-0.20261108050605-f6c0df58575c`; see `docs/upstream-status.md` for provenance.

Use real downloadable versions and maintain `go.sum`. Normal builds must work
without an adjacent eCapture checkout. Optional upstream development may use an
ignored `go.work`. Release/CI must set `GOWORK=off` and pass the protocol gate;
never turn that gate into a skip or represent local integration as standalone.
Do not publish upstream or push/commit without explicit user authorization.

## Rewrite scope and repository operations

The previous implementation is replaced in full. Its code, feature set, UI and
configuration formats are not compatibility requirements. The old SQL filter,
integrated collector launcher and Android UI are outside this version's scope;
future SQL support is a new feature designed for the new data model. Do not add
legacy adapters or restore old behavior without a new requirement. New users
configure sources through the new CLI, manifest or UI; never silently import,
overwrite or delete the previous application's configuration or user data.

Work in the original eCaptureQ repository's migration branch/worktree. Do not
create a replacement GitHub repository. Preserve the existing repository's
community metadata, other worktrees and unrelated uncommitted changes. Commit and
push only when the user explicitly authorizes them. Rewriting history, changing
the default branch, deleting remote branches/tags and modifying releases require
their own explicit authorization. No legacy branch is needed for the new
implementation's builds or acceptance.

## Invariants

Correlate within source + reconnect generation + connection identity; HTTP/1 is
FIFO, HTTP/2 and HTTP/3 also require stream identity. PID and ancestry are not
connection identity. Consume complete application messages, never reassemble TCP.
An evicted request cannot be resurrected by a late response. Unpaired does not
mean the server is still executing. Preserve bounds and missing-value semantics.

Keep 65,536 records / 192 MiB counted record JSON defaults (not RSS), 200 summaries
per page and on-demand detail. Pausing affects UI refresh only. Page-local stars
do not protect records from eviction. Each running app has its own session.

Treat all captured content as untrusted. Escape DOM values, isolate inert HTML
previews, render captured SVG only as an image, never refetch captured URLs.
Preserve source mutation same-origin + custom-header checks and exact native
origin adaptation. Never globally enable CORS. Retain frame, parser, body decode,
pending association and retention limits. Preserve the official SVG and licenses.

## Build and validation

Pure Go app/server code may build and test on macOS, Windows and Linux. Upstream
collector Linux rules remain upstream; desktop support does not imply local probe
support. Wails v3.1.0 is pinned; use its APIs, not Wails v2. Build desktop on its
target OS with SDKs; Linux v3.1 uses GTK4 + WebKitGTK 6.0, Windows WebView2, macOS
Xcode. Default `go test ./...` and `go build ./cmd/server` must not import Wails.

For Go changes: gofmt, relevant tests, then `go test -race ./...`, `go vet ./...`.
For frontends: `node --test test/*.test.mjs`, JS syntax checks, browser smoke at `/`
and `/ecaptureq-web/`. Run the native app for desktop changes when available; check
native export, clipboard, external links, source connection and close cleanup.
Use synthetic fixtures; real probe E2E needs an authorized Linux environment.
Report unexecuted platforms/E2E precisely. Do not weaken tests to obtain green CI.

No real captures, credentials, private configuration, machine paths, generated
binaries or local `go.work` in public files. Source migration provenance and
verification evidence belong in `docs/`. No automatic deployments or changes to
external capture services or Nginx installations.
