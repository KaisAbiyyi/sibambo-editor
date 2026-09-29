
# Data handling and evidence limits

This document describes the current Editor file path and the claims supported by this source snapshot. Editor is a local browser workspace, not a hosted file service or an editing system of record.

## Files admitted by the current page

The page requires one user-selected BOMC 1.2 artifact and matching JSON provenance sidecar. It checks the BOMC marker and version, computes the artifact SHA-256, and then hands the bytes to the import worker. The importer validates encoded structure, declared lengths, checksums, and references without fixed app-level file, record, geometry, or render-work cutoffs. Editor validates the sidecar against the E4 policy and checks its declared artifact byte count and SHA-256 against the selected file, then confirms its profile matches the parsed BOMC profile.

A missing or mismatched sidecar prevents admission of the selected model. A rejected replacement leaves the existing model, camera, and selection available. Matching provenance is an operator-attested record; it does not authenticate the producer or certify the model.

Sidecar JSON is read through a byte-bounded helper before parsing. BOMC section and count fields are checked against the encoded structure, and malformed or inconsistent data is rejected.

The worker can be cancelled and terminated, but cancellation does not replace parser bounds or authenticate input. Do not treat a matching hash as proof that a producer created the file.

Editor has no separate JSON dataset or project import workflow. Its JSON input is the required provenance sidecar.

## Provenance and build identity

The sidecar is an operator-attested research record. The app checks the declared metadata and digest against the selected bytes; the record is not a cryptographic producer signature or a certification.

The page displays an application source fingerprint, and GET /__build.json returns build identity metadata. These values can help compare builds, but they do not independently authenticate the producer, the deployment, or the provenance sidecar.

## Where data goes

The selected file, decoded scene, matched provenance, and current Editor session are kept in page memory. The app source does not provide a hosted database, model upload endpoint, account sync, or collaborative editing service. Unloading the model or leaving the page clears the session.

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

