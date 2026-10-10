
# Sibambo Editor

The standalone workspace follows the versioned [Sibambo UI contract](https://github.com/KaisAbiyyi/sibambo/blob/main/docs/sibambo-ui-contract-ui-reunification-001-v1.1.md), based on the production `model-eval` interface. Editor owns its layout and styles locally; shared appearance does not move model data or sessions between apps.

Sibambo Editor is a browser-based E4 viewport with a bounded BOMC authoring workflow. It opens model files for inspection and lets you create a new flat document, draw ground-plane rectangles, extrude a selected rectangle upward or downward, undo and redo those edits, and download a BOMC file. A provenance sidecar is optional and adds a matched source record when its policy, byte count, hash, and profile checks pass.

## What it currently does

- Accepts one BOMC 1.2 file without requiring a sidecar.
- Checks the BOMC marker and version, computes the artifact SHA-256, and validates encoded structure and references.
- Optionally checks a provenance sidecar against the app’s E4 policy, artifact byte count and SHA-256, and parsed encoding profile.
- Imports through an Editor-owned worker with progress and cancellation.
- Shows named scenes, Solid, X-Ray, and Wireframe display modes, standard camera views, and orbit, pan, and zoom navigation.
- Lets you pick source geometry and inspect available mesh, definition, occurrence, and face identifiers.
- Downloads a PNG of the current view.
- Creates a new empty BOMC document and edits the flat rectangle/prism subset with canonical double-precision coordinates.
- Keeps imported documents read-only unless their graph matches that exact editable subset.
- Downloads edited BOMC bytes and can reopen the downloaded file for further edits.

This is a constrained authoring phase, not a general CAD editor. Nested instances, textured or otherwise unsupported imported graphs remain view-only. A successful BOMC download does not establish native SketchUp compatibility or certification.

## Create and edit a BOMC

Choose **New BOMC**, select **Rectangle**, and place two points on the ground plane. Select an unextruded rectangle and use **Push/Pull** to enter a signed distance in metres. Undo and Redo operate on acknowledged document edits. **Save BOMC** downloads the current canonical document; after opening that downloaded file, continue editing through the same workflow. A dirty document asks whether to Save, Discard, or Cancel before New, Open, or Close.

The editable subset is intentionally narrow: a flat root document with independent ground rectangles and single upward or downward extrusions. Valid files outside that subset remain available in the viewer with BOMC Save disabled. Unsupported input is not silently flattened or rewritten.

## Open a model

Choose a BOMC 1.2 file and select **Open model file**. The persistent evidence label shows **File-only · source not recorded** when no sidecar is present. You can optionally choose a provenance JSON before opening, or add one to the current file from its source details. A successful match is labelled **Provenance-matched · operator-attested source record**. A malformed or mismatched sidecar does not replace the active session or upgrade its evidence label. After the first frame and requested textures settle, use **Save view** to download a PNG. **Cancel** stops the active import: on first load, the page stays empty; during replacement, the current model and viewport stay available. A rejected replacement also leaves the current session in place. **Unload** clears the page session.

BOMC import has no fixed app-level file, section, record, geometry, or render-work cutoffs. The importer validates encoded structure, declared lengths, checksums, and references. Optional sidecar JSON is still read through a byte-bounded helper before parsing. A provenance-matched label means the operator-attested record agrees with the selected bytes and parsed profile; it does not cryptographically prove who produced the file or certify the model.

## Status and evidence limits

E4 remains **candidate_pending_cross_model_validation**. The authoring subset's automated download/reopen qualification is being completed in the current implementation batch. A successful admission or rendered image does not establish parity with another viewer, universal model fidelity, or certification. General CAD editing, native SketchUp compatibility, and complex-model round-tripping are outside this subset.

Imported model data and the Editor session are held in page memory. There is no hosted database, model upload service, account sync, or server-side editing history in this app. Saving a view downloads an image to the user’s device.

## Run the workspace

This repository is a self-contained Bun workspace containing Editor and its five shared packages. Run the following commands from this repository root:

    bun install --frozen-lockfile
    bun run dev

The development server is configured for 127.0.0.1:5175. Root scripts also provide:

    bun run check
    bun run test
    bun run build

The package-level scripts are listed in [apps/editor/package.json](apps/editor/package.json).

## Documentation

- [Editor guide](apps/editor/README.md)
- [Architecture](docs/architecture.md)
- [Data handling and evidence limits](docs/data-and-evidence.md)
- [Vercel deployment](docs/deployment.md)
- [Verification and release status](docs/verification.md)
- [License](LICENSE)

