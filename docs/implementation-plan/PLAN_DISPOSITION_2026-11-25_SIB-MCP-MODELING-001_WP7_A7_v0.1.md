# PLAN DISPOSITION (PROPOSED) — SIB-MCP-MODELING-001 WP7: `v2.4 A7` vs Freeform `C11 model_ops`

ID **SIB-MCP-MODELING-001** · Disposition **v0.1** · Date **2026-11-25 (Asia/Jakarta)** · Status **PROPOSED — Awaiting Owner Disposition (`D-WP7-1`). Independent review [#6033558148](https://github.com/KaisAbiyyi/sibambo-editor/pull/29#pullrequestreview-6033558148) item 3 requested explicit `REVIEW/PLAN` resolution without adding blanket evaluation of unrelated modules and without silently waiving `v2.4 A7`.**

- **Trigger:** Independent review [#6033558148](https://github.com/KaisAbiyyi/sibambo-editor/pull/29#pullrequestreview-6033558148) on WP7 (`work/mcp-modeling-001/wp7-model-ops`, Draft PR [#29](https://github.com/KaisAbiyyi/sibambo-editor/pull/29)).
- **Author / Implementer:** Nazar (`NazarMuhammadFF`) via Antigravity agent session `9416ba1f-01ff-45a6-9a3a-ae1a6882457d`.
- **Governance rule honored:** Nothing in WP8–WP12 started; no merge, no self-approval, no silent waiver of `v2.4 A7`.

## Decision Requested (`D-WP7-1`)

| # | Conflict | Impacted Contract |
|---|---|---|
| **D-WP7-1** | [`v2.4 A7`](MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.4.md#L74-L77) states: *"WP6 (`edit_model`) and WP7 (`model_ops`) must evaluate with `purpose:'write'` and surface A4's rejection with the A16 body; a test per write tool must fail if the purpose is omitted."* Meanwhile, [`v2.3 C11`](MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md#L375) specifies `model_ops` as exclusively freeform (`FlatAuthoringCommand` + `ModelAction` lowered via `buildModelEdit`) that never creates or edits `ArchModule` definitions/walls and rejects any direct or indirect targeting of managed containers with `MANAGED_MODULE`. | `v2.4 A7` (`WP7 model_ops` write-purpose obligation & negative test) vs `v2.3 C11` (`model_ops` freeform-only boundary) |

## Technical Proof of Conflict

1. **`model_ops` inputs have zero architectural wall semantics:** Schema `model-ops.schema.json` accepts only SketchUp-style freeform primitives (`CREATE_RECTANGLE`, `CREATE_FACE_LOOP`, `PUSH_PULL_FACE`, `EXTRUDE_RECTANGLE`, `group`, `transform`, `scale`, `unique`, `explode`, `offset`, `paint`, `erase`, `tag-*`, `entity-info`, `asset-*`, `curve`, `follow-me`, `guide`, `clear-guides`). No `ArchElement` (`wall`, `slab`, `opening`, `space`) or `ArchModule` can be authored or mutated through `model_ops`.
2. **Managed modules are completely off-limits to `model_ops`:** `arch/model-ops.ts::collectManagedTargets` + `assertOpNotManaged` reject (`MANAGED_MODULE`, non-retryable) any op touching a managed container instance, descendant instance, managed face, ancestor container wrapping a managed module, or shared definition/mesh alias. Therefore, zero `arch.modules` entries are created or modified by a valid `model_ops` call.
3. **`WALL_STAGGERED_CONTINUATION` cannot occur in freeform edits:** A4 staggered continuation is defined solely over pairs of `wall` segments in an `ArchModule` (`evaluateModule(module, kernel, { purpose: 'write' })`). Evaluating `evaluateModule` inside `model_ops` has no target module touched by `model_ops`.
4. **Why calling `evaluateModule(..., { purpose: 'write' })` anyway is harmful ("blanket evaluation"):**
   - Pre-existing `arch.modules` in `root.label` (including orphaned entries from owner actions or read-admitted reopened fixtures) are **unrelated** to a freeform `model_ops` call.
   - Re-evaluating unrelated modules on every freeform `model_ops` call would inject async `manifold-3d` WASM initialization and Boolean rebuild latency into synchronous freeform operations and could reject unrelated freeform box/guide edits whenever an untouched architectural module happens to contain diagnostics.
   - Review #6033558148 explicitly prohibits adding blanket evaluation of unrelated modules.

## Options for Owner Disposition

| Option | Decision | Consequence for WP7 (`model_ops`) & v2.4 |
|---|---|---|
| **A (Recommended)** | **Clarify / amend `v2.4 A7`:** `evaluateModule(..., { purpose: 'write' })` and the A4 staggered-continuation rejection + negative test apply strictly to architectural write tools (`edit_model` in WP6 and any future parametric write tool that creates/modifies `ArchModule`s). Remove the `model_ops` obligation from `v2.4 A7`, and record that `model_ops` enforces `MANAGED_MODULE` non-interference (direct, ancestor container, and shared definition/mesh aliases) without importing `evaluateModule`. | Matches actual `C11` architecture cleanly; keeps `model_ops` synchronous and WASM-free; `WP6` (`edit-model-cp6.test.ts:504`) already proves A4/A7 `purpose:'write'` rejection; zero weakening of architectural safety or staggered wall rejection. |
| **B** | Enforce `v2.4 A7` literally on `model_ops` by making `model_ops` async, loading the kernel, and running `evaluateModule(..., { purpose: 'write' })` over every existing `arch.modules` entry in the document before allowing any freeform `model_ops` write. | Performs blanket evaluation of unrelated modules; contradicts review #6033558148 and blocks unrelated freeform drawing if an untouched module has staggered walls. Not recommended. |
| **C** | Defer `WP7` closure until a new architectural op is added to `model_ops`. | Unneeded scope expansion beyond `C11`; breaks frozen schema separation between `edit_model` (`C10`) and `model_ops` (`C11`). |

## Status of Non-Conflicting WP7 Remediation Items

All other blockers raised in review #6033558148 are resolved on branch `work/mcp-modeling-001/wp7-model-ops`:
1. Complete deterministic staged-diff `entityIds` (radial/linear multi-copy, multi-selection, push-pull extruded faces, metadata/org ops, zero `rootInstanceId` leakage).
2. Mandatory `T-RB9` (fresh null-root & `arch` fixtures, 4-op `model_ops`, `validateAuthoringCheckpoint` replay, `RESTORE_CHECKPOINT`, `origin`, restored `UNDO`/`REDO`) and `T-RB10` (raw vs compacted equivalence, unique `family:id` keys, paired root `put-instance`) executed through real `model_ops`.
3. Indirect `MANAGED_MODULE` protection via ancestor containers (multi-level wrappers) and shared definition/mesh aliases verified by regression tests.
