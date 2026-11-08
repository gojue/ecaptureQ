#!/bin/sh
# Rasterize the shared official SVG with the macOS SDK; no external image tools.
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -ne 1 ]; then
  echo 'Usage: sh scripts/build-macos-icon.sh output.icns' >&2
  exit 1
fi
if [ "$(uname -s)" != Darwin ]; then
  echo 'macOS icon generation requires macOS and Xcode/Command Line Tools.' >&2
  exit 1
fi
icon_work=$(mktemp -d "${TMPDIR:-/tmp}/ecaptureq-icon.XXXXXX")
trap 'rm -rf "$icon_work"' EXIT HUP INT TERM
xcrun --sdk macosx clang -fobjc-arc -framework AppKit \
  scripts/macos-icon.m -o "$icon_work/render-icon"
mkdir "$icon_work/eCaptureQ.iconset"
"$icon_work/render-icon" frontend/ecapture-logo.svg "$icon_work/eCaptureQ.iconset"
iconutil -c icns "$icon_work/eCaptureQ.iconset" -o "$icon_work/eCaptureQ.icns"
mkdir -p "$(dirname "$1")"
cp "$icon_work/eCaptureQ.icns" "$1"
