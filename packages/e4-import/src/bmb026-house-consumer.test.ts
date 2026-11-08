import './bmb021-browser-test-stream';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { BomcLoader } from './bomc-loader';
import { BomcContainer } from './container';
import { readWebBomc } from '../../bomc-document/src/reader';

const directory = fileURLToPath(new URL('./bmb026-fixtures/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: any): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const arrayBuffer = (raw: Uint8Array) => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.00002);
const root = 'house/level/';
const names = ['living', 'bedroom-a', 'bedroom-b', 'bath', 'roof'];
type Point = [number, number, number];
type Triangle = { points: Point[]; module: string; material: string; role: string; mesh: number; face: number; side: string };
type Runtime = Awaited<ReturnType<BomcLoader['load']>>;

function fixture(label: string) {
  const record = manifest.files[label];
  const bytes = new Uint8Array(readFileSync(join(directory, label)));
  expect(bytes.length, label + ' byte count').toBe(record.bytes);
  expect(sha(bytes), label + ' exact original artifact SHA256').toBe(record.sha256);
  return bytes;
}
function source(label: string) { return JSON.parse(new TextDecoder().decode(fixture(label + '.json'))); }
async function load(label: string) {
  return new BomcLoader().load(arrayBuffer(fixture(label + '.bomc')), label + '.bomc', { prepareSolid: false });
}
function triangles(value: Runtime): Triangle[] {
  const output: Triangle[] = [];
  for (const group of value.preparedRuntimeScene.groups) {
    const mesh = value.preparedRuntimeScene.meshes[group.sourceMeshIndex]!;
    for (let at = 0; at < group.matrices.length; at += 16) {
      const matrix = group.matrices;
      const position = (index: number): Point => {
        const [x, y, z] = mesh.positions.slice(index * 3, index * 3 + 3);
        const wx = matrix[at]! * x! + matrix[at + 4]! * y! + matrix[at + 8]! * z! + matrix[at + 12]!;
        const wy = matrix[at + 1]! * x! + matrix[at + 5]! * y! + matrix[at + 9]! * z! + matrix[at + 13]!;
        const wz = matrix[at + 2]! * x! + matrix[at + 6]! * y! + matrix[at + 10]! * z! + matrix[at + 14]!;
        return [wx, -wz, wy]; // actual runtime Y-up -> original source Z-up metres
      };
      for (let i = 0; i < group.indices.length; i += 3) output.push({
        points: [position(group.indices[i]!), position(group.indices[i + 1]!), position(group.indices[i + 2]!)],
        module: group.occurrenceDefinitionIds![at / 16]!.replace('def:', ''),
        material: group.materialName || '', role: group.key, mesh: group.sourceMeshIndex,
        face: group.sourceFaceIndicesByTriangle![i / 3]!, side: group.renderSide || 'front'
      });
    }
  }
  return output;
}
function normalized(items: Triangle[]) {
  return items.map(t => canonical({ ...t, mesh: undefined, face: undefined,
    points: t.points.map(p => p.map(c => Number(c.toFixed(5)))) })).sort();
}
function section(items: Triangle[], normal: number, plane: number, module?: string) {
  return items.filter(t => t.side !== 'back' && t.material.endsWith('/plaster') &&
    (!module || t.module === root + module) && t.points.every(p => Math.abs(p[normal]! - plane) < 0.00002));
}
function projectedArea(items: Triangle[], horizontal: number) {
  return items.reduce((sum, t) => {
    const [a, b, c] = t.points as [Point, Point, Point];
    return sum + Math.abs((b[horizontal]! - a[horizontal]!) * (c[2] - a[2]) -
      (c[horizontal]! - a[horizontal]!) * (b[2] - a[2])) / 2;
  }, 0);
}
function covered(items: Triangle[], horizontal: number, x: number, z: number) {
  return items.some(t => {
    const [a, b, c] = t.points as [Point, Point, Point];
    const cross = (p: Point, q: Point) => (q[horizontal]! - p[horizontal]!) * (z - p[2]) - (q[2] - p[2]) * (x - p[horizontal]!);
    const signs = [cross(a, b), cross(b, c), cross(c, a)];
    return signs.every(s => s >= -1e-7) || signs.every(s => s <= 1e-7);
  });
}
const models = Promise.all([load('baseline'), load('revised')]);

test('BMB-026 fixture provenance pins both original archives, Builder source and Editor base', () => {
  expect(manifest.builderSha).toBe('8fc6ebbeb1996889983bd6fff0958d1f9a7aaf00');
  expect(manifest.editorBaseSha).toBe('b5f46a761d1763241b60375cbb5f7110d62d99d2');
  expect(manifest.originalRun).toBe(42036423066);
  expect(manifest.originalArchives.ubuntu.sha256).toBe('48d843fd03abb10cc736ca213667b638692b2b1f4d99c149276e69e0d0108757');
  expect(manifest.originalArchives.windows.sha256).toBe('e862c56bcc90c66d24c513478985380f49de9c0e35e14b378eefa54e18f2949a');
  fixture('receipt.json');
  expect(manifest.files['baseline.bomc'].sha256).toBe('071ebe152b44d2bae387818094ad67a6f461645d45d1ad33c195848dbb0b49aa');
  expect(manifest.files['revised.bomc'].sha256).toBe('e56924fead241df9a1a76c9de9e0e647b13caf2785cf14bc4c679a8979192233');
});

for (const [index, label] of ['baseline', 'revised'].entries()) describe('BMB-026 original E4 ' + label, () => {
  test('actual mesh/face/triangle counters, materials, semantics, coverage and world bounds', async () => {
    const model = (await models)[index]!;
    expect(model.counts).toEqual({ materials: 9, tags: 0, meshes: 5, faces: 278, definitions: 7, instances: 7, transforms: 7, textures: 0, edges: 0 });
    expect(model.diagnostics.triangleOwnership.frontDefinitionTriangles).toBe(556);
    expect(model.diagnostics.coverage).toEqual({ eligible: 278, analytical: 278, visualRetained: 0, fallback: 0, excluded: 0, unaccounted: 0 });
    const actual = triangles(model);
    const front = actual.filter(t => t.side !== 'back');
    expect(front.length).toBe(556);
    expect(new Set(actual.map(t => t.face)).size).toBe(278);
    expect(model.faces.length).toBe(66); // analytics surfaces are filtered, never full source counts
    expect(model.faces.every(f => Boolean(f.semanticLabel || f.name))).toBe(true);
    for (const label of ['floor solid surface', 'wall solid surface', 'roof solid surface'])
      expect(model.faces.map(f => f.semanticLabel || f.name)).toContain(label);
    expect(new Set(actual.map(t => t.module))).toEqual(new Set(names.map(name => root + name)));
    expect(model.materialRows.map(m => [m.name, m.color])).toEqual(names.flatMap(name => name === 'roof'
      ? [[root + name + '/roof-solid', '#818b92']]
      : [[root + name + '/flooring', '#b9b09e'], [root + name + '/plaster', '#e9e8e2']]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
    for (const group of model.preparedRuntimeScene.groups) {
      if (group.materialIndex !== undefined) {
        expect(group.opacity).toBe(1);
        expect(group.baseColorRgba![3]).toBe(1);
      } else {
        // Builder opening inserts carry semantic roles and use the existing viewer style.
        expect(['doors', 'windows']).toContain(group.key);
        expect(group.materialName).toBeUndefined();
      }
      expect(group.indices.length % 3).toBe(0);
      expect(group.matrices.length).toBe(16);
      for (const i of group.indices) expect(i).toBeLessThan(model.preparedRuntimeScene.meshes[group.sourceMeshIndex]!.positions.length / 3);
    }
    for (const p of actual.flatMap(t => t.points)) for (const number of p) expect(Number.isFinite(number)).toBe(true);
    const points = front.flatMap(t => t.points);
    for (const [axis, min, max] of [[0, -0.075, 8.075], [1, -0.075, 6.075], [2, 0, 3]]) {
      near(Math.min(...points.map(p => p[axis!]!)), min!);
      near(Math.max(...points.map(p => p[axis!]!)), max!);
    }
    const floors = front.filter(t => t.role === 'floor' && t.points.every(p => Math.abs(p[2] - 0.15) < 0.00002));
    const horizontalArea = (items: Triangle[]) => items.reduce((sum, { points: [a, b, c] }) => sum + Math.abs(
      (b![0] - a![0]) * (c![1] - a![1]) - (c![0] - a![0]) * (b![1] - a![1])) / 2, 0);
    near(horizontalArea(floors), 48);
    const roof = front.filter(t => t.module === root + 'roof' && t.points.every(p => Math.abs(p[2] - 3) < 0.00002));
    near(horizontalArea(roof), 48);
    console.log(JSON.stringify({ gate: 'BMB026_ORIGINAL_E4', label, status: 'PASS', counts: model.counts,
      analyticalFaces: model.faces.length, frontTriangles: front.length, sourceFaces: new Set(actual.map(t => t.face)).size,
      bounds: model.bounds, coverage: model.diagnostics.coverage }));
  });
  test('source module transforms and actual occurrence matrices retain correct hierarchy and placement', async () => {
    const model = (await models)[index]!;
    const document = source(label);
    expect(document.modules.map((m: any) => m.moduleId).sort()).toEqual(names.map(name => root + name).sort());
    const hierarchy = model.preparedRuntimeScene.occurrenceHierarchy!;
    expect([...hierarchy.parentIndices]).toEqual([-1, 0, 1, 1, 1, 1, 1]);
    for (const group of model.preparedRuntimeScene.groups) {
      const moduleId = group.occurrenceDefinitionIds![0]!.replace('def:', '');
      const module = document.modules.find((m: any) => m.moduleId === moduleId);
      expect(module.parentId).toBe('house/level');
      const sourceMatrix = module.localFrame.transform;
      // Module IR is row-major; runtime Three.js matrices are column-major Y-up.
      near(group.matrices[12]!, sourceMatrix[3]);
      near(group.matrices[13]!, sourceMatrix[11]);
      near(group.matrices[14]!, -sourceMatrix[7]);
      const expected = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
      group.matrices.slice(0, 12).forEach((n, i) => near(n, expected[i]!));
    }
  });
  test('four single-owned seam surfaces retain three real cut doorways and solid fourth seam', async () => {
    const actual = triangles((await models)[index]!);
    const doc = source(label);
    const seams = doc.modules.flatMap((m: any) => m.ownedSeams);
    expect(seams.length).toBe(4);
    expect(new Set(seams.map((s: any) => s.seamId)).size).toBe(4);
    const configs = [
      { owner: 'living', normal: 0, horizontal: 1, center: 4, start: 0, length: 3, door: 1 },
      { owner: 'living', normal: 1, horizontal: 0, center: 3, start: 0, length: 4, door: 1.35 },
      { owner: 'bedroom-a', normal: 1, horizontal: 0, center: 3, start: 4, length: 4, door: 5.45 },
      { owner: 'bedroom-b', normal: 0, horizontal: 1, center: 4, start: 3, length: 3, door: null }
    ];
    for (const config of configs) for (const plane of [config.center - 0.075, config.center + 0.075]) {
      // Limit to this seam span; the collinear adjacent room wall is a different seam.
      const wall = section(actual, config.normal, plane).filter(t => t.points.every(p =>
        p[config.horizontal]! >= config.start - 0.00002 && p[config.horizontal]! <= config.start + config.length + 0.00002));
      expect(wall.length).toBeGreaterThan(0);
      expect(new Set(wall.map(t => t.module))).toEqual(new Set([root + config.owner]));
      near(projectedArea(wall, config.horizontal), config.length * 2.8 - (config.door === null ? 0 : 0.9 * 2.1));
      if (config.door !== null) for (const u of [0.1, 0.5, 0.9]) for (const v of [0.1, 0.5, 0.9])
        expect(covered(wall, config.horizontal, config.door + 0.9 * u, 2.1 * v), 'opaque wall blocks real door').toBe(false);
    }
  });
  test('actual exterior wall void width and surrounding opaque surface match the requested window', async () => {
    const actual = triangles((await models)[index]!);
    const width = index ? 1.2 : 1;
    for (const plane of [7.925, 8.075]) {
      const wall = section(actual, 0, plane, 'bedroom-a');
      near(projectedArea(wall, 1), 3 * 2.8 - width * 1.15);
      for (const u of [0.05, 0.5, 0.95]) for (const v of [0.1, 0.5, 0.9])
        expect(covered(wall, 1, 0.85 + width * u, 0.9 + 1.15 * v)).toBe(false);
      expect(covered(wall, 1, 0.84, 1.4)).toBe(true);
      expect(covered(wall, 1, 0.85 + width + 0.01, 1.4)).toBe(true);
      const openingY = wall.flatMap(t => t.points).map(p => p[1]).filter(y => y > 0.1 && y < 2.9);
      expect(openingY.some(y => Math.abs(y - 0.85) < 0.00002)).toBe(true);
      expect(openingY.some(y => Math.abs(y - (0.85 + width)) < 0.00002)).toBe(true);
    }
  });
});

test('localized source edit is only Bedroom A window width/revision; all other source and runtime geometry preserved', async () => {
  const before = source('baseline'), after = source('revised');
  const changed: string[] = [];
  for (const module of before.modules) {
    const revised = after.modules.find((m: any) => m.moduleId === module.moduleId);
    if (sha(canonical(module)) !== sha(canonical(revised))) changed.push(module.moduleId);
    const expected = structuredClone(module);
    if (module.moduleId === root + 'bedroom-a') {
      expected.revision = 2;
      expected.operations.find((op: any) => op.opId === 'exterior-window').width = 1.2;
    }
    expect(revised).toEqual(expected);
  }
  expect(changed).toEqual([root + 'bedroom-a']);
  expect(receipt.changedModules).toEqual(changed);
  const [a, b] = await models;
  expect(a!.materialRows).toEqual(b!.materialRows);
  expect(a!.preparedRuntimeScene.occurrenceHierarchy).toEqual(b!.preparedRuntimeScene.occurrenceHierarchy);
  const oldTriangles = triangles(a!), newTriangles = triangles(b!);
  for (const name of names) {
    const oldModule = normalized(oldTriangles.filter(t => t.module === root + name));
    const newModule = normalized(newTriangles.filter(t => t.module === root + name));
    if (name === 'bedroom-a') expect(newModule).not.toEqual(oldModule);
    else expect(newModule).toEqual(oldModule);
  }
  const outsideWindowWall = (t: Triangle) => t.module === root + 'bedroom-a' && t.role !== 'windows' &&
    !(t.material.endsWith('/plaster') && t.points.every(p => p[0] > 7.9249));
  expect(normalized(newTriangles.filter(outsideWindowWall))).toEqual(normalized(oldTriangles.filter(outsideWindowWall)));
  for (let i = 0; i < a!.preparedRuntimeScene.groups.length; i++) {
    const old = a!.preparedRuntimeScene.groups[i]!, revised = b!.preparedRuntimeScene.groups[i]!;
    expect(revised.matrices).toEqual(old.matrices);
    expect(revised.sourceFaceIndicesByTriangle).toEqual(old.sourceFaceIndicesByTriangle);
  }
  // This strip alone changes from opaque wall to void in the decoded front surfaces.
  expect(covered(section(oldTriangles, 0, 8.075, 'bedroom-a'), 1, 1.95, 1.4)).toBe(true);
  expect(covered(section(newTriangles, 0, 8.075, 'bedroom-a'), 1, 1.95, 1.4)).toBe(false);
});

test('viewer acceptance is distinct from strict editable section 241 and corrupt input rejects', async () => {
  for (const label of ['baseline', 'revised']) {
    const bytes = fixture(label + '.bomc');
    const container = new BomcContainer(arrayBuffer(bytes));
    expect(container.descriptor(241)).toBeUndefined();
    await expect(readWebBomc(bytes)).rejects.toThrow();
    for (const kind of ['crc', 'count', 'truncated']) {
      let bad = bytes.slice();
      const entry = container.descriptor(6)!;
      if (kind === 'crc') bad[entry.offset] ^= 1;
      if (kind === 'count') new DataView(bad.buffer).setUint32(container.header.directoryOffset + entry.index * container.header.directoryEntryBytes + 16, entry.count + 1, true);
      if (kind === 'truncated') bad = bad.slice(0, -32);
      await expect(new BomcLoader().load(arrayBuffer(bad), kind, { prepareSolid: false })).rejects.toThrow();
    }
  }
});
