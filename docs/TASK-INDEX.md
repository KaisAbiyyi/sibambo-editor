# Sibambo editor — claimable task index

Parent [Sibambo six-phase implementation roadmap](https://github.com/KaisAbiyyi/sibambo/blob/main/docs/BIG-IMPLEMENTATION-PLAN.md) is the **canonical multi-repository DAG** and source of truth for exact complete acceptance criteria. This local index is only the sibambo-editor subset, not an alternative roadmap. A task is **unassigned** until an agent explicitly declares `CLAIM SIB-F... ` with its branch, session, base SHA, logical resource locks and expected checks.

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
