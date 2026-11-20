# PLAN DISPOSITION (PROPOSED) — SIB-MCP-MODELING-001 WP5: multi-hole Earcut triangle count vs `geometry.ts:2044`

ID **SIB-MCP-MODELING-001** · Disposition **v0.1** · Date **2026-11-19 (Asia/Jakarta)** · Status **RESOLVED (2026-11-20): Owner Decision D-WP5-1 APPROVED — Option A. Bounded modification applied to `apps/editor/src/lib/authoring/geometry.ts:2044-2047` only; canonical `sameTuple(..., triangulateFaceRings(...))` and all fail-closed security checks preserved. Original proposal preserved below as history.**

- **Trigger:** WP5 CP5 qualification (`T-B2`, `G10-CP5` for `G4` and `G5`) on branch `work/mcp-modeling-001/wp5-topology-bake`.
- **Author / Implementer:** Nazar (`NazarMuhammadFF`) via Antigravity agent session `9416ba1f-01ff-45a6-9a3a-ae1a6882457d`.
- **Scope respected:** `apps/editor/src/lib/authoring/geometry.ts` is untouched (`READ-ONLY` in Master Plan v2.3 §Change Surface); no admission rule or CP5 gate was weakened.

## Decision requested (`D-WP5-1`)

| # | Conflict | Needed for |
|---|---|---|
| **D-WP5-1** | `validateTopologyEditableSubset` (`geometry.ts:2044-2047`) requires `(V + 2H - 2) * 3` triangle indices, while `geometry.ts:2064-2066` simultaneously requires `face.triangles` to equal `triangulateFaceRings(...)`, which returns **fewer** triangles (`12` vs `14` on `G4`, `22` vs `26` on `G5`) when `Earcut` omits zero-area collinear bridge triangles across 2+ aligned holes. | `T-B2`, `T-B6`, `G10-CP5` for `G4` and `G5`, and any multi-room floor/top ring face |

## Concrete proof

1. `topology.ts` produces exact WP5 CP5 topology for `G4` (`14` faces, `36` hard edges; `bottom` and `top` each have 1 outer 4-gon and 2 rectangular room holes at `y = [0.075, 2.925]`, `V = 12, H = 2`) and `G5` (`22` faces; `bottom` and `top` each have `V = 20, H = 4`).
2. `bakeModule` calls the mandated `faceFromRing(..., v2FaceLabel(...), face.normal, holeLoops)` (`geometry.ts:623`), which calls `triangulateFaceRings` -> `ShapeUtils.triangulateShape` -> `Earcut.triangulate` (`three@0.184.0`).
3. Across **every** loop start rotation (`4 × 4 × 4`) and hole ordering (`[h1, h2]` and `[h2, h1]`) on `G4`'s `bottom`/`top` face, `ShapeUtils.triangulateShape` returns **`12` triangles** (`36` indices) because Earcut drops 2 zero-area collinear bridge triangles along `y = 0.075` and `y = 2.925`. On `G5`, it returns **`22` triangles** instead of `26`.
4. `validateTopologyEditableSubset` (`geometry.ts:2044-2047`) rejects `36 !== (12 + 2*2 - 2) * 3` (`42`) with `Face ... has malformed ring or triangle topology.` before reaching line `2066`, which checks `sameTuple(face.triangles, triangulateFaceRings(...))` (`36 === 36`).
5. Therefore, **no** valid input to `bakeModule` can satisfy both `geometry.ts:2047` and `geometry.ts:2066` on `G4` or `G5` while `geometry.ts` remains unmodified (`READ-ONLY` per v2.3).

## Options

| Option | Change | Effect on admission & CP5 |
|---|---|---|
| **A (Recommended)** | Authorize a bounded change to `apps/editor/src/lib/authoring/geometry.ts:2044-2047`: keep exact `(V - 2) * 3` when `holes.length === 0`, and for `holes.length > 0` require `face.triangles.length >= 3 && face.triangles.length % 3 === 0 && face.triangles.length <= (V + 2*H - 2) * 3` (relying on line `2066` `sameTuple(face.triangles, triangulateFaceRings(...))` as the exact canonical triangulation check). | Zero weakening of security or canonical triangulation (`sameTuple` with `triangulateFaceRings` stays exact); `G4`, `G5`, and all multi-room modules bake and pass `validateAuthoringDocument` cleanly. |
| **B** | Replace `ShapeUtils.triangulateShape` inside `triangulateFaceRings` to force-emit zero-area bridge triangles so `count === V + 2H - 2`. | Changes canonical triangulation of existing authored holed faces (`geometry.ts` still changes) and introduces zero-area triangles into `face.triangles`. |
| **C** | Split `G4`/`G5` top and bottom ring faces so no single face has `>= 2` holes. | **Violates** C9(2) maximal coplanar faces and `G4-CP5` mandatory `14 faces` gate in Master Plan v2.4 A6. |

## Current WP5 status pending `D-WP5-1`

- All WP5 source modules (`topology.ts`, `evaluate.ts`, `bake.ts`, `managed.ts`) are implemented.
- All CP5 **topology** gates (`G1-CP5`, `T-T2`, `G2-CP5`, `G3-CP5`, `G4-CP5` 14/36, `G5` 22, `G6`, `G7`, `G8-CP5`, `G9`, `T-T1`, `T-T3`, `T-T4`, `V24-RAW-ARTIFACTS`) **PASS**.
- All CP5 **bake & managed** gates for single-hole / hole-free fixtures (`G1`, `G2`, `G3`, `G6`, `G7`, `G8`, `G9`, `T-B1`, `T-B3`, `T-B4`, `T-B5`, `G10-CP5` Bun/Node) **PASS**.
- **Blocked awaiting `D-WP5-1`:** `T-B2` / `T-B6` / `G10-CP5` for `G4` and `G5`.
- **Environment note (separate from `D-WP5-1`):** Local Bun is `1.2.23`, which lacks `DecompressionStream('deflate')` required by `AuthoringWorkerDispatcher` `WRITE -> OPEN` (`T-A2`, 7 `client.test.ts` tests, and `T-B6 WRITE -> OPEN`); hosted CI runs `Bun 1.4.4`.
