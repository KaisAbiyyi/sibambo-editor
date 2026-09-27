
# Sibambo Editor

Sibambo Editor is a browser-based E4 viewport and early editing foundation for inspecting BOMC 1.2 captures. The current page admits a model and sidecar, renders the imported source, and lets you inspect scenes and source geometry. It does not provide a complete CAD workflow or write edited geometry back to a BOMC file.

## What it currently does

- Accepts a BOMC 1.2 file with a matching E4 provenance sidecar.
- Checks the sidecar against the app’s E4 policy, verifies the declared byte count and SHA-256, and rejects unsupported BOMC versions.
- Imports through an Editor-owned worker with progress and cancellation.
- Shows named scenes, Solid, X-Ray, and Wireframe display modes, standard camera views, and orbit, pan, and zoom navigation.
- Lets you pick source geometry and inspect available mesh, definition, occurrence, and face identifiers.
- Downloads a PNG of the current view.

The imported source is read-only in the current interface. Editor-specific geometry and command classes exist as a foundation, but the page does not expose those tools, a complete edit history, or a save-back workflow.

## Open a model

Choose a BOMC 1.2 file and its matching JSON provenance sidecar, then select **Open verified model**. After the first frame and requested textures settle, use **Save view** to download a PNG. **Cancel** stops the active import; **Unload** clears the current page session.

Use files from trusted sources. The current 256 MiB artifact limit applies to the input file, but the importer does not enforce an aggregate decoded-size limit, and sidecar JSON has no explicit size limit. Hash verification binds the sidecar’s declared digest to the selected bytes; it does not cryptographically prove who produced the file.

## Status and evidence limits

E4 remains **candidate_pending_cross_model_validation**. A successful admission or rendered image does not establish parity with another viewer, universal model fidelity, or certification. Complete editing, lossless round-tripping, and modified BOMC export are not established capabilities.

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

