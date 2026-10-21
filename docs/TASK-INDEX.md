# Sibambo editor — claimable task index

Parent [Sibambo six-phase implementation roadmap](https://github.com/KaisAbiyyi/sibambo/blob/main/docs/BIG-IMPLEMENTATION-PLAN.md) is the **canonical multi-repository DAG** and source of truth for exact complete acceptance criteria. This local index is only the sibambo-editor subset, not an alternative roadmap. A task is **unassigned** until an agent explicitly declares `CLAIM SIB-F... ` with its branch, session, base SHA, logical resource locks and expected checks.

## P0 override: Editor E4 profile compatibility

See [MASTER IMPLEMENTATION PLAN — EVOLUTION-DUAL-PROFILE-001 v2.0](https://github.com/KaisAbiyyi/sibambo/blob/main/docs/implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-10-21_EVOLUTION-DUAL-PROFILE-001_v2.0.md) (**PROPOSED**, not frozen). Active exports are only **E2/E3/E4 × Exact/Visual**, with Editor continuing to consume **E4 only**. E1 and Research are retired from new exports; existing Research archive keeps legacy profile enum 2/import, Visual enum 3 unchanged. Editor must not silently treat lossy Visual preview as Exact authoritative editable source.

| P0 task | Scope | Prerequisite | Lock | Gate |
|---|---|---|---|---|
| `SIB-F1M` | E4 Exact/Visual UI+admission, legacy Research read-only support, prevent Visual→Exact silent authoring promotion | F1I frozen | `editor-profile-compat` | Cloud + independent review |

F1M can proceed concurrently with independent producer/Benchmark/Rooms tasks after interface freeze, provided editor-authoring tasks do not own the same logical geometry/import contract. F1G existing E4 parity evidence is retained and only superseded by explicit new-runtime receipts. The **30-row** future native matrix cannot reuse Research/E1 history as current PASS.

| Task | Deliverable | Predecessor tasks | Resource lock |
|---|---|---|---|
| `SIB-F1G` | E4 BOMC import/save/reopen/scene behavior regression | `SIB-F1B` | `editor-evolution` |
| `SIB-F2A` | Canonical BOMC editable contract and invariants | `SIB-F1G` | `bomc-write-contract` |
| `SIB-F2B` | Geometry edit, undo/redo, nested components | `SIB-F2A` | `editor-geometry` |
| `SIB-F2C` | Materials, scenes and canonical roundtrip serialization | `SIB-F2A` | `editor-serialization` |
| `SIB-F5A` | Typed AI house constraints and safe geometry contract | `SIB-F2F`, `SIB-F3F` | `ai-house-schema` |
| `SIB-F5B` | Deterministic editable canonical house generator | `SIB-F5A` | `house-generator` |
| `SIB-F5C` | LLM plan adapter, bounded fallback and evidence | `SIB-F5A` | `house-llm` |
| `SIB-F6A` | Typed MCP prompt→BOMC interface and capabilities | `SIB-F5E` | `mcp-house-protocol` |
| `SIB-F6B` | Scoped MCP authorization and side-effect controls | `SIB-F6A` | `mcp-house-security` |
| `SIB-F6C` | Prompt-to-BOMC generation worker and receipts | `SIB-F6A`, `SIB-F5B` | `mcp-house-runtime` |

## Claim and parallel rules

A request like `ambil F1G` within sibambo-editor means claim `SIB-F1G` after checking GitHub branches/PRs, completed predecessors, conflicting logical resource locks and any existing owner. Other agents must not edit a claimed unit; review-only is okay. GitHub comments/labels are not atomic locks, so conflicting tasks require explicit serialized claim coordination until a fenced controller exists. Push safe intermediate checkpoint commits on a unique task branch, open a draft PR early and label any unpushed Codex VM work as at risk. Interruptions do not automatically transfer write authority.

For a parent unit involving multiple repositories, record SHA and CI for **all four** child repos even if three were unaffected. Shared BOMC/E4 producer/consumer contract changes require a single logical owner and exact-SHA integration. Real SketchUp source SKPs remain local-only and cannot enter Git; human/browser/native acceptance is not replaced by CI. Independent tasks with disjoint contracts can run in parallel as the umbrella plan describes. Dynamic ChatGPT/Codex roles are allowed; no vendor is preassigned. The user's preferred verified noreply attribution remains, while agent execution is transparently recorded in PR/task metadata.

## F1I contract checkpoint and user execution override

[Dual-profile v2 contract](contracts/evolution-dual-profile-v2.md) and [machine-readable pins](contracts/evolution-dual-profile-v2.json) define the six target choices and historical-read boundary. F1I documentation contract is FROZEN_REVIEWED; no runtime migration is implied. F1J is **HOLD BY USER**. F1K proceeds only with isolated proof tooling until Rooms resource release; its native acceptance also waits F1J. [Coordination record](https://github.com/KaisAbiyyi/sibambo/issues/2).

## F1M authorized execution — 2026-10-21

`CLAIM SIB-F1M`: Codex implementer, session `sib-f1jlm-20261021`, generation `1`, issue [#4](https://github.com/KaisAbiyyi/sibambo-editor/issues/4), branch `codex/sib-f1m-profile-authority-20261021`, base `9e64a26417088d4a78625dc5dc2dd4fd0f9fc138`, logical lock `editor-profile-compat`. The user subsequently authorized J → L/M execution; the frozen F1I JSON retains its historical HOLD record unchanged. Root coordinates the cross-repository claims and producer identity handoff.

F1M enforces parsed E4 Exact eligibility before lossless supported-subset authoring; Visual is preview-only and Research is historical read-only. See [execution receipt](F1M-PROFILE-AUTHORITY-2026-10-21.md). Cloud tests do not certify producer/native fidelity or human acceptance; E4 remains `candidate_pending_cross_model_validation`.

F1M cloud implementation is ready for independent review; candidate provenance admission is bound to reviewed producer commit `e6e8d4b2380f791180464757f277cd2b8a9b3644` and source tree `72a9a4a851a9e927b0cbf0e352daf256cd7cdacf0326ae530fdcf7cf851c86a8`. This does not supply the outstanding native/human gates.
