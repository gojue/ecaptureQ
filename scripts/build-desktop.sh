#!/bin/sh
# Build on the target desktop OS. Cross compilation requires its native SDK.
set -eu
cd "$(dirname "$0")/.."
GOOS=$(go env GOHOSTOS) GOARCH=$(go env GOHOSTARCH) go run ./scripts/check-protocol
desktop_version=$(cat VERSION)
desktop_bundle_version=${desktop_version%%-*}
desktop_bundle_version=${desktop_bundle_version%%+*}
target_os=$(go env GOOS)
host_os=$(go env GOHOSTOS)
if [ "$target_os" != "$host_os" ]; then
  echo "Build the desktop app on its target OS (or configure a native SDK separately)." >&2
  exit 1
fi
mkdir -p dist
case "$target_os" in
  darwin)
    desktop_output=dist/eCaptureQ.app
    # Finder must never index a visible .app before its icon and plist exist.
    # Stage on the same volume, keeping the previous app on compilation failure.
    desktop_stage=$(mktemp -d dist/.ecaptureq-build.XXXXXX)
    trap 'rm -rf "$desktop_stage"' EXIT HUP INT TERM
    bundle="$desktop_stage/eCaptureQ.app"
    mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
    sh scripts/build-macos-icon.sh "$bundle/Contents/Resources/eCaptureQ.icns"
    # Prefer Apple's SDK-matched compiler over an unrelated clang on PATH.
    desktop_cc=${CC:-$(xcrun --find clang)}
    desktop_sdk=${SDKROOT:-$(xcrun --show-sdk-path)}
    # Keep SDK-default assembly objects and the final linker on the same target.
    # This is a build minimum, not a claim of runtime acceptance on macOS 12.
    MACOSX_DEPLOYMENT_TARGET=12.0 CGO_ENABLED=1 CC="$desktop_cc" SDKROOT="$desktop_sdk" \
      go build -trimpath -tags desktop,production -ldflags '-s -w -extldflags=-mmacosx-version-min=12.0' -o "$bundle/Contents/MacOS/eCaptureQ" ./cmd/desktop
    cp build/desktop/Info.plist "$bundle/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $desktop_bundle_version" "$bundle/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :ECaptureQVersion $desktop_version" "$bundle/Contents/Info.plist"
    # Launch Services uses the bundle modification time to detect metadata updates.
    touch "$bundle"
    # Never carry stale resources or an old code signature into a fresh build.
    rm -rf "$desktop_output"
    mv "$bundle" "$desktop_output"
    echo "Built $desktop_output ($desktop_version, sign the final bundle before distribution)."
    ;;
  windows)
    go build -trimpath -tags desktop,production -ldflags '-s -w -H windowsgui' -o dist/eCaptureQ.exe ./cmd/desktop
    echo "Built dist/eCaptureQ.exe ($desktop_version, requires WebView2)."
    ;;
  linux)
    CGO_ENABLED=1 go build -trimpath -tags desktop,production -ldflags '-s -w' -o dist/eCaptureQ ./cmd/desktop
    echo "Built dist/eCaptureQ ($desktop_version, requires GTK4 and WebKitGTK 6.0)."
    ;;
  *) echo "Unsupported desktop OS: $target_os" >&2; exit 1 ;;
esac
