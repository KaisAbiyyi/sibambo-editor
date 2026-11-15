# IMPLEMENTATION SUMMARY — SIB-MCP-MODELING-001 WP4 review remediation (Draft PR #26)

ID **SIB-MCP-MODELING-001** · Version **1.9** · Date **2026-11-15 (Asia/Jakarta)** · Status **review items 1–5 addressed · CP4 stays PARTIAL · REVIEW/PLAN open (decisions D1–D3 belong to the owner) · Draft, no merge, no self-approval**.

- **Governing plan:** [master v2.3](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md), frozen and **not amended**. The proposal for its open points is [PLAN disposition v0.1](../implementation-plan/PLAN_DISPOSITION_2026-11-15_SIB-MCP-MODELING-001_WP4_G9-C7_v0.1.md) (PROPOSED only).
- **Supersedes:** [v1.8](IMPLEMENTATION_SUMMARY_2026-11-15_SIB-MCP-MODELING-001_v1.8.md) for the WP4 source identity, the kernel lifecycle, the opposite-side wall rule, the C7.4–5 evidence and the hosted qualification. Everything else in v1.8 stands (deliverables, G1–G10 table, Interpretations 1–8, open items 2–3).
- **Review input:** the independent verdict relayed by the owner in this session: "REVIEW/PLAN, CP4 PARTIAL, no merge", with the five requested actions. No review file or GitHub review exists for it.
- **Implementor:** Claude Code cloud session `session_01JoynVtWpBxaEDZLfEkvFKf`; no subagents; exact model identifier not recorded by session policy. This document's review section is **`Self-review — Claude Code session`**, not an independent review.
- **Revision history:** v1.8 WP4 · **v1.9 review remediation + Draft PR + hosted qualification (this file)**.

## Identities

| Item | Value |
|---|---|
| Base | `5606f26888f7f6a42e9fed58e7246f062b58eda3` (`work/se-05/full-sync-20261113`, contains merged WP3) |
| Previous WP4 head (reviewed) | `29e5cbba32102b26a9db3547bd500c2a2706631c` |
| Remediation code commit | **`20cba5e2f9ff4e7cf1063232ee94aad6d72f4217`**, tree `55b5c673bbfbb7e3d7eabd84bfb46e7b2cd4d101` — kernel, walls, elements, evaluate, `connectivity.ts`, 7 test/fixture files, disposition, workflow |
| Hosted-gate fix | **`3c109d84f163dca6059591abaef345ff64fe9f21`** — workflow only (see Hosted qualification) |
| Branch / PR | `work/mcp-modeling-001/wp4-kernel-walls`, **Draft [#26](https://github.com/KaisAbiyyi/sibambo-editor/pull/26)** into `work/se-05/full-sync-20261113` |
| Publication | the docs-only commit that adds this file (read it from the PR; no self-referential SHA is invented here) |

## The five requested actions

### 1 · G9: authored connectivity versus physically closed solids (PROPOSAL, nothing wired)
The G9 fixture is **unchanged** (north wall `[[3.98,3],[0,3]]`, asserted literally). The proposal separates *solid enclosure* (the wall bodies; today's `enclosed`) from *authored enclosure* (centrelines joined with JOIN_TOL; what A8 and `WALL_GAP` are about). New pure `arch/connectivity.ts::centerlineEnclosure` reports G9 as **authored-open** while `buildSpaces` still reports solid-closed, and the evaluated mesh digest is identical before and after computing it and identical across two fresh kernels. Options A/B/C and the recommendation (C: `enclosed` = authored, new `solidClosed` = mesh truth, so G9 holds as written) are in the disposition (D1). Not called by `evaluateModule`; frozen semantics untouched. Tests: `connectivity.test.ts` (7).

### 2 · C7.4–5 deviation documented and proven
Added `construction:'plan-literal'` (exactly C7.4–5) as a reference, and `Kernel.differenceRings2d/Area2d` as measuring tools. Negative tests (`walls-deviation.test.ts`, 33; `walls-fuzz.test.ts`, 30):
- plan-literal misses authored body at acute/mixed-thickness junctions — 0.0128 m² (0.25/0.10 at 12°), 0.052 m² (0.40/0.10 at 12°), and in 188 (any side) / 167 (centre) of 300 seeded stars; the shipped solid misses ≤ 5.8e-6 m² (rounding);
- the shipped solid equals plan-literal on G1–G9, on every orthogonal junction of any thickness/side mix, on equal-thickness centre junctions at 5°…175°, and at 8° (bevel);
- **exterior protrusion:** everything added lies inside the authored bodies (≤ 3.2e-6 m² outside) and no plan material is removed (≤ 5.3e-6 m²); an oblique side-offset case shows a protrusion that is authored material. The added region is **not** bounded by the miter radius (a missing body edge can run the whole wall), so only containment is claimed;
- **slivers:** with the cleanup disabled (`new Kernel({sliverVolume:0})`) the seeded centre stars show phantom components, each < 1e-9 m³; with it, none;
- **topology/bake preconditions (probe, NOT CP5):** every part of G1–G9 is watertight, consistently oriented, fully tag-attributed, free of duplicate and collapsed triangles, volume equal to the kernel's. Literal C9 steps 1–2 on the raw wall meshes give G1 = 10 and G4 = 14 coplanar groups, equal to the plan's CP5 face counts (a compatibility signal only). Raw size of a 10×10 crossing grid: 3133 vertices / 6586 triangles (plan-literal 912 / 2144), inside the A18 bake ceilings.
- **Recorded cost:** at G7 30° the bodies add no area but introduce 6 degenerate triangles and one group < 1e-6 m² that plan-literal does not have (option **b** in the disposition would remove that and re-pin G10).
No CP5 property is claimed.

### 3 · `Kernel.init` concurrency and leak-free partial failures
- `init()` returns **one shared promise**: concurrent callers share one WASM load and one outcome; a failed load or failed `setup()` is not cached, never leaves a half-initialised kernel, and the next call retries (wrapped as `KERNEL_INIT_FAILED`). `new Kernel({load, sliverVolume})` is the seam.
- Leaks fixed: `extrude` (raw/moved when the status check fails), `checked` (status throws), `dropSlivers` (input on failure), `exportMesh` (warpBatch copy), `regionsOutside`, `buildWallNetwork` (earlier prisms when a later one fails), `openingInserts` (frame/leaf on failure), `evaluate` (insert solids held before any export). A collapsed sliver ring in 2D results is now dropped instead of throwing.
- **Fault injection** (`fixtures/fault.ts`, `kernel-faults.test.ts`, 10 tests): a fresh WASM instance whose `Manifold`/`CrossSection` methods are wrapped after `setup()`; a fault is thrown at **every outermost wrapped call** of prism, prismWithHoles, boxLocal, union (including the sliver-compose path), difference, exportMesh, stats, sliceAt, union2d, unionArea2d, areaWithHoles2d, regionsOutside, differenceRings2d, buildWallNetwork (T junction), buildSlab, openingInserts, centerlineEnclosure and the whole of `evaluateModule` (> 100 calls). After each failure the injector's own live-handle set (independent of `Kernel.liveCount`) must be empty. **Mutation check:** each of the 8 leak fixes was reverted in turn and the suite failed every time.
- The injector found its own two flaws first (wrapping before `setup()` and wrapping the wrong prototype); both are fixed and explained in its header.

### 4 · Opposite-side antiparallel walls: deterministic report-or-reject (opt-in, default unchanged)
Detection: antiparallel pair at a node (|sin| ≤ 1e-4), shared height > 1e-6 m, shared lateral width < 2.1e-5 m. From schema-valid input the width is exactly 0 or ≥ 0.005 m, so there is no ambiguous band (tested over thicknesses 0.01–2). `buildWallNetwork(…, {staggered:'report'|'reject'})`: **report** (default = the WP4 geometry) lists the pair in `network.staggered` and `EvaluatedModule.diagnostics` (`WALL_STAGGERED_CONTINUATION`), sorted and independent of input order; **reject** throws `INVALID_GEOMETRY` before any solid is built, with the node, the first wall and a next action. No `'join'` (it would invent material). The policy is part of the evaluator cache key. Goldens report nothing. Tests: `walls-staggered.test.ts` (45). Recommendation in the disposition (D3): make `reject` the production policy for agent writes once approved.

### 5 · Draft PR and hosted qualification
Draft [#26](https://github.com/KaisAbiyyi/sibambo-editor/pull/26) into the SE-05 branch. The repository's workflows only trigger for PRs into `main` and only run `unit/mcp` and `unit/editor`: **`unit/authoring`, `unit/agent` and `unit/arch` had never run in hosted CI**, so a new workflow `mcp-modeling-wp4.yml` was added.

## Hosted qualification

Workflow [`mcp-modeling-wp4.yml`](../../.github/workflows/mcp-modeling-wp4.yml): matrix Ubuntu + Windows × Bun 1.4.4 + 1.3.0; every job asserts `git rev-parse HEAD` equals the tested SHA, runs `bun run check`, then:
- **Bun 1.4.4:** the FULL Editor suite (`authoring arch mcp editor agent`, nothing skipped), `bun run build`, G10 digests under Bun and under Node.
- **Bun 1.3.0** (the Bun the repository's other workflows pin): the ten WP4 test files, named explicitly, and the G10 digests.

| SHA | Run | Event | Result |
|---|---|---|---|
| `20cba5e` | [43724595886](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43724595886) / [43724619038](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43724619038) | push / pull_request | **FAILURE on Ubuntu and Windows**: 211 pass, 1 fail — the pre-existing WP1A test `E-L2 … T-A2` (`WRITE -> OPEN` reopened as `viewer`). Cause reproduced locally on **Bun 1.3.0 at the base `5606f26`**: "Deflate decompression APIs are unavailable." (Bun 1.3.0 has no `DecompressionStream('deflate')`; Bun 1.4.4 passes). Not a WP4 regression, but the gate could not be green as written. |
| **`3c109d8`** | [43724895646](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43724895646) / [43724900699](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43724900699) | push / pull_request | **SUCCESS, 8 of 8 jobs** |

Detail of the successful run (push event; the pull_request run is identical in outcome):

| Job | Result |
|---|---|
| Ubuntu, Bun 1.4.4 | full suite **540 pass / 1 todo / 0 fail**, 541 tests in 52 files (identical to the local run); check; build; G10 identical on Bun 1.4.4 and **Node v24.22.2** |
| Windows, Bun 1.4.4 | full suite 541 tests in 52 files, job SUCCESS; G10 identical on Bun 1.4.4 and Node v22.23.4 |
| Ubuntu, Bun 1.3.0 | WP4 files **197 pass / 1 todo / 0 fail**, 198 tests in 10 files; G10 identical |
| Windows, Bun 1.3.0 | WP4 files 198 tests in 10 files, job SUCCESS; G10 identical |

The G10 hashes are the pins from v1.8, byte for byte, on Bun 1.3.0, Bun 1.4.4, Node 22 and Node 24, on Linux and Windows runners.

What this is **not**: hosted runners are not the owner's machine, no browser ran (Chromium determinism is CP12), and CI is not owner or native acceptance. **Observation about the base:** before this PR no hosted workflow ran `unit/authoring`, `unit/agent` or `unit/arch` (the existing ones run `unit/mcp` and `unit/editor` and only for PRs into `main`), so the WP1A/WP3 unit suites had never been exercised on Bun 1.3.0. The skipped steps in the successful jobs are the matrix conditionals above, not skipped tests.

## Gates local to this session (Linux cloud container)

| Gate | Result on `20cba5e` |
|---|---|
| Full Editor units (`authoring arch mcp editor agent`), Bun 1.4.4 | **540 pass / 1 todo / 0 fail**, two consecutive runs (v1.8 had 445; +95 tests, all under `unit/arch`) |
| `./unit/arch` alone | 212 pass / 1 todo: sha256 1, kernel 8, kernel-faults 10, walls 25, walls-fuzz 30, walls-staggered 45, walls-deviation 33, elements 21, golden-cp4 17 (+1 todo), connectivity 7, admission/evidence 15 |
| Every WP4 test file on **Bun 1.3.0** (installed in isolation) | all pass |
| G10 digests (pins unchanged since v1.8: G1 `efff22ff…`, G4 `7e4508b5…`, G8 `f4cf6e13…`) | identical on Bun 1.4.4, Bun 1.3.0 and Node v22 |
| `bun run check` / `bun run build` | 0 errors / 0 warnings · exit 0 |
| Pre-existing WP1A `T-A2` on Bun 1.3.0 | **fails identically at base `5606f26`** with "Deflate decompression APIs are unavailable." (Bun 1.3.0 lacks `DecompressionStream('deflate')`); passes on 1.4.4 |
| Not run | Chromium / browser determinism (CP12); owner LLM tests; Notion (tracker unreachable); Windows locally |

## Preserved

G1–G8 and G10 behaviour and pins are unchanged (verified digest-for-digest). The default evaluation path is the same code path with the same outputs; the additions are opt-in (`staggered`, `construction`, `Kernel` options) or read-only (`diagnostics`, `connectivity.ts`). No file outside `apps/editor/src/lib/arch/`, `apps/editor/unit/arch/`, `.github/workflows/mcp-modeling-wp4.yml` and docs changed. No tool is exposed to agents. No WP5–WP12 code.

## Self-review — Claude Code session (exact `20cba5e` and workflow `3c109d8` against base `5606f26`)

Findings of this round, found and fixed before commit unless stated:

| # | Sev | Finding | Fix / evidence |
|---|---|---|---|
| 1 | P1 | concurrent `Kernel.init` loaded WASM twice and the second overwrote the first | shared promise; test asserts identical promise and one load |
| 2 | P1 | eight partial-failure paths leaked WASM objects (list in action 3) | try/finally restructuring; sweep over every wrapped call; mutation-verified |
| 3 | P2 | a failed `setup()` could be mistaken for success | `wasm` is published only after `setup()` succeeds; test |
| 4 | P2 | 2D difference results crashed on slivers thinner than the 1e-6 lattice | collapsed rings dropped |
| 5 | P2 | a staggered continuation was a silent two-component result | explicit detection, diagnostics, opt-in reject |
| 6 | P2 (base, not fixed) | the hosted CI never ran `unit/authoring`/`unit/agent`/`unit/arch`, and the pre-existing WP1A T-A2 needs a runtime with deflate decompression | gate runs on both Bun versions; reported, not changed (WP1A is out of scope) |
| 7 | open | G9 `enclosed:false`, C7.4–5 amendment, staggered default | D1–D3, owner decision |

Remaining risks, none blocking the PARTIAL status:
- The injector covers outermost WASM calls only; faults raised inside the library's own glue, out-of-memory in WASM, and a failed `setup()` that has already instantiated a WASM module (it cannot be destroyed explicitly) are not covered.
- `resetTags()` is still evaluation-scoped and the evaluator cache returns shared typed arrays.
- With `staggered:'report'` as the default an agent write can still produce two touching solids until D3 is decided; WP6 must surface `diagnostics`.
- The raw meshes keep degenerate/tiny triangles at T/X/acute junctions; C9 steps 1 and 4 (WP5) are required and the G7 fragment group needs a WP5 rule.
- Property tests use fixed seeds.
- Hosted CI is not owner or native acceptance, and the Windows run uses a hosted runner, not the owner's machine.

## User Test Card

WP4 still has no owner-visible surface. **No owner test is required or was run.** Developers: `bun test ./apps/editor/unit/arch` from the repository root, and `bun unit/arch/fixtures/verify-g10.ts` from `apps/editor`.

## Next

Owner decisions D1 (G9), D2 (C7.4–5) and D3 (staggered default) decide whether CP4 can leave PARTIAL. WP5 stays unstarted. Merge, Notion and the Now/Up Next recomputation await the owner's next authorization.
