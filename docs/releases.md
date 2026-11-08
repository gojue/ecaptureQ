# CI, builds and releases

The Go/Wails implementation has three workflows. It does not run Cargo, Tauri,
pnpm, protoc, Android builds or download an eCapture probe binary.

| Workflow | Trigger | Result |
| --- | --- | --- |
| `CI` (`ci.yml`) | Branch push, pull request, manual, reusable call | Version, Node, Python packaging gates, official protobuf schema, Go race/vet and browser regressions; then build artifacts |
| `Build packages` (`build.yml`) | Called by CI/release, or manually | Native desktop builds and pure Go servers, package checksums and a combined `release-bundle` artifact |
| `Release` (`release.yml`) | Push of a `v*` tag | Matching-version gate, CI, release builds, checksum verification, GitHub Release with assets and generated notes |

PR and branch checks use read-only repository permissions. They neither publish
releases nor receive signing secrets. Only the final tag publication job has
`contents: write`. There are no automatic PR comments, deployments or probe changes.
Official actions are pinned by commit; the workflow validator is actionlint 1.7.12.
All Go jobs set `GOWORK=off` and `GOFLAGS=-mod=readonly`.

## Artifact matrix

Every matrix entry produces both amd64 and arm64 artifacts:

| OS | Web server | Desktop | Build environment |
| --- | --- | --- | --- |
| Linux | tar.gz | tar.gz | Ubuntu 24.04, native amd64/arm64 for desktop |
| macOS (`darwin`) | ZIP | App bundle ZIP and DMG | macOS 15 Intel/Apple Silicon |
| Windows | ZIP | Portable EXE ZIP | Windows 2025 amd64 / Windows 11 arm64 |

Web binaries use `CGO_ENABLED=0` and need no desktop SDK or libraries. Linux
desktop needs GTK4 and WebKitGTK 6.0 at runtime (for Ubuntu 24.04,
`libgtk-4-1 libwebkitgtk-6.0-4`); Windows desktop needs WebView2. macOS builds set
a 12.0 minimum, but older OS versions still require runtime acceptance. These
are Wails artifacts; old MSI/AppImage/APK formats are not carried forward.

Names follow `ecaptureq-VERSION-KIND-OS-ARCH.EXT`. Each archive contains the
selected executable/app, public documentation, LICENSE/NOTICE, placeholder source
configuration, `INSTALL.txt` and `BUILD-INFO.json`. No capture, local config or
collector is included. Build metadata records target, commit and signing status.

Each artifact has a `.sha256` file. Collection requires all 14 archives/images,
rejects unexpected/missing assets and verifies every hash before generating
`SHA256SUMS`. Download `release-bundle` from the Actions run page; CI artifacts
expire after 7 days. Release assets remain on the Release page.

## Publishing a version

1. Update `VERSION`, `package.json` and `build/desktop/Info.plist` together.
   `ECaptureQVersion` is the full semantic version, while
   `CFBundleShortVersionString` is numeric major.minor.patch. Update
   `CFBundleVersion` when the macOS build number changes.
2. Run `make check`, `make release-check`, native builds and the relevant runtime
   acceptance. Check the branch's hosted CI and downloadable packages.
3. After deciding to publish, push a `v`-prefixed tag matching `VERSION` on the
   intended commit. For example, VERSION `1.0.0-alpha.1` requires tag
   `v1.0.0-alpha.1`. The workflow checks an existing tag and never creates one.
4. `Release` runs validation and builds before creating the release. A version
   with a SemVer prerelease suffix is marked prerelease and not latest; a stable
   version is marked latest. Notes combine `docs/release-notes.md` and GitHub's
   generated changelog. Review that file when the product's release scope changes.

Rerunning validation/build jobs is safe. Publication deliberately does not replace
assets of an existing release. If publication failed partway through, inspect the
existing release before deciding how to finish it; do not delete tags or overwrite
published files blindly. This development update does not create a tag or release.

## macOS signing and notarization

Tag builds can reuse the existing repository secrets:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application P12.
- `APPLE_CERTIFICATE_PASSWORD`: P12 password.
- `APPLE_SIGNING_IDENTITY`: full `Developer ID Application: ...` identity.
- `APPLE_ID`, `APPLE_PASSWORD`: Apple ID and app-specific notarization password.
- `APPLE_TEAM_ID`: developer team ID.

With all six set, `scripts/sign-macos.sh` creates a temporary private keychain,
signs with hardened runtime, submits via `notarytool`, waits up to 30 minutes and
staples the accepted ticket before packaging. It verifies the signature/ticket
again and deletes temporary certificates, credentials and keychain on exit.
Neither PR nor branch builds run this step. Complete absence of signing settings
produces explicitly **unsigned** packages; a partial setup fails to avoid silently
downgrading a configured signing pipeline. `BUILD-INFO.json` and the job summary
report the actual result.

Windows code signing and Linux package signing are not configured. No Apple secret
was retrieved and no notarization or actual Release publication was performed
during development. Native window, clipboard, file dialog and real probe checks
remain separate acceptance work even when compilation and packaging pass.

## Local packaging

```sh
GOWORK=off make server desktop
python3 scripts/package-release.py --kind server --os darwin --arch arm64
python3 scripts/package-release.py --kind desktop --os darwin --arch arm64 --dmg
```

Use the actual target and an already-built binary; `--binary` can select a
cross-compiled server. The packager checks embedded Go target metadata and fails
on architecture mismatches. `dist/packages/` is ignored. The collection gate is
intended for a complete matrix, not a single local package.

References: [GitHub hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Wails platform prerequisites](https://v3.wails.io/getting-started/installation/),
[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
