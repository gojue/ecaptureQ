#!/bin/sh
# Synthetic browser integration only. Run on the designated validation VM after
# building both binaries there with the pinned public dependency (GOWORK=off).
set -eu
cd "$(dirname "$0")/.."
: "${E2E_RUN_DIR:?Set E2E_RUN_DIR to a new private validation directory}"
: "${CHROME_BIN:?Set CHROME_BIN to the validation VM browser}"
umask 077
mkdir "$E2E_RUN_DIR"
run=$(cd "$E2E_RUN_DIR" && pwd)
mkdir "$run/native"
pids=''
cleanup() {
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  for pid in $pids; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT HUP INT TERM
start() {
  name=$1
  shift
  "$@" >"$run/$name.log" 2>&1 &
  pids="$pids $!"
}
# Refuse occupied ports rather than inspecting or stopping unrelated processes.
python3 - <<'PY'
import socket
for port in [28258, 28259, 28359, 28360, 28361, 28362, 28363, 28364]:
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(('127.0.0.1', port))
PY
start text ./bin/ws-fixture --addr 127.0.0.1:28359 --module tls
start dynamic-text ./bin/ws-fixture --addr 127.0.0.1:28360 --module gotls
start keylog ./bin/ws-fixture --addr 127.0.0.1:28361 --format keylog --fragment-size 7 --module future-module
start pcapng ./bin/ws-fixture --addr 127.0.0.1:28362 --format pcapng --fragment-size 7 --module future-module
start partial-keylog ./bin/ws-fixture --addr 127.0.0.1:28363 --format keylog --fragment-size 7 --close-code 1011 --module future-module
start partial-pcapng ./bin/ws-fixture --addr 127.0.0.1:28364 --format pcapng --fragment-size 7 --close-code 1011 --module future-module
set -- --native-directory "$run/native" --max-native-mib 8 --max-native-sessions 1024 \
  --data-source ws://127.0.0.1:28359/ \
  --data-source ws://127.0.0.1:28361/ \
  --data-source ws://127.0.0.1:28362/ \
  --data-source ws://127.0.0.1:28363/ \
  --data-source ws://127.0.0.1:28364/
start web-root ./bin/ecaptureq-web --listen 127.0.0.1:28258 "$@"
start web-prefix ./bin/ecaptureq-web --listen 127.0.0.1:28259 --base-path /ecaptureq-web/ "$@"
python3 - <<'PY'
import time, urllib.request
for url in ['http://127.0.0.1:28258/api/health', 'http://127.0.0.1:28259/ecaptureq-web/api/health']:
    for attempt in range(100):
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    break
        except OSError:
            pass
        time.sleep(.1)
    else:
        raise RuntimeError('Validation Web server did not start: ' + url)
PY
export SMOKE_NATIVE=1 SMOKE_SOURCE_ENDPOINT=ws://127.0.0.1:28360/
node test/browser-smoke.mjs http://127.0.0.1:28258/ >"$run/browser-root.log" 2>&1
node test/browser-smoke.mjs http://127.0.0.1:28259/ecaptureq-web/ >"$run/browser-prefix.log" 2>&1
printf 'Browser checks passed; logs: %s\n' "$run"
