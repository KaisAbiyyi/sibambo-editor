# IMPLEMENTATION SUMMARY — SIB-MCP-MODELING-001 WP5: Topology, Bake & Managed Groups (Draft PR)

ID **SIB-MCP-MODELING-001** · Version **1.11** · Date **2026-11-19 (Asia/Jakarta)** · Status **WP5 source implemented (`topology.ts`, `evaluate.ts`, `bake.ts`, `managed.ts`) · CP5 PARTIAL / STOP → REVIEW/PLAN (`D-WP5-1`: multi-hole `Earcut` triangle count on `G4`/`G5` vs `READ-ONLY` `geometry.ts:2044`) · Draft PR, no merge, no self-approval, no owner acceptance claimed**.

- **Governing plan:** [master v2.3](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md) + [master v2.4](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.4.md) (A6 mandatory CP5 gates).
- **Disposition requested:** [PLAN disposition v0.1 (`D-WP5-1`)](../implementation-plan/PLAN_DISPOSITION_2026-11-19_SIB-MCP-MODELING-001_WP5_ADMISSION_TRIANGULATION_v0.1.md).
- **Implementor:** Nazar (`NazarMuhammadFF`) with Antigravity agent session `9416ba1f-01ff-45a6-9a3a-ae1a6882457d`. Review section below is **`Self-review — Nazar / Antigravity session`**, not an independent review.

## Identities & Claim Record

| Item | Value |
|---|---|
| Base | `7dac5bd814f540346e58df21606f49b77e1c799d` (`work/se-05/full-sync-20261113`, contains merged WP4 PR #26) |
| Branch | `work/mcp-modeling-001/wp5-topology-bake` |
| Resource locks | `apps/editor/src/lib/arch/{topology.ts,evaluate.ts,bake.ts,managed.ts}`, `apps/editor/unit/arch/{topology-cp5.test.ts,bake-managed-cp5.test.ts,fixtures/verify-g10-cp5.ts}`, `.github/workflows/mcp-modeling-wp5.yml`, `docs/implementation-{plan,summary}/*WP5*` |
| Read-only preserved | `geometry.ts`, `model.ts`, `scene.ts`, `tools.ts`, `packages/**`, `cp5-required-gates.json`, `MASTER_IMPLEMENTATION_PLAN*v2.3.md` / `v2.4.md`, remote MCP / Builder |

## What was implemented (WP5 C9 only)

1. **`apps/editor/src/lib/arch/topology.ts`** (`extractPartTopology`):
   - Welds identical `1e-6`-quantized coordinates within each part (`+0` normalized); drops degenerate/collapsed triangles (`area < 1e-12`) and counts `degenerateTriangles`.
   - Unions coplanar adjacent triangles across shared opposite half-edges (`n1·n2 >= 1 - 1e-9`, `|w1 - w2| <= 1e-6`, same `materialId`).
   - Absorbs sub-`1e-6 m²` rounding-flipped slivers (such as the `G7(30)` `7.63e-7 m²` top triangle and `G7(120)`/`G7(175)` boundary slivers) into coplanar neighbor groups whose plane contains all sliver vertices within `1e-6 m`, and drops any residual `< 1e-6 m²` fragments (`v2.4 A6`).
   - Reconstructs oriented boundary loops (`outer` = largest `|area|` CCW seen from `normal`, `holes` = CW) resolving ambiguous vertices by smallest left turn in the face plane; rotates loops to lexicographically smallest coordinate for `G2 ≡ G1` determinism.
   - Performs global collinear-vertex removal across the part (`1e-7 m` primary pass, plus `1e-6 m` quantization-fallback pass only on degree-2 vertices of oblique loops that otherwise exceed `preparePolygon`'s `1e-9 * diag` coplanarity check, e.g. `G7(15)`).
   - Classifies hard/soft edges (`soft` iff same part, same material, dihedral `< 20°`; `hard` otherwise) and assigns semantic roles (`top`, `bottom`, `side`, `exterior`, `interior`, `interior:<spaceId>`, `reveal:<openingId>`, `<insert>/<top|bottom|side>`) with per-`elementId` `<elementId>:f<k>` IDs sorted by `(role, normal 3dp, w 4dp, centroid 4dp)`.
2. **`apps/editor/src/lib/arch/evaluate.ts`**:
   - Computes `footprintRegions` via `kernel.regionsOutside` even when `spaces` is empty (required for `G1` `exterior`/`interior` roles) and populates `EvaluatedPart.topology` alongside `mesh` and `stats`.
3. **`apps/editor/src/lib/arch/bake.ts`** (`bakeModule`):
   - Deduplicates loop vertices per part in first-use order (module-local Z-up, B1) so touching parts (`walls` vs `door/frame` in `G8`) stay manifold under `buildAuthoringTopology` while single parts (`G3`) share vertices (`48` `LineSegments` vertices in `T-B5`).
   - Calls `faceFromRing` + `v2FaceLabel(..., 'line')`, enforces `RING_TOO_LONG` (`> 256`) and A18/A7 budgets (`8192` positions, `4096` faces, `20000` tris, `512` materials, `64` modules, `64 KiB` module JSON, `512 KiB` `arch` JSON), keeps `instanceId`/`definitionId`/`meshId`/container label on re-bake, pairs `forward`/`inverse` `DocumentEdit`s (create/update/remove/orphan), and validates via `validateAuthoringDocument` (`INVALID_GEOMETRY ADMISSION:...` fail-closed).
4. **`apps/editor/src/lib/arch/managed.ts`** (`readManaged`, `effectiveModuleTransform`, `currentMeshSha256`):
   - Reads `modelMetadata(graph).arch`, returning `Map<moduleId, {entry, instance|null, state: 'ok'|'detached'|'orphaned'}>`.

## CP5 Qualification Results (local Windows, Bun `1.2.23` + Node `v22.20.0`)

| Gate | Status | Evidence |
|---|---|---|
| `G1-CP5`, `T-T2` | **PASS** | `topology-cp5.test.ts`: 10 faces (4 ext, 4 int, 1 top/1 hole, 1 bot), 24 hard edges >= 20°, top face 8 loop vertices |
| `G2-CP5` | **PASS** | `topology-cp5.test.ts` + `bake-managed-cp5.test.ts`: `g2`, `g2Clockwise`, `g2Rotated` match baked `G1` (`positions`, `faceRings`, `triangles`, `normals`, `materials`) |
| `G3-CP5` | **PASS** | `topology-cp5.test.ts`: 4 `interior:sp` faces on `x=0`, `x=4`, `y=0`, `y=3` |
| `G4-CP5`, `G5`, `G6`, `G7`, `G9`, `V24-RAW-ARTIFACTS` (topology) | **PASS** | `topology-cp5.test.ts`: `G4` 14 faces / 36 hard edges; `G5` 22; `G6` 8; `G7(14)` 9; `G7(15/30/120/175)` 8; `G9` 12; zero `< 1e-6` fragments |
| `G8-CP5` | **PASS** | `topology-cp5.test.ts`: 3 `reveal:door`, 4 `reveal:win`, insert roles `frame/*`, `leaf/*`, `glazing/*` |
| `T-T1`, `T-T3`, `T-T4` | **PASS** | `topology-cp5.test.ts`: loop orientations, 24-segment cylinder 24 soft vertical edges (`15° < 20°`), face ID stability |
| `T-B1`, `T-B3`, `T-B4`, `T-B5` | **PASS** | `bake-managed-cp5.test.ts`: `graphsEqual` round-trips, B1 container move + detach/undo, orphan/erase/re-attach/replace, `48` vertices in `editor-authoring-source-edges` |
| `T-B2` (`G1,G2,G3,G6,G7,G8,G9`) | **PASS** | `bake-managed-cp5.test.ts`: `validateAuthoringDocument` + `BomcWriter` |
| `T-B2` / `G10-CP5` (`G4`, `G5`) | **BLOCKED (`D-WP5-1`)** | `Earcut` (`triangulateFaceRings`) emits `12` (`G4`) / `22` (`G5`) triangles across all rotations, rejected by `READ-ONLY` `geometry.ts:2044` (`14` / `26`). See disposition v0.1 |
| `T-B6` (`store-only OPEN`) | **PASS** | `bake-managed-cp5.test.ts`: 7/7 fixtures open as `authoring` with identical `arch` |
| `T-B6` (`WRITE -> OPEN`) | **FAIL on Bun `1.2.23` (runtime)** | Local Bun `1.2.23` lacks `DecompressionStream('deflate')` (same limit as WP1A `T-A2` and 7 `unit/authoring/client.test.ts` tests); hosted CI tests on Bun `1.4.4` |
| `G10-CP5` (`G1`, `G8`) | **PASS** | `verify-g10-cp5.ts`: identical digests across `Bun 1.2.23` and `Node v22.20.0` (`G1: 63aac6fd…`, `G8: 89441c78…`) |
| `bun run check` / `bun run build` | **PASS** | `svelte-check` 0 errors / 0 warnings; production SSR+client build succeeded |
| `unit/mcp`, `unit/editor`, `unit/agent` | **PASS** | 199 pass / 0 fail (25 files) |
| `unit/arch` (full) | **PARTIAL (Bun `1.2.23`)** | 255 pass / 1 todo (`D-WP5-1`) / 2 fail (`T-A2`, `T-B6 WRITE->OPEN`, both Bun `1.2.23` deflate limit) across 16 files |
| `unit/authoring` | **PARTIAL (Bun `1.2.23`)** | 122 pass / 7 fail (all 7 in `client.test.ts` due to Bun `1.2.23` deflate limit; unchanged from base) |

## Self-review — Nazar / Antigravity session (against base `7dac5bd`)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | P0 / Contract Conflict | `geometry.ts:2044` (`V + 2H - 2`) contradicts `geometry.ts:2064` (`triangulateFaceRings` / `Earcut`) on `G4` & `G5` multi-hole faces (`12` vs `14`, `22` vs `26`). | **STOP → REVIEW/PLAN**: `geometry.ts` left untouched per `v2.3` `READ-ONLY` rule; filed [PLAN disposition v0.1](../implementation-plan/PLAN_DISPOSITION_2026-11-19_SIB-MCP-MODELING-001_WP5_ADMISSION_TRIANGULATION_v0.1.md). |
| 2 | P1 (resolved) | Cross-part vertex deduplication in `bakeModule` would merge shared coordinates between `walls` and `door/frame` in `G8`, causing 4-face non-manifold edge failure in `buildAuthoringTopology`. | Deduplicated loop vertices per part in `bakeModule` while keeping single-part deduplication (`T-B5` 48 edges, `G8` 49 faces valid). |
| 3 | P1 (resolved) | `G7(15)` oblique wall had a `1e-6`-quantized degree-2 vertex `6.75e-7 m` off-line (`> 1e-7 m`), failing `preparePolygon` coplanarity (`1e-9 * diag`). | Added targeted pass-2 collinear cleanup (`<= 1e-6 m` only for degree-2 vertices on loops exceeding `preparePolygon` coplanarity). |
| 4 | P1 (resolved) | `G7(120)` had a boundary rounding-flipped sliver bridging two coplanar bottom/top sheets. | Updated sliver absorption in `topology.ts` to unite the sliver with all coplanar neighbor groups on the same plane. |
| 5 | accepted limitation | Local Windows environment has Bun `1.2.23` (no `DecompressionStream('deflate')`); `WRITE -> OPEN` requires Bun `1.4.4` in CI. | Added `.github/workflows/mcp-modeling-wp5.yml` running Bun `1.4.4` on Ubuntu & Windows. |

## User Test Card

WP5 has no new interactive agent UI surface yet (agent tools remain `NOT_IMPLEMENTED` per WP3/scope). Developers/reviewers:
- `bun test ./apps/editor/unit/arch/topology-cp5.test.ts` (expect 12 pass)
- `bun test ./apps/editor/unit/arch/bake-managed-cp5.test.ts` (requires Bun `>= 1.4.4` for `T-B6 WRITE->OPEN`)
- `bun apps/editor/unit/arch/fixtures/verify-g10-cp5.ts`

## Notion Status (Not Accessible Here)

Notion MCP is not configured in this session; prepared update:
- **Task / Status:** `SIB-MCP-MODELING-001 WP5` — **Review / BLOCKED (`STOP → REVIEW/PLAN` on `D-WP5-1`)**
- **Claim owner:** Nazar (`NazarMuhammadFF`) / branch `work/mcp-modeling-001/wp5-topology-bake`
- **Next action:** Owner/team decision on `D-WP5-1` (Option A recommended: 1-line `geometry.ts:2044` holed-face bound update keeping `sameTuple(..., triangulateFaceRings(...))` exact), then verify `G4`/`G5` `T-B2`/`G10-CP5` and CI on `Bun 1.4.4`.
