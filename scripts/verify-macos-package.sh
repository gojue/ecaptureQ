#!/bin/bash
# Exercise the same downloaded universal bundle on native Intel/Apple Silicon CI.
set -euo pipefail
packages=${1:-dist/packages}
native_arch=${2:-$(uname -m)}
case "$native_arch" in x86_64|arm64) ;; *) echo 'Unsupported native Mac CPU.' >&2; exit 1 ;; esac
test "$(uname -m)" = "$native_arch"
version=$(cat VERSION)
installed=$(mktemp -d "${TMPDIR:-/tmp}/ecaptureq-install.XXXXXX")
trap 'rm -rf "$installed"' EXIT
for product in ecaptureq ecaptureq-web; do
  archive="$product-$version-macos-universal.zip"
  (cd "$packages" && shasum -a 256 -c "$archive.sha256")
  ditto -x -k "$packages/$archive" "$installed"
done
app="$installed/ecaptureq-$version-macos-universal/eCaptureQ.app"
web="$installed/ecaptureq-web-$version-macos-universal/ecaptureq-web"
# A single architecture per invocation works with older and newer Xcode lipo.
for cpu in x86_64 arm64; do
  lipo "$app/Contents/MacOS/eCaptureQ" -verify_arch "$cpu"
  lipo "$web" -verify_arch "$cpu"
done
codesign --verify --all-architectures --deep --strict "$app"
codesign --verify --all-architectures --strict "$web"
arch -"$native_arch" "$app/Contents/MacOS/eCaptureQ" --help
arch -"$native_arch" "$web" --help
echo "Downloaded universal app and Web CLI passed native startup: $native_arch"
