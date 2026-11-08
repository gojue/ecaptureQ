# Synthetic WebSocket source

This helper sends **invented validation data, not captured traffic**. It uses the
official `pb.LogEntry` and `pb.Event` packages and never attaches a probe, captures
packets, executes a displayed command, or contacts `synthetic.invalid`.

```sh
go run ./scripts/ws-fixture --addr 127.0.0.1:28359
# Force repeated reconnects after five completed synthetic message pairs:
go run ./scripts/ws-fixture --addr 127.0.0.1:28360 --disconnect-after 5
```

Add `ws://127.0.0.1:28359/` as an eCaptureQ source, then select live mode. Each
connection receives three initial HTTP request/response pairs followed by one pair
per second, rotating a generated PNG checkerboard, gzip JSON and ordinary JSON.
Events contain a synthetic PID, NUL-separated argv with an empty middle argument
and trailing padding, and a complete synthetic TLS metadata map. Fingerprints are
explicitly labelled synthetic. Operational logs and heartbeats use their official
message types.

The fixture uses the same published official protocol dependency as the application,
including fields 18–20. No local eCapture checkout or `go.work` is required.
Two fixture instances can exercise independent sources; `--disconnect-after`
exercises reconnection generations. These checks do not validate real eCapture,
Decryptor, kernel probes, or actual network protocol capture.
