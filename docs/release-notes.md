This is the Go + Wails generation of eCaptureQ, with separate Web and Desktop
downloads for Linux, macOS and Windows (amd64 and arm64).

- `server` archives contain the standalone HTTP service; no desktop libraries are needed.
- `desktop` archives contain the native UI; macOS also includes a DMG. Linux needs
  GTK4 and WebKitGTK 6.0, and Windows needs WebView2.
- Verify downloads against `SHA256SUMS`. Each package contains `BUILD-INFO.json`
  with its version, source commit, target, actual signing status and notarization
  flag. macOS desktop packages default to free ad-hoc signing (`signing: adhoc`,
  `notarized: false`); they have no Apple-authenticated developer identity and are
  not notarized. Windows builds are currently unsigned.
- On first launch of the macOS app, verify the download source and checksum. If
  macOS blocks the app because its developer cannot be verified, use System
  Settings → Privacy & Security → Open Anyway and confirm the specific app.
  Managed Macs may restrict this option. See [Apple's opening instructions](https://support.apple.com/en-us/102445).
- This replaces the old Tauri implementation and configuration format. SQL
  filtering, Android UI and the integrated collector launcher are not included.
  Configure an eCapture source again; no collector executable or capture data is bundled.
- Android and iOS packages are not available in this release; mobile support is
  undecided and separate from the six desktop targets.

See the included README and `docs/upgrade.md` for prerequisites and migration.
