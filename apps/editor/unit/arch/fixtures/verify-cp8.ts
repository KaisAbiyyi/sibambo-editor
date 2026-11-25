/**
 * SIB-MCP-MODELING-001 WP8 — cross-runtime check of the perception goldens (T-P1…T-P5) outside any test runner.
 *   bun unit/arch/fixtures/verify-cp8.ts
 *   bun build unit/arch/fixtures/verify-cp8.ts --target=node --outfile=<out>.mjs --external manifold-3d --external '@jsquash/*' && node <out>.mjs unit/arch/golden
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newDocument } from './agent-harness.js';
import { g4, g8 } from './modules.js';
import { lHouse, mixedScene } from './scenes.js';

const dir = process.argv[2] ?? join(import.meta.dirname, '..', 'golden');
const failures: string[] = [];
let checked = 0;
function golden(name: string, actual: string): void {
	checked += 1;
	if (readFileSync(join(dir, `${name}.txt`), 'utf8').replace(/\r\n/g, '\n') !== actual + '\n') failures.push(name);
}

const mixed = await mixedScene();
const { harness, container, group } = mixed;
const managed = harness.meshOf(container);
harness.context = { mode: 'authoring', path: [container], selection: [{ type: 'face', id: managed.faces[3]!.id }, { type: 'edge', start: [0, 0, 0], end: [8, 0, 0] }] };
golden('t-p1-describe-scene', await harness.text('describe_scene'));
harness.context = { mode: 'viewer', path: [], selection: [{ type: 'instance', id: group }] };
golden('t-p1-describe-scene-query', await harness.text('describe_scene', { query: 'KAMAR' }));
golden('t-p2-elements', await harness.text('describe_element', { ids: ['house/ground:front', 'house/ground:floor', 'house/ground:living', group, container, 'nope'] }));
const top = harness.meshOf(group).faces.find((f) => f.normal[1] > 0.99)!.id;
const measured: string[] = [];
for (const args of [
	{ a: { point: [10.5, 0.5, 2] }, b: { faceId: top } }, { a: { faceId: 'house/ground:floor:f7' }, b: { point: [9, 2, 1] }, moduleId: 'house/ground' },
	{ a: { spaceId: 'house/ground:living' } }, { a: { spaceId: 'bed-2' }, moduleId: 'house/ground' }, { a: { elementId: 'house/ground:part-a' }, b: { elementId: 'house/ground:win-e' } },
	{ a: { elementId: 'house/ground:part-a' }, b: { instanceId: group } }, { a: { point: [0, 0, 0] }, b: { point: [3, 4, 12] } }
])
	measured.push(await harness.text('measure', args));
golden('t-p5-measure', measured.join('\n\n'));

const t = await newDocument();
await t.addModule(g4());
golden('t-p2-t-junction', await t.text('describe_element', { ids: ['test/ground:part', 'test/ground:w1'] }));
const paged = await newDocument();
await paged.addModule(g8());
for (const detail of ['faces', 'edges']) golden(`t-p3-${detail}-page-1`, await paged.text('describe_element', { ids: ['test/ground:shell', 'test/ground:door'], detail, pageSize: 7 }));
const house = await newDocument();
await house.addModule(lHouse());
golden('t-p4-corner-box', await house.text('query_region', { moduleId: 'house/ground', box: { min: [-0.2, -0.2, 0], max: [0.2, 0.2, 1] }, include: ['elements', 'faces', 'edges'] }));

const runtime = (globalThis as any).Bun ? `bun ${(globalThis as any).Bun.version}` : `node ${process.version}`;
console.log(JSON.stringify({ runtime, checked, failures, ok: failures.length === 0 }));
process.exit(failures.length === 0 ? 0 : 1);
