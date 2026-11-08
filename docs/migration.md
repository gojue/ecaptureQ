# Migration provenance

The product and repository remain **eCaptureQ**. Canonical remote:
https://github.com/gojue/ecaptureQ. Go module: `github.com/gojue/ecaptureq` (lowercase; repository/product name unchanged).
The same GitHub repository retains its existing community entry points; no new
repository or repository rename is part of this migration.

## Repository replacement

The existing eCaptureQ default branch was verified at
`cf4ba7f34cd0a122771b323e69e893bbea8dbd4d`. The original local worktree had
uncommitted changes, so implementation uses the linked worktree for the new local
branch `feat/next-generation-ui`. The original worktree was not reset, cleaned,
switched or overwritten.

The migration branch replaces the previous implementation's working-tree files
with the new Go, Wails and shared HTML/CSS/JavaScript implementation. Tauri/Rust,
React/TypeScript, their build manifests, the private Protobuf schema, old release
workflows, screenshots and feature documentation are not part of the new runtime.
Shared filenames such as README, package.json and LICENSE now hold the applicable
new implementation's content. README_CN points to the maintained new documentation.

The rewrite is delivered on `feat/next-generation-ui`, starting from the existing
eCaptureQ commit. It uses ordinary commits; no root commit or history rewrite is
part of this migration. Publishing this development branch does not switch the
default branch, delete remote branches/tags or create a release. The original
GitHub repository and its Stars, watchers and Issues remain in place.

The old feature set is not an acceptance baseline. SQL filtering will be designed
again for the new data model. Integrated collector management, Android UI and old
configuration formats are outside this implementation's scope. See
[the new-version guide](upgrade.md) for configuration and runtime boundaries.

## Implementation source

The new implementation was developed first in a workspace called **eCaptureW**.
That name is a historical development source only; it is not a second active
product or the destination repository. Its source files, tests, assets and build
configuration were imported and renamed consistently for eCaptureQ. Generated
binaries, screenshots and local configuration from that workspace were not copied
as source artifacts. Current verification is recorded separately in
[verification.md](verification.md).

The original UI source is from https://github.com/gojue/ecapture, branch
`feat/ecaptureq-web`, commit `08458d6d077e92269bda0fda1918e5c49da67068`, dated
2026-11-08. The source branch and its existing worktree were clean at that commit;
there were no subsequent branch commits to incorporate. The unrelated main
capture worktree had uncommitted work and was not modified.

| Original source | New implementation |
| --- | --- |
| `ui/live.go`, `ui/mapper.go`, associated tests | `internal/app/` |
| `ui/main.go` handler/validation/tests | `internal/httpapi/` |
| Source manifest and lifecycle from `ui/main.go` | `internal/app/`, `internal/cli/`, `cmd/server/` |
| `ui/web/*` | `frontend/` |
| `ui/test/http-body.test.mjs` | `test/http-body.test.mjs` |
| `ui/README.md` behavioral documentation | README and docs, revised for dual entries |
| `LICENSE` and per-file notices | LICENSE and original file headers |

Only UI code, synthetic fixtures, assets, tests and license/documentation material
were migrated. No generated protocol, collector runtime, real captured traffic,
credential, provisioning profile, deployment secret or machine-local setting was
copied. Examples contain synthetic endpoints and commands, never executed by the UI.

Changes since the UI baseline include separation of lifecycle and CLI, base-path
mounting, native capabilities, bounded Go decompression fallback, isolated HTML
previews, prevention of evicted-request resurrection, and the product/module/build
identity update to eCaptureQ. The protocol viewers, source persistence/validation
and core mapper regressions are retained from the new implementation.

The official Protobuf package remains the only wire-protocol source. Initial
integration required an ignored workspace because the required fields were not yet
public. They are now available in official commit
`f6c0df58575ca3027ef5baf74c4488c94a263169`, pinned through the downloadable version
`v2.10.1-0.20261108050605-f6c0df58575c`. Normal builds no longer require that local
workspace. Dependency provenance is in [upstream-status.md](upstream-status.md);
current independent-build evidence is in [verification.md](verification.md).
