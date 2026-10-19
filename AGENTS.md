# Agent instructions — Sibambo Editor

Before changing source, read `README.md`, `docs/architecture.md`, `docs/data-and-evidence.md` and `docs/verification.md`. Preserve canonical BOMC round-trip, input provenance and bounded import, undo/redo correctness. E4 remains `candidate_pending_cross_model_validation`. Use Bun workspace check/test/build; distinguish browser UX/native fidelity from cloud fixture tests.

## Shared multi-agent development (required)

Follow [docs/AGENT-ORCHESTRATION.md](docs/AGENT-ORCHESTRATION.md). Plans and phases list unassigned tasks until claimed. ChatGPT Work, Codex Cloud/local or future agents may act as architect/implementer/reviewer as capability permits, but one claim has one writer and protects files **and logical schema/security resources**. Issue labels are not atomic locks; serialize conflicts unless an atomic fenced controller operates. Use branch-isolated draft PRs, safe pushed intermediate commits, exact SHA handoffs and an explicit inventory of any cloud VM work not yet published. Do not reassign solely because of a silent/browser-broken/exhausted agent. Inspection-only is safe; writing continuation requires fenced transfer.

Link tasks affecting Rooms, Benchmark and BOM Engine Plugin with a Sibambo parent integration record, specific accepted SHAs and real browser/SketchUp/owner gates as applicable. Prefer verified owner-authorized GitHub noreply Git identity, with honest attribution exceptions and execution metadata in task/PR records; do not silently add agent co-author trailers. Never treat repo CI alone as project acceptance.
