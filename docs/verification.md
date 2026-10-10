# Current implementation batch status

**As of:** 2026-10-10, Asia/Jakarta

The Editor authoring batch is implemented and pushed to `bench/bomc-loader-luna` at `1e3fba9bd08bff4b6ebf81facb42edf2ed83dfb9`. Qualification is partial: the new authoring/browser and performance cases pass, while the full unit run still lacks the exact pinned historical `S1-new` and `S2-new` BOMC inputs. Those inputs were not replaced. Chrome and Edge are available; Firefox and WebKit are not installed in the selected Playwright environment. The single combined implementation handoff is prepared; independent REVIEW and the user's UX check remain pending.

Current checks: `bun run check` passed with 0 Svelte errors/warnings; `bun run build` passed with the existing bundle warnings; unit results were 310/312, with the two failures limited to ENOENT for the exact historical inputs. Authoring integration passed 5/5. The compact authoring matrix passed 2/2 in Chrome and 2/2 in Edge. Current profile cases passed 12/12, cold-start/warm reuse passed 4/4, semantic comparison passed 1/1, and authoring performance passed 3/3. These outcomes do not close the missing historical fixture gate or subjective UX acceptance.

E4 remains `candidate_pending_cross_model_validation`. A local authoring pass will not establish native SketchUp behavior, complex-model editing, deployment, or certification.

## Historical standalone snapshot

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

- Writable authoring is restricted to the implemented Editor rectangle/extrusion subset. Other imported documents remain read-only. The new save path downloads canonical BOMC bytes; it does not establish general CAD editing, native SketchUp behavior, complex-model editing, or certification.
- BOMC import validates encoded structure, lengths, checksums, and references. Sidecar JSON remains byte-bounded and policy-checked; a matching record does not establish producer authentication. See [Data handling and evidence limits](data-and-evidence.md).
- Imported model data stays in page memory. There is no hosted model database, account synchronization, or server-side edit history.
- E4 remains **`candidate_pending_cross_model_validation`**. Local build success does not establish cross-viewer parity, representative-corpus correctness, or certification.
- Earlier monorepo test results are not promoted to tests of this standalone checkout.

See [Architecture](architecture.md) for app boundaries and [Data handling and evidence limits](data-and-evidence.md) for import and evidence limits.
