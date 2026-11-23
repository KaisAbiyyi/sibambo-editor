# IMPLEMENTATION SUMMARY — SIB-MCP-MODELING-001 WP6 (`edit_model` & agent `undo`, Draft PR #28)

ID **SIB-MCP-MODELING-001** · Version **1.14** · Date **2026-11-23 (Asia/Jakarta)** · Status **WP6 TECHNICAL CP6 PASS · LOCAL `Bun 1.4.4` + `Node v24.21.0` PASS (`599/599`) · Draft PR [#28](https://github.com/KaisAbiyyi/sibambo-editor/pull/28) · Awaiting Review & Owner Merge (no self-approval, no merge)**.

- **Governing plans:** [MASTER IMPLEMENTATION PLAN v2.3](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md) (WP6, C5/C5a, C10, A4/A5/A7/A10/A12/A16/A18/A20, T-E1…T-E5, T-E7, CP6) and [MASTER IMPLEMENTATION PLAN v2.4](../implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.4.md) (A4/A7 mandatory `purpose: 'write'` staggered-continuation rejection and negative test).
- **Supersedes:** [v1.13](IMPLEMENTATION_SUMMARY_2026-11-20_SIB-MCP-MODELING-001_v1.13.md) for WP6 progression only; WP5 acceptance record stays in v1.13.
- **Implementor:** Antigravity (`Gemini 4 Neon`), session `fabab325-3a41-4595-b1fb-3e332608a10c` (no subagents).

## 1. Lineage & Claim Record

| Item | Value |
|---|---|
| Base (`origin/work/se-05/full-sync-20261113`) | `13b0fc8832687db5e1536f724032d499fc5d598c` (WP5 PR #27 merged) |
| Branch | `work/mcp-modeling-001/wp6-edit-model-undo` |
| **WP6 code & CP6 tests commit** | **`200b51202591b329ac14404db75bc76b98fbfe45`** |
| **Docs publication commit** | docs-only commit adding `v1.14` on `work/mcp-modeling-001/wp6-edit-model-undo` |
| Draft PR | [#28](https://github.com/KaisAbiyyi/sibambo-editor/pull/28) (base `work/se-05/full-sync-20261113`, Draft) |
| Notion tracker | `WP6 · edit_model tool & agent undo` (`419c4a6a-af73-819c-9684-cae0ede3259d`) claimed before edits under exclusive locks, transitioned to `Review` |

## 2. Work Package & Phase Progress

- **Parent objective:** SIB-MCP-MODELING-001 Phase 1 (local Editor-authority AI modeling add-on via Builder relay).
- **Completed milestones:** WP0 (`done`), WP1 (`done`), WP1A (`done`), WP2 (`done`, Builder PR #95), WP3 (`done`, Editor PR #25), WP4 (`done`, Editor PR #26), WP5 (`done`, Editor PR #27), **WP6 (`Review` — technical CP6 automated checks PASS)**.
- **Remaining work:** WP7 (`model_ops`), WP8 (`describe_scene`/`describe_element`/`query_region`/`measure`/`check_model`), WP9 (`get_floor_plan` + Denah panel), WP10 (guide completion & executable examples), WP11 (launcher/sessions/README), WP12 (scripted Playwright E2E + User Test Card), plus owner LLM-client acceptance (`O-1`…`O-8`) and parent SE-05 integration/merge.
- **Next user-visible deliverable:** WP6 review & merge of Draft PR #28 into `work/se-05/full-sync-20261113` (done when CP4/CP5/Vercel checks pass or are disposed by owner and PR #28 is merged), unlocking WP7 (`model_ops`).

## 3. What Changed (Self-Reviewed vs Change Surface & Forbidden List)

| File | Responsibility | Status |
|---|---|---|
| `apps/editor/src/lib/arch/errors.ts` | Pure A16 error catalogue (`AGENT_ERROR_CATALOGUE`, `agentError`, `AgentToolFailure`, `toAgentToolFailure` with v2.4 A4 `WALL_STAGGERED_CONTINUATION` `nextAction`); zero kernel import. | Modified |
| `apps/editor/src/lib/agent/agent-host.ts` | Import `agentError` from `../arch/errors.js` instead of `../arch/tools.js` so main-thread bundle stays free of `manifold-3d`. | Modified (1 line) |
| `apps/editor/src/lib/arch/schemas/edit-model.schema.json` | JSON Schema 2020-12 for `edit_model` (`changes` 1..64, `baseRevision` integer/null, all 8 C10 ops). | Added |
| `apps/editor/src/lib/arch/edit-model.validator.generated.js` | Standalone ESM AJV validator for `edit_model` (no `eval`/`new Function`, CSP-safe). | Added |
| `tooling/testing/generate-arch-validators.ts` | Extended generator/checker to emit and verify both `ArchModule v2` (`7e6baffb…`, unchanged) and `edit_model` (`37c6a328…`) validators. | Modified |
| `apps/editor/src/lib/arch/bake.ts` | Bounded `applyTransform?: boolean` option on `BakeEntryInput` so `set_module.transform` updates `Instance.matrix` while preserving owner container moves when omitted. | Modified |
| `apps/editor/src/lib/arch/findings.ts` | Pure architectural findings collection (`WALL_FREE_END`, `WALL_GAP`, `SPACE_NOT_ENCLOSED`, `ROOM_SOLID_LEAK`, `SPACE_DUPLICATE`, `WALL_BASE_MISMATCH`, `DOOR_CLEARANCE`, `SLAB_OVERLAP`, `TINY_EDGE`, `SLIVER_FACE`, `MODULE_DETACHED`, `MODULE_ORPHANED`, `WALL_STAGGERED_CONTINUATION`) and capped (10/10) before/after receipt diffing. | Added |
| `apps/editor/src/lib/arch/patch.ts` | `planEditModel`: 256 KiB / 64-op budget checks, AJV validation, sequential application of all 8 ops (`create_module`, `remove_module`, `set_module`, `add`, `update`, `remove` + `cascade`, `set_material`, `remove_material`), detach/orphan/affine-transform guards, mandatory `evaluateModule(..., { purpose: 'write' })` (v2.4 A4/A7), findings diff, deterministic `AgentEditBuilder[]`, and receipt. | Added |
| `apps/editor/src/lib/arch/tools.ts` | Activates `edit_model` and `undo` (`steps` default 1, integer 1..10); re-exports error helpers from `./errors.js`; remaining 8 tools still return `NOT_IMPLEMENTED`. | Modified |
| `apps/editor/src/lib/authoring/bomc-authoring.worker.ts` | `agentTools` accepts sync or async `ToolOutcome` and `agent()` `await`s it. | Modified (3 lines) |
| `apps/editor/unit/arch/edit-model-cp6.test.ts` | 10 tests / 215 assertions covering T-E1…T-E5, T-E7, v2.4 A4/A7 mandatory negative test, findings capping, Save→reopen, and main-thread bundle isolation. | Added |

**Scope-drift / Forbidden check:** Zero edits to `packages/**`, `authoring/scene.ts`, `authoring/tools.ts`, `authoring/model-tools.ts`, `authoring/model.ts`, `authoring/geometry.ts`, `lib/mcp/**`, `sibambo-bomc-builder/**`, or `tooling/testing/results/`.

## 4. Checks Run and Limits (`200b51202591b329ac14404db75bc76b98fbfe45`)

All local checks ran with `TEMP`/`TMP` scoped to `D:\projects\sibambo\scratch\wp6-tmp`.

| Check | Result | Scope & Limits |
|---|---|---|
| `bun tooling/testing/generate-arch-validators.ts` | **PASS** | `ARCH_MODULE_V2_SCHEMA_SHA256=7e6baffb…` (unchanged), `EDIT_MODEL_SCHEMA_SHA256=37c6a328…` |
| `bun run check` (`Bun 1.4.4`) | **PASS** | `svelte-check found 0 errors and 0 warnings` |
| Full Editor unit suite (`Bun 1.4.4`) | **599 pass / 0 fail** | `11,015` `expect()` calls across `56` files (`unit/authoring`, `unit/arch`, `unit/mcp`, `unit/editor`, `unit/agent`), including 10 new WP6 tests (`215` assertions) |
| `bun run build` (`Bun 1.4.4`) | **PASS** | Built in `7.48s` (`@sveltejs/adapter-node`); `manifold-B_yLhOkb.wasm` emitted only in worker assets, not main page entry |
| `verify-g10.ts` (`Bun 1.4.4`) | **PASS** | `ok: true` (`G1: efff22ff…`, `G4: 7e4508b5…`, `G8: f4cf6e13…`) |
| `verify-g10-cp5.ts` (`Bun 1.4.4` vs `Node v24.21.0 --compare`) | **PASS** | `ok: true`, `peerRuntime: "bun 1.4.4"`, `peerOk: true` (`G1: 63aac6fd…`, `G4: 0ec88fe0…`, `G8: 89441c78…`) |
| GitHub Actions (`cp4`, `cp5`) on PR #28 | **QUEUED / NOT_RUN** | Workflows queued when PR #28 opened; results not yet observed at summary time |
| Browser E2E (`WP12`) & Owner LLM tests (`O-1`…`O-8`) | **NOT_RUN / PENDING** | Out of WP6 scope; `model_ops`, perception tools (`describe_scene`, `check_model`, etc.), and `get_floor_plan` remain `NOT_IMPLEMENTED` until WP7–WP9 |

## 5. Unproven Claims & Open Boundaries

- Hosted CI (`cp4`, `cp5`) and Vercel preview on PR #28 were still `QUEUED`/`PENDING` at handoff time.
- Interactive Editor browser round-trip via the Builder MCP relay (`WP12`) and owner LLM-client behavior (`O-1`…`O-8`) remain unverified until WP7–WP12 and owner sessions.
- Tools `model_ops`, `describe_scene`, `describe_element`, `query_region`, `measure`, `check_model`, `get_floor_plan`, and `read_guide` (worker fallback) remain `NOT_IMPLEMENTED`.

## 6. Manual Gates & User Test Card

| Gate | Owner | Status | Notes |
|---|---|---|---|
| Review & merge Draft PR #28 into `work/se-05/full-sync-20261113` | Owner (`Kais`) | **PENDING** | Required before WP7 starts |
| `O-1`…`O-8` Owner LLM-client modeling acceptance | Owner (`Kais`) | **PENDING** | Deferred until WP12 add-on surface is complete (WP7–WP11) |

### User Test Card (WP6 checkpoint — worker-level `edit_model` & `undo` active; full MCP add-on test awaits WP7–WP11)

- **What changed:** Authoring worker now executes `edit_model` (all 8 C10 ops, cascade removals, custom materials, `purpose: 'write'` validation, receipt findings diff, Save→reopen persistence) and atomic agent `undo(steps)` with `origin: 'agent:<slot>'` shared undo/redo history.
- **How to start (once WP7–WP11 are complete, or for local dev build check):** in `D:\projects\sibambo\sibambo-editor`, `node tooling/local-demo/launch.mjs` → open `http://localhost:5175` → Demo Lokal → New/Open authoring model → Extensions → **Agent** → **Hubungkan agent**.
- **What to look at:** After full WP7–WP12 wiring, verify `edit_model` creates joined corners without notches, `undo` reverts agent calls cleanly without touching owner actions, and Save→reopen preserves authoring mode and parametric walls.
- **Optional non-binding ideas:** Create a 2-wall L-room with `edit_model`, resize or remove a wall with `cascade: true`, Save to BOMC, reopen, and press Ctrl+Z.
- **How to report:** Check PR #28 CI status, review diff, and for live MCP sessions run `node tooling/local-demo/sessions.mjs list` and share the session ID + observations.
