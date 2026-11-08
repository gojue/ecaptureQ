#!/bin/sh
# Generate native Windows resources from the shared PNG, using pinned Wails tools.
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -ne 2 ]; then
  echo 'Usage: sh scripts/build-windows-icon.sh amd64|arm64 output.syso' >&2
  exit 1
fi
case "$1" in
  amd64|arm64) ;;
  *) echo "Unsupported Windows architecture: $1" >&2; exit 1 ;;
esac
icon_work=$(mktemp -d "${TMPDIR:-/tmp}/ecaptureq-windows-icon.XXXXXX")
trap 'rm -rf "$icon_work"' EXIT HUP INT TERM
# The generator runs on the build host even when producing another CPU's resource.
icon_host_os=$(go env GOHOSTOS)
icon_host_arch=$(go env GOHOSTARCH)
GOOS="$icon_host_os" GOARCH="$icon_host_arch" GOWORK=off \
  go run github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0 generate icons \
  -input frontend/ecaptureq-logo.png -windowsfilename "$icon_work/eCaptureQ.ico" -macfilename ''
GOOS="$icon_host_os" GOARCH="$icon_host_arch" GOWORK=off \
  go run github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0 generate syso \
  -arch "$1" -icon "$icon_work/eCaptureQ.ico" -manifest build/windows/eCaptureQ.manifest \
  -out "$icon_work/eCaptureQ.syso"
mkdir -p "$(dirname "$2")"
cp "$icon_work/eCaptureQ.syso" "$2"
