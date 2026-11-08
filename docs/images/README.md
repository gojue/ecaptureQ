# Screenshot provenance

These are unedited 1440 × 980 screenshots of the running eCaptureQ Web UI,
captured on 2026-11-08 during the shared UI update based on `34e4d7d`.
Web and Desktop share this interface; these images show the browser edition,
not a native desktop window.

- `overview.png`: bundled mock session, HTTP/3 request, English, light theme.
- `protocol-details.png`: bundled mock session, MQTT PUBLISH fields, English,
  dark theme.
- `sources.png`: editable source defaults inferred from a local synthetic
  WebSocket address and an inert example launch command. The subsequent smoke
  test submits to a local `scripts/ws-fixture` instance, never a real collector.

The images come from `test/browser-smoke.mjs` with `SMOKE_ARTIFACT_DIR` enabled;
see [UI verification](../ui-verification.md) for test coverage. All visible
records are mock or generated test data. They are not real captured traffic and
do not establish real-probe protocol coverage. No credentials, private
configuration or user traffic are included. No image edits were applied.
