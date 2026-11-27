
# Data handling and evidence limits

This document describes the current Editor file path and the claims supported by this source snapshot. Editor is a local browser workspace, not a hosted file service or a general CAD system.

## Files admitted by the current page

The page accepts one user-selected BOMC 1.2 artifact. It checks the BOMC marker and version, computes the artifact SHA-256, and then hands the bytes to the import worker. The importer validates encoded structure, declared lengths, checksums, and references without fixed app-level file, record, geometry, or render-work cutoffs. A JSON provenance sidecar is optional. If supplied before opening, Editor validates it against the E4 policy and checks its declared artifact byte count and SHA-256 against the selected file, then confirms its profile matches the parsed BOMC profile. A sidecar can also be added to an open file; the same checks run before the session evidence changes.

Without a matching sidecar, the Editor session stores `provenance: null` and displays **File-only · source not recorded**. After all sidecar and parsed-profile checks pass, the current session may upgrade to **Provenance-matched · operator-attested source record** without remounting its viewport. A malformed or mismatched sidecar leaves the active model, camera, selection, and evidence level unchanged. File-only and provenance-matched are evidence labels; neither authenticates the producer or certifies the model.

Sidecar JSON is read through a byte-bounded helper before parsing. BOMC section and count fields are checked against the encoded structure, and malformed or inconsistent data is rejected.

The worker can be cancelled and terminated, but cancellation does not replace parser bounds or authenticate input. Do not treat a matching hash as proof that a producer created the file.

Editor has no separate JSON project import workflow. Its optional JSON input is a provenance sidecar. A new document contains an empty canonical BOMC graph; its supported edits are independent ground rectangles and one signed extrusion per rectangle. Valid imported graphs outside that exact subset remain view-only. The application does not silently normalize unsupported input into the editable subset.

## Provenance and build identity

The sidecar is an operator-attested research record. The app checks the declared metadata and digest against the selected bytes; the record is not a cryptographic producer signature or a certification.

The page displays an application source fingerprint, and GET /__build.json returns build identity metadata. These values can help compare builds, but they do not independently authenticate the producer, the deployment, or the provenance sidecar.

## Where data goes

The optional SE-05 live Builder mode receives canonical Module IR and shared geometry projections from the separate authenticated service over WSS. The owner BFF holds the opaque OAuth session in a Secure/HttpOnly cookie; the browser receives only a single-use 30-second attachment ticket. Neither credentials nor draft data go into localStorage/IndexedDB, URL parameters or automatic model logs. Worker validation and atomic frame acknowledgment gate subsequent writes. Request-status messages contain IDs/statuses only; owner request text is a separate bounded volatile inbox.

Live state is retained in the page and in the server's RAM actor/replay buffers. Closing the last connection starts a thirty-minute server idle TTL; losing both page and service loses the unsaved draft. Logout pauses/fences the owner's service channels. A new server epoch cannot silently replace the last canonical draft retained in the page. These source guarantees still require qualification of the actual deployment's logs, process/swap/core-dump policy and external IdP. Live Builder Save/reopen and restart restore are separate milestones; they are not the local authoring Save behavior below.

The selected file, decoded scene, optional provenance, canonical authoring document, and current Editor session are kept in page memory. The app source does not provide a hosted database, model upload endpoint, account sync, or collaborative editing service. Unloading the model or leaving the page clears the session.

**Save view** downloads a PNG. **Save BOMC** writes the acknowledged canonical graph and downloads the resulting BOMC bytes in the browser. A matching successful browser-download dispatch and worker acknowledgment clears dirty state; the file is not uploaded or saved to an application server. Users must retain downloaded BOMC files themselves.

## Evidence and product limits

E4 remains **candidate_pending_cross_model_validation**. A successful import, a source fingerprint, or a rendered screenshot is not evidence of parity with another viewer, universal fidelity, or certification. Those claims require separate comparison evidence.

The user-facing authoring subset is limited to flat root documents with ground rectangles and single upward or downward extrusions. General CAD operations, nested instances, textures, BOMC-to-SKP, complex native round-tripping, and SketchUp host behavior remain outside scope. The batch's automated authoring/download/reopen and independent-reader qualification must finish before claiming that the end-to-end workflow is verified.

No deployment state, production authentication, hosted retention policy, or server-side storage guarantee is established by this app source.

## Related source

- [Admission checks](../apps/editor/src/lib/e4-admission.ts)
- [Sidecar parsing and page workflow](../apps/editor/src/routes/+page.svelte)
- [Worker cancellation](../apps/editor/src/lib/e4-worker-client.ts)
- [Build identity endpoint](../apps/editor/src/routes/__build.json/+server.ts)
- [Architecture](architecture.md)

