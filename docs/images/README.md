# Screenshot provenance

These are unedited 1440 × 960 screenshots of the running eCaptureQ Web UI,
captured on 2026-11-08 from the implementation merged in `7637fff`. Web and
Desktop share this interface; these images show the browser edition, not a
native desktop window.

- `overview.png`: bundled mock session, HTTP/2 payment request, light theme.
- `protocol-details.png`: bundled mock session, MQTT PUBLISH fields, dark theme.
- `sources.png`: two local `scripts/ws-fixture` instances connected over the
  official Protobuf WebSocket protocol. Source labels explicitly identify them
  as synthetic events.

All visible records are mock or generated test data. They are not real captured
traffic and do not establish real-probe protocol coverage. No credentials, private
configuration or user traffic are included. The Web UI and its content were not
modified for the screenshots; navigation used the ordinary UI controls.
