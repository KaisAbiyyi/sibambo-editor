
# Data handling and evidence limits

This document describes the current Editor file path and the claims supported by this source snapshot. Editor is a local browser workspace, not a hosted file service or an editing system of record.

## Files admitted by the current page

The page accepts one user-selected BOMC 1.2 artifact. It always checks the 256 MiB size bound, BOMC marker and version, computes the artifact SHA-256, and then hands the bytes to the import worker. A JSON provenance sidecar is optional. If supplied before opening, Editor validates it against the E4 policy and checks its declared artifact byte count and SHA-256 against the selected file, then confirms its profile matches the parsed BOMC profile. A sidecar can also be added to an open file; the same checks run before the session evidence changes.

Without a matching sidecar, the Editor session stores `provenance: null` and displays **File-only · source not recorded**. After all sidecar and parsed-profile checks pass, the current session may upgrade to **Provenance-matched · operator-attested source record** without remounting its viewport. A malformed or mismatched sidecar leaves the active model, camera, selection, and evidence level unchanged. File-only and provenance-matched are evidence labels; neither authenticates the producer or certifies the model.

The selected artifact is limited to 256 MiB. The E4 importer also applies bounded section decoding and count, geometry, and work checks. These parser caps are provisional pending cross-model corpus validation. Sidecar JSON is read through a byte-bounded helper before parsing. These controls limit resource use but do not guarantee that every malformed file is safe to process.

The worker can be cancelled and terminated, but cancellation does not replace parser bounds or authenticate input. Do not treat a matching hash as proof that a producer created the file.

Editor has no separate JSON dataset or project import workflow. Its optional JSON input is a provenance sidecar.

## Provenance and build identity

The sidecar is an operator-attested research record. The app checks the declared metadata and digest against the selected bytes; the record is not a cryptographic producer signature or a certification.

The page displays an application source fingerprint, and GET /__build.json returns build identity metadata. These values can help compare builds, but they do not independently authenticate the producer, the deployment, or the provenance sidecar.

## Where data goes

The selected file, decoded scene, optional provenance, and current Editor session are kept in page memory. The app source does not provide a hosted database, model upload endpoint, account sync, or collaborative editing service. Unloading the model or leaving the page clears the session.

The only save action in the current page downloads a PNG view image after the viewport is ready. It does not save edits, rewrite BOMC, or persist a model to a server.

## Evidence and product limits

E4 remains **candidate_pending_cross_model_validation**. A successful import, a source fingerprint, or a rendered screenshot is not evidence of parity with another viewer, universal fidelity, or certification. Those claims require separate comparison evidence.

The current page is a read-only viewport for imported source geometry. Complete editing, validated edit operations across representative models, undo/redo in the user interface, lossless round-tripping, and modified BOMC export are not established capabilities. Editor-specific geometry classes in the source tree are an implementation foundation; they are not proof of a complete user-facing editor.

No deployment state, production authentication, hosted retention policy, or server-side storage guarantee is established by this app source.

## Related source

- [Admission checks](../apps/editor/src/lib/e4-admission.ts)
- [Sidecar parsing and page workflow](../apps/editor/src/routes/+page.svelte)
- [Worker cancellation](../apps/editor/src/lib/e4-worker-client.ts)
- [Build identity endpoint](../apps/editor/src/routes/__build.json/+server.ts)
- [Architecture](architecture.md)

