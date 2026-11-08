# eCaptureQ migration verification — 2026-11-08

This record applies to local branch `feat/next-generation-ui`, based on original
repository commit `cf4ba7f34cd0a122771b323e69e893bbea8dbd4d`. This is a linked
worktree of the existing `gojue/ecaptureQ` repository, not a new GitHub repository.

Environment: macOS arm64, Go 1.26.0, Node.js 24.14.1, installed Chrome and Xcode.
All test traffic was synthetic. Validation was completed before staging, commit
and push. No history rewrite, remote branch deletion, release or deployment was
part of validation. Repository settings, Stars, watchers and Issues were not changed.

## Replacement and preservation

The new tree contains the Go/Wails/shared HTML implementation and its tests,
resources, documentation and build configuration. Old Tauri/Rust, React/TypeScript,
Cargo/pnpm lockfiles, private protocol and release workflows are removed from this
working tree. Old features are not acceptance requirements.

Product names, module/import paths, links, examples, export names, theme preference
key, CI and output names are aligned with eCaptureQ. Module:
`github.com/gojue/ecaptureq`; app ID: `com.gojue.ecaptureq`. Development version
`1.0.0-alpha.1` matches VERSION, package.json and generated app metadata. macOS
numeric version is `1.0.0`, build `1`.

Before/after SHA-256 checks confirmed all 145 tracked/untracked source files in the
original eCaptureQ worktree and all 55 source files in the eCaptureW development
worktree remained unchanged. Their Git status and HEAD also match the before-state,
including unrelated edits. At the time of these preservation checks, the new
worktree had zero staged files and both branches pointed to the same base commit.
The subsequent authorized commit/push is confined to the migration branch.

Local workspace backups, binaries, screenshots and logs are ignored. No real capture,
credential, provisioning profile or private machine configuration was copied.

## Dependency boundary

**The independent-build blocker is resolved.** The dependency is now fixed to
public commit `f6c0df58575ca3027ef5baf74c4488c94a263169`, resolved by Go as
`v2.10.1-0.20261108050605-f6c0df58575c`. Official Event fields 18–20 and their
collector-side forwarding are present. The five protocol/output files match the
original integration baseline byte for byte; see [upstream-status.md](upstream-status.md).

The earlier local `go.work` and its checksum file were moved into ignored artifact
backups. No active workspace or local replacement remains. Successful independent
verification used a separate source-only directory with no Git metadata, go.work
or adjacent eCapture checkout, an initially empty GOMODCACHE and GOCACHE,
`GOWORK=off`, `GOPROXY=https://proxy.golang.org` and `GOSUMDB=sum.golang.org`.
The Go 1.26.0 toolchain was preinstalled; application dependencies were downloaded
from the public proxy into the empty module cache.

Module download/verification, the protocol gate, all 142 Go tests/subtests under
race, vet, tidy-diff, the CGO-disabled Web server build and the macOS desktop
production build all passed in that isolated environment. go.mod/go.sum remained
unchanged by verification. Module resolution pointed inside the fresh cache with
no Replace entry. Both resulting binaries report the public pseudo-version and
checksum in `go version -m`, with no local replacement.

Linux/Windows amd64/arm64 server artifacts were separately rebuilt using
`GOWORK=off`, and their formats and embedded dependency versions were verified.
The new Web/desktop binaries replaced the prior local-workspace artifacts.

Server dependency inspection found no Wails, probe/eBPF, libpcap or Decryptor
runtime. No `.proto` or `.pb.go` is maintained in this source tree; wire types come
only from the official generated Go package. Initial migration tests had used a
local workspace before this public commit became available; the new independent
results above supersede that earlier dependency limitation.

## Executed checks

| Check | Actual result |
| --- | --- |
| `go test -race -json ./...` | 142 tests/subtests passed in 4 tested packages, zero failures |
| `go vet ./...` | Passed |
| `node --test test/*.test.mjs` | 27 passed during migration; frontend unchanged by dependency update |
| JavaScript syntax | Passed during migration |
| macOS arm64 Web server, CGO disabled | Built successfully |
| Linux server, amd64 and arm64, CGO disabled | Both compiled; static ELF formats checked |
| Windows server, amd64 and arm64, CGO disabled | Both compiled; PE target formats checked |
| macOS arm64 desktop production build | Passed |
| Shell syntax, source/generated plist, identity/version consistency | Passed |
| Chrome against real Go service at `/` | Browser smoke passed |
| Chrome against real Go service at `/ecaptureq-web/` | Browser smoke passed |
| Real reverse-proxy regression | Passed in Go race suite |
| Desktop process, mock initial mode, `/ecaptureq-web/` | Previously launched and remained running during local-workspace migration |
| Desktop with two synthetic sources | Both connections and forced reconnect previously observed |
| Desktop TCP listening sockets | Previously none; only outbound fixture connections |
| Desktop SIGTERM shutdown | Previous runtime check exited 0; all fixture processes stopped |

Go tests cover official binary Protobuf decoding, malformed messages, multiple
sources, reconnect generation isolation, source persistence/conflicts and origin
checks, request/response association, missing sides, argv/TLS snapshots, 200-summary
pagination and on-demand details, whole-retention filtering, limits/eviction and
lifecycle cancellation. Late responses cannot resurrect evicted requests. Proxy
tests preserve prefix/Host and verify redirects, resources, APIs and foreign-origin
rejection.

Browser smoke verifies the eCaptureQ title, original repository link and theme
key, 60 mock records, 9 processes, protocol viewers, live/mock switching, filters,
stars, themes, official SVG, initial splitter position, actual JSON download and
Go decompression fallback. Security checks cover escaped fields/logs, inert
sandboxed HTML, local Blob SVG previews, no captured-URL fetches, persistent log
expansion and no unhandled JavaScript exceptions. Both screenshots were inspected.
Temporary browser-test servers exited normally and were stopped.

Native save/cancel, clipboard and external-link adapters are tested with a fake
native backend. Real process checks cover Wails startup, source connections,
reconnect and signal shutdown; they do not claim visual or native-dialog acceptance.

Desktop compilation/linking now uses a consistent macOS 12.0 deployment minimum.
`otool` confirms it; previous mismatched-target link warnings are gone. This is not
runtime acceptance on older macOS versions.

## Local artifacts (ignored by Git)

- `bin/ecaptureq-server`: current-host Web binary.
- `dist/eCaptureQ.app`: unsigned macOS arm64 app.
- `bin/ecaptureq-server-linux-{amd64,arm64}`: compiled Linux servers.
- `bin/ecaptureq-server-windows-{amd64,arm64}.exe`: compiled Windows servers.
- `bin/ecaptureq-ws-fixture`: synthetic source helper.
- `artifacts/go-race.json`: race-test evidence.
- `artifacts/web-root.png`, `artifacts/web-subpath.png`: inspected screenshots.
- `artifacts/browser-smoke-28459.log`, `artifacts/browser-smoke-28460.log`:
  browser acceptance results.
- `artifacts/desktop-runtime.json`, `artifacts/desktop-runtime.log` and fixture
  logs: native process/connection results.
- `artifacts/source-preservation.json`: original worktree preservation checks.
- `artifacts/independent-setup.json`, `artifacts/independent-build.json` and
  `artifacts/independent-*.log`: source-only fresh-cache download, protocol, race,
  vet, tidy and Web/macOS build evidence for the published dependency.
- `artifacts/public-crossbuild.json`, `artifacts/public-crossbuild.log`:
  published-dependency Linux/Windows server verification.
- `artifacts/public-browser.json`, `artifacts/public-browser-*.log`:
  browser smoke using the independently built Web binary.

## Outstanding verification

1. Initial hosted runs for `f81697b` passed Go race/vet, protocol checks and
   macOS/Windows/Linux desktop compilation. The browser job passed its UI/security
   assertions but failed while deleting Chrome's still-active temporary profile
   (`ENOTEMPTY`). The follow-up waits for Chrome closure and retries transient
   filesystem cleanup; local root/prefix browser tests passed. Check the latest
   Actions run for the expanded six-target desktop/package matrix.
2. Native window rendering, save dialogs, system clipboard, external browser and
   title-bar close were not exercised. Computer Use permission was unavailable
   during development; process and adapter tests are not substitutes.
3. Linux/Windows desktop builds passed in the initial hosted CI, but their runtime
   was not exercised locally. Cross-platform package gates do not replace native
   interactive acceptance.
4. Other macOS versions, signing, notarization and installation upgrades are not
   verified. This bundle is a local development artifact, not a published build.
5. No authorized Linux probe environment was used. Synthetic data does not prove
   that arbitrary real traffic can be captured or parsed.
6. Production Nginx and hosted deployment were not modified or exercised; shared
   routing/proxy behavior was tested locally.

Old SQL filtering, integrated capture, Android UI and old configuration compatibility
are outside this rewrite's acceptance scope. See [upgrade.md](upgrade.md). Future
SQL support is a new implementation task.

## CI and publication follow-up

The Go module/imports now consistently use `github.com/gojue/ecaptureq`; public
repository links and product branding keep eCaptureQ. The lowercase GitHub path
was verified to resolve the same repository/branch. Race tests, vet and the
CGO-disabled server build passed again after this change.

Workflow syntax/expression validation (actionlint 1.7.12), 27 Node tests, seven
Python version/package/checksum gate tests, root/prefix browser smoke, and the
updated macOS arm64 desktop build passed locally. Real ZIP/tar.gz packaging and
macOS DMG creation/integrity checks also passed. Packaging rejects wrong target
metadata, version mismatch, missing targets and corrupt hashes. See
[releases.md](releases.md) for the reusable CI/build/tag-release flow.

No version tag, GitHub Release or Apple notarization was created during this
follow-up. Full signing and the final publication step require a real authorized
release and are not reported as executed tests.

## Merged-main and user-documentation verification — 2026-11-08

The implementation is now merged into default branch `main` at `7637fff`.
Its [hosted CI run](https://github.com/gojue/ecaptureQ/actions/runs/42451978578)
completed all 12 jobs successfully: frontend and three-platform Go checks,
root/prefix browser regression, six Web server targets, six native desktop
targets and collection of all 14 archive/image assets. Desktop targets are
Linux, macOS and Windows, each with amd64/arm64. This supersedes the earlier
expanded-matrix uncertainty; it does not claim native interactive acceptance.

The user-documentation update adds three screenshots of the actual running Web
UI, using bundled mock records and two local synthetic Protobuf sources. Their
[provenance](images/README.md) distinguishes these images from native-window or
real-probe tests. Temporary browser/server/source processes were stopped.

Local checks of this documentation update passed: relative documentation/image
links, fenced blocks, version/tag consistency for `v1.0.0-alpha.1`, actionlint
1.7.12, eight Python packaging/release-gate tests and whitespace checks. The
packager now includes public screenshots and the single official SVG resource.
Actual macOS ZIP and Linux tar.gz packages were inspected: all four README image
references resolve to the exact source bytes, and package SHA-256 checks pass.
This packaging change was validated locally before submission; it was not part
of the earlier hosted run. Check the corresponding branch CI for its hosted
result. No tag or release was created during documentation validation.

The tag-triggered release call chain and version gates were inspected without
publishing. The repository has all six expected Apple signing-secret names, but
their values, certificate validity and an actual notarization were not checked.
Publishing still requires working signing credentials when they are configured;
the unsigned CI matrix is not evidence of successful Apple notarization.
