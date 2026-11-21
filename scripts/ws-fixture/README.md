# Synthetic Protobuf v2 WebSocket source

This helper sends **invented validation data, not captured traffic** through the
official `protobuf/gen/v2` types. It never attaches a probe, executes displayed
commands, or contacts captured URLs. See [dependency status](../../docs/upstream-status.md).
For this migration, run fixtures, builds and browser checks only on the designated
validation VM.

```sh
GOWORK=off go run ./scripts/ws-fixture --addr 127.0.0.1:28359
# Reconnect after five formatted HTTP request/response pairs:
GOWORK=off go run ./scripts/ws-fixture --addr 127.0.0.1:28360 --disconnect-after 5
# Fragmented native streams, each connection gets a fresh independent artifact:
GOWORK=off go run ./scripts/ws-fixture --addr 127.0.0.1:28361 --format keylog --fragment-size 7
GOWORK=off go run ./scripts/ws-fixture --addr 127.0.0.1:28362 --format pcapng --fragment-size 7
# Valid bytes followed by an abnormal close must remain partial:
GOWORK=off go run ./scripts/ws-fixture --addr 127.0.0.1:28363 --format keylog --close-code 1011
GOWORK=off go run ./scripts/ws-fixture --addr 127.0.0.1:28364 --format pcapng --close-code 1011
```

Connect to `ws://127.0.0.1:<port>/`. The default root path matches eCapture.
Use `--path` only when explicitly testing a custom path, and configure the client
with the same path. The server requires `ecapture.v2` and an Origin, and sends binary Protobuf messages. `--module`
sets the upstream module independently of the source label. `--close-code 0` closes
the transport without a Close frame; `1000` is the default normal close.

TEXT connections receive three initial HTTP pairs followed by a pair each second,
rotating generated PNG, gzip JSON and ordinary JSON. Payloads include the ordinary
SDK formatted header and preserve application bytes, argv (including NULs) and a
complete synthetic TLS map. All fingerprints are explicitly synthetic. Logs and
heartbeats use separate protocol variants.

KEYLOG contains an explicitly fictional NSS record. PCAPNG is a valid empty
section with an Ethernet interface; it intentionally contains no real packets or
secrets. Seven-byte fragments split line and block boundaries. A normal close can
complete a valid empty capture; completion does not imply packets were captured or
that TLS decryption is possible. Real E2E separately checks EPB/DSB and decrypted
request/response markers.

Run `SMOKE_NATIVE=1 node test/browser-smoke.mjs <base-url>` with all four native
sources and a TEXT source configured to check UI state, actual download byte
identity, partial filenames and reconnect generations. Run at both `/` and
`/ecaptureq-web/`. Synthetic checks do not validate real probes or decryption.
