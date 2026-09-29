# Verification and release status

**Snapshot date:** 2026-09-29 (Asia/Jakarta)

**Application:** Sibambo Editor

**Status:** The corrective source tree passed local static checks, unit and browser tests, viewport tests, and a production build. Verify the exact published commit through `/__build.json`; the user's reported BOMC has not been tested in the browser.

## Checks run

| Check | Result | Notes |
| --- | --- | --- |
| `bun run check` | **PASS** | Svelte check reported 0 errors and 0 warnings. |
| `bun x tsc --project packages/tsconfig.json` | **PASS** | Typechecked the five shared packages with no diagnostics. |
| `bun run build` | **PASS** | Built locally with the Node adapter. Vite reported client chunks larger than 500 kB; this advisory did not fail the build. |
| `bun test packages/e4-import/src` | **PASS** | 12 E4 package tests passed, including clip-plane scene resolution. |
| Editor unit and browser tests | **PASS** | 39 app unit tests and 6 Playwright tests passed. |
| Viewport package tests | **PASS** | 32 tests passed. |
| Live build identity and user's BOMC | **Pending** | Compare the published commit through `/__build.json`; the user's reported file requires a browser retry. |

The build identity is available from **GET `/__build.json`**. It describes the commit used by the running build; successful local gates with the Node adapter do not verify Vercel packaging or deployment behavior.

The tested cancellation and replacement paths do not establish real exporter behavior, cross-model parity, or manual visual agreement.

## Release boundaries

- Editor currently displays the imported source read-only; a complete CAD workflow and lossless BOMC save-back are not established capabilities.
- BOMC import validates encoded structure, lengths, checksums, and references. Sidecar JSON remains byte-bounded and policy-checked; a matching record does not establish producer authentication. See [Data handling and evidence limits](data-and-evidence.md).
- Imported model data stays in page memory. There is no hosted model database, account synchronization, or server-side edit history.
- E4 remains **`candidate_pending_cross_model_validation`**. Local build success does not establish cross-viewer parity, representative-corpus correctness, or certification.
- Earlier monorepo test results are not promoted to tests of this standalone checkout.

See [Architecture](architecture.md) for app boundaries and [Data handling and evidence limits](data-and-evidence.md) for import and evidence limits.
