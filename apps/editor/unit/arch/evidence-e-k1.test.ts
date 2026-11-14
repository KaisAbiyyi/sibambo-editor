/**
 * SIB-MCP-MODELING-001 v2.0 WP1 / E-K1: manifold-3d loads in Bun and exposes the
 * capabilities the Phase-1 kernel needs. Writes a receipt when
 * SIBAMBO_EK1_RECEIPT names a D: path (evidence runs only).
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import Module from 'manifold-3d';
import { runProbe } from './evidence/ek1-probe';

describe('E-K1 manifold-3d kernel evidence (Bun)', () => {
	test('API, precision access, original IDs, slicing and determinism fingerprint', async () => {
		const wasm = await Module();
		wasm.setup();
		const receipt = await runProbe(wasm);
		const out = process.env.SIBAMBO_EK1_RECEIPT;
		if (out) writeFileSync(out, JSON.stringify({ runtime: `bun ${Bun.version}`, ...receipt }, null, 2));

		for (const [name, present] of Object.entries(receipt.api)) expect({ name, present }).toEqual({ name, present: true });
		expect(receipt.vertPropertiesType).toBe('Float32Array');
		for (const item of receipt.cases) {
			expect(item.float64MatchesFloat32Order).toBe(true);
			expect(item.runOriginalIds.length).toBeGreaterThanOrEqual(2);
			expect(item.trianglesPerRun.every((n) => n > 0)).toBe(true);
		}
		const room = receipt.cases.find((c) => c.name === 'four-wall-room-with-door')!;
		// (4.15·3.15 − 3.85·2.85)·2.7 minus the door 0.9·2.1·0.15
		expect(room.volume).toBeCloseTo(5.67 - 0.9 * 2.1 * 0.15, 6);
		// slice at 1.2 m: ring area minus door gap 0.9·0.15
		expect(receipt.slice.area).toBeCloseTo(2.1 - 0.9 * 0.15, 6);
		expect(receipt.crossSection.unionArea).toBeCloseTo(3, 9);
	});
});
