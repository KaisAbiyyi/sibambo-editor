# IMPLEMENTATION SUMMARY — SIB-MCP-MODELING-001 WP8 Perception + Checks (CP8, PR #30)

ID **SIB-MCP-MODELING-001** · Version **1.18** · Date **2026-11-25 (Asia/Jakarta)** · Status **WP8 IMPLEMENTED · LOCAL CP8 PASS (685/685) · INDEPENDENT REVIEW REQUESTED · Draft PR [#30](https://github.com/KaisAbiyyi/sibambo-editor/pull/30) · not merged, not self-approved · WP9–WP12 not started**.

- **Governing plans, in order:** [v2.3](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md) (C12, C13, A14, A16–A18, T-P*, T-C*, CP8), [v2.4](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.4.md) (A1, A2, A4, A7), [v2.5](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.5.md). Rule conditions and text formats that v2.3 retains come from v1.0 C9/C10.
- **Supersedes:** [v1.17](IMPLEMENTATION_SUMMARY_2026-11-25_SIB-MCP-MODELING-001_v1.17.md) as the latest summary of this plan. WP7's record stays there.
- **Implementor:** Claude Code session for owner Kais, no subagents. The session started on Claude Sonnet 5.5 (preflight, plan reading, Notion claim); all source, tests and this summary were written on Claude Opus 5.5. **Independent reviewer: ChatGPT.** The editor `AGENTS.md` describes self-review and merge; the owner's WP8 instruction overrides it here (no merge, no self-approval).

## 1. Identity

| Item | Value |
|---|---|
| Base | `33645ae5a24d4aa8ca041c8e35b87214beff6007` (`work/se-05/full-sync-20261113`, WP7 PR #29 merged); re-fetched and unchanged immediately before the push |
| Branch | `work/mcp-modeling-001/wp8-perception-checks` |
| Implementation commit | `a5d8198f15d9c9462ebcda7acbfa68f5e04aa35e` |
| Publication HEAD | the docs-only commit that adds this file; exact SHA and hosted CI are recorded in a PR #30 comment and in Notion, because a commit cannot contain its own SHA |
| Deployment / RBZ / SketchUp | none; web-only change, no producer rebuild |
| Computer use | none; CLI, GitHub CLI and the Notion connector only |

## 2. Changed files

| File | Change |
|---|---|
| `apps/editor/src/lib/arch/perception.ts` (new) | C12: the four perception tools |
| `apps/editor/src/lib/arch/checks.ts` (new) | C13: `check_model`, freeform rules, shared space/diagnostic/finding rows |
| `apps/editor/src/lib/arch/read-model.ts` (new) | read-only scene index: read-purpose evaluation, frames, face attribution (A21), freeform occurrences |
| `apps/editor/src/lib/arch/read-args.ts` (new) | strict arguments, 256 KiB request and 4 MiB result limits |
| `apps/editor/src/lib/arch/textfmt.ts` (new, pure) | rounding, escaping, host header completion |
| `apps/editor/src/lib/arch/findings.ts` | rules aligned with the frozen C13 conditions (D-WP8-2) |
| `apps/editor/src/lib/arch/tools.ts` | dispatch of the five read tools |
| `apps/editor/src/lib/agent/agent-host.ts` | completes the `describe_scene` header (D-WP8-1) |
| `apps/editor/unit/arch/{checks,perception}-cp8.test.ts`, `unit/arch/fixtures/{agent-harness,agent-expect,scenes,verify-cp8}.ts`, `unit/arch/golden/t-p*.txt` (8) | CP8 tests and goldens (new) |
| `apps/editor/unit/authoring/agent-worker.test.ts` | the two WP3 placeholder assertions now use `get_floor_plan`, the only Editor tool still `NOT_IMPLEMENTED` |

Unchanged: `kernel`, `walls`, `elements`, `connectivity`, `evaluate`, `topology`, `bake`, `managed`, `metadata`, `patch`, `model-ops`, every schema and generated validator, `authoring/**`, `packages/**`, `lib/mcp/**`, Builder, launcher, workflows, plans v2.3–v2.5.

**Against §Expected Final Diff:** perception 780 lines (plan ≈ 550) and checks 187 (≈ 300), plus `read-model.ts` 373, `read-args.ts` 62 and `textfmt.ts` 86. `read-model.ts` and `read-args.ts` are extra files not named by the plan; they hold the code both tool files share. No scope-drift indicator is triggered.

## 3. CP8 acceptance

| Requirement | Evidence |
|---|---|
| T-P1 | `t-p1-describe-scene*.txt`; attribution of all 125 baked faces; rotated, moved and owner-wrapped modules; hostile names; the header through the real `AgentHost` |
| T-P2 | `t-p2-t-junction.txt`, `t-p2-elements.txt`; detached, freeform and unknown ids |
| T-P3 | `t-p3-faces-page-1.txt`, `t-p3-edges-page-1.txt`; pages concatenate to the whole list exactly once |
| T-P4 | `t-p4-corner-box.txt`; world query over a rotated module, sphere boundary, near misses |
| T-P5 | `t-p5-measure.txt`; foot inside/outside/over a hole/on the edge; same distance in both frames |
| T-P6 | every printed number is in the JSON and every measured JSON number is printed, for all five tools |
| T-C* | positive and near-negative for `WALL_GAP` (endpoint; A2 room), `WALL_FREE_END`, `ROOM_SOLID_LEAK`, `WALL_STAGGERED_CONTINUATION`, `SPACE_NOT_ENCLOSED`, `SPACE_SEED_IN_WALL`, `SPACE_DUPLICATE`, `WALL_BASE_MISMATCH`, `ELEMENT_FLOATING`, `DOOR_CLEARANCE`, `SLAB_OVERLAP`, `TINY_EDGE` and `SLIVER_FACE` (architecture and freeform), `MODULE_DETACHED`, `MODULE_ORPHANED`, `MODULE_NOT_EVALUABLE` |
| G9 (v2.4 A1) | `enclosed:true`, `authoredEnclosed:false`, `WALL_GAP` on `w3` with fix (4.000,3.000) |
| Read purity | graph identity and equality, revision, sequence, undo and redo entries and pending download, after 13 successful and failing reads, with a redo entry present and while a download awaits ACK |
| Save → reopen | same perception text after WRITE → ACK → OPEN in a fresh worker (revision numbers excluded: a reopened document restarts its count) |

## 4. Checks run on `a5d8198` (Windows 11; TEMP/TMP on `D:`)

| Check | Result |
|---|---|
| Full Editor regression, Bun 1.4.4 (`unit/authoring arch mcp editor agent`) | **685 pass / 0 fail**, 14,324 `expect()`, 59 files (baseline 614, 57 files) |
| `bun run check` | 0 errors, 0 warnings |
| `bun run build` | pass; `manifold-3d` stays in the authoring worker bundle |
| `generate-arch-validators.ts --check` | pass; three schema hashes as in v1.17 |
| `verify-g10.ts`, `verify-g10-cp5.ts`: Bun 1.4.4, then Node v24.21.0 with `--compare` | pass; pinned hashes unchanged |
| `verify-cp8.ts`: Bun 1.4.4 and Node v24.21.0 | 8/8 goldens identical |
| Mutation check | 14 single-line faults, all killed |
| Hosted CI | not finished when this file was written; see the PR #30 comment |

**Limits.** Not run locally: Bun 1.3.0, Linux, Chromium, Playwright, the Builder suites (no Builder change), and any LLM client. `verify-cp8.ts` is not wired into hosted CI; the goldens run there through the Bun 1.4.4 job on Ubuntu and Windows. Read time on documents near the A18 ceilings was not measured.

## 5. Deviations and open findings (for review)

| ID | Kind | What | Why, and what is asked |
|---|---|---|---|
| **F-WP8-1** | **P1, pre-existing, WP4/C8, not fixed** | `buildSlab` rejects most ordinary decimal outlines: of 1,600 rectangles with 0.1 m coordinates, **1,420 fail** with `SLAB_SELF_INTERSECTS`, e.g. (0,1.1)–(4,3). Owners and agents will hit this with any room that is not a whole or binary-exact size. | C8 demands area equality at 1e-9, while Finding 11 records kernel quantisation of about 3e-9 m. Changing the tolerance is a contract decision outside WP8 → **REVIEW/PLAN**. WP8 fixtures use binary-exact steps. |
| **D-WP8-1** | C12 versus C5 | The header must show writer slot and pause state, which live on the main thread; the worker context is exactly `{mode, path, selection}` and a WP3 test pins it. | The worker prints `writer unknown · paused unknown`; `AgentHost` replaces exactly that suffix of line 1 (or the JSON `agents: null`). Request envelope unchanged. Ratify or direct otherwise. |
| **D-WP8-2** | alignment of WP6 code with C13 | `findings.ts` (a) reported `WALL_FREE_END` as well as `WALL_GAP`; (b) used a different `WALL_BASE_MISMATCH` rule (walls at a node); (c) lacked `ELEMENT_FLOATING`; (d) measured doors by authored, not clear, size; (e) used bounding boxes for `SLAB_OVERLAP`; (f) flagged soft edges as `TINY_EDGE`; (g) let any near miss in a module hide an A2 room gap. | All now follow the frozen text. `edit_model` receipts share the rules, so their `findings` lists change; geometry, admission, commit and undo do not. All CP6 tests pass unmodified. |
| **D-WP8-3** | interpretation | `WALL_BASE_MISMATCH` considers only slabs a wall can stand on: not `role:"ceiling"`, and not lying on top of the wall; any matching slab satisfies it. | The literal v1.0 sentence warns for every wall under a ceiling. Ratify or direct otherwise. |
| **D-WP8-4** | addressing | Insert faces are `moduleId:<opening>/<part>:f<k>`. | C9 numbers faces per part, so a door's frame and leaf both have `door:f0`. Stored and baked ids are untouched. |
| **D-WP8-5** | added finding code | `MODULE_NOT_EVALUABLE` (ERROR) when stored parameters are not valid geometry. | Only possible for a document `edit_model` did not write; the alternative is a failing read. |
| **N-WP8-6** | kept literal | A stub shorter than 0.30 m off a wall is reported as `WALL_GAP` to the wall it grows from. | Literal A8/v1.0 text; noted as a likely false positive. |
| **N-WP8-7** | by contract order | `get_floor_plan` is not in the `Next:` hints. | It is `NOT_IMPLEMENTED` until WP9. |

`ROOM_SOLID_LEAK` is ERROR next to `SPACE_NOT_ENCLOSED`, as WP6 shipped it; v2.4 gives no severity. Its fixture is a stored staggered continuation, because the write path rejects that geometry (A4).

## 6. Long-term progress

- **Parent objective:** an agent that models in the owner's open Editor document (SIB-MCP-MODELING-001, Phase 1).
- **Done:** WP0–WP7 merged. **In review:** WP8. **Remaining:** WP9 plan and Denah panel, WP10 guide, WP11 launcher, WP12 end-to-end; OWNER rows O-1…O-8 PENDING.
- **Next user-visible deliverable:** WP9 Denah. Done when the panel shows a plan computed from the same geometry (T-F*).

## 7. User Test Card

1. **What changed:** the agent can read the open model as text: scene, element, region, measurement, problems. The owner's selection is included.
2. **How to start:** not usable end to end until WP11 (launcher). With an existing local-demo setup: open a model in authoring mode, Extensions → **Agent** → **Hubungkan agent**, and use your own client and model.
3. **What to look at (owner: Kais):** select a wall and ask what is selected → the answer names that wall. Ask for room areas → they match the model. Leave a small wall gap and ask for problems → `WALL_GAP` with a coordinate to move to. After all of this, Ctrl+Z/Ctrl+Y behave as if the agent had not read anything.
4. **How to report:** session id plus observation; recorder files as in plan P3. **Result: PENDING** (no LLM client was run by the implementor).
5. **Known limit:** slabs with ordinary decimal sizes may be rejected (F-WP8-1).

## 8. Next action

Independent review of PR #30 on the publication HEAD, including decisions on F-WP8-1 and D-WP8-1…5. WP9 must not start before CP8 is accepted.
