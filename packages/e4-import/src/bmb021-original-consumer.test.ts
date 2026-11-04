import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { BomcLoader } from './bomc-loader';
import { BomcContainer } from './container';

const root = process.env.BMB021_BUILDER_DIR;
if (!root) throw new Error('BMB021_BUILDER_DIR is required: test must run against pinned public Builder checkout');
const fixtureDir = join(root, 'tests/interop/goldens');
const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8')) as {
  fixtures: Array<{
    file: string; name: string; sha256: string; byteSize: number;
    reader: {
      bounds: number[]; counts: Record<string, number>; coverage: number[];
      triangles: number; faceLabels: string[]; frontBackDistinctFaces: number;
      materialColors: number[][]; materialOpacity: number[]; nodes: string[];
    };
  }>;
};
const EXPECTED_NAMES = [
  'concave-l-floor', 'floor-front-back', 'minimal-root',
  'mirrored-sheared-floors', 'nested-shared-definitions',
  'two-room-door-seam', 'wall-window-cutout'
];
const coverageKeys = ['eligible', 'analytical', 'visualRetained', 'fallback', 'excluded', 'unaccounted'] as const;
const asBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
function golden(file: (typeof manifest.fixtures)[number]) {
  const bytes = new Uint8Array(readFileSync(join(fixtureDir, file.file)));
  expect(bytes.byteLength, file.name + ' byteSize').toBe(file.byteSize);
  expect(createHash('sha256').update(bytes).digest('hex'), file.name + ' binary SHA256').toBe(file.sha256);
  return bytes;
}
function near(actual: number, target: number, label: string) {
  expect(Number.isFinite(actual), label + ' finite').toBe(true);
  expect(Math.abs(actual - target), label).toBeLessThan(0.0005);
}
async function load(bytes: Uint8Array, source: string) {
  return new BomcLoader().load(asBuffer(bytes), source, { prepareSolid: false });
}
function isRejected(promise: Promise<unknown>, label: string) {
  return expect(promise, label).rejects.toThrow();
}
function mutation(bytes: Uint8Array, edit: (copy: Uint8Array, view: DataView, container: BomcContainer) => void) {
  const copy = bytes.slice();
  edit(copy, new DataView(copy.buffer), new BomcContainer(asBuffer(bytes)));
  return copy;
}
function sectionLocation(container: BomcContainer, type: number) {
  const entry = container.descriptor(type);
  if (!entry) throw new Error('Missing source section ' + type);
  return { entry, directory: container.header.directoryOffset + entry.index * container.header.directoryEntryBytes };
}
describe('BMB-021 pinned Builder -> ORIGINAL Editor E4 loader (not editable)', () => {
  test('all seven names pinned; no silent missing or additional fixture', () => {
    expect(manifest.fixtures.map(f => f.name).sort()).toEqual([...EXPECTED_NAMES].sort());
  });
  for (const f of manifest.fixtures) {
    test(f.name + ' real E4 semantic decode', async () => {
      const input = golden(f);
      const value = await load(input, f.file);
      expect(value.version).toBe('1.2');
      for (const [field, count] of Object.entries(f.reader.counts)) {
        expect(value.counts[field as keyof typeof value.counts], f.name + ' ' + field).toBe(count);
      }
      expect(value.diagnostics.triangleOwnership.frontDefinitionTriangles, f.name + ' definition triangles').toBe(f.reader.triangles);
      expect(value.diagnostics.triangleOwnership.explicitBackMaterialFaces, f.name + ' back material identity').toBe(f.reader.frontBackDistinctFaces);
      for (let i = 0; i < 6; i++) {
        expect(value.diagnostics.coverage[coverageKeys[i]!], f.name + ' coverage ' + coverageKeys[i]).toBe(f.reader.coverage[i]);
      }
      expect(value.diagnostics.occurrences.hierarchyNodeCount, f.name + ' hierarchy nodes').toBe(f.reader.nodes.length);
      expect(value.faces.length, f.name + ' decoded render surfaces').toBe(f.reader.counts.faces);
      expect(value.faces.map(face => face.semanticLabel || face.name).sort(), f.name + ' face semantics')
        .toEqual([...f.reader.faceLabels].sort());
      expect(value.materialRows.length).toBe(f.reader.materialColors.length);
      f.reader.materialColors.forEach((rgba, i) => {
        const color = '#' + rgba.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
        expect(value.materialRows[i]!.color.toLowerCase(), f.name + ' material ' + i).toBe(color);
      });
      const groups = value.preparedRuntimeScene.groups;
      for (const group of groups) {
        const mesh = value.preparedRuntimeScene.meshes[group.sourceMeshIndex]!;
        expect(mesh, f.name + ' runtime mesh').toBeDefined();
        for (const index of group.indices) expect(index, f.name + ' local triangle index').toBeLessThan(mesh.positions.length / 3);
        expect(group.indices.length % 3).toBe(0);
        expect(group.matrices.length % 16).toBe(0);
        for (const coord of mesh.positions) expect(Number.isFinite(coord)).toBe(true);
        for (const coord of group.matrices) expect(Number.isFinite(coord)).toBe(true);
        if (group.materialIndex !== undefined && group.baseColorRgba) {
          const color = f.reader.materialColors[group.materialIndex]!;
          for (let c = 0; c < 4; c++) near(group.baseColorRgba[c]!, color[c]! / 255, f.name + ' RGBA ' + c);
          near(group.opacity!, f.reader.materialOpacity[group.materialIndex]! / 65535, f.name + ' opacity');
        }
      }
      if (f.reader.frontBackDistinctFaces) {
        expect(groups.some(g => g.renderSide === 'front')).toBe(true);
        expect(groups.some(g => g.renderSide === 'back')).toBe(true);
      }
      // Runtime uses Three.js Y-up: source (x,y,z) -> (x,z,-y). These are WORLD bounds.
      if (f.reader.counts.meshes) {
        const [minX, minY, minZ, maxX, maxY, maxZ] = f.reader.bounds;
        for (const [coord, expected] of [
          [value.bounds.min.x, minX], [value.bounds.min.y, minZ], [value.bounds.min.z, -maxY],
          [value.bounds.max.x, maxX], [value.bounds.max.y, maxZ], [value.bounds.max.z, -minY]
        ]) near(coord!, expected!, f.name + ' world bound');
      }
      if (f.name === 'mirrored-sheared-floors') {
        // A mirrored source occurrence must survive as a negative-determinant runtime matrix.
        expect(groups.some(g => {
          const m = g.matrices;
          for (let i = 0; i < m.length; i += 16) {
            const a = m[i]!, b = m[i + 1]!, c = m[i + 2]!;
            const d = m[i + 4]!, e = m[i + 5]!, ff = m[i + 6]!;
            const h = m[i + 8]!, j = m[i + 9]!, k = m[i + 10]!;
            if (a * (e * k - ff * j) - d * (b * k - c * j) + h * (b * ff - c * e) < -0.1) return true;
          }
          return false;
        })).toBe(true);
      }
      console.log(JSON.stringify({ gate: 'ORIGINAL_EDITOR_E4', result: 'PASS', name: f.name, sha256: f.sha256,
        counts: value.counts, triangles: value.diagnostics.triangleOwnership.frontDefinitionTriangles,
        coverage: value.diagnostics.coverage, worldBounds: value.bounds }));
    });
  }
});
describe('BMB-021 hostile input at ORIGINAL Editor E4 loader', () => {
  const f = manifest.fixtures.find(f => f.name === 'floor-front-back')!;
  const source = golden(f);
  test('version, endian, CRC, directory overlap, truncation and unsupported codec reject', async () => {
    const invalid: Array<[string, Uint8Array]> = [];
    invalid.push(['major', mutation(source, (b, v) => v.setUint16(8, 2, true))]);
    invalid.push(['minor', mutation(source, (b, v) => v.setUint16(10, 99, true))]);
    invalid.push(['endian', mutation(source, (b, v) => v.setUint32(12, 0, true))]);
    invalid.push(['CRC', mutation(source, (b, v, c) => { const s = sectionLocation(c, 6).entry; b[s.offset] ^= 1; })]);
    invalid.push(['directory count', mutation(source, (b, v, c) => { const s = sectionLocation(c, 6); v.setUint32(s.directory + 16, s.entry.count + 1, true); })]);
    invalid.push(['unsupported codec', mutation(source, (b, v, c) => { const s = sectionLocation(c, 6); b[s.directory + 2] = 3; })]);
    invalid.push(['stored length outside', mutation(source, (b, v, c) => { const s = sectionLocation(c, 6); v.setUint32(s.directory + 8, 0xffffffff, true); })]);
    invalid.push(['directory overlap', mutation(source, (b, v, c) => {
      const first = c.descriptor(1)!;
      const second = sectionLocation(c, 2);
      v.setUint32(second.directory + 4, first.offset, true);
    })]);
    for (const cut of [0, 7, 31, 32, Math.floor(source.length / 2), source.length - 16]) invalid.push(['truncated-' + cut, source.slice(0, cut)]);
    for (const [kind, bad] of invalid) {
      await isRejected(load(bad, kind + '.bomc'), kind);
      console.log(JSON.stringify({ gate: 'EDITOR_E4_NEGATIVE', vector: kind, outcome: 'REJECT' }));
    }
  });
  test('unknown optional section and malformed 241: E4 viewer observes but does not edit/interpret', async () => {
    const unknown = mutation(source, (b, v, c) => { const s = sectionLocation(c, 20); v.setUint16(s.directory, 250, true); });
    const malformed241 = mutation(source, (b, v, c) => { const s = sectionLocation(c, 20); v.setUint16(s.directory, 241, true); });
    for (const [kind, data] of [['unknown optional 250', unknown], ['malformed authoring 241', malformed241]] as const) {
      const viewed = await load(data, kind);
      expect(viewed.counts.faces).toBe(f.reader.counts.faces);
      console.log(JSON.stringify({ gate: 'EDITOR_E4_POLICY', vector: kind, outcome: 'IGNORED_UNKNOWN_SECTION_IN_VIEWER' }));
    }
  });
  test('unknown header flag is tolerated by original E4 container (observed behavior)', async () => {
    const flags = mutation(source, (b, v) => v.setUint32(16, v.getUint32(16, true) | 0x80000000, true));
    expect((await load(flags, 'header-flags.bomc')).counts.faces).toBe(f.reader.counts.faces);
    console.log('EDITOR_E4_POLICY unknown header bit: ACCEPTED (not a strict-Builder profile assertion)');
  });
});
