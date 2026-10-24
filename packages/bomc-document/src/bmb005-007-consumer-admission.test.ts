import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BomcDocument, BomcDocumentError } from './document.js';
import { BomcWriter } from './writer.js';
import { parseDirectory } from './binary.js';
import { readWebBomc } from './reader.js';
import { BomcLoader } from '../../e4-import/src/bomc-loader.js';
import { createColorGraph, createHoleGraph, createNestedGraph } from './test-fixtures/documents.js';

// This lives in the PRIVATE Editor repository. No private implementation is
// copied into the public Builder repository. BMB-007 inputs are pinned to
// a public Builder commit in the CI workflow below.
describe('BMB-005/007 original Editor consumer admission', () => {
  test('semantic Editor output survives strict editable readback and E4 viewer', async () => {
    for (const [name, make] of [
      ['hole', createHoleGraph], ['nested', createNestedGraph], ['two-sided-material', createColorGraph]
    ] as const) {
      const graph = make();
      const doc = BomcDocument.fromGraph(graph, 7);
      const writer = new BomcWriter(doc, { compressionMode: 'store-only' });
      let restored: BomcDocument | undefined;
      try {
        const bytes = (await writer.write()).bytes;
        const parsed = parseDirectory(bytes, 'web-core');
        expect(parsed.header.major).toBe(1);
        expect(parsed.header.minor).toBe(2);
        expect(parsed.sections.some(row => row.type === 241)).toBe(true);
        restored = await readWebBomc(bytes);
        expect(restored.snapshot().graph).toEqual(doc.snapshot().graph);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const viewed = await new BomcLoader().load(buffer, name + '.bomc', { prepareSolid: false });
        expect(viewed.version).toBe('1.2');
        expect(viewed.counts.faces).toBe(graph.meshes.reduce((sum, m) => sum + m.faces.length, 0));
      } finally {
        restored?.dispose(); writer.dispose(); doc.dispose();
      }
    }
  });

  test('all six BMB-007 generated containers parse structurally but fail strict authoring admission', async () => {
    const directory = process.env.BMB_FIXTURE_DIR;
    if (!directory) throw new Error('BMB_FIXTURE_DIR required: CI must generate pinned upstream fixtures');
    const names = readdirSync(directory).filter(name => /^container-.*\.bomc$/.test(name)).sort();
    expect(names).toHaveLength(6);
    for (const name of names) {
      const bytes = new Uint8Array(readFileSync(join(directory, name)));
      const parsed = parseDirectory(bytes, 'source-envelope');
      expect(parsed.header.major).toBe(1);
      expect(parsed.header.minor).toBe(2);
      expect(parsed.sections.some(row => row.type === 241)).toBe(false);
      let rejection: unknown;
      try { await readWebBomc(bytes); }
      catch (error) { rejection = error; }
      expect(rejection, name).toBeInstanceOf(BomcDocumentError);
      expect((rejection as BomcDocumentError).code, name).toBe('INVALID_SOURCE');
    }
  });
});
