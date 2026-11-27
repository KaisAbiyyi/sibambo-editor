# IMPLEMENTATION SUMMARY — SIB-MCP-MODELING-001 WP3 (worker AGENT plumbing, atomic agent writes, Agent panel skeleton)

ID **SIB-MCP-MODELING-001** · Version **1.5** · Date **2026-11-15 16:30 Asia/Jakarta** · Status **WP3 DONE · CP3 PASS (unit/static/build) · authoring browser regression BLOCKED by a pre-existing WP1A defect (not WP3) · Draft/Review, no merge, no self-approval**.

- **Governing plan:** [master v2.3](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md) — WP3, C5, C5a, C15 (skeleton), T-RB1…T-RB12, CP3. No REVIEW file governs WP3.
- **Implementer:** Claude Code desktop on the owner's local Windows machine, primary model **Claude Opus 5.5** (`claude-opus-5-5`, from the session environment). No subagents. Owner instruction: "Resume SIB-MCP-MODELING-001 WP3 using the frozen Master Plan v2.3, executing directly on the owner's local Windows machine."
- **Supersedes:** [v1.4](IMPLEMENTATION_SUMMARY_2026-11-15_SIB-MCP-MODELING-001_v1.4.md) as the current status of the track only. v1.4 stays the WP2 record; v1.0/v1.1 stay the WP0/WP1/WP1A record.
- **Revision history:** v1.0–1.1 WP0/WP1/WP1A (Opus); v1.2–1.4 WP2 (Codex); **v1.5 WP3 (this file)**.

## Identities

| Item | Value |
|---|---|
| Editor branch | `work/mcp-modeling-001/phase-1` (stacked on Draft [#24](https://github.com/KaisAbiyyi/sibambo-editor/pull/24) head `9965b3a`) |
| Base | `988ac9a76f8042b4bb2882492e1a8c0258a4926a` (= remote tip at fetch, 2026-11-15) |
| WP3 implementation commit | **`1f33d57936fb3584e97d9fdc8ef20cd7c6a24a94`**, tree `a27dc37f0b83d54638f1845a0479dd7663bf6adc` |
| Publication commit | the docs-only commit that adds this file on top of `1f33d57` (a summary cannot contain its own SHA; read it from the PR) |
| Prerequisite | WP2 CP2 PASS at Builder `cf15fa7a5526e692feb06593186231334a796649` (Draft [Builder #95](https://github.com/KaisAbiyyi/sibambo-bomc-builder/pull/95); `cp2` ubuntu-latest + windows-latest check runs SUCCESS, read back with `gh api …/check-runs`) |
| Claim | [WP3 claim record](https://github.com/KaisAbiyyi/sibambo-editor/pull/24#issuecomment-6892038613) + Notion SE-05 note. New Editor-only locks `local/addon-editor-worker`, `local/addon-editor-ui`. No conflicting claim found (Notion board: SE-05 `stable/editor-sync`, SE-03 `stable/mcp`…; Builder WP2 locks `local/addon-relay`, `local/addon-stdio`, `local/session-recorder` untouched) |

Preflight: Git 2.56.0, Bun 1.4.4, `gh` authenticated; Editor working tree clean except the pre-existing untracked `tooling/testing/results/` (left untouched, not committed). Builder repo untouched by WP3.

## Work package status

| WP | Status | Note |
|---|---|---|
| WP0, WP1, WP1A | done (earlier) | v1.0/v1.1 |
| WP2 | done, CP2 PASS (earlier) | v1.4, Builder #95 |
| **WP3** | **done** | this file; CP3 PASS on `1f33d57` |
| WP4–WP12 | not started | WP4/WP5 NOT SAFE FOR LOWER-CAPABILITY DELEGATION |

## What was implemented (files, `1f33d57`)

| File | Change |
|---|---|
| `apps/editor/src/lib/authoring/protocol.ts` | `AuthoringJournalEntry.origin?`; `AGENT_TOOL_NAMES` (A14, 10), `AGENT_WRITE_TOOLS` {edit_model, model_ops, undo}, slot/origin patterns; `AgentRequest` (`expectedRevision: number \| null`, `data {tool,args,slot,context{mode,path,selection}}`), `AgentResult {kind:'agent', toolResult, authoring}`; `isAuthoringRequest` AGENT branch with exact keys; `isAgentContext`; `isAuthoringCheckpointShape` admits `['forward','inverse','origin']`. |
| `.../authoring/history.ts` | `assertJournalEntryShape` admits exactly `{forward,inverse}` or `{forward,inverse,origin}` with `^agent:[a-z][a-z0-9-]{0,31}$`; `cloneEntry` preserves `origin`; new `topOrigins(count)` and `undoMany(document,count)` (one transact, stacks equal to `count` sequential undos). `execute/undo/redo` unchanged. |
| `.../authoring/bomc-authoring.worker.ts` | `buildCommandEdit` extracted verbatim from `command()` (owner path still calls `history.execute` directly); `compactAgentEdits`; `case 'AGENT'` → `agent()`; private `stageAndCommit` (C5a steps 1–6), `agentUndo` (step 7); private per-instance `agentTools = runTool` (test seam, no behaviour change). |
| `.../authoring/bomc-authoring-client.ts` | `agent(data, expectedRevision \| 'current' \| null)`; AGENT result shape validation; committed agent results validated as trusted transitions (`validateAgentSemantics`: revision +1; write → undo +1, redo 0, sequence advanced, top origin `agent:<slot>`; undo → k agent entries moved, sequence unchanged) and history reuse. |
| NEW `apps/editor/src/lib/arch/tools.ts` | C5 dispatcher contract (`ToolOutcome` result/write/undo, `AgentEditBuilder`, `AgentCommit`), A16 catalogue (`agentError`, `AgentToolFailure`). **Every tool returns `NOT_IMPLEMENTED`** — nothing is exposed in WP3. No kernel import. |
| NEW `apps/editor/src/lib/agent/agent-host.ts` | C15 `AgentHost`: tool/slot/args checks, pause (writes `PAUSED_BY_OWNER`, reads allowed), mode/document (`NO_EDITABLE_DOCUMENT`), 5 s owner-busy wait → `BUSY`, 60 s writer lease → `LEASE_HELD {retryAfterMs}`, `baseRevision` → `STALE_REVISION`, worker-error mapping, C5a step 8 (`EDITOR_RENDER_FAILED`, `detail {committed:true, revision, entityIds}`, no retry, no rollback), serialised calls, activity log (last 50, outcome `ok`/`rejected`/`committed`). |
| NEW `.../agent/agent-link.ts` | C15 `AgentLink`: loopback `ws://…/agent` only; fresh ticket per (re)connect via the existing `McpConnection.ticket`; first frame `HELLO {ticket, projectId, epoch:null, lastAppliedRevision:0, lastRenderedRevision:0}` (matches WP2 `AgentSocket._consume`); exact-key `agent_call` parsing, `agent_result` replies (≤ 4 MiB, else `BUDGET_EXCEEDED`), one call at a time, backoff 1/2/4/8/16/30 s, `superseded` → "Agent tersambung di tab lain" and stop, 401/403 → stop. |
| NEW `.../agent/AgentPanel.svelte` | Local-demo banner, sign-in link (existing one-click `/api/mcp/login`), **Hubungkan agent / Putuskan**, relay status, **Jeda agent**, writer slot, activity log; root carries `data-agent-status`, `data-authoring-revision`, `data-agent-paused`. Reuses existing `mcp-panel` styles (no CSS change). |
| `apps/editor/src/routes/+page.svelte` | Constructs `AgentHost` with injected page callbacks (`authoringClient`, `authoringCheckpoint`, `acceptAuthoringResult` with captured `generation`, owner-busy = busy/saveBusy/authoringOperationBusy/recovery/pending transition, `modelingState.path/selection`, `mode`); Extensions → **Agent…** only when the BFF session reports `localDemo`; mounts the panel; disposes on teardown. |
| NEW tests | `unit/authoring/agent-worker.test.ts` (21), `unit/agent/agent-host.test.ts` (14), `unit/agent/agent-link.test.ts` (5). |

Unchanged (verified by diff): `geometry.ts`, `model.ts`, `scene.ts`, `tools.ts`, `model-tools.ts`, `packages/**`, `lib/mcp/**` (imported only), Builder repo, BOMC format, remote/auth/EdgeGuard, launcher.

## Test and gate results (all on `1f33d57`, Windows, `TEMP/TMP=D:\projects\sibambo\scratch\mcp-wp3`)

| Gate | Result |
|---|---|
| Baseline before edits (`988ac9a`): `bun test ./unit/authoring ./unit/arch ./unit/mcp ./unit/editor` | run 1: 292 pass / 1 fail / 1 error (unidentified; printed during concurrent `git`/`gh` activity); runs 2 and 3: **293 pass / 0 fail** |
| **CP3 full Editor units** `./unit/authoring ./unit/arch ./unit/mcp ./unit/editor ./unit/agent` | **333 pass / 0 fail, 3130 expects** (293 pre-existing + 40 new) |
| New WP3 tests only | **40 pass / 0 fail** |
| Existing authoring tests after the `buildCommandEdit` extraction | all pass unchanged (unit/authoring 101 pre-existing tests in the 333) |
| `bun run check` | **0 errors / 0 warnings** (1020 files) |
| `bun run build` | PASS |
| Mutation checks (temporary, reverted; diff re-verified) | M1 `cloneEntry` drops `origin` → 3 fails; M2 no compaction → 1 fail (T-RB10); M3 `undoMany` as sequential undo → 2 fails (T-RB7b, T-RB7c) |
| Playwright, production build (`playwright.config.ts`): app-smoke, mcp-onboarding, model-tab-title, loaded-shell-matrix, mobile-workspace, viewer-recovery | 14 pass, 1 skip, **3 fail — all pre-existing**: `mobile-workspace` ×2 wait for `Open a model file` / `Choose model file` / `Open model file`, none of which exists in `+page.svelte` at base `988ac9a` (`git grep` 0 matches); `viewer-recovery` needs `D:\projects\sibambo\skps\model-eval-exports\…EXACT.bomc`, absent on this machine (ENOENT). MCP onboarding/Extensions-menu specs all pass. |
| Existing authoring browser regression `test:authoring:browser` (label `mcp-wp3-cp3-20261115`) and the same spec against the production build | **BLOCKED / NOT_RUN — 0 tests loaded.** Playwright cannot load `tests/bomc-authoring.spec.ts`: it imports `src/lib/authoring/model.ts` → `arch/metadata.ts` → `arch/arch-module-v2.validator.generated.js`, which imports `ajv/dist/runtime/ucs2length` without `.js` → `ERR_MODULE_NOT_FOUND` under Node ESM. Pre-existing since WP1A `5ec4e47` (base `model.ts` already imports `arch/metadata.js`; the generated file and generator are unchanged by WP3; reproduced directly with `node --input-type=module -e "import('./src/lib/arch/arch-module-v2.validator.generated.js')"`). The same file also breaks Vite **dev** SSR of `/`; the production build is unaffected (Vite rewrites the import). Not fixed here: outside WP3 scope (IMPLEMENT forbids unplanned fixes). |
| Flake note | `unit/editor/build-identity.test.ts` once hit Bun's 5 s timeout while a Playwright build ran concurrently; passes in isolation 2/2 and in the final full run. No timeout raised. |

### T-RB contract → test

| Contract | Test (file) | Result |
|---|---|---|
| T-RB1 failing op k=1 leaves graph/revision/undo/redo/sequence | `T-RB1 …` (agent-worker) | PASS |
| T-RB2 one entry `origin agent:test`, revision +1, undo/redo whole call | `T-RB2 …` | PASS |
| T-RB3 owner redo survives a failed call | `T-RB3 …` | PASS |
| T-RB4 no-op builder: no entry, redo and sequence kept | `T-RB4 …` | PASS |
| T-RB5 `execute` with invalid forward throws, nothing changed | `T-RB5 …` | PASS |
| T-RB6 pending download → `BUSY` before staging (builder never called); after ACK succeeds | `T-RB6 …` | PASS |
| T-RB7a owner entry within steps → `UNDO_NOT_AGENT` (+ `NOTHING_TO_UNDO`, steps > 10) | `T-RB7a …` | PASS |
| T-RB7b `undo(3)` revision +1 exactly; redo stack = three sequential undos (identity + reference fixture); three redos restore | `T-RB7b …` | PASS |
| T-RB7c one transact; throwing transact (history level and live commit) and `UNDO_NOOP` pre-check change nothing; `history.redo`/`undo` spies never called | `T-RB7c …` | PASS |
| T-RB8 accept throws → `EDITOR_RENDER_FAILED`, one client call, one accept | `T-RB8 + T-RB12 …` (agent-host) | PASS |
| T-RB9 mixed composite: shape + `origin`, equal lengths, full-replay checkpoint, RESTORE in fresh dispatcher keeps origin, undo/redo reproduce graphs — null root label and `arch` document (arch JSON preserved byte-for-byte) | `T-RB9 …` ×2 | PASS |
| T-RB10 compaction ≡ raw composite (forward and inverse), unique `family:id`, both contain root put | `T-RB10 …` | PASS |
| T-RB11 checkpoint → structuredClone → restore keeps origin; owner entries without origin; `origin:'owner'`/extra key rejected; forged checkpoint rejected | `T-RB11 …` ×2 | PASS |
| T-RB12 render-failed classification: `detail.committed`, revision from worker, activity `committed` | `T-RB8 + T-RB12 …` | PASS |
| WP3 host: pause, mode, busy wait, lease window, stale revision | agent-host (14 tests) | PASS |
| AGENT request validation, origin round trip, read placeholder, CAS/BUSY via AGENT, client end-to-end write/undo | agent-worker | PASS |

## Locked-decision interpretations (non-material; recorded per NO SILENT PLAN DEVIATION)

1. **Empty composite.** Plan grounding says `execute` returns false on an empty forward; in source, `assertJournalEntryShape` throws for a 0-edit entry before that check. `stageAndCommit` therefore returns `{changed:false}` before calling `execute` when the compacted composite is empty. Behaviour required by C5a step 5 / T-RB4 is unchanged.
2. **No-op write result.** A write that commits nothing returns `authoring: null` (C5 text: `authoring: write ? authoringResult() : null`), so the main thread never treats an unchanged checkpoint as a commit.
3. **Error channel.** Tool-domain failures travel as `toolResult {ok:false, error}` with the A16 body; worker-level `STALE_REVISION`/`BUSY`/`CLOSED` stay worker errors (so the client's existing desync recovery still applies) and `AgentHost` maps them (`CLOSED` → `NO_EDITABLE_DOCUMENT`, `ABORTED` → `BUSY`, others → `INVALID_COMMAND` with the message).
4. **Agent `undo` not exposed.** WP3 says "No agent write tool is exposed yet"; `agentUndo` (C5a step 7) is implemented and tested (T-RB7) but the `undo` tool returns `NOT_IMPLEMENTED` until WP6 wires it.
5. **`model_ops` failure code.** Op k failure is always `INVALID_COMMAND {opIndex:k}` (C5a step 3); single-builder calls keep their catalogue code.
6. **Lease acquisition.** A write takes/renews the writer role once it passes all host checks and is dispatched to the worker.
7. **Busy during agent writes.** The page's `authoringOperationBusy` is set for the duration of an agent write and cleared after accept, so owner input waits for the commit (A13 owner precedence is enforced before the call).
8. **`accept` returning false** (page generation/client/mode changed) is treated like a throw: `EDITOR_RENDER_FAILED` with `committed:true`.
9. **Agent menu gating.** "Production builds hide the feature" is implemented by showing Extensions → Agent… only when `/api/mcp/session` reports `localDemo`, plus `AgentLink` refusing any non-loopback/non-`/agent` URL.
10. **Denah button** (C15 panel list) is omitted until WP9 delivers `FloorPlanPanel` (C14).
11. **Client write revision.** `agent()` accepts `'current'` to bind the acknowledged revision at send time, as `command()` does; an explicit `baseRevision` is checked by the host first.
12. **Extra test file** `unit/agent/agent-link.test.ts` (5 tests) beyond the two named in WP3.
13. **Test seam.** One private per-instance worker field `agentTools` (defaults to `runTool`) lets tests drive committed write/undo outcomes end to end; no production behaviour depends on it.

## Expected-diff comparison

Matches §Expected Final Diff for WP3, with one size note: `bomc-authoring.worker.ts` is +275/−44 (estimate ≈ 80–120 plus the moved `buildCommandEdit`), because `agent()`, `agentUndo` and compaction also live there per C5. No scope-drift indicator is present: no edit to `packages/**`, `scene.ts`, `authoring/tools.ts`, `model-tools.ts`, `model.ts`, `geometry.ts`, `lib/mcp/**`, Builder, BOMC format, timeouts/caps, global configs, script execution or images. No 11th tool.

## Self-review (implementer, exact HEAD vs base — not independent)

Findings corrected before commit: (1) `model_ops` failure preserved non-INVALID_COMMAND codes — now literal C5a step 3; (2) local-demo banner rendered outside local demo — now gated; (3) `AgentLink` kept queued calls from a dead socket across reconnect — queue now cleared. Remaining risks: the writer-slot label refreshes on events, not on lease expiry (cosmetic); a hung worker keeps owner input busy for the call's duration (same as an owner command).

## Unverified claims (not proven by this checkpoint)

- A live Editor ↔ WP2 relay connection: handshake compatibility is established by reading `service/agent_relay.py::AgentSocket` at `cf15fa7` and by the fake-socket tests, not by a running relay. First live proof is WP12 (T-I1/T-I7) or the owner test below.
- The Agent panel in a real browser (no WP3 browser test exists in the plan; production Playwright suites above load the page with the panel mounted, but none opens it).
- Any agent geometry, perception, plan or guide behaviour (WP4–WP10).

## Next action

1. Owner/independent reviewer: review `988ac9a..1f33d57` in the Editor Draft PR (link in the PR thread). Independent review is requested by PR comment; it is not an approval.
2. Owner decision: a separate small fix for the pre-existing WP1A ESM import (generator `tooling/testing/generate-arch-validators.ts` should emit `ajv/dist/runtime/ucs2length.js` / `equal.js`, then regenerate), so the existing authoring browser regression and the Vite dev server work again. Not done in WP3.
3. Then WP4 (kernel/walls/elements) — **NOT SAFE FOR LOWER-CAPABILITY DELEGATION**; needs a fresh claim.

## Parent progress

- **Parent objective:** the owner's agent models directly in the owner's open Editor document (shared undo/Save), tested only by the owner.
- **Current phase:** Phase 1. **Done:** WP0, WP1, WP1A (admission encoding), WP2 (relay/recorder/stdio, CP2), **WP3 (worker AGENT plumbing + panel skeleton, CP3)**. **Remaining:** WP4 kernel/walls, WP5 topology/bake, WP6 edit_model + undo tool, WP7 model_ops, WP8 perception, WP9 plan/Denah, WP10 guide, WP11 launcher/playground, WP12 E2E + publication.
- **Next user-visible deliverable:** an agent call that builds joined walls in the open document (WP4–WP6). Definition of done: CP6 — `edit_model` commits one history entry per call, Ctrl+Z reverts it, Save → reopen keeps the walls editable.

## User Test Card (owner; all PENDING, nothing here was run by the implementer)

1. **What changed:** the Editor can now connect to the local agent relay and route agent calls through the same worker, history and Save as your own edits. **No modelling tool works yet** — every agent tool answers `NOT_IMPLEMENTED` by design until WP4–WP10.
2. **How to start (optional, only if you want to see the panel now):** in `D:\projects\sibambo\sibambo-editor`, start the local demo as you did for SE-05 (`node tooling/local-demo/launch.mjs`; the launcher/playground refresh is WP11). Open the Editor, **Extensions → MCP Extension → Masuk (demo lokal)** first (sign-in reloads the page), then **New**, then **Extensions → Agent… → Hubungkan agent**.
3. **What to look at:** the Agent menu appears only in local demo; status becomes `connected`; **Jeda agent** toggles; if your own client calls a Sibambo tool, the activity log shows the call with `NOT_IMPLEMENTED` and the document revision does not change; your own Ctrl+Z/Ctrl+Y and **Save** behave exactly as before; a second Editor tab that connects makes the first show "Agent tersambung di tab lain".
4. **Optional ideas (non-binding):** reload the tab while connected and check it can reconnect; try Save while connected.
5. **How to report:** tell the developer what you saw; if you used your agent client, name the flight-recorder session under `D:\projects\sibambo\outputs\mcp-sessions\` for analysis. LLM-behaviour testing stays yours; the implementer ran no LLM client.
