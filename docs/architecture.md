
# Architecture

Sibambo Editor is a separate SvelteKit application under apps/editor. Its route owns the file-selection, admission, worker, session, and viewport lifecycle. The package is configured with the Node adapter and its development server binds to the loopback interface on port 5175.

## Import and render path

1. The page accepts a local BOMC 1.2 file and a local JSON provenance sidecar.
2. The page reads and parses the sidecar, then calls the Editor admission function. Admission applies the E4 provenance policy, checks the declared byte count and SHA-256, applies the 256 MiB artifact limit, and checks the BOMC 1.2 marker and version.
3. The admitted ArrayBuffer is transferred to the Editor-owned module worker. The worker invokes the shared BOMC importer and scene-preparation package, reporting progress to the page.
4. The page creates an EditorSession that holds the source file reference and provenance, then mounts the shared PreparedSceneViewport in read-only mode.
5. When the viewport reports that the first frame was observed and requested textures settled, the page enables PNG capture.

Relevant implementation files:

- [Editor page and viewport lifecycle](../apps/editor/src/routes/+page.svelte)
- [E4 admission](../apps/editor/src/lib/e4-admission.ts)
- [Worker client](../apps/editor/src/lib/e4-worker-client.ts)
- [Import worker](../apps/editor/src/lib/e4-import.worker.ts)
- [Editor session](../apps/editor/src/lib/editor/EditorSession.ts)

## Cancellation and teardown

Each load has a generation identifier and an AbortController. Cancel increments the generation, aborts the worker request, clears the result and session, and prevents stale progress or a late result from replacing the current page state. The worker client sends a cancellation message and terminates its Worker when the request settles. Page teardown also aborts work and disposes the viewport and session.

Worker cancellation limits how long a user-requested import continues. It is not a substitute for decoded-data limits or a guarantee that a resource-heavy file can be safely opened.

## Ownership boundaries

The Editor package declares dependencies on these shared workspace packages:

- contracts
- E4 import and BOMC decoding
- provenance policy and validation
- scene preparation
- viewport and rendering

The application-specific route and worker live under apps/editor. The Editor page passes editorMode=false to the viewport. Although the source tree contains an Editor-owned geometry store, controller, command history, and runtime classes, the current route does not instantiate those editing components or connect them to user controls. The present UI is a read-only source viewport.

## Build identity and routes

The page displays its source fingerprint, and GET /__build.json returns the app build identity. The identity code hashes the application source and declared package closure together with relevant manifests and build configuration. It is reproducibility metadata; it does not authenticate the server, prove that the running deployment matches a separately published artifact, or certify the E4 producer.

The Editor route tree contains the main page and the build-identity endpoint. There is no model upload, save, database, or collaboration API in this application source. The adapter-node configuration does not itself add authentication, hosted storage, or deployment controls.

- [Build identity endpoint](../apps/editor/src/routes/__build.json/+server.ts)
- [Build identity implementation](../tooling/research/build-identity.ts)
- [Editor package manifest](../apps/editor/package.json)
- [SvelteKit configuration](../apps/editor/svelte.config.js)

