# PLAN DISPOSITION (PROPOSED) — SIB-MCP-MODELING-001 WP4: G9 enclosure, C7.4–5 construction, staggered continuation

ID **SIB-MCP-MODELING-001** · Disposition **v0.1** · Date **2026-11-15 (Asia/Jakarta)** · Status **RESOLVED: the owner decided D1 = B, D2 = ratify (option a), D3 = reject for agent writes / report for read, never auto-join. The decisions are incorporated in [master v2.4](MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.4.md); this file is kept unchanged below as the record of the options that were put to the owner (it was PROPOSED, `test.todo` and `'report'` default describe the state before the decision).**

- **Trigger:** independent review verdict REVIEW/PLAN, CP4 PARTIAL, on Editor `29e5cbb`.
- **Author:** implementor of WP4 (Claude Code cloud session `session_01JoynVtWpBxaEDZLfEkvFKf`); no subagents. This is a proposal by the implementor, not an approval.
- **Evidence:** every claim below is backed by a test named in the last column of the evidence table and by the WP4 summary v1.9.

## Decisions requested

| # | Question | Needed for |
|---|---|---|
| **D1** | What does a space's `enclosed` mean: wall *solids* leave no opening, or authored wall *centrelines* close a loop? | G9, CP8 `WALL_GAP`, CP4 |
| **D2** | Is the C7.4–5 construction amended (bodies and bridges added to the quads) or reverted? | CP4, CP5 |
| **D3** | What happens to collinear walls on opposite sides of their path? | WP6/WP7 error catalogue |

Nothing in WP5–WP12 is started on any answer.

## D1 — G9: authored connectivity versus physically closed solids

**The conflict.** G9 shortens the north wall by 0.02 m and expects `enclosed:false`. With t = 0.15 the shortened wall's end still lies inside the east wall's body, so the *3D solid* is closed. Under C8 ("seed outside → not enclosed" using the footprint) the answer is `true`; the room only opens when the gap exceeds t/2 = 0.075 m. Making the mesh report a gap would falsify the model, so the mesh must not change.

**The distinction.** Two different facts exist:

| | Definition | G9 | Source |
|---|---|---|---|
| **solid enclosure** | the wall bodies (mesh footprint) separate the seed from the outside | closed | `buildSpaces`, today's `SpaceResult.enclosed` |
| **authored enclosure** | the wall centrelines, joined by the module's own JOIN_TOL (0.001 m), close a loop around the seed | **open** (centrelines end 0.02 m apart, no node, `WALL_GAP`) | `connectivity.ts::centerlineEnclosure` |

Authored enclosure is what an author or agent controls (it is what "four walls sharing endpoints" means in A8) and what `WALL_GAP` (0.001–0.30 m) is about. Solid enclosure is what the model physically is. They differ exactly when walls overlap without being joined, which is a construction defect the agent should be told about even though the mesh looks closed.

**Options**

| Option | `enclosed` means | Added fields | G9 result | Cost |
|---|---|---|---|---|
| **A** | solid (unchanged) | none | `enclosed:true`; G9 text must be amended to `true` + `WALL_GAP` | the plan loses the "room is open" signal for overlapping-but-unjoined walls |
| **B** | solid (unchanged) | `authoredEnclosed` | `enclosed:true`, `authoredEnclosed:false`; G9 text amended to `authoredEnclosed:false` | two booleans; consumers must read the right one |
| **C (recommended)** | **authored** | `solidClosed` (mesh truth) | **`enclosed:false`, `solidClosed:true`** — G9 holds as written | the field's meaning moves from physical to authored; `area`/`bbox` stay computed from the solid region whenever `solidClosed`, `null` otherwise |

**Why C.** It keeps G9 and the plan's intent (`WALL_GAP` fix point) literally true, never alters a mesh, and keeps the physical fact available. Where they disagree CP8 emits `WALL_GAP` (authored open, solid closed) or `ROOM_SOLID_LEAK` (authored closed, solid open, e.g. a staggered pinch).

**What is already built (not wired).** `centerlineEnclosure(kernel, segments, spaces)` is a pure function over the wall solver's segments: strokes of width JOIN_TOL with square caps, regions of `bounds+1 m ∖ strokes`, seed in a region that does not touch the bounds. It is **not called by `evaluateModule`**, so no frozen semantics changed.

**Proof for G9** (`unit/arch/connectivity.test.ts`): the G9 fixture is unchanged (north wall `[[3.98,3],[0,3]]`); `centerlineEnclosure` → `false`; `buildSpaces` → `true`; the export SHA-256 of the evaluated module is identical before and after computing the authored answer and identical across two fresh kernels. A gap of 0.0009 m is a join (both closed); 0.0012 m opens the centreline but not the solid; 0.1 m opens both; a seed on a centreline answers `null`.

**If the owner chooses C**, the implementation is: add `solidClosed` to `SpaceResult`, set `enclosed` from `centerlineEnclosure`, turn the `test.todo` in `golden-cp4.test.ts` into the assertion, and leave every mesh test untouched. If A or B, only the G9 text and one test change.

## D2 — C7.4–5: corner quads versus quads + bodies + bridges

**Finding.** The plan extrudes the corner quads and node polygon. For two *centre* walls of different thickness at an acute angle the quad of the wide wall ends on a seam toward a far corner, and the region of its own body between the seam and the neighbour's edge belongs to nobody. Measured with `construction:'plan-literal'` (the option reproduces C7.4–5 exactly):

| walls | angle | authored body missing in plan-literal | in the shipped solid |
|---|---|---|---|
| t 0.25 / 0.10 | 12° / 30° | 0.0128 m² / 0.0039 m² | 0 |
| t 0.40 / 0.10 | 12° / 20° | 0.0521 m² / 0.0296 m² | 0 |
| t 0.40 / 0.15 | 12° | 0.0358 m² | 0 |
| orthogonal (any thicknesses and sides), equal thickness (any angle), 8° (bevel), every golden | — | 0 | identical |

Across 300 seeded random stars per mode, plan-literal misses > 1e-4 m² of authored body in **188** (any side) and **167** (centre walls only); the shipped solid misses ≤ 5.8e-6 m² (rounding).

**What is shipped (hardened).** The solid is the union of the plan quads, the plan node fan, each segment's butt-ended full body, and, for straight continuations, a bridge strip inside both bodies. Quads keep the connectivity (shared exact corner vertices); bodies and bridges attach by volume overlap. A first attempt without quads was worse (31/300 stars split) and was discarded.

**Properties proven** (`walls-deviation.test.ts`, `walls-fuzz.test.ts`): identical footprint and volume to plan-literal on G1–G9; everything added lies inside the authored bodies (≤ 3.2e-6 m² outside, rounding); no plan material removed (≤ 5.3e-6); zero-volume shells would appear without the kernel cleanup (necessity test); every part is watertight, oriented, tag-attributed and free of duplicate faces. **Not claimed:** any CP5 property. A *probe* shows that C9 steps 1–2 applied literally to the raw wall meshes yield 10 groups for G1 and 14 for G4, matching the plan's CP5 face counts; that is a compatibility signal only.

**Known costs (measured).**
- Raw size: 10×10 crossing grid 3133 vertices / 6586 triangles versus 912 / 2144 plan-literal (inside the A18 bake ceilings 8192 / 20000; baking re-triangulates from loops).
- The union leaves some degenerate/tiny triangles at T/X/acute junctions (G4 1+2, G5 6+36, G7-30 6+1 below 1e-12 / 1e-6 m²). At G7 30° the bodies add **no area** but introduce 6 degenerate triangles and one group below 1e-6 m² that plan-literal does not have. C9 step 1 drops the degenerates; the fragment group needs a WP5 rule.
- Added material is not confined to the miter radius: a missing body edge can run along the whole wall, so the guarantee is *containment in the authored bodies*, not distance.
- With `side` left/right a body can poke past a neighbour's face by at most its own butt corner (measured, contained).

**Options**

| Option | What | Effect on pins |
|---|---|---|
| **a (recommended now)** | ratify the shipped construction as the amendment of C7.4–5 | none: G10 hashes at `29e5cbb` stay valid |
| **b** | add bodies only where they add ≥ 1e-4 m² beyond the plan footprint (identical to plan-literal on goldens and sound junctions; removes the G7 artefacts) | **re-pins G1/G4/G8 hashes** (back toward the quad-only pins); needs owner approval because the pins are golden |
| **c** | revert to plan-literal and reject unsound junctions with a new reason (e.g. `WALL_JUNCTION_UNSOUND` when authored body would be lost > ε) | rejects acute mixed-thickness stars that a user can legitimately author |

Recommendation: **a** now; revisit **b** inside WP5 when the topology cost of the raw meshes is known.

## D3 — Opposite-side antiparallel walls: deterministic report-or-reject

**Facts.** Two collinear walls meeting at one node, bodies on opposite sides of the line (e.g. both `side:"right"` but running opposite ways, or left/left), share **no lateral width**; they overlap in height and touch only along an edge line. Their solids are two components. For schema-valid thickness (≥ 0.01) the shared width is exactly 0 or at least 0.005 m, so the rule below has no ambiguous band (`STAGGER_MIN_OVERLAP = 2.1e-5` m is never reached). Shared width > 0 is bonded by a bridge strip (all 27 side/thickness combinations × 4 tilts tested).

**Rule (implemented as an option, default unchanged).** `buildWallNetwork(…, {staggered})`:
1. Detect: antiparallel pair at a node (|sin| ≤ 1e-4), height overlap > 1e-6 m, shared lateral width < 2.1e-5 m.
2. `'report'` (default, the WP4 behaviour): build exactly what was authored; list each pair in `network.staggered` and in `EvaluatedModule.diagnostics` (`WALL_STAGGERED_CONTINUATION {at, elements, overlap}`), sorted by node then tags. Never silent.
3. `'reject'`: throw `INVALID_GEOMETRY WALL_STAGGERED_CONTINUATION` (elementId = first wall by tag, `at` = node, message: put both on the same side or add a connecting wall) before any solid is built.
4. **No `'join'`**: a join must invent material (a jog spanning both lateral ranges). The agent can express the intent with an explicit connecting wall.

**Recommendation:** make `'reject'` the production policy for agent writes once approved (it is always an authoring mistake); keep `'report'` for read paths. Switching the default is a one-word change plus the owner's authorization. Tests: `walls-staggered.test.ts` (45).

## Evidence index

| Claim | Test |
|---|---|
| G9 fixture unchanged; authored open / solid closed; mesh digest invariant | `connectivity.test.ts` |
| plan-literal loses material; shipped does not; goldens identical | `walls-deviation.test.ts` §1–2 |
| additions contained in authored bodies; plan material never removed (600 stars) | `walls-deviation.test.ts` §3, `walls-fuzz.test.ts` |
| cleanup necessary and harmless | `walls-deviation.test.ts` §4 |
| structural preconditions for topology/bake; A18 raw size | `walls-deviation.test.ts` §5 (probe, not CP5) |
| staggered detect / report / reject | `walls-staggered.test.ts` |
| init concurrency, partial-failure release | `kernel-faults.test.ts` |

## What stays open

D1 and D2 decide whether CP4 can leave PARTIAL. D3 decides the default. Until the owner answers, G9's plan assertion remains a `test.todo`, the shipped construction remains an implementor deviation, and `'report'` remains the default.
