# IMPLEMENTATION SUMMARY — SIB-MCP-MODELING-001 WP4 owner dispositions (Draft PR #26)

ID **SIB-MCP-MODELING-001** · Version **1.10** · Date **2026-11-15 (Asia/Jakarta)** · Status **owner dispositions D1–D3 implemented and published as master v2.4 · every CP4 assertion of v2.4 A5 passes on the exact HEADs below, in hosted CI on Ubuntu and Windows · Draft/Review, no merge, no self-approval, no owner acceptance claimed**.

- **Governing plan:** [master v2.4](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.4.md), a delta that supersedes [v2.3](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md) only for A1–A7. **v2.3 is byte-for-byte unmodified** (a guard test pins its SHA-256 and compares it with the copy in the SE-05 base).
- **Supersedes:** [v1.9](IMPLEMENTATION_SUMMARY_2026-11-15_SIB-MCP-MODELING-001_v1.9.md) for the status, G9, the staggered default and the D1–D3 open items. [v1.8](IMPLEMENTATION_SUMMARY_2026-11-15_SIB-MCP-MODELING-001_v1.8.md) and v1.9 otherwise stand. The [disposition v0.1](../implementation-plan/PLAN_DISPOSITION_2026-11-15_SIB-MCP-MODELING-001_WP4_G9-C7_v0.1.md) is marked resolved and otherwise kept.
- **Owner input:** the dispositions given in this session (D1 = B; D2 = ratify the hardened construction and make the CP5 goldens mandatory unrelaxed WP5 gates; D3 = reject staggered continuations for agent writes, report for read/evaluation, no auto-join), and the instruction to publish an addendum/v2.4, amend G9 explicitly, turn the G9 TODO into a passing assertion, rerun CP4 CI on the exact HEAD, sync PR and Notion, and record that the first claim was never published.
- **Implementor:** Claude Code cloud session `session_01JoynVtWpBxaEDZLfEkvFKf`; no subagents; model identifier not recorded by session policy. The review section is **`Self-review — Claude Code session`**, not an independent review.

## Identities

| Item | Value |
|---|---|
| Base | `5606f26888f7f6a42e9fed58e7246f062b58eda3` (`work/se-05/full-sync-20261113`) |
| Previous head | `c386b1508d70f059d9d2dc34f2f63bd12c15c9b2` |
| Disposition code + v2.4 | **`b95edaba2496b441b00fea65981f851aadcce0f7`**, tree `fb938d11cdbfcdab98b326e76c8e657431f0aae7` |
| Publication | the docs-only commit that adds this file (read it from the PR; no self-referential SHA is invented here) |
| Branch / PR | `work/mcp-modeling-001/wp4-kernel-walls`, Draft [#26](https://github.com/KaisAbiyyi/sibambo-editor/pull/26) into `work/se-05/full-sync-20261113` |

## What was implemented (WP4 only)

**D1 = B.** `evaluateModule` reports, per space, `enclosed` (**solid closure — meaning unchanged**) and the new **`authoredEnclosed`** (centreline connectivity, from `centerlineEnclosure`; `null` only for a seed on a centreline). **G9 is amended explicitly in v2.4 A1**, with the reason (v2.3's "enclosed:false" cannot be produced by C7/C8 for that fixture; the fixture itself is unchanged): *write commits; `enclosed:true`; `authoredEnclosed:false`; the mesh is byte-identical to the evaluation without the space element; (CP8) `WALL_GAP`.* The `test.todo` is gone; `golden-cp4.test.ts` now asserts the commit, both flags, the 10.9725 m² room, no diagnostics, the free ends at `(3.98,3)` and `(4,3)`, and the mesh digest with and without the space and across two kernels. G3/G4/G5/G8 assert `authoredEnclosed:true`. No golden result was changed to fit.

**D2 = ratify.** v2.4 A3 states the hardened construction (quads + node fan + butt bodies + bridges, canonical order, shell cleanup), its guarantees and its mesh consequences. It also records a deviation that v1.8 did not list: **the node fan replaced the v2.3 node polygon** from the first implementation (same T worked check and golden volumes). **A6 makes the CP5 goldens mandatory and unrelaxed** (G1 faces 10 = 4+4+1 top ring/1 hole+1, hard edges 24, dihedral ≥ 20°; T-T2 8 loop vertices; G2 identical bake; G3 interior planes; G4 faces 14 / hard edges 36; G8 reveal faces; T-T1…T-T4, T-B1…T-B6) and requires WP5 to meet them on the raw output of the shipped construction, removing the raw artifacts instead of editing a gate. `golden/cp5-required-gates.json` plus `cp5-gates-manifest.test.ts` (11 tests) pin every number to the v2.3 text and to v2.4. Mutation check: changing 24→20, marking a gate optional, and appending one space to v2.3 each fail the suite. This is a **contract**, not a result: no CP5 behaviour was implemented or asserted, and the manifest says `REQUIRED_NOT_YET_IMPLEMENTED`.

**D3 = reject for writes / report for reads.** `evaluateModule(module, kernel, {purpose:'write'|'read'})`: `write` → `INVALID_GEOMETRY WALL_STAGGERED_CONTINUATION` (module id, first wall, node, next action); `read` and the default → report in `diagnostics` with the geometry exactly as authored (two touching solids, volume equal to the sum of the bodies: nothing invented). An explicit `staggered` overrides; the policy is part of the cache key; no `'join'` exists. Tests (5 new in `walls-staggered.test.ts`, 50 total): read keeps two components and the exact volume; write rejects with no live kernel object; write never rejects a bonded continuation or any golden and agrees with read on every non-staggered module; override and cache key; a rejected write poisons nothing. WP6/WP7 must pass `purpose:'write'` (v2.4 A7); WP4 cannot enforce that.

## Claim record (disclosure; not a historical claim)

- **No claim was published before WP4 implementation began.** There was no Notion card, no GitHub claim comment and no claim in the tracker. The first public trace of this work is the branch `work/mcp-modeling-001/wp4-kernel-walls` and its first push (`aed1cf3`, then `29e5cbb`). Summary v1.8 recorded this ("claim recorded only here and in the branch name"); that is still the whole truth about the start.
- This paragraph and the PR comment are therefore a **late, present-dated disclosure of scope and locks, not a claim made at the start**. No earlier timestamped claim exists and none is implied.
- Declared scope and locks (what the work actually touched): `apps/editor/src/lib/arch/**`, `apps/editor/unit/arch/**`, `.github/workflows/mcp-modeling-wp4.yml`, `docs/implementation-plan/{PLAN_DISPOSITION…v0.1, MASTER…v2.4}`, `docs/implementation-summary/…v1.8–v1.10`. No shared file was modified (`authoring/**`, `packages/**`, `lib/mcp/**`, `+page.svelte`, schemas, manifests untouched).
- Competing-claim check at the time of the first push: the only WP-named remote branches were `work/mcp-modeling-001/phase-1` (WP3, merged) and the SE-05 sync branches; no WP4 branch or PR existed. Process deviation acknowledged: Editor AGENTS.md asks for an explicit claim before modifying code, and that was not done.

## Notion

**BLOCKED / NOT_RUN; nothing was written.** The workspace connected to this session is "26 Nazar Muhammad's Notion". Searches for the project (`SIB-MCP-MODELING-001`, the BOMC Modular Builder tracker, Master Plan v2.3/CP4) return no result, and fetching the canonical pages that AGENTS.md and the earlier PRs link — the `Projects` policy page and the master v1.3 page — returns `404 object_not_found` ("Check that you have access and that you're authenticated to the correct workspace"). The tracker is therefore in another workspace or not shared with this integration. No substitute tracker was created. Prepared update for whoever can reach the tracker:

| Field | Value |
|---|---|
| Task / Status | WP4 — **Review** (Draft PR, exact-HEAD CI green, no merge) |
| Claim owner | Claude Code cloud session `session_01JoynVtWpBxaEDZLfEkvFKf`; **claim published late (see above), not at start** |
| Branch / PR / base | `work/mcp-modeling-001/wp4-kernel-walls` / [#26](https://github.com/KaisAbiyyi/sibambo-editor/pull/26) / `5606f26` |
| Evidence | this summary; hosted runs below; master v2.4 |
| Self-review | `Self-review — Claude Code session`: findings in the table below; no independent review claimed |
| Blocker / next action | none from D1–D3 (resolved in v2.4); reviewer re-verdict; WP5 awaits explicit authorization and carries the A6 mandatory gates |
| Lane projection (to verify against the live DAG, not asserted) | Now: WP4 (Review). Up Next: WP5 only if every other prerequisite is Done or in Now; it stays Blocked until WP4 is accepted and authorised |

## Hosted qualification (exact HEAD)

Workflow `mcp-modeling-wp4.yml` (Ubuntu + Windows × Bun 1.4.4 + 1.3.0): every job asserts `git rev-parse HEAD` equals the tested SHA, then `bun run check`; Bun 1.4.4 runs the **full** suite, `bun run build` and the G10 digests under Bun and Node; Bun 1.3.0 runs the eleven WP4 test files, named, plus the G10 digests. Background of the two versions is in v1.9 (the pre-existing WP1A test `T-A2` needs `DecompressionStream('deflate')`, which Bun 1.3.0 lacks; it fails identically at the base).

| SHA | Runs | Result |
|---|---|---|
| **`b95edab`** (code + v2.4) | push [43727729620](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43727729620), pull_request [43727733323](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/43727733323) | **8/8 jobs SUCCESS.** Ubuntu Bun 1.4.4: full suite **561 pass / 0 fail / 0 todo**, 561 tests in 53 files, G10 identical on Bun 1.4.4 and Node v24.22.2. Ubuntu Bun 1.3.0: eleven WP4 files **218 pass / 0 fail**. Windows: 561 tests / 53 files (1.4.4) and 218 tests / 11 files (1.3.0), jobs SUCCESS, G10 identical (Node v22.23.4). |
| publication head | linked from the PR checks and the PR comment (a docs-only commit; the same workflow runs on it) | see the PR comment for the final exact-HEAD receipt |

The G10 pins are unchanged since v1.8 (`G1 efff22ff…`, `G4 7e4508b5…`, `G8 f4cf6e13…`) on Bun 1.3.0/1.4.4, Node 22/24, Linux and Windows runners. Not covered: Chromium determinism (CP12), owner tests, native acceptance; hosted CI is not owner acceptance.

## Local evidence (Linux cloud container, on `b95edab`)

| Gate | Result |
|---|---|
| Full suite, Bun 1.4.4 | **561 pass / 0 fail / 0 todo**, twice (v1.9: 540 + 1 todo; +21 tests; the todo became real tests) |
| `./unit/arch` | 233 pass = v1.9's 212 + connectivity/evaluate 2 + golden G9 3 (the todo is replaced by assertions) + staggered 5 + cp5 manifest 11 |
| Bun 1.3.0, eleven WP4 files | 218 pass / 0 fail |
| `bun run check` / `bun run build` | 0 errors / 0 warnings · exit 0 |
| Evaluation time (median of 20) | G1 6.2 ms · G4 13.5 ms · G5 29.7 ms · G8 8.5 ms (v1.8: 5.4 / 9.5 / 21.0 / 7.4): `authoredEnclosed` adds a stroke union per module with spaces, roughly +15–40% |

## Preserved

G1–G8 and G10 expected results and pins; the meshes are untouched (the only evaluator additions are the extra space field, the policy plumbing and the cost above). No file outside the declared scope changed. No tool is exposed to agents. **No WP5–WP12 code, no merge, no owner LLM test.**

## Self-review — Claude Code session (exact `b95edab` against base `5606f26`)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | P2 (docs, mine) | the node fan replaced the v2.3 node polygon in the first implementation and v1.8 did not list it | disclosed and ratified in v2.4 A3; v1.8 itself is not rewritten |
| 2 | P1 (resolved) | v2.3 G9 `enclosed:false` was unattainable | amended in v2.4 A1 with the reason; assertion now real |
| 3 | P2 | v2.4 first said the fan "reproduces the v2.3 node polygon"; only the worked T check and the golden volumes are proven | wording corrected before commit |
| 4 | P2 | the guard first checked T-T/T-B ids one by one while v2.4 states a range | guard now checks the range text and the exact id set |
| 5 | accepted risk | `purpose` defaults to `read`: a write path that forgets `purpose:'write'` would accept a staggered pair | v2.4 A7 makes it a WP6/WP7 test obligation; not enforceable in WP4 |
| 6 | accepted risk | the CP5 manifest is a contract: it cannot make WP5 pass, only prevent silent relaxation | WP5 must reference every id; WP4 cannot enforce that |
| 7 | accepted risk | `authoredEnclosed` uses JOIN_TOL strokes; a gap just above JOIN_TOL reads "open" although endpoints within JOIN_TOL cluster, by design (A8) | tested at 0.9 mm / 1.2 mm / 100 mm |
| 8 | known cost | raw meshes carry artifacts that WP5 must remove (G7 30° sub-1e-6 m² group, degenerate triangles) | recorded in v2.4 A3/A6 as WP5's input |

Remaining risks (unchanged unless noted): fault injection covers outermost WASM calls only; `resetTags()` is evaluation-scoped and the cache returns shared typed arrays; property tests use fixed seeds; hosted runners are not the owner's machine; `ROOM_SOLID_LEAK` and `WALL_GAP` are CP8 and not implemented; Notion unreachable.

## User Test Card

WP4 still has no owner-visible surface. **No owner test is required or was run.** Developers: `bun test ./apps/editor/unit/arch` from the repository root and `bun unit/arch/fixtures/verify-g10.ts` from `apps/editor`.

## Next

Reviewer re-verdict on PR #26; WP5 only on explicit authorization, under the A6 gates; merge only on explicit authorization. Notion and lane recomputation need access to the tracker workspace.
