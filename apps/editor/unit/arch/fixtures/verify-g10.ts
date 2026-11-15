/**
 * Runtime-independent G10 check: evaluates G1/G4/G8 on a fresh kernel and compares the export digests with the pinned
 * `golden/g10-export-hashes.json`. Run under Bun directly, or bundled for Node:
 *   bun build unit/arch/fixtures/verify-g10.ts --target=node --outfile=verify-g10.mjs --external manifold-3d && node verify-g10.mjs
 * Prints one JSON line and exits 1 on any mismatch.
 */
import { readFileSync } from 'node:fs';
import { evaluateModule } from '../../../src/lib/arch/evaluate';
import { createKernel } from '../../../src/lib/arch/kernel';
import { exportDigest } from './digest';
import { g1, g4, g8 } from './modules';

const pinsPath = process.env.G10_PINS ?? 'unit/arch/golden/g10-export-hashes.json';
const pinned = JSON.parse(readFileSync(pinsPath, 'utf8')).hashes as Record<string, string>;
const kernel = createKernel();
await kernel.init();
const actual: Record<string, string> = {};
for (const [name, make] of [['G1', g1], ['G4', g4], ['G8', g8]] as const) actual[name] = exportDigest(evaluateModule(make(), kernel, { cache: false }));
const runtime = (globalThis as { Bun?: { version: string } }).Bun ? `bun ${(globalThis as any).Bun.version}` : `node ${process.version}`;
const ok = Object.keys(pinned).every((name) => pinned[name] === actual[name]);
console.log(JSON.stringify({ runtime, ok, actual }));
process.exit(ok ? 0 : 1);
