# `@sibambo/bomc-document`

This private package is the Phase 2A canonical document and persistence kernel. It stores owned, immutable Float64-valued graph records, writes the declared `web-core-v1` subset as BOMC 1.2, reads only its recognized section 241 authoring schema, and supports byte-exact retention of an unchanged source envelope.

The package entry (`@sibambo/bomc-document`) exposes only `BomcDocument`, its error class, and graph types. Import `@sibambo/bomc-document/writer`, `/reader`, or `/source-envelope` explicitly inside code that owns those capabilities. The package has no dependency on Three.js, Svelte, the Editor session, app routes, or GPU state.

`web-core-v1` supports blank documents; supplied polygon loops, holes, and valid triangulations; mesh-backed polygonal extrusions; solid RGBA and independent opacity; shared component/group definitions; and affine transforms including mirror, shear, and nonuniform scale. It does not triangulate, repair topology, or support editable textures/UV, semantic colorization, tags, scenes, clips, fallback media, or arbitrary imported E4 edits. Unsupported graph fields fail with `UNSUPPORTED_FEATURE`.

Use `retainBomcSource(bytes).copyUnchanged()` only when the original BOMC must be copied without editing. Its `directory-and-stored-crc` integrity level validates container structure and stored checksums; it does not claim full logical model validation.
