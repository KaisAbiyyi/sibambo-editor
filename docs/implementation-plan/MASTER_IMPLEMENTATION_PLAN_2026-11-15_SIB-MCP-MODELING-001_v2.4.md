# MASTER IMPLEMENTATION PLAN — SIB-MCP-MODELING-001 v2.4 (delta over v2.3: WP4 owner dispositions)

ID **SIB-MCP-MODELING-001** · Version **2.4** · Date **2026-11-15, Asia/Jakarta** · Status **AMENDMENT. The three owner dispositions D1–D3 for the WP4 review are incorporated. [v2.3](MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md) is kept byte-for-byte unmodified as history.**

**Authority and provenance.** The authority for every change below is the owner's written disposition in the WP4 session of 2026-11-15: D1 = option **B**, D2 = ratify the hardened C7.4–5 construction and make the CP5 topology/face/edge goldens mandatory without relaxing any target, D3 = reject staggered continuations for agent writes, report for reads/evaluation, never auto-join; and the instruction "terbitkan addendum atau Master Plan v2.4 yang menjaga v2.3 sebagai histori". The text was drafted by the WP4 implementor (Claude Code cloud session `session_01JoynVtWpBxaEDZLfEkvFKf`, no subagents; the exact model identifier is not recorded here by session policy). It was **not independently reviewed**; the owner's decisions, not this drafting, are the authority. It adds no product scope.

**Supersedes** v2.3 **only** for the items in §Amended items. Every other contract, decision, work package, test and checkpoint of v2.3 — and, through it, of v2.2/v2.1/v2.0 — is restated unchanged and stays in force. Where v2.4 and v2.3 differ on an amended item, v2.4 governs; nowhere else.

**Revision history:** v2.0 owner redirect to the Editor add-on · v2.1 admission-compatible encoding · v2.2 stage-then-commit · v2.3 atomic undo and journal shape · **v2.4 WP4 dispositions (this file)**.

## Owner dispositions

| # | Question (WP4 review) | Owner decision | Where it lands |
|---|---|---|---|
| **D1** | What does a space's `enclosed` mean? | **B**: `enclosed` keeps meaning **solid closure**; add **`authoredEnclosed`** for centreline connectivity. G9 is amended explicitly; no golden result is falsified. | A1, A2 |
| **D2** | Amend or revert the C7.4–5 construction? | **Ratify** the hardened construction (quads + bodies + bridges). Document the mesh consequences. The golden topology/face/edge targets are **mandatory WP5 gates, not relaxed**. | A3, A6 |
| **D3** | Collinear walls on opposite sides of their path | **Reject** for agent writes, **report** for read/evaluation. **Never auto-join.** | A4, A7 |

## Amended items

### A1 — G9 (replaces the G9 line of §Golden geometry)
> **G9** north wall shortened 0.02 at its east end → the write commits; the space reports **`enclosed:true`** (solid closure: the 0.15 m bodies still overlap) and **`authoredEnclosed:false`** (the centrelines end 0.02 m apart, beyond JOIN_TOL, so no node exists); the exported mesh is byte-identical to the one evaluated without the space element; (CP8) `WALL_GAP` with fix (4.000,3.000).

Reason for the amendment (not a result adjustment): v2.3 G9 said "space `enclosed:false`", which C7/C8 geometry cannot produce for this fixture, because with t = 0.15 the shortened wall's end is still inside the east wall's body and the footprint is closed. The room only opens when the gap exceeds t/2 = 0.075 m. The fixture is unchanged.

### A2 — C8 Spaces output (adds to the C8 "Spaces" bullet; the placement rules there are unchanged)
Each space returns `{ring, holes, area, bbox, enclosed, authoredEnclosed}`:
- `enclosed` — **solid closure**, exactly as in v2.3: the seed lies in a bounded region of `bounds + 1 m ∖ footprint` (the footprint is the wall solids). When false, `area = 0`, `ring/holes = []`, `bbox = null` (a result, not a rejection).
- `authoredEnclosed` — **centreline connectivity**: the seed lies in a bounded region of the plane minus the wall centreline segments after JOIN_TOL clustering and T/X splitting, each stroked with width JOIN_TOL and square caps of JOIN_TOL/2. `null` only for a seed on a centreline (unreachable in practice: `SPACE_SEED_IN_WALL` is raised first).
- Neither value may change any mesh. `SPACE_SEED_IN_WALL` stays `INVALID_GEOMETRY`.
- **CP8 input:** `WALL_GAP` is raised when `authoredEnclosed=false` and `enclosed=true` (plus the near-miss endpoint rule of A8); `ROOM_SOLID_LEAK` when `authoredEnclosed=true` and `enclosed=false`. WP4 reports the two fields only.

### A3 — C7.4–5 construction (replaces C7.4 and C7.5 as written; C7.1–3, C7.6–7 unchanged)
4. **Quads** `[Ra, Rb, Lb, La]` per segment are still computed exactly as in v2.3. Their corners remain the source of `startLimit`/`endLimit` for openings (C8), and a quad that is non-simple or has area ≤ 1e-9 still rejects with `WALL_SEGMENT_TOO_SHORT`. They are no longer the whole solid.
5. **Solids.** The wall solid is ONE union of:
   1. every quad, `prism(quad, z0, z0+h, segTag)`;
   2. the **node fan**: for each node with degree ≥ 2, the triangles `(node, a, b)` formed by each segment's end edge (right→left) and by the chord from its left end to the next segment's right end, kept only when counter-clockwise with area ≥ 1e-9. This **replaces the v2.3 node polygon** (the ring of the corners `cᵢ`, feet and bevel points). The fan reproduces the worked check of v2.3 C7.3 (T: the triangle `(0.075,0.075)`, `(−0.075,0.075)`, `(0,−0.075)`) and every golden volume, closes bevel gaps, and cannot yield a clockwise overlap triangle. This replacement was made in the first WP4 implementation but was **not listed as a deviation in summary v1.8**; it is recorded here and ratified with D2;
   3. each segment's **butt-ended body**, i.e. the rectangle with the segment's own lateral body lines and perpendicular ends at both nodes (corners snapped to the 1e-9 lattice and shared with the fan), extruded over the segment's height;
   4. one **bridge strip** per straight continuation (two segments at a node with |sin| ≤ 1e-4 and opposite outward directions): a rectangle of axial half-depth 1e-4 m spanning their shared lateral range inset by 1e-5 m, over their shared height. It lies inside both bodies, so it adds no material; it exists so that the two end faces are bonded by volume overlap, never by near-coincident faces.

   Parts are ordered by a canonical geometry key before the union (equal networks give equal meshes). Boolean results drop components of volume < 1e-9 m³ (zero-volume shells that the perturbation of the boolean can leave when two inputs differ by ~1e-9).

**Guarantees (all tested):** the solid equals the v2.3-literal construction on G1–G9 and on every orthogonal junction of any thickness/side mix and every equal-thickness centre junction at any angle; everything it adds lies inside the authored bodies; it never removes material that the v2.3-literal construction has; the authored body next to a node is never lost (v2.3-literal loses up to 0.052 m² at a 0.40/0.10 m, 12° junction).

**Consequences for the mesh (recorded, owner-ratified):**
- raw triangle/vertex counts grow about 1.5–2× at T/X/acute junctions (G4 48→83 vertices; G5 105→205; a 10×10 crossing grid 912→3133 vertices and 2144→6586 triangles, inside the A18 bake ceilings 8192 / 20000);
- the raw unions keep collinear/interior vertices and some degenerate (< 1e-12 m²) or tiny (< 1e-6 m²) triangles (G4 1+2, G5 6+36, G7 30° 6+1); at G7 30° the bodies add no area but add 6 degenerate triangles and one coplanar group below 1e-6 m²;
- added material is contained in the authored bodies but not confined to the miter radius; with `side` left/right a body may poke past a neighbour's face by at most its own butt corner;
- a conditional-bodies variant (bodies only where they add ≥ 1e-4 m²) is **not** adopted; adopting it later would re-pin the G10 hashes and needs a new owner decision.

`construction:'plan-literal'` stays in the code only as the reference for the negative tests; no production caller may use it. Note that this reference is the v2.3 quads plus the node FAN above, not the v2.3 corner ring.

### A4 — Staggered continuation (adds to C7 and A8; adds one `INVALID_GEOMETRY` reason to A16)
Two segments at one node are a **staggered continuation** when their outward directions are antiparallel (|sin| ≤ 1e-4), they share height (> 1e-6 m) and share **no lateral width** (< 2.1e-5 m; from schema-valid thickness the shared width is exactly 0 or ≥ 0.005 m, so there is no ambiguous band): their bodies lie on opposite sides of the shared line and touch only along an edge line.
- **Agent write (`edit_model`, and any later write tool): REJECT** with `INVALID_GEOMETRY {reason:'WALL_STAGGERED_CONTINUATION', elementId: first wall by tag, at: node}`; nothing changes (A16 rejected-call invariants). nextAction: put both walls on the same side, or add a connecting wall.
- **Read / evaluation / describe / check: REPORT.** The geometry is exactly what was authored (two touching solids), and the pair is listed in `EvaluatedModule.diagnostics` as `WALL_STAGGERED_CONTINUATION {at, elements, overlap}`, sorted by node then tags, independent of input order.
- **Never auto-join.** A join would have to invent material. There is no `'join'` mode.
- Implementation hook: `evaluateModule(module, kernel, {purpose:'write'|'read'})` (default `read`); `purpose:'write'` selects `reject`. An explicit `staggered:'report'|'reject'` overrides. The policy is part of the evaluator cache key.

### A5 — WP4 definition of done and the CP4 row (replace the WP4 acceptance wording and the CP4 row)
**CP4 | kernel, walls, elements | topology/bake | CP4 golden parts: G1–G10 with G9 as amended by A1; T-K1; kernel fault injection (init concurrency and release on partial failure); the negative proofs of A3; the staggered rule of A4 | WP4; a design conflict → REVIEW/PLAN.**
CP4 is an automated checkpoint. It does not include Chromium determinism (CP12), owner tests or merge.

### A6 — WP5 mandatory gates (replace the WP5 acceptance wording; CP5 targets are NOT changed)
The CP5 goldens and tests of v2.3 are **mandatory gates of WP5 and are not relaxed, reinterpreted or deferred by this amendment**. The machine-readable list is `apps/editor/unit/arch/golden/cp5-required-gates.json`; a WP4 guard test pins its numbers to the v2.3 text and to this document, so it cannot be weakened silently:
- **G1:** faces **10** (4 exterior, 4 interior, top ring 1 face/1 hole, bottom 1), hard edges **24**, every edge dihedral ≥ 20°; **T-T2:** the G1 top face has 8 loop vertices.
- **G2:** identical baked geometry to G1 (positions, face rings, triangles, normals, materials; ids excluded).
- **G3:** interior faces at x=0, x=4, y=0, y=3.
- **G4:** faces **14**, hard edges **36**.
- **G8:** `reveal:<id>` faces for the door and the window.
- **T-T1…T-T4, T-B1…T-B6** as listed in v2.3 §Kernel/topology/bake.
- **Added by this amendment, in the same spirit:** WP5 is judged on the **raw output of the shipped WP4 construction** (A3), not on an easier construction. The raw artifacts it consumes (collinear/interior vertices, degenerate triangles, sub-1e-6 m² fragments such as the G7 30° group) must not survive as faces or edges, and no target above may be adjusted to accommodate them. If a gate cannot be met, WP5 stops → REVIEW/PLAN; it does not edit the gate.

### A7 — Obligations on later packages (no WP4 code)
- **WP6 (`edit_model`) and WP7 (`model_ops`)** must evaluate with `purpose:'write'` and surface A4's rejection with the A16 body; a test per write tool must fail if the purpose is omitted.
- **WP8** `describe_scene`/`check_model` must surface `diagnostics` and the `enclosed`/`authoredEnclosed` pair, and derive `WALL_GAP`/`ROOM_SOLID_LEAK` per A2.
- **WP12** summary must restate G9 as amended and cite this document.

## Unchanged (explicitly)
Frozen v2.3 semantics not listed in A1–A7: JOIN_TOL, node clustering and splitting, miter limit 4·max t and bevel, junction types, collinear-overlap rejection, opening rules, slabs, the Float64/1e-6 export, tags, the evaluator cache key by canonical-JSON SHA-256, all budgets (A18), A4 managed-module encoding, bake (C9), editing (C10/C11), the 10-tool surface, and WP5–WP12 content apart from A6/A7. G1–G8 and G10 expected results and the pinned G10 export hashes are unchanged.

## Stop conditions (restated)
A golden invariant that needs an L/A decision change → REVIEW/PLAN. Neither this document nor any WP4 implementation text is owner acceptance of a work package; owner acceptance remains the OWNER rows of v2.3.
