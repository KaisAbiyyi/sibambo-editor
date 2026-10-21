# SIB-F1M cloud execution receipt

Owner: Codex implementer under root coordination. Session `sib-f1jlm-20261021`, claim generation `1`, logical lock `editor-profile-compat`, [issue #4](https://github.com/KaisAbiyyi/sibambo-editor/issues/4). Branch `codex/sib-f1m-profile-authority-20261021`; base `9e64a26417088d4a78625dc5dc2dd4fd0f9fc138`. New commits use the repository's configured, existing owner noreply identity; agent execution is recorded here. Root handles GitHub/Notion publication. No other repository is modified by this unit.

The user authorized runtime J → L/M execution after the F1I snapshot. Frozen contract copies retain their original execution status. This is Editor E4-only work: Exact enum 1, historical Research enum 2, Visual enum 3. No E2/E3 importer or new native evidence is introduced.

## Behavior

- The route checks the parsed encoding profile before authoring admission. Visual remains an explicitly labelled preview; Research remains explicitly labelled historical read-only. Neither starts an authoring OPEN nor exposes canonical BOMC Save. Unknown/missing profile stays view-only.
- Direct authoring-worker OPEN independently checks the encoded profile before considering BWEB. The canonical reader still verifies the entire existing Exact zero-loss encoding and supported graph contract; no import tolerance is relaxed.
- Exact authoring rereads are hashed and compared with the admitted artifact identity before a canonical checkpoint is opened. A changed reread fails before replacing the previous document. This adds hashing work to the existing Exact reread; it does not retain another full input buffer during import.
- Exact supported documents retain the existing real writer/download/ACK/reopen workflow. Unsupported Exact graphs stay view-only; malformed input and failed admission preserve the last good session.
- Historical provenance hashes and strict hash/profile matching remain intact. The coordinator measured final F1J candidate source tree `72a9a4a851a9e927b0cbf0e352daf256cd7cdacf0326ae530fdcf7cf851c86a8` using `EvolutionExporter.source_tree_sha256` at immutable producer commit `e6e8d4b2380f791180464757f277cd2b8a9b3644`; its Exact/Visual candidate admission remains explicitly uncertified. The earlier provisional hash was removed before this handoff. No wildcard or inferred identity is admitted.

## Cloud verification

Initial checkpoint: `72aadf8a697da77406a50ac59fdca62b18db450b`. Final implementation is the commit containing this receipt, ready for independent review. TDD red runs reproduced missing explicit Visual/Research authority messaging, missing route profile status, authoring reread identity drift, invalid-source CRC error categorization, and rejection of the coordinator-supplied candidate hash before its explicit policy registration. The canonical reader already rejected non-Exact contracts; this work retains that strict boundary and makes route/worker authority explicit.

- Targeted current client/profile/admission units: **25 PASS**. Candidate Exact/Visual cases also decode their encoded profile and reject unknown producer hashes and invalid profile names.
- `bun run check`: **PASS**, 0 errors/warnings.
- Production build through the configured Playwright server command (`bun run build && bun run serve:build`): **PASS**; existing dynamic-import/chunk-size warnings remain.
- Focused production Chromium `profile-authority.spec.ts`: **4 PASS**, 22.7 seconds, using a temporary external config on port 5185 after a concurrent Benchmark server occupied 5175. Repo configuration is unchanged. The cases cover Visual/Research no authoring OPEN/WRITE; actual Exact download/reopen graph equality; and malformed admission, wrong-profile provenance, malformed BWEB and changed-reread failures preserving the full acknowledged document/history, dirty state, title and model pixels. Error text is asserted before temporarily hiding only the error-toast overlay for pixel comparison.
- First broader unit command (`bun test apps/editor/unit packages/bomc-document/src packages/provenance/src packages/e4-import/src`): **277 PASS, 2 FAIL**. After the two candidate admission tests were added, a concurrent-load rerun: **277 PASS, 4 FAIL**; named failures below.
- Current root `bun run test`: **53 unit/editor PASS**, then browser collection **BLOCKED** by the three existing requirements below. No browser acceptance is inferred from that command.

### Unresolved and observed failures

The unchanged historical tests `unchanged source-byte envelope > retains S1-new without turning it into editable web-core` and `... > retains S2-new without turning it into editable web-core` require absent operator-local Windows `D:/projects/sibambo/skps/model-eval-exports/PROJECT SBOOST {1,2}__SIBAMBO-BOMC-v1.2.0__EXACT.bomc` files. No fixtures were uploaded, fabricated or substituted.

The concurrent-load unit run also exceeded the unchanged 5-second timeout in:

- `authoring topology v2 Push/Pull > snaps a lower side to the parent edge, extends beyond it, and reverses through the edge` — initial full run PASS at 0.95 seconds; focused retry PASS at 2.09 seconds.
- `authoring topology v2 Push/Pull > Push/Pulls every lower child side without moving the upper cavity, before and after moving the underside` — initial full run PASS at 3.70 seconds; latest focused retry FAIL at 5.57 seconds. No geometry code or test timeout was changed.

Root Playwright collection requires the absent `/workspace/skps` corpus (`bomc-profile-compatibility.spec.ts`), an absolute `SIBAMBO_M2_WORKLOG` (`materials-v2.spec.ts`), and a runner compatible with the existing `bun:` import encountered by Node's ESM loader. These requirements were left intact.

A separate broader legacy browser probe observed `serves an app-specific build identity` failing because it expects the retired “Open a model file” heading and `Editor verifies and imports an E4 artifact in its own worker` failing because it expects the retired “Open model file” button. The subsequent `file-only import saves a view and optional provenance upgrades the open session in place` was explicitly interrupted at the same retired button; ten remaining cases in that extra probe did not run. Their old shell assertions are outside F1M. A later run that loaded Benchmark at Editor's port was invalid infrastructure evidence and was replaced by the isolated 5185 run. Intermediate new-test failures from toast pixels and default startup waits were corrected in the test harness; state/geometry expectations were retained.

## Remaining gates

No real producer SKP was opened or uploaded. Synthetic browser/worker results do not establish native SketchUp compatibility, fresh 30-row qualification, actual user acceptance, source-model bytes/MiB/performance, installed runtime/RBZ identity or certification. E4 remains `candidate_pending_cross_model_validation`. Independent review and producer/native/human integration remain required.
