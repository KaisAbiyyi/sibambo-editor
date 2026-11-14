/**
 * SIB-MCP-MODELING-001 v2.1 WP1A — E-L2 admission-compatible managed-module encoding proof.
 * A hand-built managed module (closed 4 × 3 × 2.7 box with a 1 × 1 through-hole, so the
 * top and bottom faces carry holes) encoded per A4/A7/A20 must stay an editable authoring
 * document through write/reopen, crash recovery and owner actions (T-A1…T-A7).
 * The geometry kernel is deliberately not used here.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { BomcWriter } from '@sibambo/bomc-document/writer';
import type { BomcGraph, Face, Mesh } from '@sibambo/bomc-document';
import { faceFromRing, journalEntry, v2FaceLabel } from '../../src/lib/authoring/geometry.js';
import { buildModelEdit, nextModelSequence, validateAuthoringDocument } from '../../src/lib/authoring/model.js';
import { AuthoringHistory } from '../../src/lib/authoring/history.js';
import { AuthoringWorkerDispatcher } from '../../src/lib/authoring/bomc-authoring.worker.js';
import { AUTHORING_PROTOCOL_VERSION, type AuthoringWorkerMessage, type ModelAction } from '../../src/lib/authoring/protocol.js';
import { fromInstanceMatrix, IDENTITY_ROW_MAJOR, toInstanceMatrix } from '../../src/lib/arch/convention.js';
import { meshDigestInput, validateArchMetadata } from '../../src/lib/arch/metadata.js';

const DOC = '3e1f0b6a-8c2d-4e5f-9a1b-7c6d5e4f3a2b';
const MATERIAL = `${DOC}:material:op:arch-sib-default`;
const INSTANCE = `${DOC}:instance:op:1:1`;
const DEFINITION = `${DOC}:definition:op:1:2`;
const MESH = `${DOC}:mesh:op:1:3`;
const ARCH_PREFIX = 'Unsupported arch metadata: ';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const faceId = (k: number) => `${DOC}:op:1:arch-face:${String(k).padStart(5, '0')}`;

function slabModule(moduleId = 'house/ground', extra: Record<string, unknown> = {}) {
	return {
		schemaVersion: '2.0.0', moduleId, revision: 1, transform: [...IDENTITY_ROW_MAJOR], materials: [],
		elements: [{ elementId: 'slab-1', kind: 'slab', outline: [[0, 0], [4, 0], [4, 3], [0, 3]], holes: [[[1.5, 1], [2.5, 1], [2.5, 2], [1.5, 2]]], thickness: 2.7, topElevation: 2.7 }],
		...extra
	};
}

function boxMesh(): Mesh {
	const z = 2.7;
	const positions = [
		0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0,
		0, 0, z, 4, 0, z, 4, 3, z, 0, 3, z,
		1.5, 1, 0, 2.5, 1, 0, 2.5, 2, 0, 1.5, 2, 0,
		1.5, 1, z, 2.5, 1, z, 2.5, 2, z, 1.5, 2, z
	];
	const draft: Mesh = { id: MESH, definitionId: DEFINITION, positions, faces: [] };
	const specs: [number[], [number, number, number], number[][]][] = [
		[[0, 3, 2, 1], [0, 0, -1], [[8, 9, 10, 11]]],
		[[4, 5, 6, 7], [0, 0, 1], [[12, 13, 14, 15]]],
		[[0, 1, 5, 4], [0, -1, 0], []],
		[[1, 2, 6, 5], [1, 0, 0], []],
		[[2, 3, 7, 6], [0, 1, 0], []],
		[[3, 0, 4, 7], [-1, 0, 0], []],
		[[8, 12, 13, 9], [0, 1, 0], []],
		[[9, 13, 14, 10], [-1, 0, 0], []],
		[[10, 14, 15, 11], [0, -1, 0], []],
		[[11, 15, 12, 8], [1, 0, 0], []]
	];
	const faces: Face[] = specs.map(([ring, normal, holes], k) =>
		faceFromRing(draft, faceId(k), ring, MATERIAL, null, v2FaceLabel(faceId(k), 'line'), normal, holes));
	return { ...draft, faces: [...faces].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

function managedGraph(mutateArch?: (arch: any, graph: any) => void): BomcGraph {
	const base = BomcDocument.create({ documentId: DOC, name: 'E-L2' });
	const graph = structuredClone(base.snapshot().graph) as any;
	base.dispose();
	const mesh = boxMesh();
	graph.materials = [{ id: MATERIAL, name: 'sib-default', displayName: null, rgba: [199, 204, 212, 255], opacityU16: 65535 }];
	graph.definitions = [...graph.definitions, { id: DEFINITION, name: 'house/ground', kind: 'group', meshId: MESH }];
	graph.meshes = [mesh];
	graph.instances = [...graph.instances, {
		id: INSTANCE, name: 'house/ground', kind: 'group', ownerDefinitionId: graph.rootDefinitionId, definitionId: DEFINITION,
		matrix: toInstanceMatrix(IDENTITY_ROW_MAJOR), materialId: null, visible: true, roleCode: 0,
		label: JSON.stringify(['sibambo-editor-container-v1', 1])
	}];
	const arch = { schema: 'sibambo-arch-v2', modules: [{ instanceId: INSTANCE, module: slabModule(), bakedMeshSha256: sha256(meshDigestInput(mesh)) }] };
	mutateArch?.(arch, graph);
	graph.instances[0].label = JSON.stringify({ schema: 'sibambo-editor-model-v1', guides: [], looseEdges: [], arch });
	const document = BomcDocument.fromGraph(graph);
	const canonical = structuredClone(document.snapshot().graph);
	document.dispose();
	return canonical;
}

const rootLabel = (graph: BomcGraph) => graph.instances.find((i) => i.id === graph.rootInstanceId)!.label!;
const archJson = (graph: BomcGraph) => JSON.stringify(JSON.parse(rootLabel(graph)).arch);
const meshHash = (graph: BomcGraph) => sha256(meshDigestInput(graph.meshes.find((m) => m.id === MESH)!));

class Harness {
	private messages: AuthoringWorkerMessage[] = [];
	private nextId = 1;
	readonly dispatcher = new AuthoringWorkerDispatcher((message) => this.messages.push(message), () => crypto.randomUUID());
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

async function bytesOf(graph: BomcGraph): Promise<ArrayBuffer> {
	const document = BomcDocument.fromGraph(graph);
	const bytes = new Uint8Array((await new BomcWriter(document, { compressionMode: 'store-only' }).write()).bytes);
	document.dispose();
	return bytes.slice().buffer;
}

function ownerSession(graph: BomcGraph) {
	const document = BomcDocument.fromGraph(graph);
	const history = new AuthoringHistory(null);
	const run = (action: ModelAction, editPath: string[] = []) => {
		const current = document.snapshot().graph;
		history.execute(document, journalEntry(buildModelEdit(current, editPath, action, nextModelSequence(current))));
		return document.snapshot().graph;
	};
	return { document, history, run };
}

describe('E-L2 admission-compatible managed module (WP1A)', () => {
	test('generated ArchModule v2 validator is current', () => {
		const repo = path.resolve(import.meta.dir, '../../../..');
		const result = spawnSync(process.execPath, [path.join(repo, 'tooling/testing/generate-arch-validators.ts')], { encoding: 'utf8' });
		expect(result.status).toBe(0);
	});

	test('T-A1 the hand-built managed box (holed faces included) is editable', () => {
		const graph = managedGraph();
		const holed = graph.meshes[0]!.faces.filter((f) => f.holes.length > 0);
		expect(holed).toHaveLength(2);
		const result = validateAuthoringDocument(graph);
		expect(result).toMatchObject({ editable: true });
	});

	test('T-A2 WRITE -> OPEN keeps authoring mode and identical arch; RESTORE_CHECKPOINT restores graph and history', async () => {
		const graph = managedGraph();
		const first = new Harness();
		const opened = await first.send('OPEN', { data: { ownedBuffer: await bytesOf(graph) } });
		expect(opened.kind).toBe('authoring');
		const openedGraph = opened.checkpoint.snapshot.graph as BomcGraph;
		expect(rootLabel(openedGraph)).toBe(rootLabel(graph));
		expect(openedGraph.instances.find((i) => i.id === INSTANCE)).toEqual(graph.instances.find((i) => i.id === INSTANCE));
		expect(openedGraph.meshes.find((m) => m.id === MESH)).toEqual(graph.meshes.find((m) => m.id === MESH));

		const written = await first.send('WRITE', { expectedRevision: opened.checkpoint.snapshot.revision });
		const second = new Harness();
		const reopened = await second.send('OPEN', { data: { ownedBuffer: written.ownedBuffer } });
		expect(reopened.kind).toBe('authoring');
		expect(reopened.checkpoint.snapshot.graph).toEqual(openedGraph);

		// The real save flow acknowledges the download before editing resumes.
		const acknowledged = await first.send('ACK_DOWNLOAD', { expectedRevision: opened.checkpoint.snapshot.revision,
			data: { writeId: written.writeId, revision: written.revision } });
		const edited = await first.send('COMMAND', { expectedRevision: acknowledged.checkpoint.snapshot.revision,
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'guide', guideKind: 'line', start: [0, 0, 0], end: [1, 0, 0] } } });
		expect(edited.canUndo).toBe(true);
		expect(archJson(edited.checkpoint.snapshot.graph)).toBe(archJson(graph));
		const third = new Harness();
		const restored = await third.send('RESTORE_CHECKPOINT', { data: { checkpoint: edited.checkpoint } });
		expect(restored.kind).toBe('authoring');
		expect(restored.checkpoint.snapshot.graph).toEqual(edited.checkpoint.snapshot.graph);
		expect(restored.canUndo).toBe(true);
		expect(restored.checkpoint.history.undo).toHaveLength(edited.checkpoint.history.undo.length);
	});

	test('T-A3 owner guide, tag and container move preserve arch byte-for-byte; the move round-trips through fromInstanceMatrix', () => {
		const graph = managedGraph();
		const original = archJson(graph);
		const owner = ownerSession(graph);
		try {
			let current = owner.run({ type: 'guide', guideKind: 'line', start: [0, 0, 0], end: [1, 0, 0] });
			expect(archJson(current)).toBe(original);
			current = owner.run({ type: 'tag-create', name: 'Lantai' });
			expect(archJson(current)).toBe(original);
			expect(Object.keys(JSON.parse(rootLabel(current))).sort()).toEqual(['arch', 'guides', 'looseEdges', 'organization', 'schema']);
			current = owner.run({ type: 'transform', selection: [{ type: 'instance', id: INSTANCE }], delta: [1, 0, 0], copy: false, count: 1, spacing: 'multiply', radial: null });
			expect(archJson(current)).toBe(original);
			const transform = fromInstanceMatrix(current.instances.find((i) => i.id === INSTANCE)!.matrix);
			const expected = [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
			transform.forEach((value, index) => expect(Math.abs(value - expected[index]!)).toBeLessThan(1e-12));
			expect(validateAuthoringDocument(current)).toMatchObject({ editable: true });
		} finally { owner.document.dispose(); }
	});

	test('T-A4 erasing the container orphans the entry, stays editable, and undo re-attaches it', () => {
		const graph = managedGraph();
		const original = archJson(graph);
		const owner = ownerSession(graph);
		try {
			const erased = owner.run({ type: 'erase', selection: [{ type: 'instance', id: INSTANCE }] });
			expect(erased.instances.some((i) => i.id === INSTANCE)).toBe(false);
			expect(archJson(erased)).toBe(original);
			expect(validateAuthoringDocument(erased)).toMatchObject({ editable: true });
			expect(owner.history.undo(owner.document)).toBe(true);
			const restored = owner.document.snapshot().graph;
			expect(restored.instances.some((i) => i.id === INSTANCE)).toBe(true);
			expect(archJson(restored)).toBe(original);
			expect(validateAuthoringDocument(restored)).toMatchObject({ editable: true });
		} finally { owner.document.dispose(); }
	});

	test('T-A5 push-pull inside the container stays editable and changes the mesh hash (detach detectable)', () => {
		const graph = managedGraph();
		const before = meshHash(graph);
		const east = graph.meshes[0]!.faces.find((f) => f.holes.length === 0 && f.normal[0] > 0.99
			&& f.outer.every((v) => Math.abs(graph.meshes[0]!.positions[v * 3]! - 4) < 1e-9))!;
		const owner = ownerSession(graph);
		try {
			const pushed = owner.run({ type: 'raw', command: { kind: 'PUSH_PULL_FACE', faceId: east.id, distance: 0.25 } }, [INSTANCE]);
			expect(validateAuthoringDocument(pushed)).toMatchObject({ editable: true });
			const mesh = pushed.meshes.find((m) => m.definitionId === DEFINITION)!;
			expect(sha256(meshDigestInput(mesh))).not.toBe(before);
		} finally { owner.document.dispose(); }
	});

	test('T-A6 every malformed arch case is viewer-only with the arch reason', () => {
		const wall = (n: number) => ({ elementId: `w-${n}`, kind: 'wall', thickness: 0.15, height: 2.7, baseElevation: 0,
			path: Array.from({ length: 256 }, (_, i) => [Number((i * 0.0123456).toFixed(6)), Number((n + i * 0.0001).toFixed(6))]) });
		const orphan = (n: number) => `${DOC}:instance:op:${100 + n}:1`;
		const cases: Record<string, (arch: any, graph: any) => void> = {
			badSchema: (a) => { a.schema = 'sibambo-arch-v1'; },
			extraKey: (a) => { a.extra = 1; },
			unsorted: (a) => { a.modules.push({ instanceId: orphan(1), module: slabModule('house/a'), bakedMeshSha256: '0'.repeat(64) }); },
			duplicateModuleId: (a) => { a.modules.push({ instanceId: orphan(1), module: slabModule('house/ground'), bakedMeshSha256: '0'.repeat(64) }); },
			badHash: (a) => { a.modules[0].bakedMeshSha256 = 'ABC'; },
			wrongInstancePrefix: (a) => { a.modules[0].instanceId = `${DOC}:arch:house/ground:instance`; },
			pointsAtComponent: (_a, g) => {
				g.instances.find((i: any) => i.id === INSTANCE).kind = 'component';
				g.definitions.find((d: any) => d.id === DEFINITION).kind = 'component';
			},
			moduleTooLarge: (a) => { a.modules[0].module = slabModule('house/ground', { elements: Array.from({ length: 20 }, (_, n) => wall(n)) }); },
			tooManyEntries: (a) => {
				a.modules = Array.from({ length: 65 }, (_, n) => ({ instanceId: orphan(n), module: slabModule(`house/m${String(n).padStart(3, '0')}`), bakedMeshSha256: '0'.repeat(64) }));
			}
		};
		for (const [name, mutate] of Object.entries(cases)) {
			const result = validateAuthoringDocument(managedGraph(mutate));
			expect({ name, editable: result.editable }).toEqual({ name, editable: false });
			if (!result.editable) expect({ name, prefixed: result.reason.startsWith(ARCH_PREFIX) }).toEqual({ name, prefixed: true });
		}
	});

	test('T-A7 validating 64 modules of about 7.5 KiB each stays under 50 ms (median of 5) in Bun', () => {
		const graph = managedGraph();
		const wall = (n: number, points: number) => ({ elementId: `w-${n}`, kind: 'wall', thickness: 0.15, height: 2.7, baseElevation: 0,
			path: Array.from({ length: points }, (_, i) => [Number((i * 0.0123456).toFixed(6)), Number((n + i * 0.0001).toFixed(6))]) });
		const arch = { schema: 'sibambo-arch-v2', modules: Array.from({ length: 64 }, (_, n) => ({
			instanceId: `${DOC}:instance:op:${200 + n}:1`,
			module: { ...slabModule(`house/m${String(n).padStart(3, '0')}`), elements: [wall(1, 256), wall(2, 128)] },
			bakedMeshSha256: '0'.repeat(64)
		})) };
		const bytes = new TextEncoder().encode(JSON.stringify(arch)).length;
		expect(bytes).toBeGreaterThan(64 * 7 * 1024);
		expect(bytes).toBeLessThanOrEqual(512 * 1024);
		validateArchMetadata(arch, graph); // warm-up and correctness
		const samples: number[] = [];
		for (let i = 0; i < 5; i++) {
			const start = performance.now();
			validateArchMetadata(arch, graph);
			samples.push(performance.now() - start);
		}
		samples.sort((a, b) => a - b);
		console.log(`T-A7 arch bytes=${bytes} median_ms=${samples[2]!.toFixed(3)} samples=${samples.map((s) => s.toFixed(3)).join(',')}`);
		expect(samples[2]!).toBeLessThan(50);
	});
});
