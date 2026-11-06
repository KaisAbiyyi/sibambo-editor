# BMB026 original Editor E4 consumer acceptance

Date: 2026-11-06 Asia/Jakarta. Codex Local session 01a1b121-543e-77c0-9cc0-4f28a723583f. **PASS: bounded synthetic original-consumer, localized revision and objective viewer smoke. Owner visual acceptance and independent review NOT_RUN. No merge.**

## Pinned sources and fixture provenance

- Builder [PR #62](https://github.com/KaisAbiyyi/sibambo-bomc-builder/pull/62): `8fc6ebbeb1996889983bd6fff0958d1f9a7aaf00`, unchanged.
- Original Editor [PR #12](https://github.com/KaisAbiyyi/sibambo-editor/pull/12): `b5f46a761d1763241b60375cbb5f7110d62d99d2`, unchanged. New isolated [draft consumer PR #13](https://github.com/KaisAbiyyi/sibambo-editor/pull/13) is based on that exact head.
- Consumer test/check/build/browser source: `698c2e17b0e6fca824b63fb6968f9b28c093273f`. A later evidence-only publication commit may be the PR tip; exact final-head CI is linked in the PR completion comment. No newer loader was substituted.
- [Original Builder run 42036423066](https://github.com/KaisAbiyyi/sibambo-bomc-builder/actions/runs/42036423066): original Ubuntu ZIP artifact 13417954261 SHA256 `48d843fd03abb10cc736ca213667b638692b2b1f4d99c149276e69e0d0108757`; original Windows ZIP 13417673986 SHA256 `e862c56bcc90c66d24c513478985380f49de9c0e35e14b378eefa54e18f2949a`. Both actually downloaded and validated; not regenerated replacements.
- Byte-preserved Ubuntu originals are committed in `packages/e4-import/src/bmb026-fixtures/`. Windows inner binaries have identical SHA256; JSON raw hashes differ by platform newlines while parsed source/receipt data match. Fixture attributes preserve original bytes on Windows checkout. `manifest.json` pins original file digests/sizes, source SHAs and archive provenance.

| Binary | Bytes | Original SHA256 |
|---|---:|---|
| baseline.bomc | 32660 | `071ebe152b44d2bae387818094ad67a6f461645d45d1ad33c195848dbb0b49aa` |
| revised.bomc | 32660 | `e56924fead241df9a1a76c9de9e0e647b13caf2785cf14bc4c679a8979192233` |

Exact-source regeneration is an additional check: `scripts/bmb026-verify-provenance.py` checks original digests, Python canonical per-module hashes against the original receipt, runs `python -m examples.bmb026_house` at the exact pinned Builder SHA, and proves both regenerated binaries byte-identical. Original artifacts remain preserved separately.

## Real import and model assertions

Production entrypoint `packages/e4-import/src/bomc-loader.ts`, `new BomcLoader().load(...)`; no Builder-owned reader substitutes for Editor. Digest/byte-size validated before import. Baseline and revision each have:

- Five real meshes/modules: living, bedrooms A/B, bath, fifth flat-roof module; root and level give seven definitions/instances/transforms.
- **278 full source faces, 556 front triangles; 66 filtered analytical `faces[]` records**, 156 explicit back triangles/78 back-material faces. The analytical subset is never substituted for full source geometry.
- Nine material rows: per-room flooring `#b9b09e`, plaster `#e9e8e2`, roof `#818b92`; explicit material RGBA/opacity, semantic labels and roles retained. Door/window inserts intentionally retain the existing role-based viewer style without an authored material row.
- Four-room footprint 8m x 6m, floor top and roof top each 48m2. Wall thickness extends actual source bounds to `[-0.075,-0.075,0] .. [8.075,6.075,3]` metres. Runtime Y-up bounds: `[-0.075,0,-6.075] .. [8.075,3,0.075]` within 0.00002m tolerance.
- Coverage eligible/analytical 278/278; visualRetained/fallback/excluded/unaccounted all zero. Actual decoded triangle points, indices and matrices finite/in bounds; hierarchy parent indices `[-1,0,1,1,1,1,1]`; correct row-major source transforms to column-major Y-up runtime, including room positions.
- Four single-owned seam surfaces. Three 0.9m x 2.1m doors are real cuts, verified on both wall planes by opaque surface area, ownership and nine interior uncovered samples per plane. The fourth seam is solid and single-owned. Door inserts are distinct from opaque wall topology.
- Exterior Bedroom A window void sampled on both x=7.925/8.075 planes. Baseline y=0.85..1.85m; revised y=0.85..2.05m; z=0.9..2.05m in both. Actual wall area equals 8.4m2 minus width x 1.15m, and surrounding points stay opaque. The y=1.95/z=1.4m strip changes from wall to void only after revision.

Localized comparison: canonical source hashes identify **only Bedroom A changed**. Exact source diff is its revision 1->2 and exterior-window width 1.0->1.2m. All other source fields including doorway dimensions/positions, owned seams, ports/materials/annotations remain equal. Normalized decoded triangle geometry preserves living, Bedroom B, bath, roof and Bedroom A outside its changing east wall/window insert. Material rows, occurrence hierarchy, matrices, per-triangle source-face ownership stay equal. Complete binary SHA256 values correctly differ.

Viewer import remains distinct from strict editable restoration: both files lack section 241; `readWebBomc` rejects while E4 viewing succeeds. CRC/count/truncation negative vectors reject, and previous BMB-021 negative/version/codec/count tests continue to run. Editor admission is **not** proof of persistent BMB-010 journal behavior; original Builder journal proof is separate.

## Local Windows and hosted verification

| Check | Result |
|---|---|
| New original consumer tests | PASS, 11 tests, zero failures |
| New plus retained BMB-021 interoperability/geometry/material/resource/strict-editable/roundtrip suites | PASS, 80 tests, zero failures |
| Editor application and authoring units | PASS, 157 tests, zero failures |
| `bun run check` | PASS, zero errors/warnings |
| `bun x tsc --project packages/tsconfig.json` | PASS after bounded test-only configuration repair |
| `bun run build` | PASS; existing chunk-size/tooling advisories remain |
| [Dedicated original consumer CI](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/42231543025) at `698c2e17b0e6fca824b63fb6968f9b28c093273f` | PASS, Ubuntu + Windows; 80 tests per OS plus exact-source regeneration/check/types/build |
| Existing [BMB-021](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/42231542955) / [BMB-005/007](https://github.com/KaisAbiyyi/sibambo-editor/actions/runs/42231542932) workflows | PASS at same source |

Local runtime Bun 1.4.4; hosted explicitly pinned Bun 1.3.0, Python 3.12. No package/lockfile update. Broader historical corpus/full-browser matrix is NOT_RUN; the requested relevant gates above are executed, not promoted to arbitrary corpus certification.

Reproduced configuration defect: existing browser-only package typecheck at exact Editor base b5f46a7 included Node-only BMB-021 stream/snapshot helpers, yielding three missing-node-type errors. Their only imports are in tests. Minimal `packages/tsconfig.json` exclusion of those two helpers repairs that check while keeping all production browser files checked and all 80 Bun regressions executed. No production loader/geometry fix was required. Early candidate failures remain in CI history: initial checkpoint omitted ignored binary fixtures; follow-up added exact fixtures/attributes; exact-Builder reproduction then needed jsonschema installation; final checked source corrects both. No test assertions or discovery were weakened.

## Real application rendering

PASS for objective smoke: original UI file selection -> original worker -> real loader -> original viewport/WebGL2. Chromium 149.0.7827.55, 1600x1000 CSS viewport, pixel ratio 1, same camera/display/light settings across each pair. Native SketchUp export is not required for these wholly synthetic Builder binaries.

The observer retains original Worker and mount calls; cameras/display use the existing public viewport API. No geometry hidden/replaced. X-ray view is explicitly labelled. Actual `/__build.json` at both imports: commit `698c2e17b0e6fca824b63fb6968f9b28c093273f`, dirty false; application source fingerprint `7b779c3055c2016de97f9df7d2e7733a3fe051b7f09d455485c48aec56be2135`. Both browser worker snapshots confirm 278 source faces, five meshes, seven instances and 66 analytical surfaces. Nonzero actual draw calls/triangles, no missing assets/decode failures, no application console/page errors or framework overlay. Chromium reports only capture-time ReadPixels performance warnings; no speed claim is made.

Five A/B camera pairs: exterior roof, four-room X-ray, living/shared doors, Bedroom A/bath doorway, exterior window. Relative PNGs and machine camera/render observations are under `bmb026-evidence/`; local interactive side-by-side page is `BMB026-VISUAL-AB.html` in the evidence package. These are automated objective observations, **not human visual acceptance**.

## Reproduction and review readiness

1. Check out consumer PR candidate and exact Builder SHA in isolated sibling folders. Use Python 3.12 with jsonschema==4.23.0, Bun 1.3.0 and `bun install --frozen-lockfile`.
2. Run `python scripts/bmb026-verify-provenance.py <exact-builder-checkout>`; exit 0 means byte identity and canonical source hashes PASS.
3. Run `bun test packages/e4-import/src/bmb026-house-consumer.test.ts`; run the dedicated workflow's full eight-file Bun command with its BMB021_BUILDER_DIR pinned to 0e3ec262e98762969da66088d412f8beebb63523 and original Ruby fixtures. Expected 80 PASS. Run check/types/build; expected exit 0 each.
4. Launch original app on loopback. Wait for enabled Open Model, choose baseline/revised fixture, verify footer 278 faces / seven instances / five meshes and view-only section-241 notice. Apply camera positions from `bmb026-evidence/viewer-manifest.json` (+Z source coordinates transformed to Y-up runtime); capture matching display states. Task-local reproduction script and complete runtime observations are preserved in the local evidence package.
5. Owner inspects all five A/B pairs, especially 1.0->1.2m window and unchanged doors/roof/layout, then records acceptance or defect. Independent reviewer inspects exact code/fixtures/source/evidence; no result is pre-filled.

Direct implementor self-review of exact new diff over b5f46a7 found no unresolved P0/P1/P2 issue after the configuration correction. Scope: new synthetic fixtures/test/provenance/CI/evidence plus test-only typecheck exclusion. No production runtime edits, dependency downgrade or private-to-public source transfer. Original #12/#62 and Nazar #63 stay unchanged. BMB-026 remains Review; e2e/house stays held through acceptance. Additive local writer lock is released on final handoff.

Independent review: NOT_RUN. Owner human visual: NOT_RUN/PENDING_OWNER. Native SketchUp, Model-Eval, texture/PBR, arbitrary editable/native roundtrip, live provider, performance qualification and release certification: NOT_RUN/outside this bounded gate. Stop before merge.

Recommended owner order: independently accept prerequisite Editor #12, then #13 with fresh checks if its base changes; separately owner-accept Builder #62 after consumer/visual/review disposition. Builder CI #64 -> Nazar-updated #63 is a separate integration sequence. No implicit merge authorization.
