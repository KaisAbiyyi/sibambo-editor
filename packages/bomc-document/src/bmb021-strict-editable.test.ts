import { describe, expect, test } from 'bun:test';
import { BomcDocument, BomcDocumentError } from './document';
import { readWebBomc } from './reader';
import { BomcWriter } from './writer';
import { crc32, parseDirectory } from './binary';
import { createColorGraph, createHoleGraph } from './test-fixtures/documents';
import { BomcLoader } from '../../e4-import/src/bomc-loader';

async function made() {
  const graph = createColorGraph();
  const doc = BomcDocument.fromGraph(graph, 11);
  const writer = new BomcWriter(doc, { compressionMode: 'store-only' });
  try { return { bytes: new Uint8Array((await writer.write()).bytes), graph }; }
  finally { writer.dispose(); doc.dispose(); }
}
async function reject(bytes: Uint8Array, label: string) {
  let error: unknown;
  try { await readWebBomc(bytes); } catch (caught) { error = caught; }
  expect(error, label).toBeInstanceOf(BomcDocumentError);
  expect(['INVALID_SOURCE', 'UNSUPPORTED_FEATURE', 'RESOURCE_LIMIT'],
    label + ' explicit rejection classification').toContain((error as BomcDocumentError).code);
  console.log(JSON.stringify({ gate: 'EDITOR_STRICT_EDITABLE', vector: label, status: 'REJECT',
    classification: (error as BomcDocumentError).code }));
}
describe('BMB-021 ORIGINAL Editor strict editable section 241 (separate from E4)', () => {
  test('legal Editor writer 241 survives strict round trip, geometry and E4 view', async () => {
    for (const [label, creator] of [['front-back-color', createColorGraph], ['real-hole', createHoleGraph]] as const) {
      const graph = creator();
      const doc = BomcDocument.fromGraph(graph, 11);
      const writer = new BomcWriter(doc, { compressionMode: 'store-only' });
      let restored: BomcDocument | undefined;
      try {
        const out = new Uint8Array((await writer.write()).bytes);
        expect(parseDirectory(out, 'web-core').sections.some(s => s.type === 241)).toBe(true);
        restored = await readWebBomc(out);
        expect(restored.snapshot().graph).toEqual(doc.snapshot().graph);
        const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
        const viewed = await new BomcLoader().load(buffer, label + '.bomc', { prepareSolid: false });
        expect(viewed.counts.faces).toBe(graph.meshes.reduce((a, m) => a + m.faces.length, 0));
        console.log(JSON.stringify({ gate: 'EDITOR_WRITER_STRICT_READ', vector: label, status: 'PASS',
          faces: viewed.counts.faces, triangles: viewed.diagnostics.triangleOwnership.frontDefinitionTriangles }));
      } finally { restored?.dispose(); writer.dispose(); doc.dispose(); }
    }
  });
  test('malformed/truncated/CRC-repaired authoring 241 must reject strict restoration', async () => {
    const { bytes } = await made();
    const parsed = parseDirectory(bytes, 'web-core');
    const section = parsed.sections.find(s => s.type === 241)!;
    expect(section).toBeDefined();
    const idx = parsed.sections.findIndex(s => s.type === 241);
    await reject(bytes.slice(0, Math.floor(bytes.length / 2)), 'truncated container');
    const badCRC = bytes.slice();
    badCRC[section.offset] ^= 1;
    await reject(badCRC, '241 checksum mismatch');
    const repairedCRC = badCRC.slice();
    const modified = repairedCRC.subarray(section.offset, section.offset + section.storedLength);
    const v = new DataView(repairedCRC.buffer);
    v.setUint32(32 + idx * 24 + 20, crc32(modified), true);
    await reject(repairedCRC, '241 corrupt BWEB magic with corrected CRC');
    const unknown241 = bytes.slice();
    new DataView(unknown241.buffer).setUint16(32 + idx * 24, 242, true);
    await reject(unknown241, 'missing mandatory 241 / unknown 242');
  });
  test('Builder 1.2 lacking 241 is never treated as strict editable', async () => {
    const root = process.env.BMB021_BUILDER_DIR;
    if (!root) throw new Error('BMB021_BUILDER_DIR is mandatory');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const manifest = JSON.parse(readFileSync(join(root, 'tests/interop/goldens/manifest.json'), 'utf8')) as {
      fixtures: Array<{ file: string; name: string }>;
    };
    for (const fixture of manifest.fixtures) {
      await reject(new Uint8Array(readFileSync(join(root, 'tests/interop/goldens', fixture.file))), fixture.name + ' is VIEW-ONLY');
    }
  });
});
