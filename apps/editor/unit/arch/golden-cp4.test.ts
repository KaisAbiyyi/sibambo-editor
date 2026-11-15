/**
 * CP4 golden geometry (plan v2.3 §Test and Verification Contract, G1…G10; CP4 parts only).
 * CP5 parts (faces/edges/roles) and CP8 parts (WALL_GAP finding) are NOT asserted here.
 * Tolerance 1e-6 unless stated.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { evaluateModule } from '../../src/lib/arch/evaluate';
import { createKernel, meshVolume, type Kernel } from '../../src/lib/arch/kernel';
import { ArchSchemaError, type ArchModule } from '../../src/lib/arch/schema';
import { exportDigest } from './fixtures/digest';
import { g1, g2, g3, g4, g5, g6, g7, g8, g9, moduleOf, wall } from './fixtures/modules';

let kernel: Kernel;
beforeAll(async () => {
	kernel = createKernel();
	await kernel.init();
});
const evaluate = (m: ArchModule, k: Kernel = kernel) => evaluateModule(m, k, { cache: false });
const walls = (e: ReturnType<typeof evaluate>) => e.parts.find((p) => p.partId === 'walls')!;
const junctionTypes = (e: ReturnType<typeof evaluate>) => {
	const byNode = new Map<string, string>();
	for (const list of Object.values(e.junctions)) for (const j of list) byNode.set(j.at.join(','), j.type);
	const counts: Record<string, number> = {};
	for (const t of byNode.values()) counts[t] = (counts[t] ?? 0) + 1;
	return counts;
};
const hasVertex = (e: ReturnType<typeof evaluate>, x: number, y: number, z: number) => {
	const p = walls(e).mesh.positions;
	for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i]! - x) < 1e-6 && Math.abs(p[i + 1]! - y) < 1e-6 && Math.abs(p[i + 2]! - z) < 1e-6) return true;
	return false;
};

describe('G1 four centre walls (centre-line 4.0×3.0, t 0.15, h 2.7)', () => {
	test('wall part manifold, 1 component, volume 5.670000, corner (−0.075,−0.075,0) is a vertex', () => {
		const e = evaluate(g1());
		expect(walls(e).stats).toMatchObject({ status: 'NoError', components: 1 });
		expect(walls(e).stats.volume).toBeCloseTo(5.67, 6);
		expect(hasVertex(e, -0.075, -0.075, 0)).toBe(true);
		expect(e.stats.wallVolume).toBeCloseTo(5.67, 6);
		expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('G2 same as one closed wall', () => {
	test('identical exported mesh (CP4)', () => {
		const a = evaluate(g1()), b = evaluate(g2());
		expect(Array.from(walls(b).mesh.positions)).toEqual(Array.from(walls(a).mesh.positions));
		expect(Array.from(walls(b).mesh.triangles)).toEqual(Array.from(walls(a).mesh.triangles));
	});
});

describe('G3 side:"right" CCW inner path 4×3 + seed (2,1.5)', () => {
	test('space area 12.00, bounds x[−0.15,4.15] y[−0.15,3.15]', () => {
		const e = evaluate(g3());
		expect(e.spaces).toHaveLength(1);
		expect(e.spaces[0]!.area).toBeCloseTo(12, 6);
		expect(e.spaces[0]!.enclosed).toBe(true);
		expect(e.spaces[0]!.authoredEnclosed).toBe(true);
		expect(e.bounds!.min[0]).toBeCloseTo(-0.15, 6);
		expect(e.bounds!.min[1]).toBeCloseTo(-0.15, 6);
		expect(e.bounds!.max[0]).toBeCloseTo(4.15, 6);
		expect(e.bounds!.max[1]).toBeCloseTo(3.15, 6);
		expect(e.bounds!.max[2]).toBeCloseTo(2.7, 6);
		expect(walls(e).stats.volume).toBeCloseTo((4.3 * 3.3 - 12) * 2.7, 6);
	});
});

describe('G4 G1 + partition (2,0)→(2,3) + seeds (1,1.5),(3,1.5)', () => {
	test('two spaces 1.850×2.850 (5.27 m² each) and two T', () => {
		const e = evaluate(g4());
		expect(e.spaces).toHaveLength(2);
		for (const s of e.spaces) {
			expect(s.bbox!.maxX - s.bbox!.minX).toBeCloseTo(1.85, 6);
			expect(s.bbox!.maxY - s.bbox!.minY).toBeCloseTo(2.85, 6);
			expect(s.area.toFixed(2)).toBe('5.27');
		}
		expect(junctionTypes(e)).toEqual({ L: 4, T: 2 });
		expect(e.spaces.map((s) => [s.enclosed, s.authoredEnclosed])).toEqual([[true, true], [true, true]]);
		expect(walls(e).stats).toMatchObject({ status: 'NoError', components: 1 });
	});
});

describe('G5 G1 + (0,1.5)→(4,1.5) and (2,0)→(2,3) + four seeds', () => {
	test('4 enclosed spaces; one X, four T', () => {
		const e = evaluate(g5());
		expect(e.spaces).toHaveLength(4);
		expect(e.spaces.every((s) => s.enclosed && s.authoredEnclosed === true)).toBe(true);
		expect(junctionTypes(e)).toEqual({ L: 4, T: 4, X: 1 });
	});
});

describe('G6 L with t 0.15 / 0.25', () => {
	test('manifold; outer corner = analytic body-line intersection', () => {
		const e = evaluate(g6());
		expect(walls(e).stats).toMatchObject({ status: 'NoError', components: 1 });
		expect(hasVertex(e, 4.125, -0.075, 0)).toBe(true);
		expect(hasVertex(e, 4.125, -0.075, 2.7)).toBe(true);
	});
});

describe('G7 30° acute corner', () => {
	test('manifold; miter at 30°, bevel beyond the 4·t limit (≈14.4°)', () => {
		const miter = evaluate(g7(30));
		expect(walls(miter).stats).toMatchObject({ status: 'NoError', components: 1 });
		const d = 0.075 / Math.sin(Math.PI / 12);
		expect(d).toBeLessThan(4 * 0.15);
		expect(hasVertex(miter, -d * Math.cos(Math.PI / 12), -d * Math.sin(Math.PI / 12), 0)).toBe(true);
		const bevel = evaluate(g7(14));
		expect(0.075 / Math.sin(Math.PI / 26)).toBeGreaterThan(4 * 0.15);
		expect(walls(bevel).stats).toMatchObject({ status: 'NoError', components: 1 });
		const just = evaluate(g7(15));
		expect(0.075 / Math.sin(Math.PI / 24)).toBeLessThan(4 * 0.15);
		expect(walls(just).stats.status).toBe('NoError');
	});
});

describe('G8 G3 + door (1.0, 0.9×2.1) + window (2.5, 1.0×1.2, sill 0.9) on the south wall', () => {
	test('wall volume reduced by exactly w·h·t per opening; insert parts present', () => {
		const plain = walls(evaluate(g3())).stats.volume;
		const e = evaluate(g8());
		expect(plain - walls(e).stats.volume).toBeCloseTo(0.9 * 2.1 * 0.15 + 1.0 * 1.2 * 0.15, 6);
		expect(e.parts.map((p) => p.partId)).toEqual(['door/frame', 'door/leaf', 'walls', 'win/frame', 'win/glazing']);
		expect(e.tags.some((t) => t.role === 'reveal:door')).toBe(true); // reveal attribution is in the tags (faces are CP5)
		expect(e.tags.some((t) => t.role === 'reveal:win')).toBe(true);
	});
});

describe('G9 north wall shortened 0.02 at its east end (AMENDED by master v2.4, owner disposition D1-B)', () => {
	// v2.3 wrote "space enclosed:false". The owner chose D1-B: `enclosed` keeps meaning SOLID closure and
	// `authoredEnclosed` reports CENTRELINE connectivity. G9 now reads: write commits; `authoredEnclosed:false`;
	// `enclosed:true` (the 0.15 m bodies still overlap); the mesh is not altered; `WALL_GAP` is CP8.
	test('the write commits and the near miss is NOT auto-snapped', () => {
		const e = evaluate(g9());
		expect(walls(e).stats).toMatchObject({ status: 'NoError', components: 1 });
		const free = Object.values(e.junctions).flat().filter((j) => j.type === 'free-end');
		expect(free).toHaveLength(2);
		expect(free.map((j) => j.at.join(',')).sort()).toEqual(['3.98,3', '4,3']);
	});
	test('authoredEnclosed:false (centrelines end 0.02 m apart, beyond JOIN_TOL) while enclosed:true (solid closed)', () => {
		const e = evaluate(g9());
		expect(e.spaces).toHaveLength(1);
		expect(e.spaces[0]).toMatchObject({ elementId: 'sp', enclosed: true, authoredEnclosed: false });
		expect(e.spaces[0]!.area).toBeCloseTo(3.85 * 2.85, 6); // the physical room exists: 10.9725 m²
		expect(e.diagnostics).toEqual([]);
	});
	test('the 3D mesh is not falsified: the wall mesh is byte-identical with and without the space element, and identical across kernels', async () => {
		const withSpace = evaluate(g9());
		const withoutSpace = evaluate(moduleOf(g9().elements.filter((x) => x.kind !== 'space')));
		expect(exportDigest(withSpace)).toBe(exportDigest(withoutSpace));
		const other = createKernel();
		await other.init();
		expect(exportDigest(evaluate(g9(), other))).toBe(exportDigest(withSpace));
	});
	test('the fixture itself is the plan fixture', () => {
		expect((g9().elements.find((x) => x.elementId === 'w3') as any).path).toEqual([[3.98, 3], [0, 3]]);
	});
});

describe('G10 determinism (CP4 on export)', () => {
	const pinned = JSON.parse(readFileSync(new URL('./golden/g10-export-hashes.json', import.meta.url), 'utf8')).hashes as Record<string, string>;
	for (const [name, make] of [['G1', g1], ['G4', g4], ['G8', g8]] as const)
		test(`${name}: export SHA-256 identical across two fresh kernels and equal to the pinned value`, async () => {
			const k2 = createKernel();
			await k2.init();
			const a = exportDigest(evaluate(make()));
			const b = exportDigest(evaluate(make(), k2));
			expect(a).toBe(b);
			expect(a).toBe(pinned[name]!);
		});
	test('re-evaluating on the same kernel does not drift (tag reset between runs)', () => {
		const first = exportDigest(evaluate(g8()));
		for (let i = 0; i < 5; i++) expect(exportDigest(evaluate(g8()))).toBe(first);
	});
});

describe('evaluateModule contract', () => {
	test('parts are sorted by partId and meshes are consistent (indices in range, tags known)', () => {
		const e = evaluate(g8());
		const ids = e.parts.map((p) => p.partId);
		expect(ids).toEqual([...ids].sort());
		for (const p of e.parts) {
			expect(Math.max(...p.mesh.triangles)).toBeLessThan(p.mesh.positions.length / 3);
			for (const t of p.mesh.triTag) expect(e.tags[t]).toBeDefined();
			expect(meshVolume(p.mesh)).toBeCloseTo(p.stats.volume, 9);
			expect(p.stats.volume).toBeGreaterThan(0);
		}
	});
	test('LRU cache: same module → same object; changed module → new hash; 32 entries max', () => {
		const k = createKernel();
		return k.init().then(() => {
			const a = evaluateModule(g1(), k), b = evaluateModule(g1(), k);
			expect(b).toBe(a);
			const changed = g1();
			(changed.elements[0] as any).thickness = 0.2;
			expect(evaluateModule(changed, k).hash).not.toBe(a.hash);
			for (let i = 0; i < 40; i++) {
				const m = g1();
				m.revision = 100 + i; // revision is part of the canonical JSON ⇒ part of the key
				evaluateModule(m, k);
			}
			expect(evaluateModule(g1(), k)).not.toBe(a); // evicted
			expect(k.liveCount()).toBe(0);
		});
	});
	test('schema errors surface as ArchSchemaError before any kernel work; an empty module evaluates to nothing', () => {
		const bad = g1();
		(bad.elements[0] as any).thickness = 5;
		expect(() => evaluate(bad)).toThrow(ArchSchemaError);
		const empty = evaluate(moduleOf([]));
		expect(empty.parts).toEqual([]);
		expect(empty.bounds).toBeNull();
		const lone = evaluate(moduleOf([wall('w', [[0, 0], [1, 0]])]));
		expect(lone.stats).toMatchObject({ segments: 1, nodes: 2, parts: 1 });
	});
	test('INVALID_GEOMETRY carries moduleId and elementId for the tool layer', () => {
		try {
			evaluate(moduleOf([wall('w', [[0, 0], [0.0005, 0], [3, 0]])], 'house/first'));
			throw new Error('expected failure');
		} catch (error) {
			expect((error as any).code).toBe('INVALID_GEOMETRY');
			expect((error as any).detail).toMatchObject({ moduleId: 'house/first', elementId: 'w', reason: 'WALL_DUPLICATE_POINT' });
		}
	});
});
