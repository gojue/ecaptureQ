Download **eCaptureQ** to open the application directly. Choose **eCaptureQ Web**
only when you want to host the interface and use it through a browser.
Neither package includes or launches the eCapture collector.

## What's new in v1.1.0

- Optional Web sign-in, logout, expiring sessions and login rate limiting; generate
  password hashes with `ecaptureq-web --hash-password`. Desktop does not use Web auth.
- Startup notifications for newer stable GitHub releases, with no automatic installation.
- Configurable page header and hidden-domain filtering; change-driven long polling
  reduces idle requests and unnecessary workspace refreshes.
- Linux LoongArch (`loong64`) DEB/RPM downloads for eCaptureQ Web only.
- Refreshed branding and one-click language switching; increased per-record payload
  cap from 256 KiB to 256 MiB, while frame and total retention limits still apply.
- More reliable browser navigation and shutdown in CI smoke tests.

## Upgrading from v1.0.0

- Rename eCaptureQ CLI flags: `--addr` → `--listen`, `--ecaptureq` → `--data-source`.
  The old names are no longer accepted. The upstream `ecapture --ecaptureq` flag
  is unchanged.
- Convert the `--sources` JSON array to an object with a `sources` field, e.g.
  `[]` → `{"sources":[]}`. Optional fields are `headerCenter`, `hiddenDomains` and `auth`.
- Web remains unauthenticated when `auth` is omitted. The bundled example enables
  login with the public account `ecapture` / `ecaptureQ`; replace its password
  before deployment. Secure cookies require HTTPS by default; local HTTP testing
  requires an explicit `auth.secureCookie: false`.

See the [changelog](https://github.com/gojue/ecaptureQ/blob/main/CHANGELOG.md) and
[upgrade guide](https://github.com/gojue/ecaptureQ/blob/main/docs/upgrade.md) for details.

<!-- downloads -->

- macOS uses one universal app for Intel and Apple Silicon. The DMG is the normal
  installer; ZIP is an optional portable download. The Web CLI is also universal.
- Linux DEB/RPM installers add `ecaptureq` or `ecaptureq-web` to PATH. The app also
  appears in the applications menu. Install with `sudo apt install ./file.deb`
  or `sudo dnf install ./file.rpm`; dependencies are resolved by the package manager.
  Desktop packages target Ubuntu 24.04 / Fedora 43 or compatible newer libraries.
  Web packages do not require a graphical desktop and do not auto-start a service.
- Windows ZIP contains the executable; the desktop app requires WebView2.
- Verify files against the single `SHA256SUMS`. `BUILD-INFO.json` records version,
  source commit, architecture and actual signing status. Linux metadata and docs
  are installed under `/usr/share/doc/ecaptureq` or `/usr/share/doc/ecaptureq-web`.
- macOS defaults to ad-hoc signing (`signing: adhoc`, `notarized: false`), without
  Apple-authenticated developer identity or notarization. If the first launch is
  blocked, verify the source and checksum, then use System Settings → Privacy &
  Security → Open Anyway for this app. [Apple's instructions](https://support.apple.com/en-us/102445).
- Web starts with `ecaptureq-web --listen 127.0.0.1:28257`; visit that address in a
  browser. For ZIP downloads run the executable from the extracted directory.
- The previous Tauri implementation is replaced. Legacy SQL filtering, integrated
  collector launch and Android UI are not included. Android/iOS targets remain
  undecided. Existing release files and tags are unchanged.

See README and `docs/upgrade.md` for source connection, prerequisites and migration.
