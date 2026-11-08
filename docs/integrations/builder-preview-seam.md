# BMB-027 · Sibambo Editor Builder preview seam

## Purpose

Provide a bounded handoff from BOMC Builder to Sibambo Editor without coupling the Builder construction kernel to Editor internals. Builder remains responsible for planning, module IR, graph mutation, geometric validation, deterministic compilation, and producing the BOMC 1.2 artifact. Editor remains responsible for BOMC admission, E4 decoding, scene rendering, and inspection.

## User flow

1. The Builder/agent produces a BOMC 1.2 artifact through the existing Builder writer.
2. The user selects **Extensions → Preview Builder Artifact…** in Editor and chooses that local file.
3. Editor validates the marker/version and artifact structure through its existing admission and E4 worker path.
4. Editor displays the compiled artifact in the existing PreparedSceneViewport.

This first seam is intentionally a user-mediated local file handoff. It is not a live Builder extension transport.

## Ownership and security boundaries

- **Builder owns construction.** No Builder geometry, module IR, graph compiler, validation, CLI, or MCP implementation is copied into Editor.
- **Editor owns preview and inspection.** It reuses admitE4File, loadE4InWorker, PreparedSceneViewport, and EditorSession; it does not implement a second BOMC parser or geometry constructor.
- **Always read-only.** Builder preview skips Editor's authoring-subset promotion and does not create an EditorController. Scene selection, camera navigation, source-face picking, and Save View remain available. Move, Undo/Redo, and Save BOMC are unavailable even when the file would otherwise qualify for Editor's writable subset.
- **Local-only data path.** The selected file is processed in browser memory. There is no HTTP upload, server persistence, account sync, automatic Builder call, stdio MCP invocation, API key, or external extension message bridge.
- **No private-to-public transfer.** The seam exchanges only the user-selected compiled BOMC 1.2 artifact. It does not copy private Sibambo source or Builder construction implementation into Editor.
- **Evidence labels remain honest.** A file-only artifact is not producer-authenticated. A future provenance sidecar may be added only through the existing E4 policy; this seam does not infer authorship from a filename or UI entry point.

## Pinned implementation baseline

- Editor repository: KaisAbiyyi/sibambo-editor
- Stacked base branch: feature/bmb026-original-editor-consumer-20261106
- Pinned base HEAD: 9570d8d57cd95be3d95e4785d7b1f8a45b83ae73
- Predecessor Editor PR #12: b5f46a761d1763241b60375cbb5f7110d62d99d2
- Predecessor Editor PR #13: 9570d8d57cd95be3d95e4785d7b1f8a45b83ae73

PR #12 and #13 remain draft/unmerged. BMB-027 is stacked on #13 so it does not silently absorb or merge either predecessor. Rebase/retarget only after the owner decides their disposition.

## Cloud verification

The BMB-027 workflow runs exact-head Editor check/build on Ubuntu and Windows and a Chromium browser test on Ubuntu. The browser tests cover:

- A BOMC file that normally enters Editor's writable subset remains read-only through Builder Preview.
- Save BOMC, Move, Undo, and Redo are unavailable in Builder Preview.
- E4 scene rendering and source-face inspection remain available.
- Save View remains available.

Native SketchUp, installed-browser/extension transport, real Builder CLI/MCP live connection, representative corpus fidelity, and owner visual acceptance remain separate NOT_RUN gates.
