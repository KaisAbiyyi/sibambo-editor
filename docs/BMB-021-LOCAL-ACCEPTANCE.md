# BMB-021 Windows original-consumer correction, 2026-11-05

Status: corrected consumer acceptance; final hosted receipts are linked from Builder Issue #21. No merge and no native certification.

## Targeted production change
Only packages/e4-import/src/bomc-loader.ts changes production behavior. decodeReleased reconciles each parsed table or singleton with its directory count before returning it, inside the existing release finally boundary. Position/topology counts equal decoded mesh blocks; UV count equals meshes with a UV block; texture table/blob counts equal decoded textures. Ignored viewer extension/debug/241 sections remain ignored. Material v1/v2 parsing and rendering algorithms are unchanged.

## Windows evidence
Baseline: 14 PASS / 1 FAIL, preserving the directory-count assertion. Corrected relevant import/document regression run: 114 PASS / 0 FAIL. Check: 0 errors/warnings. Node-adapter production build: PASS (existing chunk/plugin warnings).
All seven frozen Builder binaries at 0e3ec262e98762969da66088d412f8beebb63523 pass actual BomcLoader.load, including the five material-bearing geometry inputs. Original Ruby at 34f6b795b701209bb1b3262efbccf0d79fedb458 reproduces ef830ba5a5568e8af9930cf2f11a7721a2d65e2f5f0e8b1352c4142b6f4314f5 and loads successfully.
Original writer color and real-hole graphs strictly write/reopen section 241, and load through both consumer implementations in the companion Model-Eval integration script. Viewer mode never claims editability of Builder/Ruby output.
Full runtime snapshots were also compared with the original 917ba808 loader, retrieved read-only from Git: every mesh coordinate/normal/UV, triangle/face index, hierarchy, matrix, material, bound and analytical face matches. These digests are pinned in consumer-owned tests.
Opaque door/window wall planes have exact expected areas, nine void samples per side, complete source-face indices and one wall mesh owner. Full-source counts remain separate from the established 0.35m² analytics filter.
Counts are tested for compact/wide directories and empty optional sections, with positive controls. Material unsupported versions, invalid widths, CRC-repaired short/long/huge declared payloads reject. Existing CRC/codec/overlap/truncation and unknown-extension policy tests are retained; malformed 241 and count tampering reject the strict reader.

## Limits / manual owner gates
Broad Editor packages+app run was not all-green: two unavailable historical S1/S2 files, absent sibling Rooms/Benchmark paths in isolated checkout, and a build-identity test timeout. These were not repaired or replaced. The focused 114-case regression, BMB-005/007 cases, check and build pass.
No browser/WebGL/human fidelity, native SketchUp export, installation, performance certification or general resource-bomb qualification is claimed. Bun uses the existing test-only deflate transport adapter, not a BOMC semantic mock.
Owner: use an approved synthetic SketchUp model and the exact intended native producer identity, export to D:, record loaded runtime plus binary SHA256, and import in both consumers; expect the same topology/materials/transforms/coverage and intended visual appearance. Do not substitute this synthetic CLI evidence for that gate.
No private source or owner SKP is published to Builder; existing GPL-3.0-only licensing remains.

## Self-review
Direct implementor self-review, Codex Local Windows; not independent approval. Scope/diff, pre-existing count contracts, parser cleanup, backwards compatibility, optional sections, failure assertions, fixture identity and action pins checked. No remaining observed failure in this bounded consumer regression. Overall BMB-021 remains HOLD pending unresolved owner/native and unsupported-source/resource gates. Builder #57, Ruby #33, and baseline BMB-005/007 workflow remain unmodified.
