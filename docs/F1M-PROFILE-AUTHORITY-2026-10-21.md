# SIB-F1M cloud execution receipt

Owner: Codex implementer under root coordination. Session `sib-f1jlm-20261021`, claim generation `1`, logical lock `editor-profile-compat`, [issue #4](https://github.com/KaisAbiyyi/sibambo-editor/issues/4). Branch `codex/sib-f1m-profile-authority-20261021`; base `9e64a26417088d4a78625dc5dc2dd4fd0f9fc138`. New commits use the repository's configured, existing owner noreply identity; agent execution is recorded here. Root handles GitHub/Notion publication. No other repository is modified by this unit.

The user authorized runtime J → L/M execution after the F1I snapshot. Frozen contract copies retain their original execution status. This is Editor E4-only work: Exact enum 1, historical Research enum 2, Visual enum 3. No E2/E3 importer or new native evidence is introduced.

## Behavior

- The route checks the parsed encoding profile before authoring admission. Visual remains an explicitly labelled preview; Research remains explicitly labelled historical read-only. Neither starts an authoring OPEN nor exposes canonical BOMC Save. Unknown/missing profile stays view-only.
- Direct authoring-worker OPEN independently checks the encoded profile before considering BWEB. The canonical reader still verifies the entire existing Exact zero-loss encoding and supported graph contract; no import tolerance is relaxed.
- Exact authoring rereads are hashed and compared with the admitted artifact identity before a canonical checkpoint is opened. A changed reread fails before replacing the previous document. This adds hashing work to the existing Exact reread; it does not retain another full input buffer during import.
- Exact supported documents retain the existing real writer/download/ACK/reopen workflow. Unsupported Exact graphs stay view-only; malformed input and failed admission preserve the last good session.
- Historical provenance hashes and strict hash/profile matching remain intact. New producer identity admission is pending the coordinator's exact J source-tree hash handoff.

## Verification at initial checkpoint

TDD red: direct Visual/Research OPEN lacked explicit profile authority messages; cloud Chromium Visual route lacked read-only authority status; a changed Exact authoring reread replaced a dirty document instead of rejecting the identity change. These were reproduced before their corresponding fixes.

Targeted client/profile unit tests: **19 PASS**. Broader unit run (`bun test apps/editor/unit packages/bomc-document/src packages/provenance/src packages/e4-import/src`): **277 PASS, 2 FAIL**. The unchanged historical tests `unchanged source-byte envelope > retains S1-new without turning it into editable web-core` and `... > retains S2-new without turning it into editable web-core` require absent operator-local Windows `D:/projects/sibambo/skps/model-eval-exports/PROJECT SBOOST {1,2}__SIBAMBO-BOMC-v1.2.0__EXACT.bomc` files. No fixtures were uploaded, fabricated or substituted.

Initial Chromium run: Visual, Research, and actual Exact save/reopen **PASS**. The state-preservation test found its expected message under the existing status role; its locator was corrected from alert to the exact visible status message. Final rerun, workspace check, root test and build results will be appended before handoff.

No real producer SKP was opened or uploaded. Synthetic browser/worker results do not establish native SketchUp compatibility, fresh 30-row qualification, actual user acceptance, source-model bytes/MiB/performance, installed runtime/RBZ identity or certification. Independent review and producer/native/human integration remain required.
