#!/bin/bash
# Run only inside an ephemeral native-architecture Ubuntu/Fedora CI container.
set -euo pipefail
format=$1
arch=$2
case "$format:$arch" in deb:amd64|deb:arm64|rpm:amd64|rpm:arm64) ;; *) exit 2 ;; esac
version=$(cat VERSION)
web="/packages/ecaptureq-web-$version-linux-$arch.$format"
app="/packages/ecaptureq-$version-linux-$arch.$format"
if [ "$format" = deb ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends "$web" curl python3 desktop-file-utils
  if dpkg-query -W -f='${Status}' libgtk-4-1 2>/dev/null | grep -q 'install ok installed'; then
    echo 'Web installation unexpectedly required GTK.' >&2; exit 1
  fi
  test "$(dpkg-deb -f "$app" Architecture)" = "$arch"
  if [[ "$version" == *-* ]]; then
    dpkg --compare-versions "$(dpkg-deb -f "$app" Version)" lt "${version%%-*}"
  fi
else
  dnf install -y "$web" curl-minimal python3 desktop-file-utils
  if rpm -q gtk4 >/dev/null 2>&1; then echo 'Web installation unexpectedly required GTK.' >&2; exit 1; fi
  rpm_arch=x86_64
  if [ "$arch" = arm64 ]; then rpm_arch=aarch64; fi
  test "$(rpm -qp --queryformat '%{ARCH}' "$app")" = "$rpm_arch"
fi
# No service is auto-started. Exercise the installed Web executable explicitly.
ecaptureq-web --help >/dev/null
python3 - <<'PY'
import json, subprocess, time, urllib.request
process = subprocess.Popen(['ecaptureq-web', '--mode', 'mock', '--addr', '127.0.0.1:28257'])
try:
    for attempt in range(100):
        if process.poll() is not None:
            raise RuntimeError('Installed Web executable stopped unexpectedly')
        try:
            with urllib.request.urlopen('http://127.0.0.1:28257/api/health', timeout=1) as response:
                assert response.status == 200
            break
        except OSError:
            time.sleep(.1)
    else:
        raise RuntimeError('Installed Web interface did not become healthy')
finally:
    process.terminate()
    process.wait(timeout=15)
assert process.returncode == 0, process.returncode
PY
if [ "$format" = deb ]; then
  apt-get install -y --no-install-recommends "$app"
else
  dnf install -y "$app"
fi
ldd /usr/bin/ecaptureq > /tmp/ecaptureq-ldd.txt
if grep -q 'not found' /tmp/ecaptureq-ldd.txt; then cat /tmp/ecaptureq-ldd.txt; exit 1; fi
# Parses flags before opening a WebView; validates the installed native loader.
ecaptureq --help >/dev/null
desktop-file-validate /usr/share/applications/ecaptureq.desktop
python3 - <<'PY'
import json
from pathlib import Path
for product, kind in [('ecaptureq', 'desktop'), ('ecaptureq-web', 'server')]:
    docs = Path('/usr/share/doc') / product
    info = json.loads((docs / 'BUILD-INFO.json').read_text())
    assert info['kind'] == kind and info['os'] == 'linux'
    assert (docs / 'frontend/ecapture-logo.svg').is_file()
    assert len(list((docs / 'docs/images').glob('*.png'))) == 3
PY
mkdir -p "$HOME/.config/ecaptureq"
printf 'preserve user data\n' > "$HOME/.config/ecaptureq/install-test-marker"
if [ "$format" = deb ]; then
  apt-get remove -y ecaptureq ecaptureq-web
else
  dnf remove -y ecaptureq ecaptureq-web
fi
test ! -e /usr/bin/ecaptureq
test ! -e /usr/bin/ecaptureq-web
test -f "$HOME/.config/ecaptureq/install-test-marker"
echo "Install, dependencies, Web health, native loader and uninstall passed: $format/$arch"
