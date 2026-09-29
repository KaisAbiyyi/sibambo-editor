# Verification and release status

**Snapshot date:** 2026-09-28 (Asia/Jakarta)

**Application:** Sibambo Editor

**Status:** The standalone Editor check, shared-package typecheck, production build, unit tests, and browser tests passed locally with the Node adapter.

## Checks run

| Check | Result | Notes |
| --- | --- | --- |
| `bun run check` | **PASS** | Svelte check reported 0 errors and 0 warnings. |
| `bun x tsc --project packages/tsconfig.json` | **PASS** | Typechecked the five shared packages with no diagnostics. |
| `bun run build` | **PASS** | Built locally with the Node adapter. Vite reported client chunks larger than 500 kB; this advisory did not fail the build. |
| `bun run test` | **PASS** | 36 app unit tests and 6 Playwright browser tests passed. Playwright also built and served the Node-adapter production output. |
| Vercel adapter build/deployment | **Not verified** | No Vercel project or hosted deployment is established by this snapshot. Verify the Vercel adapter in the hosted builder before sharing a deployment as a release. |

The build identity is available from **GET `/__build.json`**. It describes the commit used by the running build; successful local gates with the Node adapter do not verify Vercel packaging or deployment behavior.

The combined F4 app suite across Benchmark, Rooms, and Editor reported **146 unit tests and 32 browser tests passing**. Synthetic Editor regressions cover preserving the empty first-load state or current loaded model during cancellation, and mounting a candidate viewport before disposing the previous one. These checks do not establish real exporter behavior, cross-model parity, or deployment status.

## Release boundaries

- Editor currently displays the imported source read-only; a complete CAD workflow and lossless BOMC save-back are not established capabilities.
- BOMC import validates encoded structure, lengths, checksums, and references. Sidecar JSON remains byte-bounded and policy-checked; a matching record does not establish producer authentication. See [Data handling and evidence limits](data-and-evidence.md).
- Imported model data stays in page memory. There is no hosted model database, account synchronization, or server-side edit history.
- E4 remains **`candidate_pending_cross_model_validation`**. Local build success does not establish cross-viewer parity, representative-corpus correctness, or certification.
- Earlier monorepo test results are not promoted to tests of this standalone checkout.

See [Architecture](architecture.md) for app boundaries and [Data handling and evidence limits](data-and-evidence.md) for import and evidence limits.
