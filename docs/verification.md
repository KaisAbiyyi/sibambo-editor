# Verification and release status

**Snapshot date:** 2026-09-28 (Asia/Jakarta)

**Application:** Sibambo Editor

**Status:** Local installation and production build passed. Unit, browser, and Vercel-hosted build gates remain unverified for this standalone snapshot.

## Checks run

| Check | Result | Notes |
| --- | --- | --- |
| `bun install --frozen-lockfile` | **PASS** | Bun 1.3.10; passed from repository root and `apps/editor`, resolving the committed root workspace and lockfile. |
| `bun run build` | **PASS** | Built locally with the Node adapter. Vite reported client chunks larger than 500 kB; this is an advisory and the build completed. |
| `bun run check` | **Not run** | Available at the repository root; no standalone check result is claimed. |
| `bun run test` | **Not run** | Unit and Playwright suites are present but were not rerun in this standalone repository. |
| Vercel adapter build/deployment | **Not verified** | No Vercel project or hosted deployment is established by this snapshot. Verify the Vercel adapter in the hosted builder before sharing a deployment as a release. |

The build identity is available from **GET `/__build.json`**. It describes the commit used by the running build; a successful local Node-adapter build does not verify Vercel packaging or deployment behavior.

## Release boundaries

- Editor currently displays the imported source read-only; a complete CAD workflow and lossless BOMC save-back are not established capabilities.
- The input-file cap does not impose an aggregate decoded-size limit, and the provenance sidecar has no explicit size limit. Use trusted files; see [Data handling and evidence limits](data-and-evidence.md).
- Imported model data stays in page memory. There is no hosted model database, account synchronization, or server-side edit history.
- E4 remains **`candidate_pending_cross_model_validation`**. Local build success does not establish cross-viewer parity, representative-corpus correctness, or certification.
- Earlier monorepo test results are not promoted to tests of this standalone checkout.

See [Architecture](architecture.md) for app boundaries and [Data handling and evidence limits](data-and-evidence.md) for import and evidence limits.
