import { expect, test } from 'bun:test';
import { Box3, BufferGeometry, Group, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { PreparedSceneViewport } from '@sibambo/viewport';
import { moduleGroup } from '../../src/lib/mcp/draft-scene';
import type { DraftModule } from '../../src/lib/mcp/draft-protocol';
function group() {
  let geometryDisposals = 0, materialDisposals = 0;
  const root = new Group(), geometry = new BufferGeometry(), material = new MeshBasicMaterial();
  geometry.addEventListener('dispose', () => geometryDisposals++); material.addEventListener('dispose', () => materialDisposals++);
  root.add(new Mesh(geometry, material));
  return { root, disposed: () => [geometryDisposals, materialDisposals] };
}
function viewport(throwRender = false) {
  const frame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { queueMicrotask(() => callback(0)); return 1; };
  const scene = new Scene(), overlays = new Map(); let renders = 0;
  const instance = Object.assign(Object.create(PreparedSceneViewport.prototype), {
    disposed: false, scene3d: scene, domainOverlays: overlays, disposedOverlays: new WeakSet(), initialFitComplete: true,
    fittedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    rendererHost: { updateClipRange() {}, renderNow() { if (++renders === 1 && throwRender) throw Error('injected frame failure'); } }
  }) as PreparedSceneViewport;
  return { instance, scene, overlays, restore: () => { globalThis.requestAnimationFrame = frame; } };
}
const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } };
test('explicit framing uses live draft bounds and applying a draft never moves the camera', async () => {
  const v = viewport(); let focused: unknown = null;
  Object.assign(v.instance, { meshRecords: [], invalidateNavigationState() {}, refreshNavigationAxes() {} });
  (v.instance as any).rendererHost.focusBounds = (value: unknown) => { focused = value; };
  try {
    await v.instance.setExternalDraftProjection([{ moduleId: 'a', object: group().root }], bounds);
    expect(focused).toBeNull();
    v.instance.fit(); expect(focused).toEqual(bounds);
  } finally { v.restore(); }
});
test('two-module transaction swaps once and disposes only retired resources after the frame', async () => {
  const v = viewport(), oldA = group(), oldB = group(), unchanged = group(), nextA = group(), nextB = group();
  for (const [name, item] of [['a', oldA], ['b', oldB], ['same', unchanged]] as const) { v.overlays.set('builder/module/' + name, item.root); v.scene.add(item.root); }
  try {
    await v.instance.setExternalDraftProjection([{ moduleId: 'a', object: nextA.root }, { moduleId: 'b', object: nextB.root }], bounds);
    expect(v.overlays.get('builder/module/a')).toBe(nextA.root); expect(v.overlays.get('builder/module/b')).toBe(nextB.root);
    expect(v.overlays.get('builder/module/same')).toBe(unchanged.root);
    expect(oldA.disposed()).toEqual([1, 1]); expect(oldB.disposed()).toEqual([1, 1]); expect(unchanged.disposed()).toEqual([0, 0]);
  } finally { v.restore(); }
});
test('failed frame restores both old groups and disposes both candidates, without half-transaction ACK', async () => {
  const v = viewport(true), oldA = group(), oldB = group(), nextA = group(), nextB = group();
  for (const [name, item] of [['a', oldA], ['b', oldB]] as const) { v.overlays.set('builder/module/' + name, item.root); v.scene.add(item.root); }
  try {
    await expect(v.instance.setExternalDraftProjection([{ moduleId: 'a', object: nextA.root }, { moduleId: 'b', object: nextB.root }], bounds)).rejects.toThrow('injected');
    expect(v.overlays.get('builder/module/a')).toBe(oldA.root); expect(v.overlays.get('builder/module/b')).toBe(oldB.root);
    expect(oldA.disposed()).toEqual([0, 0]); expect(oldB.disposed()).toEqual([0, 0]);
    expect(nextA.disposed()).toEqual([1, 1]); expect(nextB.disposed()).toEqual([1, 1]);
  } finally { v.restore(); }
});
test('world placement and mirror apply R*M_world exactly once', () => {
  const module = { moduleId: 'house/room', projection: { moduleId: 'house/room', revision: 1,
    worldTransform: [-1,0,0,10,0,1,0,20,0,0,1,30,0,0,0,1], positions: [], faces: [], materials: [] } } as unknown as DraftModule;
  const group = moduleGroup(module), point = new Vector3(1, 2, 3).applyMatrix4(group.matrix);
  expect(point.x).toBeCloseTo(9); expect(point.y).toBeCloseTo(33); expect(point.z).toBeCloseTo(-22);
});
