# Image provenance

## Application screenshots

These are unedited 1440 × 980 screenshots of the running eCaptureQ Web UI,
refreshed on 2026-11-08 for the eCaptureQ logo update based on `65795e1`.
The original shared UI screenshots were captured on the same date based on
`34e4d7d`; these fresh captures include the new transparent eCaptureQ logo.
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

## Product relationship illustration

`terminal-to-interface-fine.webp` is an unchanged copy of the eCapture website's
`src/public/assets/q/terminal-to-interface-fine.webp`, imported on 2026-11-08
from `gojue/ecapture.cc` commit `11343b4373d72a9834680059a76f0a7f1528c32f`.
It is a 1752 × 897 transparent WebP (quality 90), with SHA-256
`4c65b8f3cc08923b1ecfa5bdae321bd6319fce13ae449cc6c0683985e35a8ee3`.

The website records this as an AI-generated conceptual illustration created on
2026-11-08 using the OpenAI image generation tool, without real captures or
third-party references. It represents eCapture's terminal capture output on
the left and eCaptureQ's graphical message analysis, including captured-image
preview, on the right. It is not an application screenshot, does not distinguish
Desktop and Web editions, and does not imply terminal-text or log-file import.
The arrows show application-message flow; eCaptureQ initiates the WebSocket
connection. The README caption supplies the product labels that the website
renders separately as HTML.

The illustration is distributed under the website's MIT license; the original
copyright and license are preserved in
[terminal-to-interface-LICENSE.txt](terminal-to-interface-LICENSE.txt).
This does not change the Apache-2.0 license of eCaptureQ or its screenshots.

Source references at the imported commit:

- [Illustration and provenance](https://github.com/gojue/ecapture.cc/blob/11343b4373d72a9834680059a76f0a7f1528c32f/src/public/assets/q/README.txt).
- [Generation and refinement prompts](https://github.com/gojue/ecapture.cc/blob/11343b4373d72a9834680059a76f0a7f1528c32f/maintenance/ecaptureq-illustration-prompt.txt).
- [Chinese product overview](https://github.com/gojue/ecapture.cc/blob/11343b4373d72a9834680059a76f0a7f1528c32f/src/q/zh/index.md)
  and [homepage introduction](https://github.com/gojue/ecapture.cc/blob/11343b4373d72a9834680059a76f0a7f1528c32f/.vitepress/theme/components/EcaptureQIntro.vue),
  used to align the README's product roles and three-pane workflow.
