// Synthetic-only interop fixture from ORIGINAL Editor writer; no private graph or owner SKP.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BomcDocument } from '../packages/bomc-document/src/document';
import { BomcWriter } from '../packages/bomc-document/src/writer';
import { readWebBomc } from '../packages/bomc-document/src/reader';
import { createColorGraph } from '../packages/bomc-document/src/test-fixtures/documents';

const outputDir = process.env.BMB021_EDITOR_EXPORT_DIR;
if (!outputDir) throw new Error('Set BMB021_EDITOR_EXPORT_DIR for bounded synthetic artifact');
const graph = createColorGraph();
const doc = BomcDocument.fromGraph(graph, 11);
const writer = new BomcWriter(doc, { compressionMode: 'store-only' });
try {
  const { bytes } = await writer.write();
  const raw = new Uint8Array(bytes);
  const reopened = await readWebBomc(raw);
  try {
    if (JSON.stringify(reopened.snapshot().graph) !== JSON.stringify(doc.snapshot().graph)) {
      throw new Error('Original writer -> strict reader semantic graph mismatch');
    }
  } finally { reopened.dispose(); }
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const file = 'editor-writer-color.bomc';
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, file), raw);
  const metadata = {
    gate: 'BMB021_EDITOR_ORIGINAL_WRITER', file, sha256, byteSize: raw.length,
    authoringSection: 241, sourceRepository: 'KaisAbiyyi/sibambo-editor',
    sourceSha: process.env.BMB021_CONSUMER_SHA || 'NOT_SET',
    expected: {
      materials: graph.materials.length, meshes: graph.meshes.length,
      faces: graph.meshes.reduce((a, m) => a + m.faces.length, 0),
      triangles: graph.meshes.reduce((a, m) => a + m.faces.reduce((n, f) => n + f.triangles.length / 3, 0), 0),
      definitions: graph.definitions.length, instances: graph.instances.length,
      faceIds: graph.meshes.flatMap(m => m.faces.map(f => f.id)),
      frontBackDistinctFaces: graph.meshes.reduce((a, m) => a + m.faces.filter(f => f.frontMaterialId && f.backMaterialId && f.frontMaterialId !== f.backMaterialId).length, 0)
    }
  };
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log('BMB021_EDITOR_MANIFEST:' + JSON.stringify(metadata));
  // Bounded synthetic bytes only, emitted in PRIVATE CI logs to bridge via a reviewed pinned fixture.
  if (process.env.BMB021_PRINT_BASE64 === '1') console.log('BMB021_EDITOR_FIXTURE_BASE64:' + Buffer.from(raw).toString('base64'));
} finally { writer.dispose(); doc.dispose(); }
