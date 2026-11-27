/**
 * Owner disposition D2 (master v2.4): the CP5 topology/face/edge goldens are MANDATORY WP5 gates and are not relaxed.
 * This guard makes that checkable in WP4: the machine-readable manifest must match the v2.3 text number for number and be
 * restated by v2.4, v2.3 must stay unmodified as history, and no gate may be marked optional. It proves nothing about CP5
 * itself; no CP5 behaviour is implemented or asserted here.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../../src/lib/arch/sha256';

const read = (url: string) => readFileSync(new URL(url, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const manifest = JSON.parse(read('./golden/cp5-required-gates.json')) as { status: string; gates: Record<string, any>[] };
const v23 = read('../../../../docs/implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.3.md');
const v24 = read('../../../../docs/implementation-plan/MASTER_IMPLEMENTATION_PLAN_2026-11-15_SIB-MCP-MODELING-001_v2.4.md');
const gate = (id: string) => manifest.gates.find((g) => g.id === id)!;

describe('v2.3 is history: unchanged', () => {
	test('the frozen master plan v2.3 is byte-identical (line endings normalised) to the copy in the SE-05 base', () => {
		expect(sha256Hex(v23)).toBe('0ec46bf4826083919e834e10773a2e9c591aac72f84028e5dd79c6603841b22e');
	});
	test('v2.4 declares itself a delta that keeps v2.3 and names the owner dispositions', () => {
		expect(v24).toMatch(/kept byte-for-byte unmodified as history/);
		for (const d of ['**D1**', '**D2**', '**D3**']) expect(v24).toContain(d);
		expect(v24).toMatch(/Supersedes\*\* v2\.3 \*\*only\*\*/);
	});
});

describe('CP5 required gates are pinned to the v2.3 text', () => {
	test('G1: 10 faces (4 exterior, 4 interior, top ring 1 face / 1 hole, bottom 1), 24 hard edges, dihedral ≥ 20°', () => {
		expect(v23).toContain('(CP5) faces **10** (4 exterior, 4 interior, top ring 1 face/1 hole, bottom 1), hard edges **24**, every edge dihedral ≥ 20°');
		expect(gate('G1-CP5')).toMatchObject({ faces: 10, exteriorFaces: 4, interiorFaces: 4, topRingFaces: 1, topRingHoles: 1, bottomFaces: 1, hardEdges: 24, minDihedralDegrees: 20 });
		const g = gate('G1-CP5');
		expect(g.exteriorFaces + g.interiorFaces + g.topRingFaces + g.bottomFaces).toBe(g.faces);
	});
	test('T-T2: the G1 top face has 8 loop vertices', () => {
		expect(v23).toContain('T-T2 G1 top face has 8 loop vertices');
		expect(gate('T-T2').topFaceLoopVertices).toBe(8);
	});
	test('G2: identical baked geometry (positions, face rings, triangles, normals, materials), ids excluded', () => {
		expect(v23).toContain('identical baked geometry (CP5): equal positions, equal face rings/triangles/normals/materials, ids excluded');
		expect(gate('G2-CP5')).toMatchObject({ bakedIdenticalTo: 'G1', idsExcluded: true });
		expect(gate('G2-CP5').compared).toEqual(['positions', 'faceRings', 'triangles', 'normals', 'materials']);
	});
	test('G3: interior faces at x=0, x=4, y=0, y=3', () => {
		expect(v23).toContain('interior faces at x=0, x=4, y=0, y=3 (CP5)');
		expect(gate('G3-CP5').interiorFacePlanes).toEqual(['x=0', 'x=4', 'y=0', 'y=3']);
	});
	test('G4: 14 faces, 36 hard edges', () => {
		expect(v23).toContain('(CP5) faces **14**, hard edges **36**');
		expect(gate('G4-CP5')).toMatchObject({ faces: 14, hardEdges: 36 });
	});
	test('G8: reveal faces per opening', () => {
		expect(v23).toContain('(CP5) `reveal:<id>` faces');
		expect(gate('G8-CP5')).toMatchObject({ revealFaceRole: 'reveal:<openingId>', openings: ['door', 'win'] });
	});
	test('every T-T* and T-B* test of v2.3 is present, once', () => {
		const ids = ['T-T1', 'T-T2', 'T-T3', 'T-T4', 'T-B1', 'T-B2', 'T-B3', 'T-B4', 'T-B5', 'T-B6'];
		for (const id of ids) {
			expect(v23).toContain(id);
			expect(manifest.gates.filter((g) => g.id === id)).toHaveLength(1);
		}
	});
});

describe('nothing is relaxed', () => {
	test('every gate is required; the manifest says NOT YET IMPLEMENTED (it is a contract, not a result); ids are unique', () => {
		expect(manifest.status).toBe('REQUIRED_NOT_YET_IMPLEMENTED');
		expect(manifest.gates.every((g) => g.required === true)).toBe(true);
		expect(new Set(manifest.gates.map((g) => g.id)).size).toBe(manifest.gates.length);
	});
	test('v2.4 A6 restates every gate id, the manifest path, and forbids editing a gate to fit the raw artifacts', () => {
		for (const id of ['G1', 'G2', 'G3', 'G4', 'G8', 'T-T2']) expect(v24).toContain(`**${id}:**`);
		expect(v24).toContain('**T-T1…T-T4, T-B1…T-B6**'); // the range stands for exactly the manifest's T-T1,T-T3,T-T4 and T-B1…T-B6 plus T-T2 above
		const ranged = manifest.gates.map((g) => g.id).filter((id) => /^T-[TB]\d$/.test(id)).sort();
		expect(ranged).toEqual(['T-B1', 'T-B2', 'T-B3', 'T-B4', 'T-B5', 'T-B6', 'T-T1', 'T-T2', 'T-T3', 'T-T4']);
		expect(v24).toContain('cp5-required-gates.json');
		expect(v24).toMatch(/are \*\*mandatory gates of WP5 and are not relaxed/);
		expect(v24).toMatch(/If a gate cannot be met, WP5 stops → REVIEW\/PLAN; it does not edit the gate/);
		expect(gate('V24-RAW-ARTIFACTS').rule).toMatch(/must not survive as faces or edges/);
	});
});
