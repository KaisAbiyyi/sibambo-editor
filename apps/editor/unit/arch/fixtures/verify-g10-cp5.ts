/**
 * Cross-runtime G10-CP5 baked SHA-256 enforcement (Bun vs Node & pinned digests).
 * Evaluates & bakes G1, G4, and G8 on a fresh kernel, verifies digests against
 * `golden/g10-cp5-bake-hashes.json` (or `--pins` / `G10_CP5_PINS`), and optionally
 * enforces exact equality against another runtime's JSON output (`--compare` / `G10_CP5_COMPARE`).
 * Prints one JSON line and exits 1 on any mismatch or malformed input.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { bakeModule } from '../../../src/lib/arch/bake.js';
import { evaluateModule } from '../../../src/lib/arch/evaluate.js';
import { createKernel } from '../../../src/lib/arch/kernel.js';
import { g1, g4, g8 } from './modules.js';

const REQUIRED_FIXTURES = ['G1', 'G4', 'G8'] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const runtime = (globalThis as { Bun?: { version: string } }).Bun ? `bun ${(globalThis as any).Bun.version}` : `node ${process.version}`;

type Mismatch = {
	kind: 'pin' | 'peer';
	fixture: string;
	expected: string | null;
	actual: string | null;
};

function parseFlag(flag: string): string | undefined {
	const args = process.argv.slice(2);
	const eq = args.find((a) => a.startsWith(`${flag}=`));
	if (eq) return eq.slice(flag.length + 1);
	const idx = args.indexOf(flag);
	if (idx >= 0) {
		const next = args[idx + 1];
		if (!next || next.startsWith('--')) throw new Error(`Missing value for ${flag}`);
		return next;
	}
	return undefined;
}

function defaultPinsPath(): string {
	for (const candidate of [
		'unit/arch/golden/g10-cp5-bake-hashes.json',
		'apps/editor/unit/arch/golden/g10-cp5-bake-hashes.json'
	]) {
		const abs = resolve(candidate);
		if (existsSync(abs)) return abs;
	}
	return resolve('unit/arch/golden/g10-cp5-bake-hashes.json');
}

function readDigestMap(filePath: string, label: string): { hashes: Record<string, string>; runtime?: string; ok?: boolean } {
	const parsed = JSON.parse(readFileSync(resolve(filePath), 'utf8').replace(/^\uFEFF/, '')) as {
		hashes?: Record<string, unknown>;
		actual?: Record<string, unknown>;
		runtime?: unknown;
		ok?: unknown;
	};
	const raw = parsed.hashes ?? parsed.actual;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`Invalid ${label} JSON at ${filePath}: missing hashes object`);
	}
	const hashes: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v === 'string') hashes[k] = v;
	}
	return {
		hashes,
		runtime: typeof parsed.runtime === 'string' ? parsed.runtime : undefined,
		ok: typeof parsed.ok === 'boolean' ? parsed.ok : undefined
	};
}

try {
	const pinsPath = parseFlag('--pins') ?? process.env.G10_CP5_PINS ?? defaultPinsPath();
	const comparePath = parseFlag('--compare') ?? process.env.G10_CP5_COMPARE;
	const pinned = readDigestMap(pinsPath, 'pins');
	const peer = comparePath ? readDigestMap(comparePath, 'compare') : null;

	const kernel = createKernel();
	await kernel.init();
	const actual: Record<string, string> = {};
	for (const [name, make] of [['G1', g1], ['G4', g4], ['G8', g8]] as const) {
		const doc = BomcDocument.create({ documentId: '4a2e1c9b-7d3f-4a8e-9b2c-1d4e5f6a7b8c', name });
		const g0 = structuredClone(doc.snapshot().graph);
		doc.dispose();
		const mod = make();
		actual[name] = bakeModule(g0, mod, evaluateModule(mod, kernel, { cache: false }), 1, 1).bakedMeshSha256;
	}

	const mismatches: Mismatch[] = [];
	for (const name of REQUIRED_FIXTURES) {
		const expectedPin = pinned.hashes[name] ?? null;
		const got = actual[name] ?? null;
		if (!expectedPin || !SHA256_HEX.test(expectedPin) || !got || !SHA256_HEX.test(got) || expectedPin !== got) {
			mismatches.push({ kind: 'pin', fixture: name, expected: expectedPin, actual: got });
		}
	}

	if (peer) {
		if (peer.ok === false) {
			mismatches.push({ kind: 'peer', fixture: '*', expected: 'ok:true', actual: 'ok:false' });
		}
		for (const name of REQUIRED_FIXTURES) {
			const expectedPeer = peer.hashes[name] ?? null;
			const got = actual[name] ?? null;
			if (!expectedPeer || !SHA256_HEX.test(expectedPeer) || expectedPeer !== got) {
				mismatches.push({ kind: 'peer', fixture: name, expected: expectedPeer, actual: got });
			}
		}
	}

	const ok = mismatches.length === 0;
	console.log(
		JSON.stringify({
			runtime,
			ok,
			hashes: actual,
			actual,
			...(peer ? { peerRuntime: peer.runtime ?? null, peerOk: !mismatches.some((m) => m.kind === 'peer') } : {}),
			...(mismatches.length > 0 ? { mismatches } : {})
		})
	);
	process.exit(ok ? 0 : 1);
} catch (error) {
	console.log(JSON.stringify({ runtime, ok: false, error: error instanceof Error ? error.message : String(error) }));
	process.exit(1);
}
