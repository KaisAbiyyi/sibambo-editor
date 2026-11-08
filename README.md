
> **Product architecture update — 2026-11-08:** the [two-phase MASTER IMPLEMENTATION PLAN v1.1](docs/two-phase/MASTER_IMPLEMENTATION_PLAN_2026-11-08_SIB-TWO-PHASE-001_v1.1.md) governs new Stable Editor remote MCP/live draft/owner Save delivery and the separate **EXPERIMENTAL** native agentic application. This older document is retained as foundation/history; its task/component completion is not product readiness. [Gap audit](docs/two-phase/GAP-AUDIT.md) · [ADRs](docs/two-phase/ADR-LEDGER.md) · [task contracts](docs/two-phase/TASK-CONTRACTS.md) · [Notion/GitHub resource map](docs/two-phase/RESOURCE-MAP.md). No product implementation/deployment/release is performed by this documentation update.


# Sibambo Editor

The standalone workspace follows the versioned [Sibambo UI contract](https://github.com/KaisAbiyyi/sibambo/blob/main/docs/sibambo-ui-contract-ui-reunification-001-v1.1.md), based on the production `model-eval` interface. Editor owns its layout and styles locally; shared appearance does not move model data or sessions between apps.

Sibambo Editor is a browser-based E4 viewport with a bounded BOMC authoring workflow. It opens model files for inspection and lets you draw planar geometry, Push/Pull faces, organize Groups and Components, transform selections, and download/reopen canonical BOMC documents. A provenance sidecar is optional and adds a matched source record when its policy, byte count, hash, and profile checks pass.

## What it currently does

- Accepts one BOMC 1.2 file without requiring a sidecar.
- Checks the BOMC marker and version, computes the artifact SHA-256, and validates encoded structure and references.
- Optionally checks a provenance sidecar against the app’s E4 policy, artifact byte count and SHA-256, and parsed encoding profile.
- Imports through an Editor-owned worker with progress and cancellation.
- Shows named scenes, Solid, X-Ray, and Wireframe display modes, standard camera views, and orbit, pan, and zoom navigation.
- Lets you pick source geometry and inspect available mesh, definition, occurrence, and face identifiers.
- Downloads a PNG of the current view.
- Creates a new empty BOMC document with canonical double-precision coordinates, inferred Rectangle/Line drawing and bounded nested-face Push/Pull.
- Supports owned Groups/Components, Move/Copy/arrays, numeric Rotate/Scale/Flip, Inset/Offset, segmented Circle/Polygon/center Arc, and planar Follow Me.
- Paints solid front/back colors and opacity, samples selected materials, and inherits container paint on unpainted faces.
- Organizes containers with Tags, a searchable Outliner, basic Entity Info and an in-document Component library with geometry cost preview.
- Keeps imported documents read-only unless their graph matches the application-owned editable subset.
- Downloads edited BOMC bytes and can reopen the downloaded file for further edits.

This is a constrained authoring phase. Foreign or textured graphs remain view-only; application-owned nested instances support bounded affine edits. Texture authoring/UV/PBR, general Boolean geometry, nonplanar Follow Me and a library shared across documents are not implemented. A successful BOMC download does not establish native SketchUp compatibility or certification.

## Create and edit a BOMC

Choose **New BOMC**, select **Rectangle**, and place two points on the ground plane. Select an unextruded rectangle and use **Push/Pull** to enter a signed distance in metres. Undo and Redo operate on acknowledged document edits. **Save BOMC** downloads the current canonical document; after opening that downloaded file, continue editing through the same workflow. A dirty document asks whether to Save, Discard, or Cancel before New, Open, or Close.

Open **Modeling** for additional tools. **Inset / Offset** uses the SketchUp workflow: click a face near an edge, move inward/outward and click, or enter a precise distance under Offset, Guides & Dimensions. Then use Push/Pull on the inner face for depth. Circle/Polygon use center then radius; center Arc adds a third endpoint. Follow Me consumes a continuous selected edge chain and a perpendicular profile on its starting plane, within the same edit context. Paths must be planar; branches, folded/self-crossing profile envelopes and excessive miters reject atomically. It does not merge the resulting sweep with other solids.

Rotate/Scale/Flip use world axes and a numeric pivot; **Use Selection Center** fills pivot and dimensions. Painting a container supplies color only to its unpainted faces. Tags apply to containers while raw geometry stays Untagged. The library stores local Component definitions inside this BOMC: Component entries share their source definition, while Group entries get an independent definition. Insertion uses definition axes and the entered position; it does not copy a source occurrence's scale, rotation or container material. Save/reopen retains these records. Older Editor builds may show expanded documents read-only or ignore presentation metadata; use this build for authoring them.

Valid files outside the supported subset remain available in the viewer with BOMC Save disabled. Unsupported input is not silently flattened or rewritten.

## Open a model

Choose a BOMC 1.2 file and select **Open model file**. The persistent evidence label shows **File-only · source not recorded** when no sidecar is present. You can optionally choose a provenance JSON before opening, or add one to the current file from its source details. A successful match is labelled **Provenance-matched · operator-attested source record**. A malformed or mismatched sidecar does not replace the active session or upgrade its evidence label. After the first frame and requested textures settle, use **Save view** to download a PNG. **Cancel** stops the active import: on first load, the page stays empty; during replacement, the current model and viewport stay available. A rejected replacement also leaves the current session in place. **Unload** clears the page session.

BOMC import has no fixed app-level file, section, record, geometry, or render-work cutoffs. The importer validates encoded structure, declared lengths, checksums, and references. Optional sidecar JSON is still read through a byte-bounded helper before parsing. A provenance-matched label means the operator-attested record agrees with the selected bytes and parsed profile; it does not cryptographically prove who produced the file or certify the model.

## Status and evidence limits

E4 remains **candidate_pending_cross_model_validation**. Automated tests cover the bounded authoring operations, history and actual downloaded-file reopen; manual usability and native parity remain separate gates. General CAD editing, native SketchUp compatibility, and complex-model round-tripping are outside this subset.

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

## Multi-agent orchestration

Agents must follow [AGENTS.md](AGENTS.md) and the [shared orchestration protocol](docs/AGENT-ORCHESTRATION.md) for neutral task planning, exclusive claims, isolated branches, remote checkpoints, safe takeover, author attribution and four-repo Sibambo integration. These rules do not change existing validation claims.
