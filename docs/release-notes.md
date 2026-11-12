Download **eCaptureQ** to open the application directly. Choose **eCaptureQ Web**
only when you want to host the interface and use it through a browser.
Neither package includes or launches the eCapture collector.

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
  undecided. Existing alpha.2 release files and tags are unchanged.

See README and `docs/upgrade.md` for source connection, prerequisites and migration.
