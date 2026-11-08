This is the Go + Wails generation of eCaptureQ, with separate Web and Desktop
downloads for Linux, macOS and Windows (amd64 and arm64).

- `server` archives contain the standalone HTTP service; no desktop libraries are needed.
- `desktop` archives contain the native UI; macOS also includes a DMG. Linux needs
  GTK4 and WebKitGTK 6.0, and Windows needs WebView2.
- Verify downloads against `SHA256SUMS`. Each package contains `BUILD-INFO.json`
  with its version, source commit, target and actual signing status. macOS is
  signed/notarized only when the release signing secrets are configured;
  otherwise it is explicitly unsigned. Windows builds are currently unsigned.
- This replaces the old Tauri implementation and configuration format. SQL
  filtering, Android UI and the integrated collector launcher are not included.
  Configure an eCapture source again; no collector executable or capture data is bundled.
- Android and iOS packages are not available in this release; mobile support is
  undecided and separate from the six desktop targets.

See the included README and `docs/upgrade.md` for prerequisites and migration.
