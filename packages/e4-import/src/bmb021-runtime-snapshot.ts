// Exact synthetic runtime snapshots from original Editor 917ba8083d5be88a4672b3876bfd66ccbef80b71.
// Pins full typed geometry, triangle/face ownership, materials, hierarchy,
// local/world matrices, bounds and the established analytics subset.
import { createHash } from 'node:crypto';
export const expectedRuntimeSha256: Record<string,string> = {
  "concave-l-floor": "6304ccdafb5d37069099b98496db4b94d6cabad112fee7d2f4269ffa9c6c53a3",
  "floor-front-back": "cac6b3a92d3a4186932c7fd3160512323e4b7edf4cf0c59602248e31b213e61c",
  "minimal-root": "45bf587590e4fe7dfcd3a14943a7955bc60d0ca0d778579ad8b8c6883ae6f9a4",
  "mirrored-sheared-floors": "6cd648915778210968990a328e64ac41380a70555149f135b7d13a06aad8456c",
  "nested-shared-definitions": "52630018414bc9f8e158d95d5b6528a21c0c29229a52e563a4f039d1da490148",
  "two-room-door-seam": "1f174f0b6ca831f021f7a38632248de7a519fa97a6afcc0cfa546caf228e49df",
  "wall-window-cutout": "66d9af42dcc51b52331090da7ad07dde54b20e99378ec24bfe50f2b7b62230d3"
};
export function runtimeSha256(v:any) {
  const snapshot = {
    counts:v.counts, materials:v.materialRows, coverage:v.diagnostics.coverage, bounds:v.bounds,
    triangles:v.diagnostics.triangleOwnership.frontDefinitionTriangles,
    backFaces:v.diagnostics.triangleOwnership.explicitBackMaterialFaces,
    faces:v.faces.map((f:any)=>({label:f.semanticLabel||f.name,area:f.areaM2,vertices:f.vertices,holes:f.holes})),
    hierarchy:v.preparedRuntimeScene.occurrenceHierarchy,
    meshes:v.preparedRuntimeScene.meshes.map((m:any)=>({positions:[...m.positions],
      normals:m.normals?[...m.normals]:null,uvs:m.uvs?[...m.uvs]:null})),
    groups:v.preparedRuntimeScene.groups.map((g:any)=>({mesh:g.sourceMeshIndex,definition:g.definitionIndex,
      side:g.renderSide,material:g.materialIndex,rgba:g.baseColorRgba,opacity:g.opacity,
      indices:[...g.indices],matrices:[...g.matrices],faceIndices:[...(g.sourceFaceIndicesByTriangle||[])]}))
  };
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
