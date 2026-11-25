# MASTER IMPLEMENTATION PLAN — SIB-MCP-MODELING-001 v2.5 (delta over v2.4: WP7 owner disposition D-WP7-1 & C11 clarifications)

ID **SIB-MCP-MODELING-001** · Version **2.5** · Date **2026-11-25, Asia/Jakarta** · Status **AMENDMENT. Incorporates Owner Disposition D-WP7-1 (Option A approved) and clarifies C11 operation-level receipt semantics. [v2.3](MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md) and [v2.4](MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.4.md) are kept byte-for-byte unmodified as history.**

**Authority and provenance.** Authorized by Owner Decision **D-WP7-1: APPROVED — Option A** during WP7 PR [#29](https://github.com/KaisAbiyyi/sibambo-editor/pull/29) remediation (`work/mcp-modeling-001/wp7-model-ops`). Incorporates [PLAN DISPOSITION WP7 A7 v0.1](PLAN_DISPOSITION_2026-11-25_SIB-MCP-MODELING-001_WP7_A7_v0.1.md). Adds no WP8–WP12 product scope.

**Supersedes** `v2.4` **only** for the amended items below (`A7`). Every other contract, decision, golden invariant, and checkpoint of `v2.3` and `v2.4` remains unchanged and in force.

## Owner Disposition

| # | Conflict (PR #29 Review #6033558148 / #6056896392) | Owner Decision | Where it lands |
|---|---|---|---|
| **D-WP7-1** | `v2.4 A7` named `WP7 (model_ops)` alongside `WP6 (edit_model)` for `evaluateModule(..., { purpose: 'write' })`, whereas `v2.3 C11` defines `model_ops` as freeform-only (`MANAGED_MODULE` refusal, zero `ArchModule` creation/editing). | **Option A**: Scope `A7` `purpose:'write'` evaluation and A4 `WALL_STAGGERED_CONTINUATION` negative tests to architectural write tools (`edit_model` and any future parametric write tool); keep `model_ops` freeform-only with complete `MANAGED_MODULE` non-interference. | A7 (amended), C11 |

## Amended Items

### A7 — Obligations on architectural write tools (replaces `v2.4 A7` bullet 1; bullets 2–3 unchanged)
- **Architectural write tools (`WP6 edit_model`, and any future parametric write tool that creates or modifies an `ArchModule`)** must evaluate touched modules with `purpose: 'write'` and surface A4's `WALL_STAGGERED_CONTINUATION` rejection with the A16 body; an automated negative test per architectural write tool must fail if the `write` purpose is omitted (verified for `edit_model` in `edit-model-cp6.test.ts:504`).
- **WP7 (`model_ops`, `C11`)** is strictly freeform (`FlatAuthoringCommand` + `ModelAction`), never constructs or edits `ArchModule` entities, must not import `evaluateModule` or perform blanket evaluation of unrelated `arch.modules` entries, and must reject (`MANAGED_MODULE`, atomic, zero live/redo/sequence mutation) any direct or indirect targeting of managed architectural containers, descendant instances, managed faces, ancestor wrapper containers, shared definition/mesh aliases, tags assigned to protected instances (`tag-visibility`), or assets whose definition subtree reaches protected modules (`asset-insert`, `asset-delete`).
- **WP8** `describe_scene`/`check_model` and **WP12** requirements from `v2.4 A7` remain unchanged.

### C11 Receipt Semantics Clarification (supplements `v2.3 C11`)
- `model_ops` returns `{ revision, entityIds, bounds, changed }`.
- `entityIds` reports deterministically ordered, deduplicated **operation-level public entity IDs** (never leaking internal `rootInstanceId`), derived from the real staged graph transitions:
  - `group` reports the newly created container instance ID (`[newInstanceId]`), not internal re-parented geometry IDs moved inside that container;
  - `transform` / `scale` with `copy: true` on instances reports all newly cloned active-context instance IDs across iterations and selections (not internal copied faces inside cloned sub-definitions);
  - `unique` reports `[action.instanceId]` (the instance whose definition was forked);
  - `explode` reports the exploded container instance ID alongside active-context promoted faces, child instances, loose edges, and guides;
  - Active-context `raw`, `transform`/`scale` on faces, `paint`, `erase`, `offset`, `follow-me`, `curve`, `guide`, `clear-guides`, `entity-info`, `tag-*`, and `asset-*` report all created, modified, or deleted active-context entities and organization metadata IDs.
