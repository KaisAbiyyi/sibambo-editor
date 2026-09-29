
# Sibambo Editor

Editor is the E4-only viewport application in this self-contained Bun workspace. The workspace includes the five shared packages Editor depends on. Use the repository root for dependency installation and commands.

## Open a model file

1. Select one BOMC 1.2 file and choose **Open model file**.
2. Editor checks the file size, BOMC marker, and version header, computes its SHA-256, and imports it through the bounded E4 worker.
3. Without a sidecar the source is labelled **File-only · source not recorded**. You may choose a provenance JSON before opening or add one to the current model from source details.
4. Editor labels a successfully matched record **Provenance-matched · operator-attested source record** after checking the E4 policy, declared byte count, SHA-256, and parsed encoding profile.
5. Wait for the import worker and viewport to finish. The status changes after the first frame is observed and requested textures settle. Choose a named scene, adjust the camera and display, inspect source geometry, or use **Save view** to download a PNG.

The sidecar is optional operator-attested metadata, not a cryptographic producer signature. A matching hash confirms that the selected bytes match the sidecar’s digest; it does not prove producer authorship or certify the model. A malformed or mismatched sidecar leaves the current file, viewport, camera, and selection in place.

## Viewport controls

The current route provides:

- Fit, top, front, and isometric views.
- Orbit, pan, and zoom navigation.
- Solid, X-Ray, and Wireframe display modes.
- Named-scene selection when scenes are present.
- Source-geometry picking, with mesh, definition, occurrence, and face identifiers where available.
- PNG capture after the viewport is ready.

These controls inspect the imported source. The app page does not expose drawing, push/pull, undo/redo, or a file-writing workflow for imported BOMC geometry.

## Import cancellation and session lifetime

Import runs in an app-owned worker. Progress is shown while the worker decodes and prepares render data. **Cancel** aborts the request and prevents stale progress or results from replacing the current state. On first load, cancellation leaves no loaded session; during replacement, it preserves the current model and viewport. Editor mounts a replacement candidate viewport before disposing the old session and viewport, so a candidate that is rejected or fails to mount leaves the current view available. **Unload** clears the selected files and in-memory session. Closing or reloading the page disposes the active viewport and session.

The worker keeps decoding and render preparation off the main UI thread. BOMC imports validate encoded structure and references as described in [Data handling and evidence limits](../../docs/data-and-evidence.md).

## Data handling

Editor does not upload the selected model or save it to a hosted database. The selected file reference, imported result, and Editor session remain in page memory. The **Save view** button downloads a PNG to the local device. The current page has no model-save, cloud-sync, or collaboration feature.

The source model is displayed read-only. The [Editor session](src/lib/editor/EditorSession.ts) has a separate Editor-owned geometry store, but the current route does not connect drawing tools or save edited geometry. Treat the application as a viewport foundation, not as a complete or lossless CAD editor.

## Security and evidence limits

The app rejects unsupported BOMC versions. It has no fixed app-level BOMC file-size, section, record, geometry, or render-work cutoff. When provided, sidecar JSON is read through a byte-bounded helper and checked for policy, byte count, hash, and parsed profile matches.

The sidecar hash is not a security signature and does not prove producer authenticity. BOMC format checks do not certify E4 behavior.

E4 remains **candidate_pending_cross_model_validation**. Cross-model viewer parity, universal fidelity, certification, complete editing, and lossless save-back are unproven. See [Data handling and evidence limits](../../docs/data-and-evidence.md).

## Run the workspace

This repository includes Editor and its shared workspace packages, so no separate monorepo checkout is needed. From the repository root:

    bun install --frozen-lockfile
    bun run dev

The development server binds to 127.0.0.1 on port 5175. Root check, test, and build scripts are also available:

    bun run check
    bun run test
    bun run build

Editor package scripts are listed in [package.json](package.json).

## Related documentation

- [Workspace overview](../../README.md)
- [Architecture](../../docs/architecture.md)
- [Data handling and evidence limits](../../docs/data-and-evidence.md)
- [Vercel deployment](../../docs/deployment.md)
- [Verification and release status](../../docs/verification.md)
- [Admission code](src/lib/e4-admission.ts)
- [Worker lifecycle](src/lib/e4-worker-client.ts)

