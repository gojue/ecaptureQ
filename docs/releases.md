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

The user-facing products are **eCaptureQ** (the default desktop download) and
**eCaptureQ Web** (browser deployment). Internal Go entries remain `cmd/desktop`
and `cmd/server`; they do not imply separate collector products.

| OS | eCaptureQ | eCaptureQ Web | Build / installation validation |
| --- | --- | --- | --- |
| Linux amd64 / arm64 | DEB and RPM | DEB and RPM, no GUI dependencies | Native Ubuntu 24.04 build; clean Ubuntu 24.04 and Fedora 43 install/remove checks on each CPU |
| macOS universal | DMG and optional ZIP | ZIP | One Xcode SDK builds Intel + Apple Silicon slices; merged packages execute on both native runner types |
| Windows amd64 / arm64 | Portable EXE ZIP | ZIP | Windows 2025 amd64 / Windows 11 arm64 |

Names are `ecaptureq-VERSION-OS-ARCH.EXT` and
`ecaptureq-web-VERSION-OS-ARCH.EXT`. The public OS spelling is `macos`, and its
architecture is always `universal`; users need not select a Mac CPU. Other
platforms retain `amd64` / `arm64`. There are **15 packages plus SHA256SUMS**.
Per-file `.sha256` sidecars are used internally between CI jobs and omitted from
public downloads. Collection verifies all expected files and their hashes, then
copies only public packages and the aggregate manifest to `release-bundle`.
A later publication check verifies that manifest again, without regenerating a
corrupted one. No old alpha.2 asset or tag is renamed or replaced.

Each package contains public documentation, LICENSE/NOTICE, placeholder source
configuration, `INSTALL.txt` and `BUILD-INFO.json`. Metadata records the source
commit, internal kind, OS, architecture and signing status. Universal packages
also record `architectures: ["amd64", "arm64"]`; validation extracts both slices
and checks their Go metadata. Merge inputs must have matching app resources and
version metadata. Final signing happens **after** `lipo`, and verification covers
every architecture. The Web executable is also ad-hoc signed after merging.

Linux packages are produced with **nFPM v2.48.0**, installed using Go **1.26.10**
as a build tool independently of the application module. They install
`/usr/bin/ecaptureq` or `/usr/bin/ecaptureq-web`; desktop packages also install the
application-menu entry and official SVG icon. Documentation and metadata live in
`/usr/share/doc/ecaptureq` or `/usr/share/doc/ecaptureq-web`. They can coexist;
there are no install scripts, systemd activation, collector binaries or user
configuration changes. Uninstall leaves user-owned configuration untouched.

Desktop DEB dependencies require glibc 2.39+, GTK 4.14+, GLib 2.80+ and WebKitGTK
2.44+ (6.0 API). RPM uses the corresponding Fedora package names and the same
version floors; testing on Fedora 43 does not establish compatibility with older
RHEL/CentOS. Clean-container checks enable documentation retention (minimal container images
otherwise discard it), then install Web first without GTK, check its HTTP
health and shutdown, install the app with dependencies, check dynamic linking,
`--help`, menu metadata and uninstall. They are not graphical-session acceptance.
Windows needs WebView2. macOS retains a 12.0 build minimum; older OS versions still
need runtime validation. Android/iOS are undecided targets.

CI artifacts expire after 7 days; published Release assets remain available.

## Publishing a version

1. Update `VERSION`, `package.json` and `build/desktop/Info.plist` together.
   `ECaptureQVersion` is the full semantic version, while
   `CFBundleShortVersionString` is numeric major.minor.patch. Update
   `CFBundleVersion` when the macOS build number changes.
2. Run `make check`, `make release-check`, native builds and the relevant runtime
   acceptance. Check the branch's hosted CI and downloadable packages.
3. After deciding to publish, push a `v`-prefixed tag matching `VERSION` on the
   intended commit. For example, VERSION `1.0.0-alpha.3` requires tag
   `v1.0.0-alpha.3`. The workflow checks an existing tag and never creates one.
4. `Release` runs validation and builds before creating the release. A version
   with a SemVer prerelease suffix is marked prerelease and not latest; a stable
   version is marked latest. Notes combine `docs/release-notes.md` and GitHub's
   generated changelog. Review that file when the product's release scope changes.

The repository's default branch is `main`. After the reviewed changes have been
committed and merged, use a clean checkout of that branch to tag the reviewed
commit. **Creating a local tag alone does not start GitHub Actions**: the tag must
be pushed to `origin`. For the current `1.0.0-alpha.3` version:

```sh
git fetch origin main
git switch main
git pull --ff-only origin main
git status --short
python3 scripts/check-version.py --tag v1.0.0-alpha.3
# Run these two commands only when ready to publish the reviewed version:
git tag -a v1.0.0-alpha.3 -m "eCaptureQ v1.0.0-alpha.3"
git push origin refs/tags/v1.0.0-alpha.3
```

The published `v1.0.0-alpha.2` remains unchanged. This branch prepares
`1.0.0-alpha.3`; no new tag is created by changing version files or opening a PR.

If choosing another version, update all version files before committing and use
the matching tag instead. Do not reuse or overwrite an existing release tag. On
the [Actions page](https://github.com/gojue/ecaptureQ/actions/workflows/release.yml),
check that the `Release` run points to the intended commit and that `publish`
completes. All six desktop platform/architecture pairs must succeed before the
release is published; a partial platform matrix is not accepted.

Rerunning validation/build jobs is safe. Publication deliberately does not replace
assets of an existing release. If publication failed partway through, inspect the
existing release before deciding how to finish it; do not delete tags or overwrite
published files blindly. This development update does not create a tag or release.

## macOS signing modes

The default is **`adhoc`**, for both CI packages and tag releases. The optional
Developer ID mode applies to the desktop app; the universal Web CLI stays ad-hoc. This mode uses
macOS `codesign` with the ad-hoc identity `-`, verifies the executable and app
bundle, then creates ZIP/DMG artifacts. It needs no Apple certificate, developer
membership or signing secrets and does not call Apple's notarization service.
The macOS job does not inject Apple secrets into the ad-hoc signing step, even
if old or expired secrets remain configured in the repository.

`BUILD-INFO.json` records `signing: "adhoc"` and `notarized: false`. This describes
signature integrity only: it does not identify an Apple-verified developer or
make Gatekeeper automatically trust the app. The package's `INSTALL.txt` and
[README](../README.md) explain first launch. After verifying the repository source
and SHA-256 checksum, a user whose first launch is blocked can use System
Settings → Privacy & Security → Open Anyway for this app, then confirm. Managed
Macs may disallow this exception. Do not assume that a newer ad-hoc build inherits
previous launch exceptions or system permissions. See [Apple's instructions](https://support.apple.com/en-us/102445).

The reusable `Build packages` workflow accepts the string input
`macos-signing-mode`, defaulting to `adhoc`. Branch/PR CI and manual builds use
ad-hoc signing without Apple secrets. The `Release` workflow reads the repository
**Actions variable** `MACOS_SIGNING_MODE`; leaving it unset selects `adhoc`.
The presence of `APPLE_*` secrets never selects a signing mode automatically.

### Optional Developer ID signing

To restore Apple-authenticated signing and notarization, explicitly set
`MACOS_SIGNING_MODE=developer-id` under the repository's Actions variables and
provide all six valid secrets below. This mode is restricted to pushed version
tags. Renew the required Apple membership/certificate and verify the identity
before enabling it; expired credentials from the previous release attempt are
not sufficient.

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application P12, including its private key.
- `APPLE_CERTIFICATE_PASSWORD`: P12 password.
- `APPLE_SIGNING_IDENTITY`: full `Developer ID Application: ...` identity.
- `APPLE_ID`, `APPLE_PASSWORD`: Apple ID and app-specific notarization password.
- `APPLE_TEAM_ID`: developer team ID.

With explicit `developer-id` mode and complete credentials,
`scripts/sign-macos.sh` uses a temporary private keychain, signs with hardened
runtime, submits via `notarytool`, waits up to 30 minutes and staples the accepted
ticket before packaging. The signer and packager verify the signature/ticket.
Successful desktop packages record `signing: "notarized"` and `notarized: true`.
Missing or invalid credentials, signature errors or notarization errors fail the
release; this explicit mode never silently falls back to ad-hoc signing.

Secret names only confirm configuration presence. They do not prove that a P12
contains a usable private key, the certificate is valid, the identity matches,
or Apple will accept a notarization submission. Real Developer ID signing and
notarization still require separate validation when that mode is re-enabled.
Windows code signing and Linux package signing are not configured. Native window,
clipboard, file dialog and real probe checks remain separate acceptance work
even when compilation, signing integrity and packaging pass.

## Verify without publishing

```sh
python3 scripts/check-version.py --tag v1.0.0-alpha.3
python3 -B -m unittest discover -s test -p '*_test.py'
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -shellcheck=''
```

The version check validates the proposed tag without creating one. The unit tests
cover version mismatch, missing/corrupted archives, and packaging boundaries;
actionlint checks workflow syntax and reusable-call inputs. A successful branch
CI also exercises the same six-target build matrix and complete-artifact checksum
gate used by tag releases. The manual `Build packages` action can rebuild these
ad-hoc-signed macOS and other platform artifacts without publishing. These checks
do not establish Gatekeeper trust or Apple notarization. Actual Developer ID
signing/notarization is only exercised by a tag release explicitly selecting
that mode; the final GitHub Release API call also needs an authorized tag release.

## Local packaging

```sh
# macOS: one SDK creates both architecture slices, then merges them.
GOWORK=off sh scripts/build-macos-universal.sh
bash scripts/sign-macos.sh dist/eCaptureQ.app adhoc
python3 scripts/package-release.py --kind desktop --os darwin --arch universal --signing adhoc --dmg
python3 scripts/package-release.py --kind server --os darwin --arch universal --binary bin/ecaptureq-web-macos-universal --signing adhoc

# Linux: compile on the target CPU with its GTK/WebKit development libraries.
GOTOOLCHAIN=go1.26.10 go install github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.48.0
GOWORK=off sh scripts/build-desktop.sh
python3 scripts/package-release.py --kind desktop --os linux --arch amd64
# Default Linux output is DEB + RPM. Use --linux-format deb or rpm to select one.
```

Use the actual target and an already-built binary; `--binary` can select a
cross-compiled server. The packager checks embedded Go target metadata and fails
on architecture mismatches. `dist/packages/` is ignored. The collection gate is
intended for a complete matrix, not a single local package.

References: [GitHub hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Wails platform prerequisites](https://v3.wails.io/getting-started/installation/),
[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

Packaging references: [nFPM configuration](https://nfpm.goreleaser.com/docs/configuration/),
[Apple universal binaries](https://developer.apple.com/documentation/apple-silicon/building-a-universal-macos-binary).
