
# Sibambo Editor

Editor is the E4-only viewport application in this self-contained Bun workspace. The workspace includes the five shared packages Editor depends on. Use the repository root for dependency installation and commands.

## Open a verified model

1. Select a BOMC 1.2 artifact and its matching JSON provenance sidecar.
2. Choose **Open verified model**. Admission checks the E4 provenance policy, the sidecar’s declared byte count and SHA-256, and the BOMC 1.2 signature and version header.
3. Wait for the import worker and viewport to finish. The status changes after the first frame is observed and requested textures settle.
4. Choose a named scene, adjust the camera and display, inspect source geometry, or use **Save view** to download a PNG.

The sidecar is operator-attested metadata, not a cryptographic producer signature. A matching hash confirms that the selected bytes match the sidecar’s digest; it does not prove producer authorship or certify the model.

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

Import runs in an app-owned worker. Progress is shown while the worker decodes and prepares render data. **Cancel** aborts the request, terminates the worker, clears the current result, and prevents an earlier request from mounting a late viewport. **Unload** also clears the selected files and the in-memory session. Closing or reloading the page disposes the active viewport and session.

The worker keeps heavy decoding and render preparation off the main UI thread, but that does not remove the resource limits described in [Data handling and evidence limits](../../docs/data-and-evidence.md).

## Data handling

Editor does not upload the selected model or save it to a hosted database. The selected file reference, imported result, and Editor session remain in page memory. The **Save view** button downloads a PNG to the local device. The current page has no model-save, cloud-sync, or collaboration feature.

The source model is displayed read-only. The [Editor session](src/lib/editor/EditorSession.ts) has a separate Editor-owned geometry store, but the current route does not connect drawing tools or save edited geometry. Treat the application as a viewport foundation, not as a complete or lossless CAD editor.

## Security and evidence limits

The app rejects mismatched sidecars and unsupported BOMC versions, and admission caps the selected artifact at 256 MiB. The current importer does not enforce an aggregate decoded-size limit, and the sidecar is read as text and parsed without an explicit byte-size cap. A crafted file can therefore consume substantial browser memory even when its compressed artifact is below the input limit.

Until decoded-size and sidecar-size limits are added and reviewed, use only BOMC files and sidecars from trusted sources. Do not treat the sidecar hash as a security signature.

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
- [Verification and release status](../../docs/verification.md)
- [Admission code](src/lib/e4-admission.ts)
- [Worker lifecycle](src/lib/e4-worker-client.ts)

