# IMPLEMENTATION SUMMARY — SIB-MCP-MODELING-001 WP8A Slab area tolerance (A22, F-WP8-1)

ID **SIB-MCP-MODELING-001** · Version **1.19** · Date **2026-11-28 (Asia/Jakarta)** · Status **WP8A IMPLEMENTED · LOCAL VERIFICATION PASS (692/692) · INDEPENDENT REVIEW REQUESTED · PR not merged, not self-approved · WP9–WP12 not started**.

- **Governing plan:** [v2.6](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-28_SIB-MCP-MODELING-001_v2.6.md) (WP8A, amendment A22; owner approval "Approve, implement" given in chat on 2026-11-28). v2.3–v2.5 stay in force for everything else.
- **Supersedes:** [v1.18](IMPLEMENTATION_SUMMARY_2026-11-25_SIB-MCP-MODELING-001_v1.18.md) as the latest summary of this plan. v1.18 §5 F-WP8-1 is resolved by this work package; its other rows stand as ratified in the PR #30 review.
- **Implementor:** Claude Sonnet 5.5 (Claude Code session for owner Kais), no subagents. The same session authored plan v2.6; PLAN eligibility of that model was recorded as unresolved in the plan. **Independent reviewer: the owner-designated reviewer (PR #31). The implementor does not approve or merge.**

## 1. Identity

| Item | Value |
|---|---|
| Base | `1e8c82828c9d6df1110f011a636572c5eb493441` (tip of `work/se-05/full-sync-20261113`, PR #30 merged); fetched immediately before branching, `elements.ts`/`findings.ts` unchanged against PR #30 |
| Branch | `work/mcp-modeling-001/wp8a-slab-area-tolerance` |
| Plan commit | `3212e8a` (docs only) |
| Implementation commit | `4bb6936` (all source and tests) |
| Publication HEAD | the docs-only commit that adds this file; its SHA and the hosted-CI verdicts are recorded in the PR (a commit cannot contain its own SHA) |
| Deployment / RBZ / SketchUp | none; web-only, no producer rebuild |
| Computer use | none; CLI only |

## 2. Work package status

| WP | Status |
|---|---|
| **WP8A** | **done locally** (all plan steps 1–7 except hosted CI and independent review, which are pending) |

## 3. Changed files

| File | Change |
|---|---|
| `apps/editor/src/lib/arch/elements.ts` | two constants (`AREA_TOL_BASE = 1e-9`, `AREA_TOL_PER_METRE = 2e-8`), module-local `areaTolerance(rings)` (perimeter via `Math.sqrt`), and the three `buildSlab` comparisons use it instead of `EPS`. +21 / −3 lines in the source diff |
| `apps/editor/src/lib/arch/findings.ts` | header comment only (review nit 2) |
| `apps/editor/unit/arch/slab-tolerance.test.ts` (new) | T-S1 … T-S7 |
| `docs/implementation-plan/…_v2.6.md` (new), this file (new) | documentation |

Unchanged, verified by `git diff --stat` (two source files): `kernel.ts`, `walls.ts`, `isSimpleRing`, `EPS`, `evaluate.ts`, `bake.ts`, `topology.ts`, `checks.ts`, `perception.ts`, every schema and validator, existing tests and goldens, CI workflows, `package.json`, lockfile.

**Against Expected Final Diff:** elements.ts +21/−3 (plan ≈ +14/−4: the extra lines are the doc comment and a comment on the helper), findings.ts 2 comment lines, new test file 135 lines (plan ≈ 150–220). No scope-drift indicator triggered: no new export, no kernel parameter, no changed error code or message, no loosened assertion.

**Deviations from the plan:** none material. One trivial test-expectation correction after the first post-fix run: the text format prints `slabs 1` (the colon form is the JSON key), so T-S7 asserts `slabs 1`. The production code was not involved.

## 4. Checks run on `4bb6936`

Windows 11; `TEMP`/`TMP` on `D:\projects\sibambo\scratch\wp8a\tmp`; Bun 1.4.4; Node v24.21.0. Logs: `D:\projects\sibambo\scratch\wp8a\`.

| Check | Result |
|---|---|
| **Pre-fix run of the new tests (plan step 2)** | T-S1, T-S2, T-S3, T-S7 **fail**; T-S4, T-S5, T-S6 pass. T-S1 printed `rejected 35896 of 40000`; T-S2 rejected 2,965 of 3,000; T-S3 case 0 rejected; T-S7's `edit_model` returned `INVALID_GEOMETRY SLAB_SELF_INTERSECTS`. This reproduces F-WP8-1 exactly |
| New tests after the fix | 7 pass / 0 fail; T-S1 `rejected 0 of 40000` (≈ 2 s); `kernel.liveCount()` unchanged |
| Existing slab and kernel tests | `elements.test.ts`, `kernel-faults.test.ts`: pass, unmodified |
| Mutation checks (each reverted, `cmp` confirmed restoration) | (a) per-metre = 0 → T-S1, T-S2, T-S3, T-S7 fail; (b) per-metre = 1e-3 → T-S4, T-S5 fail; (c) outline check back to `EPS` → T-S1, T-S2, T-S3, T-S7 fail; (d) combined check back to `EPS` → T-S1, T-S2, T-S3 fail; (e) `Math.hypot` → 7 pass (not observable on this runtime, as predicted; D1 still forbids it). All killed except (e), which the plan classed as not observable |
| Full Editor regression (`unit/authoring arch mcp editor agent`) | **692 pass / 0 fail**, 20,368 `expect()`, 60 files (baseline 685, 59 files; +7 tests, +1 file). See the flake note below |
| `bun run check` | 0 errors, 0 warnings, 1041 files |
| `bun run build` | pass |
| `generate-arch-validators.ts --check` | pass; three schema hashes identical to v1.18 (`7e6baffb…`, `37c6a328…`, `a0a0875d…`) |
| `verify-g10.ts`, `verify-g10-cp5.ts`: Bun, then Node with `--compare` | pass; pinned hashes unchanged |
| `verify-cp8.ts`: Bun and Node | 8/8 goldens identical |
| Hosted CI | not finished when this file was written; see the PR |

**Flake note (honest record).** The first full-regression run reported **690 pass / 2 fail**: two tests in `unit/arch/walls-deviation.test.ts` ("300 seeded stars", any side / centre only) hit Bun's default 5 s timeout (7.2 s and 8.2 s) while the machine was busy. They are wall tests; this package does not touch walls. The file passes 33/33 alone **with** the change and 33/33 alone **with the change stashed** (base), and a second full run passed 692/0. I treat this as load-induced timing, not a regression; I did not change the test or its timeout. It may recur on a loaded machine.

**Limits.** Not run locally: Bun 1.3.0, Linux, Chromium, Playwright, the Builder suites (no Builder change), any LLM client. `verify-cp8.ts` is still not wired into hosted CI (review nit 3, out of scope). Non-rectangular slabs (L-shaped, rotated, curved) have no automated proof beyond the planner's measurement of 5–24-gon rings (ratio ≤ 3.14e-9 m); T-S3 and T-S7 are rectangular.

## 5. Findings and decisions

| ID | Status |
|---|---|
| **F-WP8-1** | **Fixed** by A22. Any decimal rectangle on a 0.1 m grid is admitted (0 of 40,000 rejected, was 35,896). Defects of ≥ 1 µm over a ≥ 1 m edge are still rejected (T-S4); proportional behaviour on a 100 m ring is pinned (T-S5) |
| Review nit 2 (`findings.ts` header) | Fixed (comment only) |
| Review nit 3 (`verify-cp8.ts` in CI) | **Not done**, out of scope per plan D7; still open |
| Documented limit | A protrusion or overlap narrower than about 2e-8 m (below the 1e-6 m output lattice) may be admitted. Not asserted either way |
| Carried from the PR #30 review | N-WP8-6 false positive for the WP10 guide; WP12 expectations must note that `edit_model` receipt findings changed in WP8; read time near the A18 ceilings, Bun 1.3.0 locally, and the LLM-client result are still unmeasured/pending |
| New findings | none (stop condition 5, F-WP8-2, did not fire: T-S7 passed end to end) |

## 6. Long-term progress

- **Parent objective:** an agent that models in the owner's open Editor document (SIB-MCP-MODELING-001, Phase 1).
- **Done:** WP0–WP8; **WP8A in review.** **Remaining:** WP9 plan and Denah panel, WP10 guide, WP11 launcher, WP12 end-to-end; OWNER rows O-1…O-8 PENDING.
- **Next user-visible deliverable:** WP9 Denah (done when the panel shows a plan computed from the same geometry, T-F*). WP9 does not depend on WP8A; WP12 must not be accepted before CP8A is accepted.

## 7. User Test Card

1. **What changed:** an agent (or you) can now create floor slabs with ordinary decimal sizes. Before, most were refused as "self-intersecting".
2. **How to start:** as in summary v1.18 §7 — local-demo setup, open a model in authoring mode, Extensions → **Agent** → **Hubungkan agent**, your own client and model.
3. **What to look at (owner: Kais):** ask the agent to add a 4.2 m × 3.9 m floor slab at (0.3, 0.3); then a slab with a window-sized hole; then an L-shaped or rotated slab; ask it to describe the scene and check the model. Non-binding ideas: a 12 m × 7.4 m slab; a slab whose hole sits a few millimetres outside the outline (it should still be refused).
4. **How to report:** session id plus observation; recorder files under `outputs/mcp-sessions/`. **Result: PENDING** (no LLM client was run by the implementor).
5. **Known limit:** non-rectangular slabs are not covered by automated proof.

## 8. Next action

Independent review of the WP8A PR on its publication HEAD (read the hosted-CI verdicts there). WP9 may proceed in parallel; CP8A must be accepted before WP12.
