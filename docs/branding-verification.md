# eCaptureQ branding verification — 2026-11-08

Baseline: `65795e1` (`v1.0.0`); branch `codex/ecaptureq-branding-readme`.

## Assets and documentation

The supplied `frontend/ecaptureq-logo` SVG/PNG family is preserved unchanged,
including its preview variants. The transparent SVG is used by the shared UI,
favicon, loading screen, README, macOS ICNS generator and Linux package icon.
The matching PNG supplies Wails application metadata and Windows icon resources.
The original upstream `ecapture-logo.svg` remains intact.

Windows builds now generate a multi-size ICO and architecture-specific resource
with the pinned Wails v3.1.0 CLI. Temporary resources are removed after success
or failure; an existing resource is not overwritten. The app module is unchanged.

The README follows the official website's product overview: eCapture captures
and decrypts; eCaptureQ connects, correlates and displays application messages.
The website concept illustration is copied unchanged, with its MIT license and
[provenance](images/README.md). It is separate from the three actual Web UI
screenshots, refreshed using bundled mock data and a local synthetic source.
Release archives include the relative README images and their license.

## Executed checks

Environment: macOS arm64, Go 1.26.0, Node.js 24.14.1, system Chrome and Xcode.
Go checks and builds used `GOWORK=off`.

- Go race tests and vet passed; official Event fields 18–20 gate passed.
- All 60 Node tests and frontend/test JavaScript syntax checks passed.
- All 39 Python packaging, signing, icon and release tests passed.
- Shell syntax, version consistency and diff whitespace checks passed.
- Web production build and browser smoke passed at `/` and `/ecaptureq-web/`,
  with synthetic live input and source-form submission. This includes light/dark
  themes, both languages, logo loading, protocol views, export and security checks.
- The macOS production app built and passed ad-hoc signature verification.
  Its generated ICNS was decoded and visually checked against the supplied logo.
- The native process started, connected to the synthetic WebSocket source,
  opened no TCP listener, and exited with code 0 after SIGTERM; the source
  connection closed.
- Windows amd64 and arm64 resource objects were generated with the actual
  pinned tool and identified as the corresponding COFF architectures.
- README relative links, concept-image bytes and original license were checked.

Browser review images and synthetic logs are ignored local artifacts under
`artifacts/branding/`. The three selected screenshots are in `docs/images/`.

## Limits

Native UI automation was unavailable because Computer Use permissions were not
granted. Save/cancel dialogs, clipboard, external links and title-bar close were
not clicked in the native app; process lifecycle checks do not replace them.
Windows/Linux desktop runtime, Linux container installation, macOS Intel startup
and real Linux/Android probe E2E were not run. No release, deployment, external
capture service, commit or push was performed.
