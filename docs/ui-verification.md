# Shared UI verification — 2026-11-08

Baseline: `origin/main` at `34e4d7d5f6e9e762c7ed550143740213bf03d504`
from `https://github.com/gojue/ecaptureQ.git`; branch `codex/ui-language-theme`.
The canonical remote was confirmed before fetching main and creating an isolated
worktree. Existing migration files and other sessions were preserved.

## Behavior and boundaries

- The connection panel shows connection ID, message direction, combined transport
  and application protocol, then capture time. Only the complete known UUID format
  is shortened for display. Endpoint order and generation are retained; IPv6 is
  bracketed and unknown formats remain literal. Raw IDs remain in diagnostic JSON
  and exports. Association keys, stream IDs, source isolation and collector code
  are unchanged.
- The default left pane retains its width; the middle pane uses 60% of its previous
  default and detail takes the remainder. At 1440px this is 218 / 296.4 / 917.6px,
  plus two 4px separators. Middle/detail minima are 240/340px with responsive
  sidebar and single-pane layouts. Only explicit widths are saved; resize and
  refresh do not repeatedly scale them. The previous implementation had no saved
  width preference to migrate.
- Theme variables follow the official website's actual
  `.vitepress/theme/styles/custom-theme.css`, imported by its theme stylesheet.
  The palette uses warm light surfaces, graphite dark surfaces and yellow brand
  accents. Protocol, success, warning and error colors remain distinct. The
  website repository was not changed.
- English and Simplified Chinese share a centralized catalog. Without a saved
  choice, each load follows the primary system/browser language; Chinese variants
  use Simplified Chinese and unsupported languages fall back to English. The menu
  has only English and Simplified Chinese. Explicit choices persist and take
  precedence, including choosing the currently detected language. Switching
  preserves filters, selection, tabs, stars, drafts, scroll and capture state.
  Captured text and protocol names remain unchanged. Native export accepts only
  a validated locale, never a frontend-provided arbitrary dialog title.
- Source host defaults come from the WebSocket hostname, including IPv6 without
  brackets or port. Module defaults come from an explicit eCapture command or
  official alias, with limited quoting, sudo/env and known global-option parsing.
  Unknown or compound commands do not produce a guessed module. Command text is
  never executed. Manual edits, including clearing a value, win until form reset;
  cancel, close/reopen and language changes preserve the draft. These values are
  editable registration metadata, not capture-event facts.
- The macOS icon is generated from the existing official SVG using AppKit and
  iconutil, with standard 16–1024 pixel representations. Builds finish in a hidden
  staging directory before replacing the visible bundle and updating its mtime.
  Compilation failure retains the previous build. No external image dependency
  or generated executable is checked in.

## Executed checks

Environment: macOS arm64, Go 1.26.0, Node.js 24.14.1, system Chrome and Xcode.
Go checks used `GOWORK=off` and the published official dependency.

| Check | Result |
| --- | --- |
| `make check` | Passed: Go race tests, vet, Node, Python packaging tests and syntax checks |
| Official Event fields 18–20 gate | Passed |
| Pure-Go Web and macOS production desktop builds | Passed |
| Frontend/test JavaScript syntax, Go formatting, diff whitespace | Passed |
| Node tests | 60 passed |
| Python packaging/icon tests | 37 passed |
| `/` and `/ecaptureq-web/` browser smoke | Passed with synthetic live WebSocket input |
| macOS bundle icon and ad-hoc signature | Passed |
| Native process startup, synthetic connection, no extra listener | Passed |
| Native signal shutdown and connection cleanup | Passed; exited with code 0 |

The final browser runs cover seven protocol views in both languages and themes;
raw identifier exports; IPv4/IPv6/unknown IDs; stable identity after request/response
reversal and QUIC migration; live pairing, process filters, commands and TLS;
actual pointer and keyboard splitters; 1920/1440/1100/800/390px layouts and reload;
language persistence and view-state preservation; localized form validation;
automatic source defaults, manual overrides, draft retention and successful
submission to an explicit loopback fixture. Narrow-screen form buttons are
reachable by scrolling. Existing hostile-field escaping, inert HTML, image-only
captured SVG, no captured-URL fetch, body-decode limits and source-log tests pass.
Unknown capture directions, including object-prototype property names, safely
omit the flow diagram without throwing or changing the original record.

A language-menu regression reproduces WebKit-style `focusout(null)` between a
trusted mouse press and click. The old handler hid the option too early; the fix
passes pointer, Enter, arrow-key, Tab, Escape and outside-click checks.

An isolated WKWebView reproduced native select height at 20px versus a 34.8px
input. Normalized appearance and a shared minimum now give both 36px in light,
dark and 390px layouts, and both 54px at 150% zoom. A trusted native key selects
GoTLS in the retained real select. This is a WebKit harness check, not a full
application interaction test. The owner separately confirmed the Finder icon
and manual language switching in the macOS review app.

## Review images and reproducible evidence

The repository [overview](images/overview.png),
[protocol details](images/protocol-details.png) and
[source form](images/sources.png) screenshots are from the final smoke run;
[provenance](images/README.md) identifies the synthetic inputs. They contain no
real captures or private configuration.

`test/browser-smoke.mjs` accepts `SMOKE_ARTIFACT_DIR` for screenshots,
`SMOKE_REQUIRE_LIVE=1` for live pairing, and `SMOKE_SOURCE_ENDPOINT` for source-form
submission to an explicit numeric-loopback synthetic fixture. Local ignored logs
are `artifacts/ui-source-form-root.log` and `artifacts/ui-source-form-subpath.log`;
additional WebKit measurements/screenshots are in
`artifacts/source-controls-webkit/`. The latest review app's embedded HTML/CSS/JS
was checked against the source and the copied bundle passed ad-hoc signing checks.

## Limits

Full native save/cancel dialogs, system clipboard, external browser opening and
title-bar close were not verified through UI automation. Build, lifecycle,
adapter tests and the isolated WebKit harness do not substitute for those checks.
OS-owned dialog buttons follow the OS language. Windows/Linux desktop runtime,
other WebView versions and real Linux/Android probe E2E remain unexecuted.
No production capture service, Nginx installation, release or deployment was changed.
