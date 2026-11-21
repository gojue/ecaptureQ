Download **eCaptureQ** to open the application directly. Choose **eCaptureQ Web**
only when you want to host the interface and use it through a browser.
Neither package includes or launches the eCapture collector.

## What's new in v1.2.0

- Live sources now use the official Protobuf v2 protocol. When upgrading from
  v1.1.0, start the eCapture v2.12.0 collector with `--stream-listen` and
  connect eCaptureQ to its WebSocket URL.
- KEYLOG and PCAPNG streams can now be exported in their native formats.

Packages now omit documentation and configuration examples. macOS desktop ZIP
contains only the app; DMG also includes the Applications shortcut. Other packages
retain the executable, licenses and build metadata, plus Linux desktop integration.

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
- Verify files against the single `SHA256SUMS`. `BUILD-INFO.json` (inside `eCaptureQ.app/Contents/Resources/Distribution/` on macOS desktop) records version,
  source commit, architecture and actual signing status. Linux metadata
  is installed under `/usr/share/doc/ecaptureq` or `/usr/share/doc/ecaptureq-web`.
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
