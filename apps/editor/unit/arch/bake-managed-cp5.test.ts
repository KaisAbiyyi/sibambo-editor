/**
 * SIB-MCP-MODELING-001 WP5 (CP5) — Bake, Managed Groups, and Determinism tests.
 * Covers G2-CP5 (baked comparison), G10-CP5 (baked determinism for G1/G4/G8), T-B1–T-B6,
 * D-WP5-1 Option A multi-hole triangulation & fail-closed admission regressions,
 * container transforms (B1), owner undo/redo/save preservation, and budget/ring guards.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { LineSegments } from 'three';
import { DEFAULT_DISPLAY_STATE } from '@sibambo/viewport';
import type { BomcGraph } from '@sibambo/bomc-document';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { BomcWriter } from '@sibambo/bomc-document/writer';
import { bakeModule } from '../../src/lib/arch/bake.js';
import { fromInstanceMatrix } from '../../src/lib/arch/convention.js';
import { evaluateModule } from '../../src/lib/arch/evaluate.js';
import { createKernel, type Kernel } from '../../src/lib/arch/kernel.js';
import { effectiveModuleTransform, readManaged } from '../../src/lib/arch/managed.js';
import type { ArchModule } from '../../src/lib/arch/schema.js';
import { AuthoringWorkerDispatcher } from '../../src/lib/authoring/bomc-authoring.worker.js';
import { faceFromRing, journalEntry, triangulateFaceRings, v2FaceLabel } from '../../src/lib/authoring/geometry.js';
import { AuthoringHistory, graphsEqual } from '../../src/lib/authoring/history.js';
import { buildModelEdit, modelMetadata, nextModelSequence, validateAuthoringDocument } from '../../src/lib/authoring/model.js';
import { AUTHORING_PROTOCOL_VERSION, type AuthoringWorkerMessage, type ModelAction } from '../../src/lib/authoring/protocol.js';
import { projectAuthoringScene } from '../../src/lib/authoring/scene.js';
import { g1, g2, g2Clockwise, g2Rotated, g3, g4, g5, g6, g7, g8, g9, moduleOf } from './fixtures/modules.js';

const DOC = '4a2e1c9b-7d3f-4a8e-9b2c-1d4e5f6a7b8c';
let kernel: Kernel;

beforeAll(async () => {
	kernel = createKernel();
	await kernel.init();
});

const evaluate = (m: ArchModule, k: Kernel = kernel) => evaluateModule(m, k, { cache: false });

function newGraph(): BomcGraph {
	const doc = BomcDocument.create({ documentId: DOC, name: 'CP5-Test' });
	try {
		return structuredClone(doc.snapshot().graph);
	} finally {
		doc.dispose();
	}
}

function applyEdits(graph: BomcGraph, edits: readonly any[]): BomcGraph {
	const doc = BomcDocument.fromGraph(graph);
	try {
		doc.transact(edits);
		return structuredClone(doc.snapshot().graph);
	} finally {
		doc.dispose();
	}
}

function bakeInto(graph: BomcGraph, mod: ArchModule, S = 1, counter = 1, k: Kernel = kernel) {
	const evaluated = evaluate(mod, k);
	const baked = bakeModule(graph, mod, evaluated, S, counter);
	const nextGraph = applyEdits(graph, baked.forward);
	return { baked, nextGraph };
}

class WorkerHarness {
	private messages: AuthoringWorkerMessage[] = [];
	private nextId = 1;
	readonly dispatcher = new AuthoringWorkerDispatcher(
		(message) => this.messages.push(message),
		() => crypto.randomUUID()
	);
	constructor(private readonly session = crypto.randomUUID()) {}

	async send(type: string, extra: Record<string, unknown> = {}): Promise<any> {
		const requestId = this.nextId++;
		this.dispatcher.receive({ protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: this.session, requestId, type, ...extra });
		for (let i = 0; i < 500; i++) {
			const reply = this.messages.find((m) => (m.event === 'RESULT' || m.event === 'ERROR') && (m as any).requestId === requestId);
			if (reply) {
				if (reply.event === 'ERROR') throw new Error(`${type} failed: ${JSON.stringify((reply as any).error)}`);
				return (reply as any).result;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`${type} timed out`);
	}
}

async function storeOnlyBytes(graph: BomcGraph): Promise<ArrayBuffer> {
	const doc = BomcDocument.fromGraph(graph);
	try {
		const bytes = new Uint8Array((await new BomcWriter(doc, { compressionMode: 'store-only' }).write()).bytes);
		return bytes.slice().buffer;
	} finally {
		doc.dispose();
	}
}

describe('Bake & Managed Modules (WP5 / CP5)', () => {
	test('T-B1: create (G1), re-bake (G4 then G8, keeping instance/definition/mesh IDs), and remove forward -> inverse restores exact graphsEqual', () => {
		const g0 = newGraph();
		const m1 = g1();
		const createRes = bakeModule(g0, m1, evaluate(m1), 1, 1);
		const gAfterCreate = applyEdits(g0, createRes.forward);
		expect(graphsEqual(applyEdits(gAfterCreate, createRes.inverse), g0)).toBe(true);

		const managed1 = readManaged(gAfterCreate).get(m1.moduleId)!;
		expect(managed1.state).toBe('ok');
		expect(managed1.instance!.id).toBe(`${DOC}:instance:op:1:1`);
		expect(managed1.entry.module.revision).toBe(1);

		// Re-bake as G4 (partition with 2 aligned holes) at S=2: keeps instance/definition/mesh IDs and container label
		const m2 = g4();
		const update1Res = bakeModule(gAfterCreate, m2, evaluate(m2), 2, 1);
		const gAfterUpdate1 = applyEdits(gAfterCreate, update1Res.forward);
		expect(graphsEqual(applyEdits(gAfterUpdate1, update1Res.inverse), gAfterCreate)).toBe(true);

		const managed2 = readManaged(gAfterUpdate1).get(m2.moduleId)!;
		expect(managed2.state).toBe('ok');
		expect(managed2.instance!.id).toBe(managed1.instance!.id);
		expect(managed2.instance!.definitionId).toBe(managed1.instance!.definitionId);
		expect(managed2.instance!.label).toBe(managed1.instance!.label);
		expect(managed2.entry.module.revision).toBe(2);

		const def1 = gAfterCreate.definitions.find((d) => d.id === managed1.instance!.definitionId)!;
		const def2 = gAfterUpdate1.definitions.find((d) => d.id === managed2.instance!.definitionId)!;
		expect(def2.meshId).toBe(def1.meshId);
		const mesh2 = gAfterUpdate1.meshes.find((m) => m.id === def2.meshId)!;
		expect(mesh2.faces).toHaveLength(14);
		expect(mesh2.faces.every((f) => f.id.startsWith(`${DOC}:op:2:arch-face:`))).toBe(true);

		// Re-bake as G8 (doors/windows + multiple parts/materials) at S=3
		const m3 = g8();
		const update2Res = bakeModule(gAfterUpdate1, m3, evaluate(m3), 3, 1);
		const gAfterUpdate2 = applyEdits(gAfterUpdate1, update2Res.forward);
		expect(graphsEqual(applyEdits(gAfterUpdate2, update2Res.inverse), gAfterUpdate1)).toBe(true);
		const managed3 = readManaged(gAfterUpdate2).get(m3.moduleId)!;
		expect(managed3.entry.module.revision).toBe(3);
		expect(gAfterUpdate2.meshes.find((m) => m.id === def2.meshId)!.faces).toHaveLength(49);

		// Remove attached module: forward -> inverse restores exact graph
		const removeRes = bakeModule(gAfterUpdate2, m3, null, 4, 1);
		const gAfterRemove = applyEdits(gAfterUpdate2, removeRes.forward);
		expect(readManaged(gAfterRemove).size).toBe(0);
		expect(gAfterRemove.instances).toHaveLength(1);
		expect(gAfterRemove.definitions).toHaveLength(1);
		expect(gAfterRemove.meshes).toHaveLength(0);
		expect(graphsEqual(applyEdits(gAfterRemove, removeRes.inverse), gAfterUpdate2)).toBe(true);
	});

	test('G2-CP5: baked G2 (CCW, CW, rotated) matches baked G1 (positions, faceRings, triangles, normals, materials), ids excluded', () => {
		const { nextGraph: g1Graph } = bakeInto(newGraph(), g1(), 1, 1);
		const m1 = g1Graph.meshes[0]!;
		for (const make of [g2, g2Clockwise, g2Rotated]) {
			const { nextGraph: altGraph } = bakeInto(newGraph(), make(), 1, 1);
			const mAlt = altGraph.meshes[0]!;
			expect(mAlt.positions).toEqual(m1.positions);
			expect(mAlt.faces.length).toBe(m1.faces.length);
			for (let i = 0; i < m1.faces.length; i++) {
				const a = m1.faces[i]!;
				const b = mAlt.faces[i]!;
				expect(b.outer).toEqual(a.outer);
				expect(b.holes).toEqual(a.holes);
				expect(b.triangles).toEqual(a.triangles);
				expect(b.normal).toEqual(a.normal);
				expect(b.frontMaterialId).toBe(a.frontMaterialId);
				expect(b.backMaterialId).toBe(a.backMaterialId);
			}
		}
	});

	test('T-B2: every baked G1–G9 document passes validateAuthoringDocument and BomcWriter', async () => {
		for (const [name, mod] of [
			['G1', g1()],
			['G2', g2()],
			['G3', g3()],
			['G4', g4()],
			['G5', g5()],
			['G6', g6()],
			['G7(14)', g7(14)],
			['G7(15)', g7(15)],
			['G7(30)', g7(30)],
			['G8', g8()],
			['G9', g9()]
		] as const) {
			const { nextGraph } = bakeInto(newGraph(), mod, 1, 1);
			const valid = validateAuthoringDocument(nextGraph);
			expect({ name, editable: valid.editable, reason: valid.editable ? undefined : valid.reason }).toEqual({
				name,
				editable: true,
				reason: undefined
			});
			const bytes = await storeOnlyBytes(nextGraph);
			expect(bytes.byteLength).toBeGreaterThan(0);
		}
	});

	test('D-WP5-1 Option A regression: G4/G5 multi-hole Earcut triangulation, scene projection, and malformed-face fail-closed checks', () => {
		// G4 (2 aligned room holes) & G5 (4 aligned room holes)
		for (const [name, mod, expectedTris, expectedEdges] of [
			['G4', g4(), 12, 36],
			['G5', g5(), 22, 60]
		] as const) {
			const { nextGraph } = bakeInto(newGraph(), mod, 1, 1);
			const mesh = nextGraph.meshes[0]!;
			const holedFaces = mesh.faces.filter((f) => f.holes.length > 0);
			expect(holedFaces).toHaveLength(2);
			for (const f of holedFaces) {
				expect(f.triangles.length / 3).toBe(expectedTris);
				expect(f.triangles).toEqual(triangulateFaceRings(mesh, f.outer, f.holes, f.normal as [number, number, number]));
			}
			const doc = BomcDocument.fromGraph(nextGraph);
			try {
				const projection = projectAuthoringScene(doc.snapshot(), DEFAULT_DISPLAY_STATE);
				const lineGroups: LineSegments[] = [];
				projection.group.traverse((obj) => {
					if (obj instanceof LineSegments && obj.name === 'editor-authoring-source-edges') lineGroups.push(obj);
				});
				expect(lineGroups).toHaveLength(1);
				expect(lineGroups[0]!.geometry.getAttribute('position').count).toBe(expectedEdges * 2);
			} finally {
				doc.dispose();
			}
			expect(validateAuthoringDocument(nextGraph).editable).toBe(true);
			expect(readManaged(nextGraph).get(mod.moduleId)!.state).toBe('ok');
		}

		// Multi-hole slab (2 aligned holes)
		const multiHoleSlab = moduleOf([
			{
				elementId: 'slab-2h',
				kind: 'slab',
				outline: [[0, 0], [6, 0], [6, 3], [0, 3]],
				holes: [
					[[0.5, 0.5], [2.5, 0.5], [2.5, 2.5], [0.5, 2.5]],
					[[3.5, 0.5], [5.5, 0.5], [5.5, 2.5], [3.5, 2.5]]
				],
				thickness: 0.2,
				topElevation: 0.2
			}
		]);
		const { nextGraph: slabGraph } = bakeInto(newGraph(), multiHoleSlab, 1, 1);
		expect(validateAuthoringDocument(slabGraph).editable).toBe(true);

		// Malformed faces must fail closed under Option A
		const { nextGraph: g4Base } = bakeInto(newGraph(), g4(), 1, 1);
		const mutateFace = (mutate: (face: any, mesh: any) => void) => {
			const cloned = structuredClone(g4Base);
			const mesh = cloned.meshes[0]!;
			const holedIdx = mesh.faces.findIndex((f) => f.holes.length > 0);
			mutate(mesh.faces[holedIdx]!, mesh);
			return validateAuthoringDocument(cloned);
		};

		// 1. Empty triangles on holed face -> rejected
		expect(mutateFace((f) => { f.triangles = []; })).toMatchObject({ editable: false });
		// 2. Non-multiple of 3 on holed face -> rejected
		expect(mutateFace((f) => { f.triangles = f.triangles.slice(0, 5); })).toMatchObject({ editable: false });
		// 3. Exceeds (V + 2H - 2) * 3 upper bound -> rejected
		expect(mutateFace((f) => { f.triangles = [...f.triangles, f.outer[0], f.outer[1], f.outer[2], f.outer[0], f.outer[1], f.outer[2], f.outer[0], f.outer[1], f.outer[2]]; })).toMatchObject({ editable: false });
		// 4. Same length (12 tris) but non-canonical vertex order -> rejected by sameTuple(face.triangles, triangulateFaceRings)
		expect(mutateFace((f) => { const t = [...f.triangles]; [t[1], t[2]] = [t[2]!, t[1]!]; f.triangles = t; })).toMatchObject({ editable: false });
		// 5. References vertex outside ringVertices -> rejected
		expect(mutateFace((f, m) => { const outside = m.faces.find((x: any) => !f.outer.includes(x.outer[0]) && !f.holes.flat().includes(x.outer[0]))!.outer[0]; f.triangles[0] = outside; })).toMatchObject({ editable: false });

		// 6. Backward compatibility: hole-free face still enforces exact (V - 2) * 3
		const { nextGraph: g6Base } = bakeInto(newGraph(), g6(), 1, 1);
		const g6Mut = structuredClone(g6Base);
		const plainFace = g6Mut.meshes[0]!.faces.find((f) => f.holes.length === 0 && f.outer.length >= 4)!;
		plainFace.triangles = plainFace.triangles.slice(0, 3);
		expect(validateAuthoringDocument(g6Mut)).toMatchObject({ editable: false });
	});

	test('T-B3: owner push-pull inside managed container sets state to detached while keeping document editable; container move stays ok', () => {
		const { baked, nextGraph } = bakeInto(newGraph(), g3(), 1, 1);
		const doc = BomcDocument.fromGraph(nextGraph);
		const history = new AuthoringHistory(null);
		try {
			const run = (action: ModelAction, path: string[] = []) => {
				const curr = doc.snapshot().graph;
				history.execute(doc, journalEntry(buildModelEdit(curr, path, action, nextModelSequence(curr))));
				return doc.snapshot().graph;
			};

			// Move container instance by [2, 1, 0] in Three.js Y-up -> module Z-up [2, 0, 1]
			const moved = run({
				type: 'transform',
				selection: [{ type: 'instance', id: baked.instanceId }],
				delta: [2, 1, 0],
				copy: false,
				count: 1,
				spacing: 'multiply',
				radial: null
			});
			const movedRecord = readManaged(moved).get('test/ground')!;
			expect(movedRecord.state).toBe('ok');
			expect(validateAuthoringDocument(moved).editable).toBe(true);
			const effective = effectiveModuleTransform(movedRecord);
			expect(effective[3]).toBeCloseTo(2, 9);
			expect(effective[7]).toBeCloseTo(0, 9);
			expect(effective[11]).toBeCloseTo(1, 9);

			// Re-bake syncs module.transform from instance.matrix and keeps state 'ok'
			const rebake = bakeModule(moved, g3(), evaluate(g3()), nextModelSequence(moved), 1);
			const reBakedGraph = applyEdits(moved, rebake.forward);
			expect(readManaged(reBakedGraph).get('test/ground')!.state).toBe('ok');
			expect(readManaged(reBakedGraph).get('test/ground')!.entry.module.transform).toEqual(
				fromInstanceMatrix(reBakedGraph.instances.find((i) => i.id === baked.instanceId)!.matrix)
			);

			// Owner edits a face inside the container -> state becomes 'detached'
			const mesh = moved.meshes[0]!;
			const topFace = mesh.faces.find((f) => f.normal[2] > 0.99)!;
			const pushed = run({ type: 'raw', command: { kind: 'PUSH_PULL_FACE', faceId: topFace.id, distance: 0.2 } }, [baked.instanceId]);
			expect(validateAuthoringDocument(pushed).editable).toBe(true);
			expect(readManaged(pushed).get('test/ground')!.state).toBe('detached');

			// Owner undo restores attached 'ok' state
			expect(history.undo(doc)).toBe(true);
			expect(readManaged(doc.snapshot().graph).get('test/ground')!.state).toBe('ok');
		} finally {
			doc.dispose();
		}
	});

	test('T-B4: erasing container orphans entry; undo re-attaches; remove_module deletes orphan; create replaces orphan', () => {
		const { baked, nextGraph } = bakeInto(newGraph(), g1(), 1, 1);
		const doc = BomcDocument.fromGraph(nextGraph);
		const history = new AuthoringHistory(null);
		try {
			const eraseEdit = buildModelEdit(
				doc.snapshot().graph,
				[],
				{ type: 'erase', selection: [{ type: 'instance', id: baked.instanceId }] },
				nextModelSequence(doc.snapshot().graph)
			);
			history.execute(doc, journalEntry(eraseEdit));
			const erased = doc.snapshot().graph;
			expect(validateAuthoringDocument(erased).editable).toBe(true);
			const orphanRecord = readManaged(erased).get('test/ground')!;
			expect(orphanRecord.state).toBe('orphaned');
			expect(orphanRecord.instance).toBeNull();

			// Remove orphan entry via bakeModule(..., null)
			const removeOrphan = bakeModule(erased, orphanRecord.entry, null, 2, 1);
			const cleared = applyEdits(erased, removeOrphan.forward);
			expect(readManaged(cleared).size).toBe(0);
			expect(graphsEqual(applyEdits(cleared, removeOrphan.inverse), erased)).toBe(true);

			// Replace orphan entry with new bake (monotonic worker sequence S=2)
			const replaced = bakeModule(erased, g3(), evaluate(g3()), 2, 1);
			const replacedGraph = applyEdits(erased, replaced.forward);
			expect(readManaged(replacedGraph).get('test/ground')!.state).toBe('ok');
			expect(readManaged(replacedGraph).get('test/ground')!.instance!.id).not.toBe(baked.instanceId);
			expect(graphsEqual(applyEdits(replacedGraph, replaced.inverse), erased)).toBe(true);

			// Owner undo of erase re-attaches original container as 'ok'
			expect(history.undo(doc)).toBe(true);
			const reattached = doc.snapshot().graph;
			expect(readManaged(reattached).get('test/ground')!.state).toBe('ok');
			expect(readManaged(reattached).get('test/ground')!.instance!.id).toBe(baked.instanceId);
		} finally {
			doc.dispose();
		}
	});

	test('T-B5: projectAuthoringScene on baked G3 yields editor-authoring-source-edges with 48 vertices (24 edges)', () => {
		const { nextGraph } = bakeInto(newGraph(), g3(), 1, 1);
		const doc = BomcDocument.fromGraph(nextGraph);
		try {
			const projection = projectAuthoringScene(doc.snapshot(), DEFAULT_DISPLAY_STATE);
			const lineGroups: LineSegments[] = [];
			projection.group.traverse((obj) => {
				if (obj instanceof LineSegments && obj.name === 'editor-authoring-source-edges') lineGroups.push(obj);
			});
			expect(lineGroups).toHaveLength(1);
			const posAttr = lineGroups[0]!.geometry.getAttribute('position');
			expect(posAttr.count).toBe(48);
		} finally {
			doc.dispose();
		}
	});

	test('T-B6 (store-only OPEN): every baked G1–G9 opens as authoring with identical arch', async () => {
		for (const mod of [g1(), g2(), g3(), g4(), g5(), g6(), g7(30), g8(), g9()]) {
			const { nextGraph } = bakeInto(newGraph(), mod, 1, 1);
			const expectedArch = JSON.stringify(modelMetadata(nextGraph).arch);

			const first = new WorkerHarness();
			const opened = await first.send('OPEN', { data: { ownedBuffer: await storeOnlyBytes(nextGraph) } });
			expect(opened.kind).toBe('authoring');
			expect(JSON.stringify(modelMetadata(opened.checkpoint.snapshot.graph).arch)).toBe(expectedArch);
		}
	});

	test('T-B6 (WRITE -> OPEN round-trip across G1–G9, requires DecompressionStream deflate / Bun >= 1.4.4)', async () => {
		for (const mod of [g1(), g2(), g3(), g4(), g5(), g6(), g7(30), g8(), g9()]) {
			const { nextGraph } = bakeInto(newGraph(), mod, 1, 1);
			const expectedArch = JSON.stringify(modelMetadata(nextGraph).arch);

			const first = new WorkerHarness();
			const opened = await first.send('OPEN', { data: { ownedBuffer: await storeOnlyBytes(nextGraph) } });
			expect(opened.kind).toBe('authoring');
			const written = await first.send('WRITE', { expectedRevision: opened.checkpoint.snapshot.revision });
			const second = new WorkerHarness();
			const reopened = await second.send('OPEN', { data: { ownedBuffer: written.ownedBuffer } });
			expect(reopened.kind).toBe('authoring');
			expect(JSON.stringify(modelMetadata(reopened.checkpoint.snapshot.graph).arch)).toBe(expectedArch);
			expect(reopened.checkpoint.snapshot.graph).toEqual(opened.checkpoint.snapshot.graph);
		}
	});

	test('G10-CP5 (G1, G4, G8): baked SHA-256 identical across two fresh kernels', async () => {
		const k2 = createKernel();
		await k2.init();
		for (const mod of [g1(), g4(), g8()]) {
			const a = bakeInto(newGraph(), mod, 1, 1, kernel).baked.bakedMeshSha256;
			const b = bakeInto(newGraph(), mod, 1, 1, k2).baked.bakedMeshSha256;
			expect(a).toBe(b);
			expect(a).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	test('RING_TOO_LONG, budgets, empty module bake, and admission fail-closed enforcement', () => {
		const emptyMod = moduleOf([], 'test/empty');
		const emptyRes = bakeInto(newGraph(), emptyMod, 1, 1);
		expect(emptyRes.nextGraph.meshes).toHaveLength(0);
		expect(readManaged(emptyRes.nextGraph).get('test/empty')!.state).toBe('ok');
		expect(validateAuthoringDocument(emptyRes.nextGraph).editable).toBe(true);

		const fakeEval = evaluate(g1());
		const longOuter = Array.from({ length: 257 }, (_, i) => i);
		const longTopo = {
			...fakeEval,
			parts: [
				{
					...fakeEval.parts[0]!,
					topology: {
						...fakeEval.parts[0]!.topology,
						faces: [{ ...fakeEval.parts[0]!.topology.faces[0]!, outer: longOuter, holes: [] }]
					}
				}
			]
		};
		expect(() => bakeModule(newGraph(), g1(), longTopo, 1, 1)).toThrow(/RING_TOO_LONG/);

		const gManyMats = newGraph();
		const mats = Array.from({ length: 512 }, (_, i) => ({
			id: `${DOC}:material:op:legacy-${i}`,
			name: `legacy-${i}`,
			displayName: null,
			rgba: [100, 100, 100, 255] as const,
			opacityU16: 65535
		}));
		const with512 = { ...gManyMats, materials: mats };
		expect(() => bakeModule(with512, g1(), fakeEval, 1, 1)).toThrow(/BUDGET_EXCEEDED/);

		const { nextGraph: g3Baked } = bakeInto(newGraph(), g3(), 1, 1);
		const m3 = g3Baked.meshes[0]!;
		expect(() =>
			faceFromRing(
				m3,
				`${DOC}:op:2:arch-face:00000`,
				m3.faces[0]!.outer,
				m3.faces[0]!.frontMaterialId!,
				null,
				v2FaceLabel(`${DOC}:op:2:arch-face:00000`, 'line'),
				m3.faces[0]!.normal,
				m3.faces[0]!.holes
			)
		).not.toThrow();
	});

	test('owner undo/redo and Save (BomcWriter) work cleanly alongside baked modules', async () => {
		const { nextGraph } = bakeInto(newGraph(), g3(), 1, 1);
		const doc = BomcDocument.fromGraph(nextGraph);
		const history = new AuthoringHistory(null);
		try {
			const rect = buildModelEdit(
				doc.snapshot().graph,
				[],
				{ type: 'raw', command: { kind: 'CREATE_RECTANGLE', first: [6, 0, 0], opposite: [8, 0, 2] } },
				nextModelSequence(doc.snapshot().graph)
			);
			expect(history.execute(doc, journalEntry(rect))).toBe(true);
			expect(readManaged(doc.snapshot().graph).get('test/ground')!.state).toBe('ok');
			expect(validateAuthoringDocument(doc.snapshot().graph).editable).toBe(true);

			const saved = await new BomcWriter(doc, { compressionMode: 'store-only' }).write();
			expect(saved.bytes.byteLength).toBeGreaterThan(0);

			expect(history.undo(doc)).toBe(true);
			expect(graphsEqual(doc.snapshot().graph, nextGraph)).toBe(true);
			expect(readManaged(doc.snapshot().graph).get('test/ground')!.state).toBe('ok');
		} finally {
			doc.dispose();
		}
	});
});
