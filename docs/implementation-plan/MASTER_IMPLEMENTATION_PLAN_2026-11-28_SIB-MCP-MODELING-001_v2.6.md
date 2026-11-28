# MASTER IMPLEMENTATION PLAN — SIB-MCP-MODELING-001 v2.6 (delta over v2.5: WP8A, F-WP8-1 slab area tolerance, contract amendment A22)

| Field | Value |
|---|---|
| ID, version | **SIB-MCP-MODELING-001 · v2.6** |
| Date | **2026-11-28 12:45, Asia/Jakarta** |
| Author | **Claude Sonnet 5.5** (Claude Code session, PLAN only, no subagents, no source change). **Eligibility is unresolved, not asserted:** the workspace `AGENTS.md` names Opus 5.5 and Fable but not Sonnet 5.5 as PLAN authors. The basis here is the owner's explicit request to this session to write this plan; the owner may ask for re-authoring by an eligible model. No benchmark equivalence is claimed. |
| Status | **FROZEN — SAFE FOR LOWER-CAPABILITY EXECUTION.** Amendment **A22** takes effect when the owner approves it (the merge of this file, or an explicit "approved" in chat). Until then WP8A must not start. |
| Supersedes | [v2.3](MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md) **C8 slab bullet only** ("area of union equals area of polygon within 1e-9"), as amended by nothing in [v2.4](MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.4.md) or [v2.5](MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.5.md). Every other contract, decision, golden and checkpoint of v2.3–v2.5 stays in force. v2.3–v2.5 are kept unmodified. |
| Revision history | v2.6 (2026-11-28): first version. Created from the WP8 independent review of PR [#30](https://github.com/KaisAbiyyi/sibambo-editor/pull/30) (finding **F-WP8-1**, P1) and the planner's own measurements below. |
| Governing evidence | [Summary v1.18](../implementation-summary/IMPLEMENTATION_SUMMARY_2026-11-25_SIB-MCP-MODELING-001_v1.18.md) §5 F-WP8-1; PR #30 review comment of 2026-11-27 ("must be fixed before WP12 / owner acceptance"). |
| Repository, base | `sibambo-editor`, base = tip of `work/se-05/full-sync-20261113` (PR #30 merged as `1e8c82828c9d6df1110f011a636572c5eb493441`). Branch for WP8A: `work/mcp-modeling-001/wp8a-slab-area-tolerance`. |

## Objective and User-Visible Definition of Done

**INTENT.** An agent or owner can author a floor slab with ordinary decimal dimensions — a 4.2 m × 3.9 m room at (0.3, 0.3), the outline (0,1.1)–(4,3) — and the Editor accepts it exactly as it accepts (0,0)–(4,3). Today `edit_model` fails such a slab with `INVALID_GEOMETRY · SLAB_SELF_INTERSECTS` although the polygon is perfectly simple.

**Done when all are true** (each proven in the Test and Verification Contract):
1. Every rectangle on a 0.1 m grid (5 × 5 origins × 40 × 40 sizes, 40,000 cases) is built by `buildSlab`. Before the fix 35,896 of them throw.
2. A slab with a decimal outline and a decimal hole is built, evaluated, baked, and readable through `describe_scene` / `check_model` after a real `edit_model` call.
3. Genuinely invalid slabs (self-intersection, hole outside, overlapping holes, hole protruding by ≥ 1 µm) are still rejected with the same code, reason and `elementId`.
4. Nothing else changes: slabs that were accepted before produce byte-identical meshes; walls, openings, spaces, schemas, kernel, goldens are untouched.

## Current-State Findings

All verified by the planner on the base above (Windows, Bun 1.4.4). Scratch scripts are in `D:\projects\sibambo\scratch\wp8-review\` (not part of any deliverable).

1. **Entry point → flow.** `edit_model` → worker patch → `evaluateModule` (`apps/editor/src/lib/arch/evaluate.ts:168`, `keep(buildSlab(kernel, slab, tag))`) → `buildSlab` in `apps/editor/src/lib/arch/elements.ts:63-78`. The same call runs on every read of a stored module (`MODULE_NOT_EVALUABLE` if it throws).
2. **`buildSlab` today**, in order: (a) `isSimpleRing` on outline and each hole, else `SLAB_SELF_INTERSECTS`; (b) `canonicalRing` (coordinates rounded to 1e-9, CCW/CW normalised, lexicographic start); (c) `|kernel.unionArea2d([outline]) − |signedArea(outline)|| > EPS` → reject; (d) the same for each hole; (e) `|kernel.areaWithHoles2d(outline, holes) − (A(outline) − ΣA(holes))| > EPS` → reject; (f) `kernel.prismWithHoles(...)`. `EPS = 1e-9` is a module constant at `elements.ts:11`, shared with `isSimpleRing` and other code.
3. **`isSimpleRing` is not the problem.** 0 false rejects on the 40,000-rectangle 0.1 m grid and on 23,200 rectangles of a 0.01 m grid, including thin ones.
4. **Root measurement.** `Kernel.section` (`kernel.ts:210`) passes coordinates to `CrossSection.ofPolygons`, which quantises them (v2.3 Finding 11: "≤ ~3e-9 m"). `section.area()` therefore differs from the double-precision shoelace area of the same ring by an amount **proportional to the ring perimeter**:

| Population (all valid, simple rings) | n | max \|kernel area − shoelace\| | max ratio to perimeter P |
|---|---|---|---|
| rectangles, 0.1 m grid, P ≤ 24 m | 40,000 | 4.6e-8 m² | 2.98e-9 m |
| rectangles, 0.01 m grid, P ≤ 225 m, offsets ≤ 10 m | 3,000 | 6.4e-7 m² | 3.30e-9 m |
| rectangles, offsets 0 … 10,000 m | 1,500 each | ≤ 3.3e-7 m² | 3.55e-9 m (one sample 5.85e-9 m at offset 10,000 m) |
| rectangles, offsets ±9,000 … ±9,900 m, sizes ≤ 100 m (outline check) | 4,000 each | — | 3.55e-9 m |
| same, hole check (ratio to outline + hole perimeter) | 4,000 each | — | 3.23e-9 m |
| 5–24-gons at mm precision | 2,000 | — | 3.14e-9 m |
| rectangles at offset 100,000 m (**outside** the schema range ±10,000) | 1,500 | 3.4e-6 m² | 3.69e-7 m — breaks the model; unsupported |

   With `EPS = 1e-9` flat, any ring with P above about 0.3 m can fail. The schema (`arch-module-v2.schema.json`, `coord`) bounds every coordinate to ±10,000 m.
5. **A flat 1e-8 tolerance (the reviewer's lower-bound suggestion) is not enough:** it still rejects 1,286 of 1,500 centimetre-grid rooms. A relative rule is required.
6. **What a genuine defect looks like.** A hole protruding by e metres over a 1 m edge changes the kernel area by e·1 m² (measured for e = 1e-3 … 1e-8: diff equals e·1 to 7 digits); two holes overlapping by e behave the same. The error to be absorbed is ≈ 3.5e-9·P; the defect signal is ≥ e·L. They separate by orders of magnitude for any defect wider than a few ×1e-8 m.
7. **Downstream survives.** With the two kernel checks simulated as passing, twelve decimal slabs (outline only and with a valid hole, offsets −3.7 … 9.9) went through `evaluateModule` and `bakeModule` + `BomcDocument.transact` with 0 errors. Closed wall loops on a decimal grid are not affected: 729 of 729 evaluate. The defect is confined to slabs.
8. **Cost.** 40,000 `buildSlab` calls with release take ≈ 1.1 s; the full grid is affordable in unit tests.
9. **Reference implementation.** None. This is a new rule, not a restore.

## Root Cause / Gap

C8 froze the slab validity test as an **absolute** area equality at 1e-9 m². The kernel's quantisation makes the compared quantity wrong by ≈ 3.5e-9 m × perimeter. The contract compared two numbers that cannot agree to the stated tolerance for any room larger than a few decimetres whose coordinates are not binary-exact. WP4 shipped the letter of C8; WP8's fixtures used binary-exact steps and hid it.

## Locked Architecture Decisions

The executor must not revisit any of these.

- **D1 — Rule (amendment A22 to C8).** The three slab area comparisons use `tolerance(rings) = AREA_TOL_BASE + AREA_TOL_PER_METRE × Σ perimeter(ring)` instead of `EPS`, with
  - `AREA_TOL_BASE = 1e-9` (m², the v2.3 value, kept as the floor),
  - `AREA_TOL_PER_METRE = 2e-8` (m² per metre of ring perimeter),
  - perimeter measured on the **`canonicalRing` output** in metres, using `Math.sqrt(dx*dx + dy*dy)` — **not** `Math.hypot` (its last-bit result is engine-dependent; the identity of results across Bun, Node and Chromium is an existing invariant).
  - outline check → `tolerance([outline])`; each hole check → `tolerance([hole])`; combined check → `tolerance([outline, ...holes])`.
- **D2 — Margin.** 2e-8 is ≥ 3.4× the worst measured ratio inside the schema range (5.85e-9) and ≈ 5.6× the typical worst (3.55e-9). The detection floor this leaves is a strip about 2e-8 m wide along a defect edge, far below the 1e-6 m output lattice at which the kernel already treats slivers as "not geometry" (`kernel.ts:435`).
- **D3 — Ownership.** The rule lives **only** in `buildSlab` in `elements.ts`, as module-local constants and one module-local helper. The kernel stays the only importer of `manifold-3d` (A3) and gains **no** parameter, method or constant. `EPS` keeps its value and its other uses (`isSimpleRing`, spaces, openings).
- **D4 — Rejected alternatives (do not implement).** (a) flat 1e-8 or flat 1e-6: measured insufficient or scale-blind; (b) relative to area: wrong, the error scales with perimeter (long thin rooms); (c) snapping stored or input coordinates to a 1e-6 lattice: changes stored geometry against baked geometry and replay identity; (d) removing the area checks and substituting exact containment predicates: a redesign, not a fix; (e) a tolerance argument on `Kernel.unionArea2d` / `areaWithHoles2d`; (f) catching `SLAB_SELF_INTERSECTS` and retrying.
- **D5 — Supported range.** Coordinates within the schema range ±10,000 m. Behaviour beyond it is undefined and is not tested or documented as supported.
- **D6 — Error surface unchanged.** Same `invalidGeometry('SLAB_SELF_INTERSECTS', slab.elementId)` at the same three sites. No new code, no message change, no new `detail` field.
- **D7 — Scope of side changes.** The only other production edit is the comment-only fix of the `findings.ts` header (review nit 2). `verify-cp8.ts` CI wiring (review nit 3) is **out of scope** and is not done here.

## Data and Control Flow

**Before.** `buildSlab`: simple-ring check → canonical rings → `|unionArea − shoelace| > 1e-9` → per-hole same → `|areaWithHoles − (A_outline − ΣA_hole)| > 1e-9` → prism. For a 4 × 1.9 m room the kernel error (≈ 3e-8) exceeds 1e-9 and the function throws although nothing is wrong.

**After.** Identical order and identical operations. Only the three comparison thresholds change from the constant `EPS` to `areaTolerance(...)`, computed from rings that were already built by `canonicalRing` on the preceding lines. The kernel is called exactly as before (same calls, same arguments, same count). The prism, tags, part roles and every downstream stage see identical input for any slab that was accepted before.

## Change Surface

| Class | Path | Nature |
|---|---|---|
| **MUST change** | `apps/editor/src/lib/arch/elements.ts` | `buildSlab` thresholds; two new module-local constants and one module-local function |
| **MUST change** | `apps/editor/src/lib/arch/findings.ts` | header comment lines 2–4 only (D7) |
| **MUST create** | `apps/editor/unit/arch/slab-tolerance.test.ts` | 7 tests (contract below) |
| **MUST create** | `docs/implementation-summary/IMPLEMENTATION_SUMMARY_<date>_SIB-MCP-MODELING-001_v1.19.md` in `sibambo-editor` | implementation ledger, with User Test Card |
| **Conditional** | none | no other file may change; if one must, STOP (see Stop Conditions) |
| **Read-only reference** | `kernel.ts` (`section`, `unionArea2d`, `areaWithHoles2d`, `canonicalRing`, `signedArea`), `evaluate.ts:168`, `unit/arch/elements.test.ts` (existing slab tests), `unit/arch/fixtures/agent-harness.ts` (`newDocument`, `AgentHarness.addModule`, `ok`, `text`, `fails`), `unit/arch/fixtures/modules.ts` (`moduleOf`) |
| **Forbidden** | `kernel.ts`; `walls.ts`; `isSimpleRing` and `EPS`; `evaluate.ts`; `bake.ts`; `topology.ts`; `checks.ts`; `perception.ts`; `patch.ts`; every schema and generated validator; existing tests and goldens (no edit, no re-baseline); `packages/**`; Builder; `lib/mcp/**`; launcher; workflows; plans v2.3–v2.5 | Behaviourally: this change decides only whether a slab polygon is admitted; it must not alter how any admitted geometry is built, baked, read or reported. |

## Implementation Contracts

### `elements.ts` — `buildSlab(kernel, slab, tag)` (line ~63)

- **Current responsibility.** Validate one slab and return its prism `Solid`.
- **Why here.** It owns the C8 slab validity contract and is the only caller of the three area comparisons.
- **Add, immediately below `const EPS = 1e-9;` (line 11), module-local, not exported:**
  - `const AREA_TOL_BASE = 1e-9;` and `const AREA_TOL_PER_METRE = 2e-8;` with a one-line comment: kernel quantisation (≤ ~3.5e-9 m) makes `section.area()` differ from the shoelace area by ≈ that times the perimeter; amendment A22.
  - `function areaTolerance(rings: readonly (readonly Vec2[])[]): number`:
    ```
    let perimeter = 0
    for each ring in rings:
      for i in 0 .. ring.length-1:
        a = ring[i]; b = ring[(i+1) % ring.length]
        dx = b[0]-a[0]; dy = b[1]-a[1]
        perimeter += Math.sqrt(dx*dx + dy*dy)
    return AREA_TOL_BASE + AREA_TOL_PER_METRE * perimeter
    ```
    Input rings are the `canonicalRing` results (type `Vec2[]`); `Vec2` is already imported.
- **Edit the three comparisons only** (keep every other line, including the `isSimpleRing` loop before and `prismWithHoles` after):
  1. `... unionArea2d([outline]) - areaOf(outline)) > EPS` → `> areaTolerance([outline])`
  2. in the `holes.forEach`: `... > EPS` → `> areaTolerance([hole])`
  3. `... areaWithHoles2d(outline, holes) - expected) > EPS` → `> areaTolerance([outline, ...holes])`
- **Inputs / outputs / state.** Unchanged: reads `slab`, `kernel`; returns the same `Solid`; mutates nothing. Kernel calls: same three queries, then `prismWithHoles`, in the same order.
- **Failure behaviour.** Unchanged throw sites and payload (D6). A `KernelError` from `canonicalRing` (non-finite, < 3 vertices, zero area) still propagates before any comparison.
- **Cleanup.** None added; kernel section lifetimes are inside the kernel methods.
- **Interactions.** `isSimpleRing` is untouched and still runs first. `evaluate.ts:168` and `kernel-faults.test.ts` call `buildSlab` unchanged. Replace the one-line comment above the combined check if it mentions "1e-9" with wording that mentions the perimeter-scaled tolerance; otherwise leave comments alone.

### `findings.ts` — header comment (lines 2–4)

Replace the sentence "Does not import the geometry kernel." with exactly: "Pure and synchronous: it never calls a `Kernel` instance. It imports `distanceToRings`, `frameWidth` and `windingNumber` from `./elements.js`, which imports the `./kernel.js` module (not an instance)." No code line may change.

### `slab-tolerance.test.ts` — new file

Imports: `beforeAll, describe, expect, test` from `bun:test`; `buildSlab` from `../../src/lib/arch/elements`; `createKernel, type Kernel` from `../../src/lib/arch/kernel`; `ArchError` from `../../src/lib/arch/errors`; `evaluateModule`, `bakeModule` and the BomcDocument helpers exactly as in `bake-managed-cp5.test.ts` only if the executor prefers them for T-S6 (not required, see below); `newDocument` from `./fixtures/agent-harness`; `moduleOf` from `./fixtures/modules`. `beforeAll` creates one kernel and `await kernel.init()`. Deterministic pseudo-random source, identical everywhere: `let seed = <given>; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;`. Contract: see the next section.

## Invariants

1. A slab accepted before the change yields a byte-identical mesh after it (same canonical rings → same prism). Proven by unchanged `verify-g10.ts`, `verify-g10-cp5.ts` pinned hashes and by the unchanged `verify-cp8.ts` goldens.
2. Rejection payload is identical: `ArchError`, `code INVALID_GEOMETRY`, `detail.reason 'SLAB_SELF_INTERSECTS'`, `detail.elementId` = the slab id (existing assertion style in `elements.test.ts:153-158`).
3. `isSimpleRing` still runs first and still rejects bow-ties and touching vertices at any scale.
4. The kernel API surface and `manifold-3d` import location are unchanged.
5. `EPS` is still `1e-9`; wall, opening and space behaviour is unchanged.
6. The kernel is called the same number of times per `buildSlab`; `kernel.liveCount()` returns to its starting value after every case (no leaked Manifold/CrossSection objects).
7. Schemas and generated validators are unchanged; `generate-arch-validators.ts --check` passes with the same three hashes as in summary v1.18.
8. The tolerance is deterministic: no `Math.hypot`, no randomness, no clock.
9. Reads stay pure: no read tool, perception or check code is touched.

## Edge Cases and Failure Semantics

| Case | Required behaviour |
|---|---|
| Valid decimal rectangle of any size in ±10,000 m | admitted |
| Valid decimal outline with decimal hole(s) fully inside, up to 32 holes | admitted; the combined check uses outline + all hole perimeters |
| Hole protruding past the outline by ≥ 1e-6 m over a ≥ 1 m edge | rejected |
| Two holes overlapping by ≥ 1e-5 m over a 1 m edge | rejected |
| Hole entirely outside the outline | rejected |
| Bow-tie, touching vertex, self-overlap | rejected by `isSimpleRing` before any area check |
| Protrusion or overlap narrower than about 2e-8 m (below the 1e-6 m output lattice) | **may be admitted**; documented, not asserted either way |
| Clockwise rings | unchanged: `canonicalRing` normalises first |
| Duplicate / collinear consecutive vertices | unchanged: duplicates collapsed by `canonicalRing`; perimeter is taken from the collapsed ring |
| Non-finite coordinate, < 3 vertices, zero area | unchanged: `KernelError` from `canonicalRing`, before any comparison |
| Coordinates outside ±10,000 m | outside scope (D5); not tested |
| Slab thickness, elevation, role, material | unrelated to this rule; unchanged |

## Work Packages

### WP8A — Slab area tolerance (A22)

Dependencies: owner approval of A22; base as in the metadata table. **Risk:** low (one function, three thresholds). **Eligible implementation agent:** any primary model; subagents only if the owner authorises, and then only GPT-6 Luna at maximum effort. **Independent review required afterwards:** yes — the owner-designated reviewer (PR [#31](https://github.com/KaisAbiyyi/sibambo-editor/pull/31)); the implementor neither approves nor merges.

Ordered steps (the repository stays runnable after each):
1. Fetch; confirm base tip equals the merge of PR #30 or a descendant that did not touch `elements.ts`. Create the branch.
2. Write `slab-tolerance.test.ts` first (all 7 tests). Run it **before** touching production code. Record the output: T-S1, T-S2, T-S3 and T-S7 must FAIL; T-S1's failure message must report 35,896 rejections (T-S1 prints the count before asserting). T-S4, T-S5, T-S6 must PASS (they test rejection, which already works). If T-S1 does not fail → STOP.
3. Edit `elements.ts` as specified. Run `slab-tolerance.test.ts`: all 7 pass.
4. Edit the `findings.ts` comment as specified.
5. Run the existing slab and kernel tests: `bun test unit/arch/elements.test.ts unit/arch/kernel-faults.test.ts` — unchanged, pass.
6. Mutation checks (each applied, test run, **reverted**; report the result): (a) `AREA_TOL_PER_METRE = 0` → T-S1 fails; (b) `AREA_TOL_PER_METRE = 1e-3` → T-S4 and T-S5 fail; (c) outline check back to `EPS` but others new → T-S1 fails; (d) combined check back to `EPS` → T-S3 fails; (e) `Math.hypot` instead of `Math.sqrt(...)` → tests still pass (record as "not observable", no action). `git diff` after reverting must show only steps 3–4.
7. Full verification (below), commit only task-owned files, push the branch, open a PR, write the summary.

**CHECKPOINT CP8A.** Gate, not progress. Must exist: the edited `elements.ts`, `findings.ts` comment, the new test file, the summary. Must not exist: any other production diff. Must pass: everything in the Test and Verification Contract. Failure of any item → stop dependent work, report evidence, route to REVIEW/PLAN. Continue only after independent review of the PR; WP12 must not be accepted before CP8A is accepted.

## Test and Verification Contract

Evidence categories: UNIT, INTEGRATION (T-S7, through the real worker dispatcher), STATIC, LIVE (hosted CI). No BROWSER/MANUAL item is a gate for this package.

| ID | File · behaviour · fixture · action · expected | Negative assertion · why it protects the contract |
|---|---|---|
| **T-S1** | `slab-tolerance.test.ts` · every 0.1 m grid rectangle is admitted · loops `ox,oy ∈ 0..4`, `w,h ∈ 1..40`; outline `[ox/10,oy/10] [(ox+w)/10,oy/10] [(ox+w)/10,(oy+h)/10] [ox/10,(oy+h)/10]`, thickness 0.2, topElevation 0 · call `buildSlab`, `kernel.release(solid)`; count throws, `console.log` the count first · expect 0 throws of 40,000; afterwards `kernel.liveCount() === 0` · **Negative:** no case may be skipped (assert iteration count 40,000). Would have failed before the fix (35,896 throws); this is the regression for F-WP8-1. Timeout 60 s (expected ≈ 1–3 s). |
| **T-S2** | scale and offset · seed `20261128`; 3,000 rectangles; offset `ox`, `oy` each = `[-9800,-1000,-100,-10,0,10,100,1000,9800][Math.floor(rnd()*9)]`; `x0 = ox + Math.round(rnd()*5000)/100`, `y0` likewise; `w = Math.round(rnd()*6000)/100 + 0.01`, `h` likewise · all admitted; all stay within ±10,000 by construction · **Negative:** assert `Math.max(|x|,|y|)` of every vertex ≤ 10,000 so the fixture cannot silently leave the supported range. Protects D2 at the schema edge. |
| **T-S3** | decimal holes · seed `7`; 2,000 cases; outline `[0.1,0.1]` to `(0.1 + w, 0.1 + h)` with `w = 4 + Math.round(rnd()*400)/10`, `h = 4 + Math.round(rnd()*300)/10`; hole `[hx,hy]`–`[hx+hw,hy+hh]` with `hx = 1 + Math.round(rnd()*10)/10`, `hy` likewise, `hw = 0.3 + Math.round(rnd()*10)/10`, `hh` likewise (always inside: hole ≤ 3.3 < outline ≥ 4.1) · admitted, and `kernel.stats(solid).volume` equals `(w·h − hw·hh)·0.2` within 1e-6 m³ · **Negative:** `stats.genus === 1` and `status === 'NoError'`. Proves the hole is a real hole, not that the check was merely skipped. |
| **T-S4** | genuine defects at decimal scale are still rejected · outline `[0,0],[4,0],[4,3],[0,3]`; hole `[3.5,1],[4+e,1],[4+e,2],[3.5,2]` for `e ∈ {1e-3,1e-4,1e-5,1e-6}`; second suite: overlapping holes `[1,1],[2,1],[2,2],[1,2]` and `[2-e,1],[3,1],[3,2],[2-e,2]` for `e ∈ {1e-3,1e-5}`; third: outline `(0.3,0.3)–(4.2,3.3)` with hole `[3.7,1],[4.2+1e-4,1],[4.2+1e-4,2],[3.7,2]` · each throws `ArchError` with `detail.reason 'SLAB_SELF_INTERSECTS'` and `detail.elementId` = the slab id · **Negative:** the same slab with `e = 0` for the first fixture (hole touching the boundary) is **not** asserted (ambiguous by design). Catches a tolerance chosen too large (mutation 6b). |
| **T-S5** | tolerance scales but does not blanket-open large rings · outline `(0,0)–(100,100)`; hole `[90,40],[100.0001,40],[100.0001,41],[90,41]` · rejected with the same payload (area signal 1e-4 m² vs tolerance ≈ 8.4e-6) · **Negative:** none beyond the payload check. Protects D1's proportionality. |
| **T-S6** | unchanged semantics at decimal coordinates · (a) bow-tie `[0.3,0.3],[4.2,3.3],[4.2,0.3],[0.3,3.3]`; (b) hole fully outside `[5.1,5.1],[6.2,5.1],[6.2,6.2],[5.1,6.2]` in outline `(0.3,0.3)–(4.2,3.3)`; (c) touching vertex `[0.3,0.3],[4.2,0.3],[4.2,3.3],[2.1,0.3],[0.3,3.3]` · each rejected with the standard payload · Protects invariant 3 (the simple-ring guard) and shows the new tolerance did not weaken containment. |
| **T-S7** | end to end, no LLM · `const h = await newDocument(); await h.addModule(moduleOf([{ elementId:'s', kind:'slab', outline:[[0,1.1],[4,1.1],[4,3],[0,3]], holes:[[[1.2,1.7],[1.2,2.3],[1.9,2.3],[1.9,1.7]]], thickness:0.2, topElevation:0 }]))` · `addModule` resolves (the `edit_model` call succeeded; the harness throws otherwise); `await h.text('describe_scene')` contains `test/ground` and `slab` (the module row shows `slabs: 1`, as in `perception-cp8.test.ts:52`); `const json = await h.ok('check_model', { limit: 1000, format: 'json' })` as in `checks-cp8.test.ts:21`: `json.findings` contains **no** row with code `MODULE_NOT_EVALUABLE` and **no** row with severity `ERROR`; then `await h.ok('undo', { steps: 1 })` succeeds and `await h.text('describe_scene')` contains `Arch modules 0:` · **Negative:** `h.revision()` read before the edit differs after it and the undo does not leave the slab (the second `describe_scene` must not contain `test/ground`). Use only existing harness members; invent no counters. This is the owner-visible symptom, run through the real dispatcher, evaluator and baker. |

**Full verification, on the final commit** (Windows, `TEMP`/`TMP` on `D:` under `D:\projects\sibambo\scratch\`; commands as used for CP8 in summary v1.18 §4):
1. `bun test unit/authoring unit/arch unit/mcp unit/editor unit/agent` — **692 pass / 0 fail** (685 baseline + 7 new); if the count differs, report the actual and explain every difference.
2. `bun run check` — 0 errors, 0 warnings.
3. `bun run build` — pass.
4. `generate-arch-validators.ts --check` — pass, three hashes identical to v1.18.
5. `verify-g10.ts`, `verify-g10-cp5.ts` on Bun then Node with `--compare`, and `verify-cp8.ts` on Bun and Node — pass; pinned hashes and 8/8 goldens unchanged. **If any hash or golden changes → STOP** (invariant 1 is violated).
6. Hosted CI on the exact pushed HEAD: read the verdicts (cp4 and cp5, ubuntu and windows, Bun 1.3.0 and 1.4.4); never claim a result not read.

**Real inputs and fixture gap.** Rectangles and holes exercise perimeter-proportional error well, but rooms are L-shaped, rotated and curved. The planner measured 5–24-gon rings at mm precision (ratio ≤ 3.14e-9). T-S3 and T-S7 are rectangular. The remaining gap (non-rectangular slabs in an agent session) is the **owner test** in the User Test Card, not an automated gate.

**Benchmarks and unproven claims.** Measured: grid timing (≈ 1.1 s for 40,000 builds) and all ratios above. Not measured / unproven: Bun 1.3.0 locally (CI covers it), Linux locally, Chromium, any LLM client, read time near the A18 ceilings, rotated or curved slab outlines.

## Expected Final Diff

- `apps/editor/src/lib/arch/elements.ts`: ≈ +14 / −4 lines — two constants, one ≈ 8-line function, three comparisons edited, at most one comment sentence.
- `apps/editor/src/lib/arch/findings.ts`: 1–2 comment lines changed.
- `apps/editor/unit/arch/slab-tolerance.test.ts`: new, ≈ 150–220 lines.
- `docs/implementation-summary/IMPLEMENTATION_SUMMARY_*_v1.19.md`: new.
- Nothing else. **Scope-drift indicators:** any edit in `kernel.ts`, `walls.ts`, `evaluate.ts`, schemas, validators, goldens, existing tests; a changed `EPS`; a new exported symbol from `elements.ts`; a new tolerance parameter on any kernel method; a changed error code or message; a test with a loosened assertion; edits to `package.json`, lockfile, CI workflows.
- Symbols that must stay unchanged: `EPS`, `isSimpleRing`, `canonicalRing`, `signedArea`, `Kernel.unionArea2d`, `Kernel.areaWithHoles2d`, `invalidGeometry`.

## Stop Conditions

The executor reports evidence and stops; it must not redesign:
1. `buildSlab`, `EPS` or the three comparisons do not look as described in Current-State Findings (the base has moved), or `elements.ts` / `findings.ts` has diverged on the base.
2. T-S1 passes before the fix (the defect is not reproduced).
3. After the fix T-S1, T-S2 or T-S3 still has any rejection — **do not raise `AREA_TOL_PER_METRE`**; report the failing case and its measured ratio.
4. After the fix any of T-S4, T-S5, T-S6 is accepted — **do not lower the constant**; report.
5. T-S7 fails at a stage other than `buildSlab` (evaluate, bake, `describe_scene`, `check_model`, undo): record it as a new finding (**F-WP8-2**), do not patch downstream code.
6. Any existing test, pinned hash, or golden changes outcome.
7. Full-grid time exceeds 30 s on the executor's machine (the plan assumes ≈ 1–3 s).
8. Any edit outside the Change Surface becomes necessary.

## Manual Gates

None blocks WP8A. The owner-run **User Test Card** (written into the summary, per the owner-driven MCP testing rule) is:
1. **What changed:** an agent can now create slabs with ordinary decimal sizes.
2. **How to start:** as in summary v1.18 §7 (local-demo setup, Extensions → Agent → Hubungkan agent), your own client and model.
3. **What to look at (owner: Kais):** ask the agent to add a 4.2 m × 3.9 m floor slab at (0.3, 0.3), then a slab with a window-sized hole, then an L-shaped or rotated slab; ask it to describe the scene and check the model. Optional, non-binding ideas: a 12 m × 7.4 m slab; a slab whose hole is moved a few millimetres outside the outline (should be refused).
4. **How to report:** session id plus observation; recorder files under `outputs/mcp-sessions/`. Result PENDING until reported.
5. **Known limit:** non-rectangular slabs are not covered by automated proof.

## Executor Completion Report Requirements

The summary and final response must state: actual files changed; every material deviation from this plan (or "none"); every check run with its exact result and command (including the pre-fix failure output of T-S1 with its count, mutation results, and the unchanged hashes); remaining unverified claims (as listed above); a diff-scope comparison against Expected Final Diff; commit SHA, branch, PR link and the hosted-CI verdicts actually read; **long-term progress** (parent objective: an agent that models in the owner's open Editor document; WP0–WP8 done, WP8A done/partial, WP9–WP12 remaining; next deliverable: WP9 Denah). Do not claim the User Test Card passed. Do not merge.

## Final adversarial pass (planner)

A literal executor could: (i) raise the constant until its tests pass — blocked by Stop 3/4 and by T-S4/T-S5; (ii) change `EPS` globally — blocked by the forbidden list, invariant 5 and the diff-shape indicators; (iii) put the tolerance in the kernel — blocked by D3 and Forbidden; (iv) use `Math.hypot` — D1 forbids it, a mutation check records it; (v) pass T-S1–T-S3 yet leave the owner symptom broken — T-S7 runs the real dispatcher; (vi) weaken rejection — T-S4/T-S5/T-S6 and the existing `elements.test.ts` cases; (vii) re-baseline goldens — Stop 6; (viii) test only rectangles at the origin — T-S2 spans ±9,800 m, T-S3 holes, and the fixture gap is named and routed to the owner test; (ix) satisfy the words while leaking kernel objects — invariant 6 and T-S1's `liveCount` assertion. No critical dependency on high-level reasoning remains.
