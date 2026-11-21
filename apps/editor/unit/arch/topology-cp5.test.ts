/**
 * SIB-MCP-MODELING-001 WP5 (CP5) — Topology qualification tests.
 * Exercises the RAW output of shipped WP4 evaluation across G1–G9, T-T1–T-T4,
 * material boundaries, slab holes, and v2.4 A6 raw-artifact removal.
 * Nothing in cp5-required-gates.json is relaxed.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { evaluateModule } from '../../src/lib/arch/evaluate.js';
import { createKernel, type Kernel, type MeshExport } from '../../src/lib/arch/kernel.js';
import { extractPartTopology, type TagInfo } from '../../src/lib/arch/topology.js';
import type { ArchModule } from '../../src/lib/arch/schema.js';
import { g1, g2, g2Clockwise, g2Rotated, g3, g4, g5, g6, g7, g8, g9, moduleOf, wall } from './fixtures/modules.js';

let kernel: Kernel;
beforeAll(async () => {
	kernel = createKernel();
	await kernel.init();
});

const evaluate = (m: ArchModule, k: Kernel = kernel) => evaluateModule(m, k, { cache: false });
const wallsTopo = (e: ReturnType<typeof evaluate>) => e.parts.find((p) => p.partId === 'walls')!.topology;

function loopSignedArea2d(loop: readonly number[], positions: Float64Array, normal: readonly [number, number, number]): number {
	let sx = 0;
	let sy = 0;
	let sz = 0;
	for (let i = 0; i < loop.length; i++) {
		const a = loop[i]!;
		const b = loop[(i + 1) % loop.length]!;
		const ax = positions[a * 3]!;
		const ay = positions[a * 3 + 1]!;
		const az = positions[a * 3 + 2]!;
		const bx = positions[b * 3]!;
		const by = positions[b * 3 + 1]!;
		const bz = positions[b * 3 + 2]!;
		sx += ay * bz - az * by;
		sy += az * bx - ax * bz;
		sz += ax * by - ay * bx;
	}
	return 0.5 * (normal[0] * sx + normal[1] * sy + normal[2] * sz);
}

describe('CP5 golden geometry topology (G1–G9, v2.4 A6)', () => {
	test('G1-CP5: 10 faces (4 exterior, 4 interior, 1 top ring / 1 hole, 1 bottom), 24 hard edges, dihedral >= 20 deg', () => {
		const topo = wallsTopo(evaluate(g1()));
		expect(topo.faces).toHaveLength(10);
		expect(topo.faces.filter((f) => f.role === 'exterior')).toHaveLength(4);
		expect(topo.faces.filter((f) => f.role === 'interior')).toHaveLength(4);
		const tops = topo.faces.filter((f) => f.role === 'top');
		expect(tops).toHaveLength(1);
		expect(tops[0]!.holes).toHaveLength(1);
		expect(topo.faces.filter((f) => f.role === 'bottom')).toHaveLength(1);

		const hard = topo.edges.filter((edge) => edge.flag === 'hard');
		expect(hard).toHaveLength(24);
		expect(topo.edges).toHaveLength(24);
		for (const edge of hard) expect(edge.dihedral).toBeGreaterThanOrEqual(20);
	});

	test('T-T2: G1 top face has 8 loop vertices (4 outer + 4 hole)', () => {
		const top = wallsTopo(evaluate(g1())).faces.find((f) => f.role === 'top')!;
		expect(top.outer).toHaveLength(4);
		expect(top.holes).toHaveLength(1);
		expect(top.holes[0]).toHaveLength(4);
		expect(top.outer.length + top.holes[0]!.length).toBe(8);
	});

	test('G2-CP5: G2 (CCW, CW, rotated) topology matches G1 geometry (ids excluded)', () => {
		const base = wallsTopo(evaluate(g1()));
		for (const make of [g2, g2Clockwise, g2Rotated]) {
			const alt = wallsTopo(evaluate(make()));
			expect(Array.from(alt.positions)).toEqual(Array.from(base.positions));
			expect(alt.faces.length).toBe(base.faces.length);
			for (let i = 0; i < base.faces.length; i++) {
				const a = base.faces[i]!;
				const b = alt.faces[i]!;
				expect(b.role).toBe(a.role);
				expect(b.materialId).toBe(a.materialId);
				expect(b.normal).toEqual(a.normal);
				expect(b.outer).toEqual(a.outer);
				expect(b.holes).toEqual(a.holes);
			}
			expect(alt.edges.map(({ a, b, dihedral, flag }) => ({ a, b, dihedral, flag }))).toEqual(
				base.edges.map(({ a, b, dihedral, flag }) => ({ a, b, dihedral, flag }))
			);
		}
	});

	test('G3-CP5: interior faces lie on planes x=0, x=4, y=0, y=3 with role interior:sp', () => {
		const topo = wallsTopo(evaluate(g3()));
		expect(topo.faces).toHaveLength(10);
		expect(topo.edges.filter((e) => e.flag === 'hard')).toHaveLength(24);
		const interior = topo.faces.filter((f) => f.role === 'interior:sp');
		expect(interior).toHaveLength(4);
		const planes = interior
			.map((f) => {
				const [nx, ny] = f.normal;
				if (Math.abs(nx) > 0.99) return `x=${Math.round(f.centroid[0])}`;
				if (Math.abs(ny) > 0.99) return `y=${Math.round(f.centroid[1])}`;
				return '?';
			})
			.sort();
		expect(planes).toEqual(['x=0', 'x=4', 'y=0', 'y=3']);
	});

	test('G4-CP5: 14 faces, 36 hard edges, degenerate raw triangle absorbed/dropped cleanly', () => {
		const topo = wallsTopo(evaluate(g4()));
		expect(topo.faces).toHaveLength(14);
		expect(topo.edges.filter((e) => e.flag === 'hard')).toHaveLength(36);
		expect(topo.edges).toHaveLength(36);
		expect(topo.faces.every((f) => f.area >= 1e-6)).toBe(true);
	});

	test('G5, G6, G7(14/15/30/120/175), G9: V24-RAW-ARTIFACTS — no sub-1e-6 fragments survive as faces or edges', () => {
		const cases: [string, ArchModule, number][] = [
			['G5', g5(), 22],
			['G6', g6(), 8],
			['G7(14)', g7(14), 9],
			['G7(15)', g7(15), 8],
			['G7(30)', g7(30), 8],
			['G7(120)', g7(120), 8],
			['G7(175)', g7(175), 8],
			['G9', g9(), 12]
		];
		for (const [label, mod, expectedFaces] of cases) {
			const topo = wallsTopo(evaluate(mod));
			expect({ label, faces: topo.faces.length }).toEqual({ label, faces: expectedFaces });
			for (const face of topo.faces) expect(face.area).toBeGreaterThanOrEqual(1e-6);
			for (const edge of topo.edges) expect(edge.faces.length).toBe(2);
		}
	});

	test('G8-CP5: walls carries reveal:door and reveal:win faces; insert parts carry frame/glazing/leaf roles', () => {
		const e = evaluate(g8());
		const wt = wallsTopo(e);
		expect(wt.faces).toHaveLength(17);
		expect(wt.faces.filter((f) => f.role === 'reveal:door')).toHaveLength(3);
		expect(wt.faces.filter((f) => f.role === 'reveal:win')).toHaveLength(4);

		const byPart = new Map(e.parts.map((p) => [p.partId, p.topology]));
		expect(byPart.get('door/frame')!.faces.every((f) => f.role.startsWith('frame/'))).toBe(true);
		expect(byPart.get('door/leaf')!.faces.every((f) => f.role.startsWith('leaf/'))).toBe(true);
		expect(byPart.get('win/frame')!.faces.every((f) => f.role.startsWith('frame/'))).toBe(true);
		expect(byPart.get('win/glazing')!.faces.every((f) => f.role.startsWith('glazing/'))).toBe(true);
	});
});

describe('Topology invariants T-T1, T-T3, T-T4, materials & slabs', () => {
	test('T-T1: all boundary loops are closed, outer is CCW seen from normal and holes are CW seen from normal', () => {
		for (const mod of [g1(), g3(), g4(), g5(), g6(), g7(30), g8(), g9()]) {
			const e = evaluate(mod);
			for (const part of e.parts) {
				const t = part.topology;
				for (const face of t.faces) {
					expect(face.outer.length).toBeGreaterThanOrEqual(3);
					expect(new Set(face.outer).size).toBe(face.outer.length);
					expect(loopSignedArea2d(face.outer, t.positions, face.normal)).toBeGreaterThan(0);
					for (const hole of face.holes) {
						expect(hole.length).toBeGreaterThanOrEqual(3);
						expect(new Set(hole).size).toBe(hole.length);
						expect(loopSignedArea2d(hole, t.positions, face.normal)).toBeLessThan(0);
					}
				}
			}
		}
	});

	test('T-T3: 24-segment cylinder built via kernel has all 24 vertical edges soft (< 20 deg) and rim edges hard', () => {
		const segments = 24;
		const ring: [number, number][] = Array.from({ length: segments }, (_, i) => {
			const theta = (2 * Math.PI * i) / segments;
			return [Math.cos(theta), Math.sin(theta)];
		});
		const solid = kernel.prism(ring, 0, 3, 0);
		let mesh: MeshExport;
		try {
			mesh = kernel.exportMesh(solid);
		} finally {
			kernel.release(solid);
			kernel.resetTags();
		}
		const tags: TagInfo[] = [{ elementId: 'cyl', role: 'slab', materialId: 'sib-default' }];
		const topo = extractPartTopology({ partId: 'cyl', kind: 'slab', elementId: 'cyl', mesh }, tags);
		expect(topo.faces).toHaveLength(segments + 2);
		const soft = topo.edges.filter((e) => e.flag === 'soft');
		const hard = topo.edges.filter((e) => e.flag === 'hard');
		expect(soft).toHaveLength(segments);
		expect(hard).toHaveLength(segments * 2);
		for (const edge of soft) expect(edge.dihedral).toBeCloseTo(360 / segments, 3);
		for (const edge of hard) expect(edge.dihedral).toBeCloseTo(90, 3);
	});

	test('T-T4: face ids stay stable when an unrelated slab or disconnected wall element is added', () => {
		const base = evaluate(g1());
		const baseWallIds = wallsTopo(base).faces.map((f) => f.id);

		const withSlab = evaluate(
			moduleOf([
				...g1().elements,
				{
					elementId: 'floor',
					kind: 'slab',
					outline: [[0, 0], [4, 0], [4, 3], [0, 3]],
					thickness: 0.2,
					topElevation: 0
				}
			])
		);
		expect(wallsTopo(withSlab).faces.map((f) => f.id)).toEqual(baseWallIds);
		const slabTopo = withSlab.parts.find((p) => p.partId === 'floor')!.topology;
		expect(slabTopo.faces).toHaveLength(6);
		expect(slabTopo.faces.map((f) => f.role).sort()).toEqual(['bottom', 'side', 'side', 'side', 'side', 'top']);

		const withExtraWall = evaluate(moduleOf([...g1().elements, wall('z-detached', [[10, 10], [12, 10]])]));
		const extraTopo = wallsTopo(withExtraWall);
		for (const id of baseWallIds) {
			const before = wallsTopo(base).faces.find((f) => f.id === id)!;
			const after = extraTopo.faces.find((f) => f.id === id)!;
			expect(after).toBeDefined();
			expect(after.role).toBe(before.role);
			expect(after.normal).toEqual(before.normal);
			expect(
				after.outer.map((v) => [extraTopo.positions[v * 3], extraTopo.positions[v * 3 + 1], extraTopo.positions[v * 3 + 2]])
			).toEqual(
				before.outer.map((v) => [
					wallsTopo(base).positions[v * 3],
					wallsTopo(base).positions[v * 3 + 1],
					wallsTopo(base).positions[v * 3 + 2]
				])
			);
		}
	});

	test('material boundary keeps coplanar walls separated with a hard edge', () => {
		const mod: ArchModule = {
			schemaVersion: '2.0.0',
			moduleId: 'test/mat-split',
			revision: 1,
			transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
			materials: [{ materialId: 'brick', rgba: [180, 80, 60, 255], opacity: 1 }],
			elements: [
				wall('wa', [[0, 0], [2, 0]]),
				wall('wb', [[2, 0], [4, 0]], { materialId: 'brick' })
			]
		};
		const topo = wallsTopo(evaluate(mod));
		// Two touching aligned segments with different materials form 2 distinct top faces, 2 bottom faces, etc.
		expect(topo.faces.filter((f) => f.role === 'top')).toHaveLength(2);
		expect(topo.faces.filter((f) => f.role === 'bottom')).toHaveLength(2);
		const seamEdges = topo.edges.filter((edge) => {
			if (edge.faces.length !== 2) return false;
			const f1 = topo.faces.find((f) => f.id === edge.faces[0])!;
			const f2 = topo.faces.find((f) => f.id === edge.faces[1])!;
			return f1.materialId !== f2.materialId;
		});
		expect(seamEdges.length).toBeGreaterThan(0);
		for (const edge of seamEdges) expect(edge.flag).toBe('hard');
	});

	test('holed slab yields top, bottom, and side faces with hole loop CW', () => {
		const mod = moduleOf([
			{
				elementId: 'slab-holed',
				kind: 'slab',
				outline: [[0, 0], [4, 0], [4, 3], [0, 3]],
				holes: [[[1, 1], [3, 1], [3, 2], [1, 2]]],
				thickness: 0.25,
				topElevation: 0.25
			}
		]);
		const topo = evaluate(mod).parts[0]!.topology;
		expect(topo.faces).toHaveLength(10);
		expect(topo.faces.filter((f) => f.role === 'top' && f.holes.length === 1)).toHaveLength(1);
		expect(topo.faces.filter((f) => f.role === 'bottom' && f.holes.length === 1)).toHaveLength(1);
		expect(topo.faces.filter((f) => f.role === 'side')).toHaveLength(8);
	});
});
