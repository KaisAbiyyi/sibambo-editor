# IMPLEMENTATION SUMMARY — SIB-MCP-MODELING-001 WP4 kernel, wall network, elements (CP4)

ID **SIB-MCP-MODELING-001** · Version **1.8** · Date **2026-11-15 (Asia/Jakarta)** · Status **WP4 implemented · CP4 golden parts PASS except ONE plan assertion that C7/C8 geometry contradicts (G9 `enclosed:false`, open item 1) · Draft/Review, no merge, no self-approval, no PR opened**.

- **Governing plan:** [master v2.3](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md) — C6, C7, C8, `evaluate.ts` (topology stubbed to raw triangles), §Golden geometry G1–G10, CP4. Frozen; not changed.
- **Scope delivered:** WP4 only. No WP5–WP12 code. Builder repository untouched.
- **Implementer:** Claude Code cloud session `session_01JoynVtWpBxaEDZLfEkvFKf` (<https://claude.ai/code/session_01JoynVtWpBxaEDZLfEkvFKf>); the exact model identifier is not recorded here by session policy. **No subagents**: kernel, wall and junction geometry were written and reviewed by this one session. Whether this model meets the owner's "high-capability" requirement for WP4 is the owner's call.
- **Revision history:** v1.5 WP3 · v1.6 validator fix · v1.7 WP3 review remediation · **v1.8 WP4 (this file)**.

## Identities

| Item | Value |
|---|---|
| Base (Editor) | `5606f26888f7f6a42e9fed58e7246f062b58eda3` = head of `work/se-05/full-sync-20261113` (PR [#24](https://github.com/KaisAbiyyi/sibambo-editor/pull/24)), contains the merged WP3 (#25) |
| Base (Builder, WP2) | `02b4749c79cd8d3e12b3675a9df95770edbc7555`, `work/se-05/full-sync-20261113` (merge of #95) — read-only here |
| Branch | `work/mcp-modeling-001/wp4-kernel-walls` (created from the Editor base) |
| WP4 code commit | **`aed1cf3ba0e5d23bd7439467310902b4c7764261`**, tree `e10318bf887c9b6cec2c149f9ee6609b73bc8bb9` — 15 files, +2502, all under `apps/editor/src/lib/arch/` and `apps/editor/unit/arch/` |
| Publication | the docs-only commit that adds this file (read it from the branch tip; no self-referential SHA is invented here) |

## Preflight (verified before implementation)

| Check | Result |
|---|---|
| Builder post-merge CI at `02b4749` | every listed workflow run SUCCESS on push and on PR #94 (e.g. [MCP modeling add-on CP2](https://github.com/KaisAbiyyi/sibambo-bomc-builder/actions/runs/43705333639), [SE-02](https://github.com/KaisAbiyyi/sibambo-bomc-builder/actions/runs/43705333649), [SE-03](https://github.com/KaisAbiyyi/sibambo-bomc-builder/actions/runs/43705333658), [SE-05](https://github.com/KaisAbiyyi/sibambo-bomc-builder/actions/runs/43705333663)). Not re-run locally. |
| Editor post-merge CI at `5606f26` | SUCCESS: [BMB-005-007 consumer acceptance](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43705207584), [BMB-021 original Editor](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43705207606), [SE-04 cloud qualification](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43705207536), [SE-05 cross-repo](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43705207518) |
| Local baseline at `5606f26` | `./unit/arch` 15 pass; `./unit/authoring` 129 pass; 0 fail |
| AGENTS.md | read in both repositories. Editor AGENTS.md: implementor self-review, no independent-review gate, no silent agent co-author trailers (none added). |
| Competing claim / lock | none found: the only WP-named remote branches are `work/mcp-modeling-001/phase-1` (WP3, merged) and the SE-05 sync branches; no WP4 branch or PR existed. Every file added here is new (`lib/arch/{kernel,walls,elements,evaluate,errors,sha256}.ts`, `unit/arch/**`); no shared file was modified. |
| **Claim record** | **Not written to the Notion tracker or to a GitHub claim comment**: the Notion workspace connected to this session contains none of the BOMC/Sibambo tracker pages (searches returned only unrelated personal pages), and no GitHub comment was posted. The claim is recorded only here and in the branch name. **Notion update: NOT_RUN / BLOCKED.** |

## Delivered

| File | Contract | Contents |
|---|---|---|
| `src/lib/arch/kernel.ts` | C6 (+A3) | the only `manifold-3d` importer; `init`, `prism`, `prismWithHoles`, `boxLocal`, `union`, `difference`, `exportMesh` (Float64 via `warpBatch`, order asserted against `getMesh`, rounded 1e-6), `sliceAt`, `union2d`, `regionsOutside`, `release`, plus `stats`, `meshVolume`, `canonicalRing`, `createKernel` (independent WASM instance), `liveCount`, `resetTags`, `KernelError` |
| `src/lib/arch/walls.ts` | C7 | `buildWallNetwork`: segments, duplicate/reversal/merge rules, JOIN_TOL clustering, T/X splitting, collinear-overlap rejection, outward-angle corner solving with miter limit (4·max t) → bevel, junction report `free-end/L/T/X/Y/multi`, one canonical union |
| `src/lib/arch/elements.ts` | C8 | slabs (self-intersection, holes), opening placement rules and cutters, frame/glazing/leaf inserts, spaces |
| `src/lib/arch/evaluate.ts` | C9 subset | `evaluateModule`: parts sorted by partId, per-triangle tags (`wall`, `reveal:<id>`, slab, frame/glazing/leaf), junctions, spaces, bounds, stats, LRU(32) cache keyed by SHA-256 of canonical JSON |
| `src/lib/arch/errors.ts`, `sha256.ts` | A16 / C9 | `ArchError` (`INVALID_GEOMETRY`, `BUDGET_EXCEEDED`, `detail {moduleId, elementId, reason, at}`); synchronous SHA-256 (verified against `node:crypto`) |
| `unit/arch/*.test.ts`, `fixtures/`, `golden/` | §Test | see Gates |

## CP4 golden assertions (tolerance 1e-6)

| G | CP4 assertion | Result |
|---|---|---|
| G1 | wall part manifold, 1 component, volume 5.670000; corner (−0.075,−0.075,0) is a vertex | **PASS** (genus 1, no leaked kernel objects) |
| G2 | closed wall ≡ four walls: identical exported mesh | **PASS** (also for clockwise and rotated-start closed paths, and across two fresh kernels) |
| G3 | space area 12.00, bounds x[−0.15,4.15] y[−0.15,3.15] | **PASS** |
| G4 | two spaces 1.850×2.850 (5.27 m²), two T | **PASS** (6.82425 m³ = 5.67 + partition) |
| G5 | four enclosed spaces, one X, four T | **PASS** |
| G6 | L t 0.15/0.25 manifold, outer corner = analytic body-line intersection | **PASS** (4.125, −0.075) |
| G7 | 30° acute manifold, miter vs bevel per C7.3 | **PASS** (30° miter tip at (t/2)/sin 15°; 14° bevel; 15° miter; sweep 5°–175° manifold) |
| G8 | wall volume reduced by exactly w·h·t per opening; insert parts present | **PASS** (5.4495 = 5.913 − 0.2835 − 0.18); `reveal:<id>` attribution is on triangle tags (faces are CP5) |
| G9 | write commits; space `enclosed:false` | **commits: PASS · `enclosed:false`: NOT MET** — see open item 1. `WALL_GAP` is CP8. |
| G10 | G1/G4/G8 export SHA-256 identical across fresh kernels and Bun/Node | **PASS** (Bun 1.4.4 = Node v22.23.4 = two fresh kernels = pinned `unit/arch/golden/g10-export-hashes.json`). **Chromium: NOT_RUN** (CP12 by the plan). |
| T-K1 | `.delete()` balance | **PASS** by a wrapper counter (the library exposes none): 100 evaluations and 20 failing evaluations leave `liveCount() === 0` |

## Gates on `aed1cf3` (Linux cloud container, Bun 1.4.4, Node v22)

| Gate | Result |
|---|---|
| `bun test ./unit/authoring ./unit/arch ./unit/mcp ./unit/editor ./unit/agent` | **445 pass / 1 todo / 0 fail, 5544 expects**, three consecutive runs (the CP3 Windows run in v1.7 recorded 343; this run is 102 tests higher, all of them new under `unit/arch`) |
| `./unit/arch` alone | 117 pass / 1 todo: sha256 1, kernel 8, walls 25, walls-fuzz 30, elements 21, golden-cp4 17 (+1 todo), admission/evidence 15 unchanged |
| `bun run check` | 0 errors / 0 warnings |
| `bun run build` | exit 0 (the new modules are not yet imported by the app) |
| Fuzz | 2 × 300 seeded random junction stars (2–5 walls, mixed thickness, side, angle) + 27 side/thickness combinations of straight continuations × 4 tilts + a 10×10 crossing grid (180 segments, 100 nodes, ≈0.3 s) |
| Evaluation time (median of 20) | G1 5 ms · G4 10 ms · G5 21 ms · G8 7 ms |
| **Not run** | Chromium/browser tests of any kind; Playwright suites; Windows; hosted CI on the new SHA (not yet published when this was written); the Builder suites (no Builder change) |

**One unexplained transient.** The very first full-suite run after the kernel and tests existed reported 335 tests, 2 fail, 2 errors; its log was not kept. It never recurred in 13 later full runs (sequential and four in parallel; the code changed between them), peak memory of the arch suite is ≈ 230 MB, and no test depends on timing apart from the pre-existing Push/Pull benchmark. Cause **unconfirmed**; hosted CI is the arbiter.

## Deviations and interpretations (all need owner/architect awareness)

1. **C7.4–5 solid construction (material deviation).** The plan extrudes the corner quads and node polygon. A seeded fuzz showed that for acute junctions with mixed thickness (e.g. 12° between a 0.25 m and a 0.10 m wall) the quad of the wide wall ends on a far seam and **the wall's own body next to the node is missing** (≈0.3 m long hole, found by sampling points inside the butt-ended body). The solid is therefore ONE union of: the plan quads, the plan node fan, each segment's butt-ended full body, and a bridge strip per straight continuation. Quads keep connectivity (they share exact corner vertices); bodies attach by volume overlap. A first attempt without quads (bodies + corner fills) was **worse** (31 of 300 stars split into extra components because contact relied on near-coincident faces) and was discarded. Every plan golden is reproduced exactly. Cost: about 1.5–2× raw triangles in T/X cases (G4 48→83 vertices, G5 105→205). WP5 re-triangulates from loops, so baked output is unaffected. A body can protrude past a neighbour's face by at most its own butt corner when walls meet at an angle with `side` left/right.
2. **`SPACE_NOT_ENCLOSED` is a result, not a rejection** (`enclosed:false`, area 0), per G9 "the write commits". `SPACE_SEED_IN_WALL` stays `INVALID_GEOMETRY`.
3. **Zero-volume shells.** Manifold can return 4-triangle zero-volume components when two inputs differ by ~1e-9; `union`/`difference` drop components below 1e-9 m³. Without this, ordinary T/X junctions reported phantom components.
4. **Collinear continuation tolerance.** Junction reporting treats directions within sin 1e-3 as a straight continuation (a stem ending 0.4 mm off the through wall bends its halves by ~2e-4 rad and must still read as T). Geometry is unaffected. Straight continuations whose bodies lie on opposite sides of the line touch only along an edge line and are two components by construction (tested for all 9 side combinations).
5. **Collinear overlap** is tested in both directions with JOIN_TOL on both endpoints; a strict parallel test let a 0.4 mm-skewed overlapping wall through (found in self-review).
6. **Volumes** come from the Float64 export (Manifold's `volume()` is single precision: 5.670000225 for G1).
7. **Door leaf** follows C8 literally: a box perpendicular to the wall at the hinge jamb on the `swing.side` face, length `width − 2fw`. T-F2 (plan drawing) will show whether that is the intended 3D representation.
8. **Walls with different baseElevation/height at one node** get node pieces over `[min z0, max top]`, as C7.5 says.

## Open items for REVIEW/PLAN (no decision taken here)

1. **G9 `enclosed:false` contradicts C7/C8.** With t = 0.15, shortening the north wall by 0.02 leaves its end inside the east wall's body, so the footprint is still closed (`enclosed:true`, 10.9725 m²). The room opens only when the gap exceeds t/2 = 0.075 m (verified with a 0.1 m gap → `enclosed:false`). `WALL_GAP` (0.001–0.30 m) therefore has to be an endpoint rule in WP8, not a consequence of the footprint. `golden-cp4.test.ts` carries `test.todo` for the plan assertion and asserts only what holds. Plan stop rule: golden invariant needing an L/A change → REVIEW/PLAN.
2. **Staggered continuation** (collinear walls on opposite sides of the path) yields two solids touching along an edge. Decide whether that should be rejected or bridged.
3. **Notion tracker not reachable** from this session: claim, Status and Now/Up Next were not updated.

## Self-review (implementor; exact `aed1cf3` against base `5606f26`)

Reviewed for contracts, tolerance, orientation, resource lifetime, error paths, scope and test strength. Findings found **and fixed before commit**:

| # | Sev | Finding | Fix / evidence |
|---|---|---|---|
| 1 | P1 | `regionsOutside` forced every ring CCW, so the hole ring of `footprintRings` was filled and rooms were never found | orientation preserved; kernel test "closed frame encloses its hole" |
| 2 | P1 | corner-trimmed quads leave holes at acute junctions with mixed thickness (deviation 1) | bodies added; fuzz "centre only" now asserts footprint ⊇ butt bodies on 300 stars |
| 3 | P1 | straight continuations with different lateral extents split into two components (1e-9 non-coplanar contact) | overlap bridge strip; 27 × 4 continuation cases |
| 4 | P1 | zero-volume shells counted as components (deviation 3) | cleanup in kernel; fuzz and G4/G5 |
| 5 | P2 | T reported as Y when the stem lands 0.4 mm off the wall | `COLLINEAR_SIN`; JOIN_TOL test |
| 6 | P2 | near-collinear overlap not rejected (deviation 5) | symmetric tolerance test; red-then-green test |
| 7 | P2 | bowtie slab with zero signed area reported `RING_DEGENERATE` | explicit simplicity check → `SLAB_SELF_INTERSECTS` (incl. touching vertex) |
| 8 | P2 | G9 contradicted the geometry | recorded, not forced (open item 1) |

Remaining risks, none blocking CP4:
- `resetTags()` is evaluation-scoped: a caller holding solids from an earlier evaluation loses their tag attribution. Nothing in WP4 does; WP5 must export before the next evaluation.
- The evaluator cache returns shared typed arrays; callers must treat them as immutable.
- Raw meshes contain collinear and a few degenerate/tiny triangles (G4 1 + 2, G5 6 + 36 below 1e-6 m², G7 6). C9 steps 1 and 4 (WP5) are required to remove them; they were present with and without the body addition.
- Property tests use a fixed seed; other seeds may show further acute/mixed configurations.
- Evidence for Chromium/browser determinism, Windows and hosted CI is absent.

## Preserved

No file outside `apps/editor/src/lib/arch/` and `apps/editor/unit/arch/` changed. `packages/**`, `authoring/**`, `lib/mcp/**`, `+page.svelte`, schemas, package manifest and lockfile are untouched; the WP3 worker/host/link and all 129 authoring tests behave as before. No tool is exposed to agents; every A14 tool is still `NOT_IMPLEMENTED`.

## User Test Card

WP4 has no owner-visible surface (no UI, no tool). **No owner test is required or was run.** Developers can reproduce with `bun test ./unit/arch` from `apps/editor`.

## Next

WP5 (topology, bake, managed groups) consumes `EvaluatedModule.parts[].mesh` and `tags`; it must also settle open item 1 before CP5's G9/G3 interior-face assertions are relied on. Merge, PR, Notion and the Now/Up Next recomputation await the owner's next authorization.
