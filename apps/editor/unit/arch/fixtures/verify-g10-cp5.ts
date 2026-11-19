/**
 * Cross-runtime G10-CP5 baked SHA-256 check (Bun vs Node).
 * Verifies baked G1 and G8 deterministic mesh digests (G4 pending D-WP5-1 disposition).
 */
import { BomcDocument } from '@sibambo/bomc-document/document';
import { bakeModule } from '../../../src/lib/arch/bake.js';
import { evaluateModule } from '../../../src/lib/arch/evaluate.js';
import { createKernel } from '../../../src/lib/arch/kernel.js';
import { g1, g8 } from './modules.js';

const kernel = createKernel();
await kernel.init();
const hashes: Record<string, string> = {};
for (const [name, make] of [['G1', g1], ['G8', g8]] as const) {
	const doc = BomcDocument.create({ documentId: '4a2e1c9b-7d3f-4a8e-9b2c-1d4e5f6a7b8c', name });
	const g0 = structuredClone(doc.snapshot().graph);
	doc.dispose();
	const mod = make();
	hashes[name] = bakeModule(g0, mod, evaluateModule(mod, kernel, { cache: false }), 1, 1).bakedMeshSha256;
}
const runtime = (globalThis as { Bun?: { version: string } }).Bun ? `bun ${(globalThis as any).Bun.version}` : `node ${process.version}`;
console.log(JSON.stringify({ runtime, hashes }));
