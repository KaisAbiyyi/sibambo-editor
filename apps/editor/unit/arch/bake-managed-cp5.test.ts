/**
 * SIB-MCP-MODELING-001 WP5 (CP5) — Bake, Managed Groups, and Determinism tests.
 * Covers G2-CP5 (baked comparison), G10-CP5 (baked determinism for G1/G4/G8), T-B1–T-B6,
 * D-WP5-1 Option A multi-hole triangulation & fail-closed admission regressions,
 * container transforms (B1), owner undo/redo/save preservation, and budget/ring guards.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineSegments } from 'three';
import { DEFAULT_DISPLAY_STATE } from '@sibambo/viewport';
import type { BomcGraph, DocumentEdit } from '@sibambo/bomc-document';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { BomcWriter } from '@sibambo/bomc-document/writer';
import { bakeModule } from '../../src/lib/arch/bake.js';
import { fromInstanceMatrix } from '../../src/lib/arch/convention.js';
import { ArchError } from '../../src/lib/arch/errors.js';
import { evaluateModule } from '../../src/lib/arch/evaluate.js';
import { createKernel, type Kernel } from '../../src/lib/arch/kernel.js';
import { effectiveModuleTransform, readManaged } from '../../src/lib/arch/managed.js';
import type { ArchModule } from '../../src/lib/arch/schema.js';
import { AuthoringWorkerDispatcher } from '../../src/lib/authoring/bomc-authoring.worker.js';
import { faceFromRing, journalEntry, triangulateFaceRings, v2FaceLabel } from '../../src/lib/authoring/geometry.js';
import { AuthoringHistory, graphsEqual } from '../../src/lib/authoring/history.js';
import { buildModelEdit, modelMetadata, modelOccurrences, nextModelSequence, validateAuthoringDocument } from '../../src/lib/authoring/model.js';
import { AUTHORING_PROTOCOL_VERSION, type AuthoringWorkerMessage, type ModelAction } from '../../src/lib/authoring/protocol.js';
import { projectAuthoringScene } from '../../src/lib/authoring/scene.js';
import { g1, g2, g2Clockwise, g2Rotated, g3, g4, g5, g6, g7, g8, g9, moduleOf, wall } from './fixtures/modules.js';

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

	test('G10-CP5 (G1, G4, G8): baked SHA-256 identical across two fresh kernels and equal to pinned digests', async () => {
		const pinned = JSON.parse(readFileSync(new URL('./golden/g10-cp5-bake-hashes.json', import.meta.url), 'utf8')).hashes as Record<string, string>;
		const k2 = createKernel();
		await k2.init();
		for (const [name, mod] of [['G1', g1()], ['G4', g4()], ['G8', g8()]] as const) {
			const a = bakeInto(newGraph(), mod, 1, 1, kernel).baked.bakedMeshSha256;
			const b = bakeInto(newGraph(), mod, 1, 1, k2).baked.bakedMeshSha256;
			expect(a).toBe(b);
			expect(a).toBe(pinned[name]!);
			expect(a).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	test('G10-CP5 CLI verifier: enforces pinned & cross-runtime equality (Bun vs Node) and fails closed on mismatch', () => {
		const pinnedPath = fileURLToPath(new URL('./golden/g10-cp5-bake-hashes.json', import.meta.url));
		const pinned = JSON.parse(readFileSync(pinnedPath, 'utf8')).hashes as Record<string, string>;
		const verifierPath = fileURLToPath(new URL('./fixtures/verify-g10-cp5.ts', import.meta.url));
		const editorRoot = fileURLToPath(new URL('../..', import.meta.url));
		const workDir = mkdtempSync(join(tmpdir(), 'g10-cp5-'));
		const flipHex = (hex: string) => `${hex.startsWith('0') ? '1' : '0'}${hex.slice(1)}`;
		const runJson = (cmd: string, args: string[], env: Record<string, string> = {}) => {
			const res = spawnSync(cmd, args, { cwd: editorRoot, encoding: 'utf8', env: { ...process.env, ...env } });
			expect(res.error).toBeUndefined();
			const parsed = JSON.parse(res.stdout.trim()) as {
				runtime: string;
				ok: boolean;
				peerOk?: boolean;
				hashes?: Record<string, string>;
				mismatches?: Array<{ kind: string; fixture: string; expected: string | null; actual: string | null }>;
			};
			return { status: res.status, parsed };
		};

		try {
			// 1. Positive: Bun verifier matches pinned G1/G4/G8 digests and exits 0
			const bunRun = runJson(process.execPath, [verifierPath, '--pins', pinnedPath]);
			expect(bunRun.status).toBe(0);
			expect(bunRun.parsed.ok).toBe(true);
			expect(bunRun.parsed.hashes).toEqual(pinned);

			const bunOutPath = join(workDir, 'bun-g10-cp5.json');
			writeFileSync(bunOutPath, JSON.stringify(bunRun.parsed));

			// 2. Positive: Node bundled verifier matches both pins and Bun output via --compare
			// Note: ESM resolves `--external manifold-3d` from the bundled `.mjs` file's parent `node_modules`.
			const nodeMjsPath = join(editorRoot, `.tmp-verify-g10-cp5-${process.pid}.mjs`);
			const buildRes = spawnSync(
				process.execPath,
				['build', verifierPath, '--target=node', `--outfile=${nodeMjsPath}`, '--external', 'manifold-3d'],
				{ cwd: editorRoot, encoding: 'utf8' }
			);
			expect(buildRes.status).toBe(0);

			try {
				const nodeCheck = runJson('node', [nodeMjsPath, '--pins', pinnedPath, '--compare', bunOutPath]);
				expect(nodeCheck.status).toBe(0);
				expect(nodeCheck.parsed.ok).toBe(true);
				expect(nodeCheck.parsed.peerOk).toBe(true);
				expect(nodeCheck.parsed.hashes).toEqual(pinned);

				// 3. Negative (pin mismatch): flipping a pinned digest (G1/G4/G8) must fail closed with exit 1
				for (const fixture of ['G1', 'G4', 'G8'] as const) {
					const badPinsPath = join(workDir, `bad-pins-${fixture}.json`);
					writeFileSync(badPinsPath, JSON.stringify({ hashes: { ...pinned, [fixture]: flipHex(pinned[fixture]!) } }));
					const pinFail = runJson(process.execPath, [verifierPath], { G10_CP5_PINS: badPinsPath });
					expect(pinFail.status).toBe(1);
					expect(pinFail.parsed.ok).toBe(false);
					expect(pinFail.parsed.mismatches).toEqual(
						expect.arrayContaining([expect.objectContaining({ kind: 'pin', fixture })])
					);
				}

				// 4. Negative (cross-runtime --compare mismatch): G8 drift in peer JSON must fail on both Bun and Node
				const driftedPeerPath = join(workDir, 'drifted-peer-g8.json');
				writeFileSync(
					driftedPeerPath,
					JSON.stringify({ runtime: 'fake-peer', ok: true, hashes: { ...pinned, G8: flipHex(pinned.G8!) } })
				);
				const bunPeerFail = runJson(process.execPath, [verifierPath, '--pins', pinnedPath, '--compare', driftedPeerPath]);
				expect(bunPeerFail.status).toBe(1);
				expect(bunPeerFail.parsed.ok).toBe(false);
				expect(bunPeerFail.parsed.peerOk).toBe(false);
				expect(bunPeerFail.parsed.mismatches).toEqual(
					expect.arrayContaining([expect.objectContaining({ kind: 'peer', fixture: 'G8' })])
				);

				const nodePeerFail = runJson('node', [nodeMjsPath, '--pins', pinnedPath, '--compare', driftedPeerPath]);
				expect(nodePeerFail.status).toBe(1);
				expect(nodePeerFail.parsed.ok).toBe(false);
				expect(nodePeerFail.parsed.peerOk).toBe(false);
				expect(nodePeerFail.parsed.mismatches).toEqual(
					expect.arrayContaining([expect.objectContaining({ kind: 'peer', fixture: 'G8' })])
				);

				// 5. Negative (missing key in peer JSON): omitting G1 must fail closed with exit 1
				const missingKeyPath = join(workDir, 'missing-key-g1.json');
				writeFileSync(missingKeyPath, JSON.stringify({ runtime: 'fake-peer', hashes: { G4: pinned.G4, G8: pinned.G8 } }));
				const missingFail = runJson(process.execPath, [verifierPath, '--pins', pinnedPath, '--compare', missingKeyPath]);
				expect(missingFail.status).toBe(1);
				expect(missingFail.parsed.ok).toBe(false);
				expect(missingFail.parsed.peerOk).toBe(false);
				expect(missingFail.parsed.mismatches).toEqual(
					expect.arrayContaining([expect.objectContaining({ kind: 'peer', fixture: 'G1', expected: null })])
				);
			} finally {
				rmSync(nodeMjsPath, { force: true });
			}
		} finally {
			rmSync(workDir, { recursive: true, force: true });
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

	test('P1 cross-module material collision fails closed while matching reuse, single-module updates, and undo work cleanly (A7)', () => {
		const RED: [number, number, number, number] = [220, 40, 40, 255];
		const BLUE: [number, number, number, number] = [40, 80, 220, 255];
		const GREEN: [number, number, number, number] = [30, 180, 60, 255];
		const FINISH_ID = `${DOC}:material:op:arch-finish`;

		const makeMod = (
			moduleId: string,
			xOffset: number,
			rgba: [number, number, number, number],
			opacity = 1
		): ArchModule => {
			const m = moduleOf([wall('w1', [[xOffset, 0], [xOffset + 2, 0]], { materialId: 'finish' })], moduleId);
			return { ...m, materials: [{ materialId: 'finish', rgba: [...rgba], opacity }] };
		};

		const expectCollision = (fn: () => unknown, moduleId: string) => {
			let caught: unknown;
			try {
				fn();
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(ArchError);
			expect((caught as ArchError).code).toBe('INVALID_GEOMETRY');
			expect((caught as ArchError).detail).toMatchObject({
				reason: 'MATERIAL_COLLISION',
				moduleId,
				elementId: 'finish'
			});
		};

		// 1. Forward order: A (finish red) then B (finish blue) rejects atomically
		const modARed = makeMod('test/mod-a', 0, RED, 1);
		const modBBlue = makeMod('test/mod-b', 5, BLUE, 1);
		const afterA = bakeInto(newGraph(), modARed, 1, 1);
		expect(afterA.nextGraph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(RED);

		expectCollision(() => bakeInto(afterA.nextGraph, modBBlue, 2, 1), 'test/mod-b');
		expect(afterA.nextGraph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(RED);
		expect(readManaged(afterA.nextGraph).get('test/mod-a')?.state).toBe('ok');
		expect(readManaged(afterA.nextGraph).has('test/mod-b')).toBe(false);

		// Opacity-only mismatch also fails closed
		const modARedHalf = makeMod('test/mod-b', 5, RED, 0.5);
		expectCollision(() => bakeInto(afterA.nextGraph, modARedHalf, 2, 1), 'test/mod-b');

		// 2. Reversed order: B (finish blue) then A (finish red) fails closed on A, preserves B
		const afterB = bakeInto(newGraph(), modBBlue, 1, 1);
		expect(afterB.nextGraph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(BLUE);
		expectCollision(() => bakeInto(afterB.nextGraph, modARed, 2, 1), 'test/mod-a');
		expect(afterB.nextGraph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(BLUE);
		expect(readManaged(afterB.nextGraph).get('test/mod-b')?.state).toBe('ok');
		expect(readManaged(afterB.nextGraph).has('test/mod-a')).toBe(false);

		// 3. Matching material reuse: A (finish red) + B (finish red) reuses A7 global material without put-material
		const modBRed = makeMod('test/mod-b', 5, RED, 1);
		const afterBReuse = bakeInto(afterA.nextGraph, modBRed, 2, 1);
		expect(validateAuthoringDocument(afterBReuse.nextGraph).editable).toBe(true);
		expect(afterBReuse.nextGraph.materials.filter((m) => m.id === FINISH_ID)).toHaveLength(1);
		expect(afterBReuse.baked.forward.some((e) => e.type === 'put-material' && e.value.id === FINISH_ID)).toBe(false);
		expect(readManaged(afterBReuse.nextGraph).get('test/mod-a')?.state).toBe('ok');
		expect(readManaged(afterBReuse.nextGraph).get('test/mod-b')?.state).toBe('ok');

		// 4. Re-bake/update B while A remains managed must still fail closed
		const modBRebakedBlue = { ...modBBlue, revision: 2 };
		expectCollision(() => bakeInto(afterBReuse.nextGraph, modBRebakedBlue, 3, 1), 'test/mod-b');
		expect(afterBReuse.nextGraph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(RED);
		expect(readManaged(afterBReuse.nextGraph).get('test/mod-a')?.state).toBe('ok');
		expect(readManaged(afterBReuse.nextGraph).get('test/mod-b')?.state).toBe('ok');

		// 5. Removing A lets B update finish from red -> blue cleanly, with reversible inverse
		const remA = bakeModule(afterBReuse.nextGraph, modARed, null, 4, 1);
		const onlyB = applyEdits(afterBReuse.nextGraph, remA.forward);
		const bUpdated = bakeInto(onlyB, modBRebakedBlue, 5, 1);
		expect(validateAuthoringDocument(bUpdated.nextGraph).editable).toBe(true);
		expect(bUpdated.nextGraph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(BLUE);
		expect(readManaged(bUpdated.nextGraph).get('test/mod-b')?.state).toBe('ok');
		expect(graphsEqual(applyEdits(bUpdated.nextGraph, bUpdated.baked.inverse), onlyB)).toBe(true);

		// 6. Orphaned A (erased container still in arch) still blocks conflicting B
		const eraseAEdit = buildModelEdit(
			afterA.nextGraph,
			[],
			{ type: 'erase', selection: [{ type: 'instance', id: afterA.baked.instanceId }] },
			nextModelSequence(afterA.nextGraph)
		);
		const erasedA = applyEdits(afterA.nextGraph, eraseAEdit.forward);
		expect(readManaged(erasedA).get('test/mod-a')?.state).toBe('orphaned');
		expectCollision(() => bakeInto(erasedA, modBBlue, 3, 1), 'test/mod-b');

		// 7. Standalone non-target mesh referencing arch-finish still blocks overwriting its RGBA
		const copiedMeshGraph = structuredClone(onlyB);
		copiedMeshGraph.meshes.push({
			...copiedMeshGraph.meshes[0]!,
			id: `${DOC}:mesh:op:99:1`,
			definitionId: `${DOC}:definition:op:99:1`,
			faces: copiedMeshGraph.meshes[0]!.faces.map((f, idx) =>
				idx === 0 ? { ...f, id: `${DOC}:op:99:face:00000`, frontMaterialId: FINISH_ID } : f
			)
		});
		expectCollision(() => bakeInto(copiedMeshGraph, modBBlue, 5, 1), 'test/mod-b');

		// 8. Single-module material update + AuthoringHistory undo/redo rollback
		const doc = BomcDocument.fromGraph(newGraph());
		const history = new AuthoringHistory(null);
		try {
			const b1 = bakeModule(doc.snapshot().graph, modARed, evaluate(modARed), 1, 1);
			expect(history.execute(doc, journalEntry(b1))).toBe(true);
			const revAfterCreate = doc.snapshot().revision;

			// Atomic rejection leaves document, revision, and stacks intact
			expectCollision(() => bakeModule(doc.snapshot().graph, modBBlue, evaluate(modBBlue), 2, 1), 'test/mod-b');
			expect(doc.snapshot().revision).toBe(revAfterCreate);

			// Single-module update (red -> green) succeeds and undoes cleanly back to red
			const modAGreen = { ...makeMod('test/mod-a', 0, GREEN, 1), revision: 2 };
			const b2 = bakeModule(doc.snapshot().graph, modAGreen, evaluate(modAGreen), 3, 1);
			expect(history.execute(doc, journalEntry(b2))).toBe(true);
			expect(doc.snapshot().graph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(GREEN);
			expect(readManaged(doc.snapshot().graph).get('test/mod-a')?.state).toBe('ok');

			expect(history.undo(doc)).toBe(true);
			expect(doc.snapshot().graph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(RED);
			expect(readManaged(doc.snapshot().graph).get('test/mod-a')?.state).toBe('ok');

			expect(history.redo(doc)).toBe(true);
			expect(doc.snapshot().graph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(GREEN);
		} finally {
			doc.dispose();
		}
	});

	test('P1 instance-level materialId overrides and shared definitions/meshes fail closed on conflicting material updates (A7)', () => {
		const RED: [number, number, number, number] = [220, 40, 40, 255];
		const BLUE: [number, number, number, number] = [40, 80, 220, 255];
		const GREEN: [number, number, number, number] = [30, 180, 60, 255];
		const FINISH_ID = `${DOC}:material:op:arch-finish`;

		const makeMod = (moduleId: string, xOffset: number, rgba: [number, number, number, number], revision = 1): ArchModule => {
			const m = moduleOf([wall('w1', [[xOffset, 0], [xOffset + 2, 0]], { materialId: 'finish' })], moduleId);
			return { ...m, revision, materials: [{ materialId: 'finish', rgba: [...rgba], opacity: 1 }] };
		};

		const expectCollision = (fn: () => unknown, moduleId: string) => {
			let caught: unknown;
			try {
				fn();
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(ArchError);
			expect((caught as ArchError).code).toBe('INVALID_GEOMETRY');
			expect((caught as ArchError).detail).toMatchObject({
				reason: 'MATERIAL_COLLISION',
				moduleId,
				elementId: 'finish'
			});
		};

		const doc = BomcDocument.fromGraph(newGraph());
		const history = new AuthoringHistory(null);
		try {
			// 1. Bake mod-a with custom finish RED
			const modARed = makeMod('test/mod-a', 0, RED, 1);
			const b1 = bakeModule(doc.snapshot().graph, modARed, evaluate(modARed), 1, 1);
			expect(history.execute(doc, journalEntry(b1))).toBe(true);

			// 2. Build an ordinary owner-authored rectangle -> push-pull -> group (mesh faces use neutral material)
			const rectEdit = buildModelEdit(
				doc.snapshot().graph,
				[],
				{
					type: 'raw',
					command: {
						kind: 'CREATE_RECTANGLE',
						points: [
							[10, 0, 0],
							[12, 0, 0],
							[12, 0, 2],
							[10, 0, 2]
						],
						normal: [0, 1, 0]
					}
				},
				nextModelSequence(doc.snapshot().graph)
			);
			expect(history.execute(doc, journalEntry(rectEdit))).toBe(true);
			const extrudeEdit = buildModelEdit(
				doc.snapshot().graph,
				[],
				{ type: 'raw', command: { kind: 'PUSH_PULL_FACE', faceId: rectEdit.entityId!, distance: 1.5 } },
				nextModelSequence(doc.snapshot().graph)
			);
			expect(history.execute(doc, journalEntry(extrudeEdit))).toBe(true);
			const rootFaces = doc.snapshot().graph.meshes
				.find((m) => m.definitionId === doc.snapshot().graph.rootDefinitionId)!
				.faces.map((f) => ({ type: 'face' as const, id: f.id }));
			const groupEdit = buildModelEdit(
				doc.snapshot().graph,
				[],
				{ type: 'group', name: 'Owner Shed', containerKind: 'group', selection: rootFaces },
				nextModelSequence(doc.snapshot().graph)
			);
			expect(history.execute(doc, journalEntry(groupEdit))).toBe(true);
			const ownerGroupId = groupEdit.entityId!;
			const ownerInstBefore = doc.snapshot().graph.instances.find((i) => i.id === ownerGroupId)!;
			const ownerMesh = doc.snapshot().graph.meshes.find(
				(m) => m.definitionId === ownerInstBefore.definitionId
			)!;
			expect(
				ownerMesh.faces.every((f) => f.frontMaterialId !== FINISH_ID && f.backMaterialId !== FINISH_ID)
			).toBe(true);

			// Paint the owner group instance at instance level with arch-finish (RED)
			const rootInst = doc.snapshot().graph.instances.find((i) => i.id === doc.snapshot().graph.rootInstanceId)!;
			const paintOwnerInst: DocumentEdit = {
				type: 'put-instance',
				value: { ...ownerInstBefore, materialId: FINISH_ID }
			};
			const clearOwnerInst: DocumentEdit = { type: 'put-instance', value: ownerInstBefore };
			const paintEntry = journalEntry({
				forward: [paintOwnerInst, { type: 'put-instance', value: rootInst }],
				inverse: [clearOwnerInst, { type: 'put-instance', value: rootInst }]
			});
			expect(history.execute(doc, paintEntry)).toBe(true);

			expect(validateAuthoringDocument(doc.snapshot().graph).editable).toBe(true);
			const occ = modelOccurrences(doc.snapshot().graph);
			const ownerOccIdx = occ.findIndex((o) => o.path[o.path.length - 1] === ownerGroupId);
			expect(occ[ownerOccIdx]?.materialId).toBe(FINISH_ID);

			// Helper reading the projected Three.js front color of the owner group occurrence
			const projectedOwnerRgb = (graph = doc.snapshot().graph) => {
				const proj = projectAuthoringScene({ ...doc.snapshot(), graph }, DEFAULT_DISPLAY_STATE);
				const g = proj.group.children[ownerOccIdx]!;
				const colors: Array<[number, number, number]> = [];
				g.traverse((obj: any) => {
					if (obj.isMesh && obj.material?.color) {
						colors.push([obj.material.color.r, obj.material.color.g, obj.material.color.b]);
					}
				});
				return colors;
			};
			const redBefore = projectedOwnerRgb();
			expect(redBefore.length).toBeGreaterThan(0);
			// Owner group currently renders with finish RED (r >> g, r >> b)
			expect(redBefore.every(([r, g, b]) => r > 0.5 && g < 0.1 && b < 0.1)).toBe(true);

			// 3. Matching material reuse (mod-b with identical finish RED) stays valid while owner group uses arch-finish
			const modBRed = makeMod('test/mod-b', 5, RED, 1);
			const reuseB = bakeModule(doc.snapshot().graph, modBRed, evaluate(modBRed), nextModelSequence(doc.snapshot().graph), 1);
			expect(reuseB.forward.some((e) => e.type === 'put-material' && e.value.id === FINISH_ID)).toBe(false);
			const withB = applyEdits(doc.snapshot().graph, reuseB.forward);
			expect(validateAuthoringDocument(withB).editable).toBe(true);

			// Remove mod-b so test/mod-a is once again the ONLY managed module in arch.modules
			// Note: owner group instance still holds `materialId: FINISH_ID`.
			const snapBeforeConflict = structuredClone(doc.snapshot().graph);
			const revBeforeConflict = doc.snapshot().revision;

			// 4. Updating the ONLY managed module mod-a (RED -> BLUE) MUST fail atomically!
			const modABlue = makeMod('test/mod-a', 0, BLUE, 2);
			const modAGreen = makeMod('test/mod-a', 0, GREEN, 2);
			expectCollision(
				() => bakeModule(doc.snapshot().graph, modABlue, evaluate(modABlue), nextModelSequence(doc.snapshot().graph), 1),
				'test/mod-a'
			);
			expect(doc.snapshot().revision).toBe(revBeforeConflict);
			expect(graphsEqual(doc.snapshot().graph, snapBeforeConflict)).toBe(true);
			expect(doc.snapshot().graph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(RED);
			expect(projectedOwnerRgb()).toEqual(redBefore);
			expect(readManaged(doc.snapshot().graph).get('test/mod-a')?.state).toBe('ok');

			// 5. Nested child instance inside an owner group overriding/carrying FINISH_ID also fails closed
			const nestedChildGraph = structuredClone(doc.snapshot().graph);
			const childInstId = `${DOC}:instance:op:900:1`;
			const clearParent = nestedChildGraph.instances.find((i) => i.id === ownerGroupId)!;
			clearParent.materialId = null;
			nestedChildGraph.instances.push({
				...clearParent,
				id: childInstId,
				name: 'Nested Child',
				ownerDefinitionId: ownerInstBefore.definitionId,
				materialId: FINISH_ID
			});
			// Replace cyclic self-ref with distinct child definition owning no child instances
			const childDefId = `${DOC}:definition:op:900:1`;
			nestedChildGraph.definitions.push({ id: childDefId, name: 'Nested Child', kind: 'group', meshId: null });
			nestedChildGraph.instances[nestedChildGraph.instances.length - 1]!.definitionId = childDefId;
			expect(validateAuthoringDocument(nestedChildGraph).editable).toBe(true);
			expectCollision(
				() => bakeModule(nestedChildGraph, modAGreen, evaluate(modAGreen), nextModelSequence(nestedChildGraph), 1),
				'test/mod-a'
			);

			// 6. Shared definition and shared mesh paths must also protect non-target references
			const baseOnlyModA = applyEdits(doc.snapshot().graph, [
				{ type: 'put-instance', value: { ...ownerInstBefore, materialId: null } }
			]);
			const modAInst = baseOnlyModA.instances.find((i) => i.id === b1.instanceId)!;
			const modADef = baseOnlyModA.definitions.find((d) => d.id === modAInst.definitionId)!;

			// 6a. Second instance sharing mod-a's definitionId
			const sharedDefGraph = structuredClone(baseOnlyModA);
			sharedDefGraph.instances.push({
				...modAInst,
				id: `${DOC}:instance:op:901:1`,
				name: 'Copied Wall Group',
				materialId: null
			});
			expect(validateAuthoringDocument(sharedDefGraph).editable).toBe(true);
			expectCollision(
				() => bakeModule(sharedDefGraph, modAGreen, evaluate(modAGreen), nextModelSequence(sharedDefGraph), 1),
				'test/mod-a'
			);

			// 6b. Second definition sharing mod-a's meshId
			const sharedMeshGraph = structuredClone(baseOnlyModA);
			const sharedDefId2 = `${DOC}:definition:op:902:1`;
			sharedMeshGraph.definitions.push({ id: sharedDefId2, name: 'Shared Mesh Def', kind: 'group', meshId: modADef.meshId });
			sharedMeshGraph.instances.push({
				...modAInst,
				id: `${DOC}:instance:op:902:1`,
				name: 'Shared Mesh Holder',
				definitionId: sharedDefId2,
				materialId: null
			});
			expect(validateAuthoringDocument(sharedMeshGraph).editable).toBe(true);
			expectCollision(
				() => bakeModule(sharedMeshGraph, modAGreen, evaluate(modAGreen), nextModelSequence(sharedMeshGraph), 1),
				'test/mod-a'
			);

			// 7. Clearing the owner instance's override restores legitimate single-module update + AuthoringHistory undo/redo
			expect(
				history.execute(
					doc,
					journalEntry({
						forward: [clearOwnerInst, { type: 'put-instance', value: rootInst }],
						inverse: [paintOwnerInst, { type: 'put-instance', value: rootInst }]
					})
				)
			).toBe(true);
			const b2 = bakeModule(doc.snapshot().graph, modAGreen, evaluate(modAGreen), nextModelSequence(doc.snapshot().graph), 1);
			expect(history.execute(doc, journalEntry(b2))).toBe(true);
			expect(doc.snapshot().graph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(GREEN);
			expect(readManaged(doc.snapshot().graph).get('test/mod-a')?.state).toBe('ok');

			expect(history.undo(doc)).toBe(true);
			expect(doc.snapshot().graph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(RED);
			expect(readManaged(doc.snapshot().graph).get('test/mod-a')?.state).toBe('ok');

			expect(history.redo(doc)).toBe(true);
			expect(doc.snapshot().graph.materials.find((m) => m.id === FINISH_ID)?.rgba).toEqual(GREEN);
		} finally {
			doc.dispose();
		}
	});

	test('P1 shared managed geometry: same-material re-bake is fail-closed and removal preserves aliased owner geometry', () => {
		const initial = bakeInto(newGraph(), g1(), 1, 1).nextGraph;
		const owner = readManaged(initial).get(g1().moduleId)!.instance!;
		const def = initial.definitions.find((d) => d.id === owner.definitionId)!;
		const mesh = initial.meshes.find((m) => m.id === def.meshId)!;

		const sharedDefinition = structuredClone(initial);
		sharedDefinition.instances.push({
			...owner, id: DOC + ':instance:op:910:1', name: 'Owner Copy / Shared Definition'
		});

		const sharedMesh = structuredClone(initial);
		const aliasId = DOC + ':definition:op:911:1';
		sharedMesh.definitions.push({ id: aliasId, name: 'Owner Mesh Alias', kind: 'group', meshId: mesh.id });
		sharedMesh.instances.push({
			...owner, id: DOC + ':instance:op:911:1',
			name: 'Owner Copy / Shared Mesh', definitionId: aliasId
		});

		const changed = g4();
		expect(changed.moduleId).toBe(g1().moduleId);
		expect(changed.materials).toEqual(g1().materials);

		for (const graph of [sharedDefinition, sharedMesh]) {
			expect(validateAuthoringDocument(graph).editable).toBe(true);
			const before = structuredClone(graph);
			const doc = BomcDocument.fromGraph(graph);
			try {
				const revision = doc.snapshot().revision;
				let error: unknown;
				try {
					bakeModule(doc.snapshot().graph, changed, evaluate(changed), 2, 1);
				} catch (caught) { error = caught; }
				expect(error).toBeInstanceOf(ArchError);
				expect((error as ArchError).code).toBe('INVALID_GEOMETRY');
				expect((error as ArchError).detail).toMatchObject({
					reason: 'SHARED_MANAGED_GEOMETRY', moduleId: changed.moduleId
				});
				expect(doc.snapshot().revision).toBe(revision);
				expect(graphsEqual(doc.snapshot().graph, before)).toBe(true);
				expect(readManaged(doc.snapshot().graph).get(g1().moduleId)?.state).toBe('ok');
			} finally {
				doc.dispose();
			}

			// Owner copies survive remove_module; inverse recreates the exact original.
			const remove = bakeModule(graph, g1(), null, 3, 1);
			const removed = applyEdits(graph, remove.forward);
			expect(validateAuthoringDocument(removed).editable).toBe(true);
			expect(removed.meshes.find((m) => m.id === mesh.id)).toEqual(mesh);
			expect(readManaged(removed).size).toBe(0);
			expect(graphsEqual(applyEdits(removed, remove.inverse), graph)).toBe(true);
		}

		const unshared = bakeInto(initial, changed, 2, 1);
		expect(unshared.nextGraph.meshes.find((m) => m.id === mesh.id)?.faces).toHaveLength(14);
		expect(graphsEqual(applyEdits(unshared.nextGraph, unshared.baked.inverse), initial)).toBe(true);
	});

});
