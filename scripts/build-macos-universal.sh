#!/bin/sh
# One macOS SDK builds both CPU slices; no Rosetta is required to build.
set -eu
cd "$(dirname "$0")/.."
if [ "$(go env GOHOSTOS)" != darwin ]; then
  echo 'Universal macOS builds require macOS and Xcode.' >&2
  exit 1
fi
mkdir -p dist/macos bin
server_version=$(cat VERSION)
for target_arch in amd64 arm64; do
  GOARCH="$target_arch" sh scripts/build-desktop.sh
  rm -rf "dist/macos/$target_arch.app"
  mv dist/eCaptureQ.app "dist/macos/$target_arch.app"
  CGO_ENABLED=0 GOARCH="$target_arch" go build -trimpath -ldflags "-s -w -X github.com/gojue/ecaptureq/internal/version.Version=$server_version" \
    -o "bin/ecaptureq-web-macos-$target_arch" ./cmd/server
done
python3 scripts/merge-macos.py --amd64 dist/macos/amd64.app --arm64 dist/macos/arm64.app --output dist/eCaptureQ.app
rm -f bin/ecaptureq-web-macos-universal
python3 scripts/merge-macos.py --amd64 bin/ecaptureq-web-macos-amd64 --arm64 bin/ecaptureq-web-macos-arm64 --output bin/ecaptureq-web-macos-universal
codesign --force --sign - --timestamp=none bin/ecaptureq-web-macos-universal
codesign --verify --all-architectures --strict bin/ecaptureq-web-macos-universal
