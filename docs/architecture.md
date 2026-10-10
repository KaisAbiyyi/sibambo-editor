
# Architecture

Sibambo Editor is a separate SvelteKit application under apps/editor. Its route owns the file-selection, admission, worker, session, and viewport lifecycle. Its SvelteKit configuration selects the Vercel adapter when the Vercel build environment is present and the Node adapter for local builds. The development server binds to the loopback interface on port 5175.

## Import and render path

1. The page accepts one local BOMC 1.2 file; a local JSON provenance sidecar is optional.
2. Editor admission checks the BOMC 1.2 marker and version and computes the artifact SHA-256. If a sidecar is supplied, the page reads it through the byte-bounded helper and admission applies the E4 provenance policy and checks the declared byte count and SHA-256.
3. The admitted ArrayBuffer is transferred to the Editor-owned module worker. The worker invokes the shared BOMC importer and scene-preparation package, reporting progress to the page.
4. The page confirms any declared sidecar profile matches the parsed BOMC profile, creates an EditorSession with either `provenance: null` or matched provenance, and mounts the shared PreparedSceneViewport.
5. A sidecar added to an open file goes through the same policy, byte-count, hash, and parsed-profile checks before session evidence changes; it does not remount the viewport.
6. When the viewport reports that the first frame was observed and requested textures settled, the page enables PNG capture.

## Authoring flow

The route keeps one viewport host mounted while it moves among empty, imported, and authoring states. **New BOMC** creates a canonical `BomcDocument` and a lazy authoring client. Rectangle and signed extrusion tools convert pointer rays to document-space commands; the worker validates the supported flat subset and applies each edit as one document transaction. The client publishes a new checkpoint only after the worker acknowledges the transaction. Undo and Redo use the same journal and checkpoint boundary.

Canonical graph coordinates remain JavaScript numbers. `scene.ts` projects the graph into disposable viewport geometry and overlays; GPU float buffers are not read back as document state. Camera changes, display changes, selection, and previews do not mutate the graph. A successful New/Open focuses canonical bounds once; later edits preserve the camera pose.

Save locks the acknowledged revision, writes it through the persistent authoring worker, and dispatches the exact output bytes as a browser download. Only the matching `ACK_DOWNLOAD` updates the saved graph and clears dirty state. The route does not upload the model or persist it to a server. Reopening a downloaded BOMC creates a clean document checkpoint; supported new edits use the same worker and writer path.

Dirty New/Open/Close transitions offer Save, Discard, or Cancel. Candidate inspection and viewport mounting happen before replacing the current session. A failed or cancelled transition restores the previous viewport, title, document checkpoint, history, and dirty state.

Relevant implementation files:

- [Editor page and viewport lifecycle](../apps/editor/src/routes/+page.svelte)
- [E4 admission](../apps/editor/src/lib/e4-admission.ts)
- [Worker client](../apps/editor/src/lib/e4-worker-client.ts)
- [Import worker](../apps/editor/src/lib/e4-import.worker.ts)
- [Editor session](../apps/editor/src/lib/editor/EditorSession.ts)

## Cancellation and teardown

Each load has a generation identifier and an AbortController. Cancel increments the generation and aborts the worker request, preventing stale progress or a late result from replacing current page state. On first load, cancellation leaves no session; during replacement, it preserves the current model, session, and viewport. A replacement candidate viewport is mounted before the old session and viewport are disposed, so a rejected candidate or mount failure leaves the current view active. The worker client sends a cancellation message and terminates its Worker when the request settles. Page teardown aborts work and disposes the active viewport and session.

Worker cancellation lets a user stop an import in progress. The importer validates encoded structure and declared lengths; the sidecar hash does not establish producer identity.

## Ownership boundaries

The Editor package declares dependencies on these shared workspace packages:

- contracts
- E4 import and BOMC decoding
- provenance policy and validation
- scene preparation
- viewport and rendering

The application-specific route and authoring worker live under apps/editor. `authoring/{protocol,geometry,history,scene,tools}.ts` owns the canonical flat-shape command model, undo journal, viewport projection, and pointer controller. `bomc-authoring-client.ts` owns the persistent worker and acknowledged checkpoints; `bomc-authoring.worker.ts` owns the document and writer. Imported rendering still uses the shared PreparedSceneViewport. An imported graph becomes editable only when it passes the explicit flat rectangle/prism subset check; other valid graphs stay view-only.

## Build identity and routes

The page displays its source fingerprint, and GET /__build.json returns the app build identity. The identity code hashes non-test files under `apps/editor/src` and the declared package `src` trees, the workspace and package manifests, selected SvelteKit/Vite/TypeScript/Playwright configuration files, the root lockfile, and the build-identity helper. Files ending in `.test.*` or `.spec.*` under `src` are excluded. This is reproducibility metadata; it does not authenticate the server, prove that the running deployment matches a separately published artifact, or certify the E4 producer.

The Editor route tree contains the main page and the build-identity endpoint. There is no model upload, save, database, or collaboration API in this application source. Selecting the Vercel or Node adapter does not itself add authentication, hosted storage, or deployment controls.

- [Build identity endpoint](../apps/editor/src/routes/__build.json/+server.ts)
- [Build identity implementation](../tooling/research/build-identity.ts)
- [Editor package manifest](../apps/editor/package.json)
- [SvelteKit configuration](../apps/editor/svelte.config.js)

