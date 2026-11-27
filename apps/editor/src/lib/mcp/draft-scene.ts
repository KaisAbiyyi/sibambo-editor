/** Disposable projection only: shared triangles, one R*M_world, no geometry generation or BOMC import. */
import { BackSide, Box3, BufferGeometry, Color, Float32BufferAttribute, FrontSide, Group, Matrix4, Mesh, MeshStandardMaterial, SRGBColorSpace } from 'three';
import type { PreparedSceneViewport, ViewportBounds } from '@sibambo/viewport';
import type { DraftModule, DraftProposal } from './draft-protocol';
export function moduleGroup(module: DraftModule): Group {
  const p = module.projection, group = new Group(); group.name = 'builder/module/' + module.moduleId; group.matrixAutoUpdate = false;
  const world = new Matrix4(); world.set(...p.worldTransform as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]);
  group.matrix.multiplyMatrices(new Matrix4().makeRotationX(-Math.PI / 2), world);
  const materials = new Map(p.materials.map(m => [m.materialId, m]));
  for (const face of p.faces) for (const [id, side] of [[face.frontMaterialId, FrontSide], [face.backMaterialId, BackSide]] as const) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(face.triangles.flatMap(t => t.flatMap(i => p.positions[i]!)), 3));
    geometry.computeVertexNormals();
    const source = id === null ? undefined : materials.get(id), rgba = source?.rgba ?? [199, 204, 212, 255];
    const material = new MeshStandardMaterial({ color: new Color().setRGB(rgba[0]! / 255, rgba[1]! / 255, rgba[2]! / 255, SRGBColorSpace),
      opacity: (source?.opacity ?? 1) * rgba[3]! / 255, transparent: (source?.opacity ?? 1) * rgba[3]! / 255 < 1, side });
    const mesh = new Mesh(geometry, material); mesh.userData = { moduleId: p.moduleId, faceId: face.faceId }; group.add(mesh);
  }
  return group;
}
export class DraftScene {
  private modules = new Map<string, { hash: string; group: Group; bounds: Box3 }>();
  constructor(private viewport: PreparedSceneViewport) {}
  async render(proposal: DraftProposal, current: () => boolean) {
    if (!current()) return;
    const next = new Map<string, { hash: string; group: Group; bounds: Box3 }>();
    const changes: Array<{ moduleId: string; object: Group | null }> = [];
    for (const module of proposal.state.modules) {
      const retained = this.modules.get(module.moduleId);
      if (retained?.hash === module.projectionSha256) { next.set(module.moduleId, retained); continue; }
      const group = moduleGroup(module); group.updateMatrixWorld(true);
      next.set(module.moduleId, { hash: module.projectionSha256, group, bounds: new Box3().setFromObject(group) });
      changes.push({ moduleId: module.moduleId, object: group });
    }
    for (const mid of this.modules.keys()) if (!next.has(mid)) changes.push({ moduleId: mid, object: null });
    const box = new Box3(); for (const module of next.values()) box.union(module.bounds);
    const bounds: ViewportBounds = box.isEmpty() ? { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 1, z: 1 } } :
      { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
    await this.viewport.setExternalDraftProjection(changes, bounds, current);
    if (current()) this.modules = next;
  }
}
