# IMPLEMENTATION SUMMARY — SIB-MCP-MODELING-001 WP3 review remediation (PR #25)

ID **SIB-MCP-MODELING-001** · Version **1.7** · Date **2026-11-15 18:00 Asia/Jakarta** · Status **three review findings fixed, each with negative regression tests · CP3 gates PASS · re-review requested · Draft/Review, no merge, no self-approval**.

- **Governing plan:** [master v2.3](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md) — C5a step 8, invariants 3/3a, A16, A18, C15. Frozen; not changed.
- **Review input:** the three independent-review findings, relayed by the owner in this session's instruction: "Remediate SIB-MCP-MODELING-001 WP3 PR #25 at latest HEAD under frozen v2.3." No review file or GitHub review exists for them.
- **Supersedes:** [v1.5](IMPLEMENTATION_SUMMARY_2026-11-15_SIB-MCP-MODELING-001_v1.5.md) only for the C15 `AgentHost.accept` contract, `AgentLink` call dispatch and oversized-result handling, and the CP3 counts. [v1.6](IMPLEMENTATION_SUMMARY_2026-11-15_SIB-MCP-MODELING-001_v1.6.md) (validator ESM fix) is unchanged. All other v1.5 records stand: the WP3 contents, the T-RB map, interpretations 1–13 and the User Test Card.
- **Implementer:** Claude Code desktop, Claude Opus 5.5 (`claude-opus-5-5`), owner's local Windows machine, no subagents.
- **Revision history:** v1.5 WP3 · v1.6 validator fix · **v1.7 review remediation (this file)**.

## Identities

| Item | Value |
|---|---|
| Branch / PR | `work/mcp-modeling-001/phase-1`, Draft [#25](https://github.com/KaisAbiyyi/sibambo-editor/pull/25) (stacked on #24) |
| Reviewed HEAD (before remediation) | `a6961fcaf7062189825564cc514f9f021365a4a9` (= remote tip at fetch) |
| Remediation commit | **`dee824efa8de3aa9d5d5fdc7243cae49d183df98`**, tree `6654a206122c754096ee4a1bbc6a7ba6b132e2dd` |
| Publication | the docs-only commit adding this file (read from the PR) |

## Findings, root causes and fixes

| # | Finding | Root cause on `a6961fc` | Fix in `dee824e` |
|---|---|---|---|
| 1 | Real page projection failures must reach `AgentHost` as `EDITOR_RENDER_FAILED`, committed; keep the committed checkpoint, no retry | `+page.svelte` wired `accept` to `acceptAuthoringResult`, which ignored `refreshAuthoringProjection()`'s result and always returned `true` after applying. `AgentHost` counted any non-`false` value as shown. | **Page:** `applyAuthoringResult` returns `'stale'` (before touching state), else applies the checkpoint and returns `refreshAuthoringProjection(false) ? 'rendered' : 'render-failed'`. `acceptAuthoringResult` = `applyAuthoringResult(...) !== 'stale'`, so owner paths keep exactly the previous meaning. `AgentHost.accept` is wired to `applyAuthoringResult`. **Host:** the contract is `AgentAcceptOutcome = 'rendered' \| 'render-failed' \| 'stale'`. Anything but `'rendered'`, or a throw, gives `EDITOR_RENDER_FAILED` (retryable false, `detail {committed:true, revision, entityIds}`), with activity `committed`. The client call is made once, `accept` runs once, and the committed checkpoint is never reverted. |
| 2 | `AgentLink` stalls when an old in-flight call overlaps a new socket generation | `pump(generation)` held `pumping=true` while awaiting an old-generation `host.handle`. Calls queued from the new socket hit the `pumping` guard; the old loop then exited on the generation mismatch and nothing restarted it. | Queue entries carry the generation of the socket that delivered them. `pump()` is no longer bound to one generation: it drops entries from dead sockets and drops the old call's reply, and continues with new-socket calls. Its `finally` restarts the pump if calls remain. Serial execution (A2) is unchanged. |
| 3 | An oversized `agent_result` must not report a committed write as an ordinary uncommitted `BUDGET_EXCEEDED` | `reply()` replaced any frame > 4 MiB with `BUDGET_EXCEEDED`, which by invariant 3 means "nothing changed", even for committed writes. | `AgentHost` attaches internal `committed {revision, entityIds}` metadata exactly when the worker committed (success or `EDITOR_RENDER_FAILED`); it is never a wire key. The new pure `resultFrame(id, reply)` builds the frame. If it fits, it is unchanged. If it does not fit, a committed success becomes `ok:true` with a compact receipt `{committed:true, truncated:true, revision, entityIds (≤100 ids of ≤256 chars), entityCount, message}`. A committed `EDITOR_RENDER_FAILED` keeps its code with compact detail. **Only an uncommitted reply may become `BUDGET_EXCEEDED`.** Frames always stay ≤ 4 MiB with the exact relay keys. |

## Negative regression tests (written first; FAIL on `a6961fc`, PASS on `dee824e`)

Run on the unfixed source (`a6961fc`, `src/` clean): **11 fail / 39 pass**. On `dee824e`: **50 pass / 0 fail**.

| Test | File | Finding |
|---|---|---|
| accept that applied the checkpoint but whose projection failed → committed `EDITOR_RENDER_FAILED`, no retry | `unit/agent/agent-host.test.ts` | 1 |
| any accept result other than `rendered` (e.g. a legacy truthy value) is not treated as shown | agent-host | 1 |
| accept reporting `stale` is a committed `EDITOR_RENDER_FAILED` | agent-host | 1 |
| a projection failure after a real commit (real `AuthoringClient` + dispatcher): `EDITOR_RENDER_FAILED`, client checkpoint and worker history keep the committed entry (`origin agent:codex`, undo 1, redo 0), one client call, one accept | `unit/authoring/agent-worker.test.ts` | 1 |
| `+page.svelte` wiring: `accept` → `applyAuthoringResult`; it returns `stale` first and the projection outcome after applying; `acceptAuthoringResult` keeps the owner meaning | NEW `unit/agent/page-wiring.test.ts` (3 tests) | 1 |
| an old in-flight call overlapping a new socket generation does not stall calls on the new socket (new-1 answered on its own; old reply dropped) | `unit/agent/agent-link.test.ts` | 2 |
| an oversized committed result stays committed; an oversized committed `EDITOR_RENDER_FAILED` keeps its code; only an uncommitted oversized read becomes `BUDGET_EXCEEDED`; all frames ≤ 4 MiB with exact keys | agent-link | 3 |
| committed writes carry `committed` metadata; reads and rejections carry none; `EDITOR_RENDER_FAILED` carries it | agent-host (2 tests) | 3 |

Note on test strength: `+page.svelte` cannot be mounted in Bun. Finding 1 at the page level is therefore guarded by:
- a source-wiring test (the same technique as `unit/editor/editor-foundation-policy.test.ts`);
- host-level tests and the real-client integration test above;
- the authoring browser regression, which exercises the refactored `applyAuthoringResult` through every owner path.

No WP3 code path can make the real page commit an agent write (all tools are `NOT_IMPLEMENTED`). An end-to-end projection-failure test through the real page therefore belongs to WP6/WP12.

Two pre-existing host tests used exact `toEqual` and were updated to assert the new `committed` metadata. The default `accept` stub and two individual test stubs changed only from `true`/`false` to `'rendered'`/`'stale'`.

## Gates on `dee824e` (Windows, `TEMP/TMP=D:\projects\sibambo\scratch\mcp-wp3`)

| Gate | Result |
|---|---|
| **CP3 full Editor units** (`./unit/authoring ./unit/arch ./unit/mcp ./unit/editor ./unit/agent`) | **343 pass / 0 fail, 3166 expects** (333 + 10 new) |
| `bun run check` | 0 errors / 0 warnings |
| `bun run build` | PASS |
| **Existing authoring browser regression** `test:authoring:browser mcp-wp3-remediation-20261115` (Vite dev + Chromium) | **20 passed / 1 failed**. The failure is test 21, which needs the absent `D:\projects\sibambo\skps\model-eval-exports` (ENOENT); identical to v1.6. |
| Production-build Playwright (smoke, MCP onboarding, tab title, shell matrix, mobile, viewer recovery) | 14 pass / 1 skip / 3 fail, identical to v1.5. All three failures are pre-existing: two stale mobile selectors absent at base, and `viewer-recovery`, which needs the same missing fixture (ENOENT). |
| PR checks | Vercel preview only (not test CI) |

## Preserved (unchanged by `dee824e`)

C5a stage-then-commit and atomic agent undo (`bomc-authoring.worker.ts`, `history.ts` untouched; T-RB1…T-RB12 still pass). Other boundaries:
- `origin` journals are unchanged;
- owner Undo/Redo/Save and `acceptAuthoringResult` semantics are unchanged (the authoring browser regression's 20 owner flows pass);
- legacy v1 / `lib/mcp/**` and deferred remote are unchanged;
- WP3 tool boundary: every tool is still `NOT_IMPLEMENTED`;
- no WP4–WP12 code.

Diff: `agent-host.ts`, `agent-link.ts`, `+page.svelte` (16 lines), tests.

## Interpretations added (non-material)

14. **Accept contract.** `AgentHost.accept` returns `AgentAcceptOutcome`; only `'rendered'` is success. The page passes `applyAuthoringResult` (C15 named `acceptAuthoringResult`; same function split so owner callers keep its boolean).
15. **Committed metadata.** `AgentReply.committed` is main-thread metadata for the link's fallback only; it never appears as a frame key (the relay checks exact keys).
16. **Oversized committed results.** These are a compact success receipt (or a compact `EDITOR_RENDER_FAILED`). They never get a new error code, because invariant 3 reserves every other code for "nothing changed".

## Housekeeping

Two earlier PR comments had lost their code formatting to PowerShell escaping (backticks in a double-quoted string). Both were edited in place with unchanged content and an edit note:
- #24 claim handoff [6892418368](https://github.com/KaisAbiyyi/sibambo-editor/pull/24#issuecomment-6892418368);
- #25 validator-fix update [6892482329](https://github.com/KaisAbiyyi/sibambo-editor/pull/25#issuecomment-6892482329).

## Next action

1. Independent re-review of `a6961fc..dee824e` (requested on PR #25). Not approved; no merge.
2. Optional, owner: restore `skps/model-eval-exports` so authoring test 21 and `viewer-recovery` can run.
3. After review closes: WP4 (NOT SAFE FOR LOWER-CAPABILITY DELEGATION) with a fresh claim.

Manual owner tests: unchanged from the v1.5 User Test Card (all PENDING; LLM testing owner-only). The remediation adds no owner-visible behaviour, because no agent write can commit in WP3.
