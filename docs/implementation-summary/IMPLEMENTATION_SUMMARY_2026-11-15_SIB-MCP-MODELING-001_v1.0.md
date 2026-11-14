# IMPLEMENTATION SUMMARY — SIB-MCP-MODELING-001, WP0 + WP1

ID **SIB-MCP-MODELING-001** · Version **1.0** · Date **2026-11-15 00:30 Asia/Jakarta** · Status **WP0 DONE · WP1 STOPPED at CP1 (E-K1 PASS, E-L1 FAIL) → `blocked → PLAN`**.

Governing plan: [MASTER IMPLEMENTATION PLAN SIB-MCP-MODELING-001 v2.0](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-14_SIB-MCP-MODELING-001_v2.0.md). No review exists for this ID. Prior ledger: [plan publication v1.0](IMPLEMENTATION_SUMMARY_2026-11-14_SIB-MCP-MODELING-PLAN-SYNC-001_v1.0.md).
Implementer: primary Claude Code session, Claude Opus 5.5; no subagents. Owner instruction: "WP-0 sama 1 sama lu, implement".

**Long-term reporting.** Parent objective: owner-tested Editor agent add-on (joined walls, SketchUp-like edges, Denah, text perception, freeform modelling). Current phase: Phase 1, evidence gate CP1. Completed: WP0; E-K1 kernel evidence; E-L1 evidence (negative). Remaining: PLAN v2.1 for the managed-module encoding, then WP2–WP12. Next user-visible deliverable: none yet. The first one (agent builds joined walls with edges in the open Editor document) needs PLAN v2.1 + WP2–WP6.

## Work packages

| WP | Status | Result |
|---|---|---|
| WP0 process contract + publication | **done** | Workspace `AGENTS.md` gains "Owner-driven MCP testing (2026-11-14)" under the PUSH section (local file; workspace root is not a repo). Indexes and the Editor-repo plan copy were already done in the plan sync (`9965b3a`). |
| WP1 E-K1 (manifold-3d) | **PASS** | See evidence below. |
| WP1 E-L1 (managed label + convention) | **FAIL (design)** | BOMC format round trip PASS; Editor authoring admission rejects the v2.0 A4/A7/C9 encoding; convention determined. |
| WP1 runtime venv | **done** | `D:\projects\sibambo\outputs\venvs\builder-v2` (CPython 3.13.12) from the **unchanged** Builder `service/requirements.lock` (`--require-hashes`, SHA-256 prefix `e085d385552dd005`); `import mcp, uvicorn, jwt, jsonschema` OK. Builder repo untouched. |
| WP2–WP12 | **not started** | Blocked by CP1 per plan stop rule. |

## E-K1 evidence — PASS

Package: `manifold-3d@3.5.5` (exact) added to `apps/editor/package.json`; `bun.lock` +113 lines. Bun reports 30 packages installed. The lockfile lists 56 new entries, most from manifoldCAD tooling dependencies (gltf-transform, sharp + platform binaries, esbuild-wasm, ndarray, commander…). The core runtime used is `manifold.js` + `manifold.wasm` (542,744 B; 208.7 kB gzip). In the Vite build, the worker chunk was 47.2 kB and the extra dependencies were not bundled.

API mapping (recorded for `arch/kernel.ts`): init `await Module(); wasm.setup()`. Classes: `Manifold`, `CrossSection`, `Mesh`. Calls used: `CrossSection.ofPolygons(rings)`, `CrossSection.union(list)`, `#area()`, `#toPolygons()`; `Manifold.extrude(section, h)` + `#translate`; `Manifold.union(list)` / `Manifold.difference(list)` (batch); `#asOriginal()`; `#getMesh()` → `runIndex` + `runOriginalID` (per-triangle source attribution works: every case reports ≥2 runs, all non-empty); `#slice(z)` → CrossSection; `#delete()`. Also present: `Manifold.levelSet`, `#minGap`, `#warpBatch`, `#simplify`, `#refine*`, `#smoothOut`.

Precision: `getMesh().vertProperties` is **Float32Array only** (no float64 mesh export in JS). Double-precision vertices are readable through `Manifold#warpBatch((verts: Float64Array, count) => copy)`. In all three cases the Float64 positions are in **exactly the same vertex order** as the Float32 mesh (`Math.fround(double) === float32` for every coordinate). Max float32 error was 1.94e-7 m on the room. `CrossSection.ofPolygons` quantises input coordinates by ≤ ~3e-9 m (e.g. 0.075 → 0.075000002980), so rounding to 1e-6 m (plan A3) recovers exact decimals. `Manifold.cube` input is exact. Overlapping coplanar unions produce extra collinear/interior vertices (e.g. x ≈ 0.0679 on the naive four-box room). A9's loop re-triangulation and global collinear removal must handle these; WP4 should also consider `#simplify`.

Determinism and timing:

| Case | verts/tris | volume | Bun run1 = run2 | Bun = Chromium (4 fresh workers, 2 page loads) |
|---|---|---|---|---|
| two touching prisms | 12/20 | 2 | yes | yes |
| box minus box | 14/24 | 7 | yes | yes |
| four-wall room + door | 41/82 | 5.386500215 (exact 5.3865) | yes | yes |

Hashes compared: Float32 positions, triangle indices, and Float64-rounded-1e-6 positions. Room evaluation median: Bun 3.4–3.8 ms, Chromium 2.8–3.2 ms (target < 50 ms). The slice at z = 1.2 gives area 1.965000078 (exact 1.965); 2D union area is 3 (exact).

Chromium harness: the Editor's own Vite 8.0.16 builds an ES module worker importing `manifold-3d` and the shared probe. A Bun server sends the **Editor's full CSP on every response** (`script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, `connect-src 'self'`, …). Results: zero CSP violations (document and worker), zero console errors, `crossOriginIsolated=false` (the single-threaded build works without COOP/COEP), HeadlessChrome 149 via Playwright. Limit: this is a standalone Vite build with identical CSP, not the SvelteKit app bundle. App integration is first exercised when the kernel enters the authoring worker (WP3/WP4).

## E-L1 evidence — FAIL (design), with a feasible alternative

| Check | Result |
|---|---|
| (i-a) 64 KiB `Instance.label` on a group instance: `BomcDocument.fromGraph` → `BomcWriter` → `readWebBomc` | **PASS**: label byte-identical (65,536 B; file 67,464 B, store-only). The BOMC format can carry the data. |
| (i-b) `validateAuthoringDocument` on the v2.0 encoding | **FAIL**: `editable:false`, first reason "Unsupported authoring material." |
| (i-c) OPEN of that file through the real `AuthoringWorkerDispatcher` | **FAIL**: result kind `viewer` (viewer-only), same reason. The WRITE→OPEN(authoring) round trip required by E-L1 is impossible. |
| (i-e) layered rejection | Each v2.0 layer is rejected independently. (1) `${doc}:material:sib-*` → only neutral/legacy/`${doc}:material:op:N` authored materials are admitted. (2) Container id `${doc}:arch:…:instance` with label `sibambo-arch-v2:…` → "Unsupported container label." Non-root instances must have id prefix `${doc}:instance:op:` and label exactly `["sibambo-editor-container-v1", N]`. (3) Faces with `surfaceCode`/`roleCode` ≠ 0 or label `sib:…` → rejected. Faces must use `["sibambo-editor-shape-v2", "rectangle"\|"line"\|"push-pull"\|"split", faceId(, appId)]` with codes 0. Holed faces must equal the canonical `triangulateFaceRings` output exactly. **After all three are changed to the admitted forms the graph becomes editable.** |
| (i-d) root metadata with an extra `arch` key | **FAIL**: "Unsupported authoring metadata schema." Root label keys are whitelisted to `{schema, guides, looseEdges[, organization]}`. |
| (ii) holed face via `triangulateFaceRings` passes admission + writer | **NOT RUN.** `triangulateFaceRings` is private; exporting it is a product change. The admission source shows holed faces must match its canonical output exactly, consistent with A9. |
| (iii) coordinate convention | **Determined.** Authored geometry is stored in the **Y-up runtime frame** (rectangle on y = 0). Source Z-up maps (x, y, z) → (x, z, −y). `Instance.matrix` arrays are **column-major** (`Matrix4.fromArray` in `model.ts::modelOccurrences`, composed parent · child, applied to child positions). `CONVENTION` column-major = `[1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1]`. Branch **B1** (child positions module-local Z-up; `Instance.matrix = CONVENTION · transform`, stored column-major). Note: v2.0 A4 omitted that the stored matrix is column-major. |

**Conclusion.** v2.0 locked decisions A4 (managed-group ids/label), A7 (built-in material ids) and C9 (face codes/labels) are incompatible with the Editor's authoring admission (`apps/editor/src/lib/authoring/model.ts::validateAuthoringDocument`, `geometry.ts::validateTopologyEditableSubset`, `isAuthoredMaterial`). `model.ts` is READ-ONLY in v2.0. Per the CP1 stop rule, no workaround was improvised.

**Evidence-based options for PLAN v2.1** (decision belongs to the PLAN author/owner):
1. **Admission-compatible bake + one small, validated admission extension (recommended).** Bake managed modules as ordinary containers (`instance:op:N`, container label), materials as `material:op:N`, faces as shape-v2 `line` faces with codes 0 and canonical `triangulateFaceRings` triangles. Extend `modelMetadata` to admit one new root key (e.g. `arch`: `{ modules: { [containerInstanceId]: { module, bakedMeshSha256 } } }`) with its own strict validator. Save/reopen persistence, undo and owner push/pull then work natively; the BOMC format and package stay unchanged; only the Editor's application-level admission whitelist changes.
2. Same bake, with arch data kept outside the document (worker state + history-entry extension). This needs no admission change, but loses Save→reopen of parametric data.
3. A new admitted container-label variant carrying the arch payload. Larger admission change; touches every consumer of container labels.

## Files / commits

- Editor branch `work/mcp-modeling-001/phase-1` (from `9965b3a`): `apps/editor/package.json`, `bun.lock` (manifold-3d 3.5.5 exact); NEW `apps/editor/unit/arch/evidence/ek1-probe.ts`, `apps/editor/unit/arch/evidence-e-k1.test.ts`, `apps/editor/unit/arch/evidence-e-l1.test.ts` (characterisation tests of current behaviour); copy of this summary. Commit SHA: see the Editor branch head (a summary cannot contain its own commit); recorded in the Notion update.
- Workspace (local): `AGENTS.md` section; this summary; receipts in `D:\projects\sibambo\outputs\2026-11-15-mcp-modeling-wp1\`: `ek1-bun-run1.json` (58f44f7b…), `ek1-bun-run2.json` (76363e24…), `ek1-chromium.json` (86d3fa89…), `el1-receipt.json` (dc593b5e…), `chromium-harness/` (reference copy; it was run from `D:\projects\sibambo\scratch\mcp-modeling-wp1\chromium\`).
- Builder repo: unchanged.

## Checks actually run

- `bun test ./unit/arch/evidence-e-k1.test.ts`: 1 pass (two fresh processes).
- `bun test ./unit/arch/evidence-e-l1.test.ts`: 6 pass (assertions encode the observed rejections).
- `bun test ./unit/authoring ./unit/arch`: **114 pass / 0 fail**.
- `bun test ./unit/mcp ./unit/editor`: **171 pass / 0 fail**.
- `bun run check`: **0 errors / 0 warnings** (1012 files).
- Chromium harness: 2 page loads × 2 fresh workers, all hashes equal to Bun.
- Not run: Playwright suites, production SvelteKit build with the kernel, E-L1 (ii).

## Deviations

None from the plan's steps. The footprint measurement used the lockfile diff and the package's own files instead of a full `node_modules` size, which was too slow on Windows and was stopped. The scratch Vite harness was used as the plan's "Vite production build worker" check; its limit is stated above.

## Manual tests

None are applicable: WP0/WP1 have no owner-visible behaviour. No owner test is pending from this IMPLEMENT.

## User Test Card

1. **What changed:** nothing you can use yet. The geometry kernel (Manifold WASM) is proven to run in the Editor's browser setup. The planned way to store walls inside the document was rejected by the Editor's own document rules, so the plan needs a v2.1 revision first.
2. **To try (optional, ideas only):** open `D:\projects\sibambo\outputs\2026-11-15-mcp-modeling-wp1\el1-receipt.json` to see the exact rejection reasons.
3. **How to report:** no session to record yet.

## Unresolved claims / next action

- **Next action: PLAN v2.1** of SIB-MCP-MODELING-001 to replace A4/A7/C9 with an admission-compatible managed-module encoding (options above). It should also fix the `Instance.matrix` column-major statement and add the warpBatch Float64 read path and `CrossSection` quantisation note to C6. Implementation stays stopped until then.
- Still pending owner decision: the two-product ADR revision for the local agent path.
- E-K1 limits: SvelteKit-bundle integration and memory/`delete()` balance (T-K1) are not yet measured.
