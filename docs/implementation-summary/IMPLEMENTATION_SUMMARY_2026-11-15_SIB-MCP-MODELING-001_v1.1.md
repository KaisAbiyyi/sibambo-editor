# IMPLEMENTATION SUMMARY — SIB-MCP-MODELING-001, WP1A (E-L2 admission-compatible encoding)

ID **SIB-MCP-MODELING-001** · Version **1.1** · Date **2026-11-15 Asia/Jakarta** · Status **WP1A DONE — CP1A PASS**. WP2–WP12 not started.

- Governing plan: [MASTER IMPLEMENTATION PLAN v2.1](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.1.md). No review exists for this ID.
- Prior summary: [v1.0](IMPLEMENTATION_SUMMARY_2026-11-15_SIB-MCP-MODELING-001_v1.0.md) (WP0 done, WP1 evidence), still valid for its scope.
- Implementer: primary Claude Code session, Claude Opus 5.5; no subagents. Self-review was done by the same session (not an independent review).
- Owner instruction: "IMPLEMENT WP1A".

**Long-term reporting.**
- Parent objective: an owner-tested Editor agent add-on (joined walls, SketchUp-like edges, Denah, text perception, freeform modelling).
- Current phase: Phase 1. Gate CP1A is passed.
- Completed milestones: WP0, WP1 (E-K1 PASS / E-L1 evidence), WP1A (E-L2 PASS).
- Remaining: WP2 (relay/recorder/stdio surface) → WP3 (worker AGENT plumbing) → WP4/WP5 (walls, topology, bake; Sol-level executor) → WP6–WP12.
- Next user-visible deliverable: your own Claude Code builds a room whose walls join cleanly and show SketchUp edges in the open Editor document, editable and saved like your own geometry. That needs WP2–WP6.

## Work packages

| WP | Status | Result |
|---|---|---|
| WP0, WP1 | done (v1.0) | not repeated |
| **WP1A** E-L2 proof | **done** | The admission extension and the encoding proof are in place. T-A1…T-A7 PASS. |
| WP2–WP12 | not started | |

## What changed (Editor branch `work/mcp-modeling-001/phase-1`, base `642a7d6`)

- `apps/editor/src/lib/authoring/geometry.ts` — added the `export` keyword to `triangulateFaceRings` and `v2FaceLabel`. No behaviour change. `faceFromRing` was **already exported** through `export { faceFromRing, compactReferencedVertices }` (line 2210); adding a second export would duplicate it, so it was left as is (see Deviations).
- `apps/editor/src/lib/authoring/model.ts` — changed only the metadata area:
  - imported `validateArchMetadata`/`ArchMetadata`;
  - added `arch?: ArchMetadata` to `ModelMetadata`;
  - in `modelMetadata`, extended the admitted key sets with `arch,…` and validate `arch` right after `validateOrganization`. Failures go through `fail(...)` with the `Unsupported arch metadata: …` reason.
- NEW `apps/editor/src/lib/arch/convention.ts` (A10):
  - CONVENTION row-major / column-major / inverse constants;
  - `toInstanceMatrix(T)` and `fromInstanceMatrix(m)`.
- NEW `apps/editor/src/lib/arch/schemas/arch-module-v2.schema.json` (A6) and the generated `apps/editor/src/lib/arch/arch-module-v2.validator.generated.js`. The AJV standalone file has no `eval`/`new Function`; schema LF SHA-256 is `7e6baffb551ef64fee7ed9446ba4e14dfa2de189180d44276c1f4283dd88da7c`.
- NEW `apps/editor/src/lib/arch/schema.ts` (C2): `canonicalJson`, `validateArchModule` (AJV + semantic checks), 64 KiB module limit.
- NEW `apps/editor/src/lib/arch/metadata.ts` (C9a):
  - `validateArchMetadata` performs checks 1–9 in plan order and admits orphans;
  - `meshDigestInput` produces the canonical `{faces, positions}` input for `bakedMeshSha256`.
- NEW `tooling/testing/generate-arch-validators.ts`: generator; without `--write` it checks that the committed file is current.
- NEW `apps/editor/unit/arch/admission-e-l2.test.ts`: generator-current check plus T-A1…T-A7.
- `apps/editor/unit/arch/evidence-e-l1.test.ts`: header and the (i-d) title now say these tests document that the **v2.0** encoding is still rejected. Assertions are unchanged and still pass.

## Checks actually run

| Check | Result |
|---|---|
| `bun test ./unit/arch/admission-e-l2.test.ts` | **8 pass / 0 fail** |
| `bun test ./unit/authoring ./unit/arch` | **122 pass / 0 fail** (114 before + 8 new) |
| `bun test ./unit/mcp ./unit/editor` | **171 pass / 0 fail** |
| `bun run check` (svelte-check) | **0 errors / 0 warnings** (1016 files) |
| `bun run build` (Vite + adapter-node) | **built** (5.96 s) |
| `bun tooling/testing/generate-arch-validators.ts` (check mode) | current |

**T-A evidence**

- **T-A1:** the hand-built managed box (10 faces, top and bottom holed, built only with `faceFromRing`/`v2FaceLabel`, container `instance:op:1:1`, material `material:op:arch-sib-default`, `arch` entry with real `bakedMeshSha256`) → `editable:true`.
- **T-A2:** OPEN through the real `AuthoringWorkerDispatcher` gives `authoring`, with the root label byte-identical and container/mesh equal. WRITE → second OPEN gives an equal graph. After ACK_DOWNLOAD, a root guide COMMAND keeps `arch` byte-identical. RESTORE_CHECKPOINT in a fresh dispatcher restores an equal graph and the same undo depth.
- **T-A3:** owner guide → `tag-create` (keys become `arch,guides,looseEdges,organization,schema`) → container move by (1,0,0). `arch` stays byte-identical, and `fromInstanceMatrix` gives translation (1,0,0) within 1e-12.
- **T-A4:** erase → the entry is kept as an orphan and the document stays editable. Undo brings the container back with the entry attached.
- **T-A5:** push-pull of the east face inside the container stays editable, and the mesh SHA-256 changes, so detach is detectable.
- **T-A6:** all 9 malformed cases give viewer-only with the `Unsupported arch metadata:` prefix: bad schema, extra key, unsorted, duplicate moduleId, bad hash, wrong instance prefix, entry pointing at a component, module > 64 KiB, 65 entries.
- **T-A7:** 64 modules, 466,280 B total. `validateArchMetadata` median **8.27 ms** (samples 7.81–8.66 ms) in Bun 1.4.4, below the 50 ms target.

**Limits.** No browser/Playwright run: WP1A has no UI. The main-thread admission cost was measured in Bun, not in Chromium. Rooms/Benchmark consumers were not exercised with an `arch` root label (Phase 4 per A21).

## Deviations (trivial; architecture unchanged)

1. `faceFromRing` was already exported, so only two `export` keywords were added (plan step 1 listed three).
2. The plan text said "6 faces"; a box with a 1×1 through-hole has 10 faces. The plan's intent (two holed faces) is met.
3. T-A7 uses about 7.3 KiB modules (466 KB total), because 64 × 8 KiB plus the envelope would exceed the A20 512 KiB limit that the same plan sets.
4. T-A2 sends `ACK_DOWNLOAD` between WRITE and the next COMMAND, as the real Save flow does. The dispatcher locks editing until a download is acknowledged.
5. Schema details the plan did not number were filled conservatively: coordinates |v| ≤ 10,000 m (Builder geometry bound), transform entries |v| ≤ 1e6, ≤ 128 materials per module, `along` ≤ 100,000 m, opening width/height ≤ 100 m.

## Self-review (implementor, same session)

- Scope: matches the Expected Final Diff. `model.ts` changed only in `modelMetadata`, its type and its import; `geometry.ts` only by `export` keywords; no `packages/**`, `scene.ts`, `tools.ts`, `model-tools.ts`, worker or Builder change.
- Existing documents: documents without `arch` behave exactly as before (the branch is skipped).
- Untrusted input: `arch` comes from opened files. The entry count is checked before per-entry work; AJV bounds structure before `canonicalJson` runs; the documentId is regex-escaped; a malformed `arch` fails closed to viewer-only.
- Cost: `validateArchMetadata` runs in every admission, including owner actions; it was measured at about 8 ms at the upper budget.
- No open P0/P1 findings.
- P2: the 59 KB validator now ships in the main bundle because `model.ts` is shared by the main thread and the worker. This is accepted by design (C9a is pure and kernel-free).

## Files / commits

- Editor commit: see the branch head after `642a7d6` on `work/mcp-modeling-001/phase-1`. The SHA is recorded in Notion; a summary cannot contain its own commit. The summary copy is committed in the repo's `docs/implementation-summary/`.
- Builder: unchanged.
- Workspace docs: this file and index lines.

## Manual tests

None are applicable. WP1A has no owner-visible behaviour, so no owner test is pending from this IMPLEMENT.

## User Test Card

1. **What changed:** nothing visible yet. Under the hood, the Editor now accepts documents in which agent-built groups carry their "wall/slab/opening" data. Save, reopen, Undo and your own edits keep that data, and erasing a group plus Undo re-attaches it.
2. **To try (optional):** nothing needed. If you want, open and save any of your usual BOMC models in the Editor; they should behave exactly as before (no `arch` data means no change).
3. **How to report:** no MCP session yet. Only report if an existing model suddenly opens viewer-only.

## Unresolved claims / next action

- **Next:** IMPLEMENT **WP2** (Builder relay, recorder, discovery, add-on stdio surface). This is safe for any implementer. WP4/WP5 stay NOT SAFE for lower-capability delegation.
- Pending owner decision: the two-product ADR revision for the local agent path.
- Not yet measured: SvelteKit-bundle WASM loading of the kernel (WP3/WP4), WASM memory balance (T-K1), consumer reaction to `arch` (Phase 4).
