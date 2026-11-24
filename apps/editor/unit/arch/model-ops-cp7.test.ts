/**
 * SIB-MCP-MODELING-001 v2.3 WP7 / CP7 — `model_ops` (C11) tests.
 * Covers T-E6 across all ModelAction & FlatAuthoringCommand families (raw/command,
 * group/component, transform radial & linear copy, scale, unique/explode, offset,
 * curve, follow-me, paint, erase, tags, entity-info, assets, guides), nested `path`,
 * MANAGED_MODULE refusal, T-RB1/T-RB3/T-RB9 through the real `model_ops` tool,
 * budgets/schema, Save->reopen, and AgentHost end-to-end execution.
 */
import { describe, expect, test } from 'bun:test';
import type { BomcGraph } from '@sibambo/bomc-document';
import { DEFAULT_DISPLAY_STATE } from '@sibambo/viewport';
import { LineSegments } from 'three';
import { AgentHost } from '../../src/lib/agent/agent-host.js';
import { readManaged } from '../../src/lib/arch/managed.js';
import { AuthoringClient } from '../../src/lib/authoring/bomc-authoring-client.js';
import { AuthoringWorkerDispatcher } from '../../src/lib/authoring/bomc-authoring.worker.js';
import { AuthoringHistory, graphsEqual, validateAuthoringCheckpoint } from '../../src/lib/authoring/history.js';
import { modelMetadata, modelOccurrences, validateAuthoringDocument } from '../../src/lib/authoring/model.js';
import { AUTHORING_PROTOCOL_VERSION, type AuthoringCheckpoint, type AuthoringWorkerMessage } from '../../src/lib/authoring/protocol.js';
import { projectAuthoringScene } from '../../src/lib/authoring/scene.js';
import { wall } from './fixtures/modules.js';

const DOC = '9a4b5c6d-1e2f-4a3b-8c7d-0e1f2a3b4c5d';
const SESSION = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const CONTEXT = { mode: 'authoring', path: [], selection: [] } as const;

type Reply =
	| { event: 'RESULT'; result: any }
	| { event: 'ERROR'; error: { code: string; message: string; currentRevision: number | null } };

class Harness {
	readonly messages: AuthoringWorkerMessage[] = [];
	readonly dispatcher = new AuthoringWorkerDispatcher((message) => this.messages.push(message), () => crypto.randomUUID());
	private nextId = 1;
	constructor(private readonly session = crypto.randomUUID()) {}
	get d(): any { return this.dispatcher; }
	async send(type: string, extra: Record<string, unknown> = {}): Promise<Reply> {
		const requestId = this.nextId++;
		this.dispatcher.receive({ protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: this.session, requestId, type, ...extra });
		for (let attempt = 0; attempt < 500; attempt += 1) {
			const reply = this.messages.find((m) => (m.event === 'RESULT' || m.event === 'ERROR') && (m as any).requestId === requestId) as any;
			if (reply) return reply.event === 'RESULT' ? { event: 'RESULT', result: reply.result } : { event: 'ERROR', error: reply.error };
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		throw new Error(`${type} timed out`);
	}
	async ok(type: string, extra: Record<string, unknown> = {}): Promise<any> {
		const reply = await this.send(type, extra);
		if (reply.event === 'ERROR') throw new Error(`${type} failed: ${JSON.stringify(reply.error)}`);
		return reply.result;
	}
	revision(): number { return this.d.document.snapshot().revision; }
	graph(): BomcGraph { return this.d.document.snapshot().graph; }
	history(): AuthoringHistory { return this.d.history; }
	state() {
		const checkpoint = this.history().checkpoint();
		return {
			graph: this.graph(),
			revision: this.revision(),
			undo: [...checkpoint.undo],
			redo: [...checkpoint.redo],
			sequence: this.d.sequence as number
		};
	}
	async agentCall(tool: string, args: Record<string, unknown>, slot = 'claude-code', expectedRevision: number | null = this.revision()) {
		const reply = await this.send('AGENT', { expectedRevision, data: { tool, args, slot, context: CONTEXT } });
		if (reply.event !== 'RESULT') throw new Error(`Unexpected worker error for ${tool}: ${JSON.stringify(reply.error)}`);
		return reply.result as { kind: 'agent'; toolResult: { ok: boolean; result?: any; error?: any }; authoring: any };
	}
}

async function created(documentId = DOC) {
	const harness = new Harness();
	await harness.ok('CREATE', { data: { documentId, name: 'Untitled' } });
	return harness;
}

function expectUnchanged(harness: Harness, before: ReturnType<Harness['state']>) {
	const after = harness.state();
	expect(graphsEqual(after.graph, before.graph)).toBe(true);
	expect(after.revision).toBe(before.revision);
	expect(after.sequence).toBe(before.sequence);
	expect(after.undo.length).toBe(before.undo.length);
	expect(after.redo.length).toBe(before.redo.length);
	after.undo.forEach((entry, index) => expect(entry).toBe(before.undo[index]!));
	after.redo.forEach((entry, index) => expect(entry).toBe(before.redo[index]!));
}

describe('WP7 / CP7 — model_ops action families (T-E6)', () => {
	test('command lowering, raw, push-pull, group, nested path, radial transform, scale, offset, paint, and erase', async () => {
		const harness = await created();

		// 1. Composite call using shorthand `{command}`, explicit `{action:{type:'raw'}}`, and bounds check
		const r1 = await harness.agentCall('model_ops', {
			ops: [
				{
					command: {
						kind: 'CREATE_RECTANGLE',
						points: [[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2]],
						normal: [0, 1, 0]
					}
				},
				{ action: { type: 'raw', command: { kind: 'PUSH_PULL_FACE', faceId: `${DOC}:rectangle:1`, distance: 1.5 } } }
			]
		});
		expect(r1.toolResult.ok).toBe(true);
		expect(r1.toolResult.result.revision).toBe(1);
		expect(r1.toolResult.result.changed).toBe(true);
		expect(r1.toolResult.result.entityIds).toEqual([`${DOC}:rectangle:1`]);
		expect(r1.toolResult.result.bounds).toEqual({ min: [0, 0, 0], max: [2, 1.5, 2] });
		expect(harness.state().undo).toHaveLength(1);
		expect(harness.state().undo[0]!.origin).toBe('agent:claude-code');
		expect(validateAuthoringDocument(harness.graph()).editable).toBe(true);

		const rootMesh = harness.graph().meshes.find((m) => m.definitionId === harness.graph().rootDefinitionId)!;
		expect(rootMesh.faces).toHaveLength(6);
		const faceSelection = rootMesh.faces.map((f) => ({ type: 'face' as const, id: f.id }));

		// 2. Group the 6 root faces into a container, then create a nested rectangle inside via `path: [pillarId]`
		const rGroup = await harness.agentCall('model_ops', {
			ops: [{ action: { type: 'group', selection: faceSelection, containerKind: 'group', name: 'Column' } }]
		});
		expect(rGroup.toolResult.ok).toBe(true);
		const pillarId = rGroup.toolResult.result.entityIds[0] as string;
		expect(pillarId).toContain(':instance:');

		const rInside = await harness.agentCall('model_ops', {
			ops: [
				{
					path: [pillarId],
					command: { kind: 'CREATE_FACE_LOOP', points: [[0.5, 1.5, 0.5], [1.5, 1.5, 0.5], [1.5, 1.5, 1.5], [0.5, 1.5, 1.5]], normal: [0, 1, 0] }
				},
				{
					action: {
						type: 'paint',
						selection: [{ type: 'instance', id: pillarId }],
						name: 'Concrete',
						rgba: [180, 180, 175, 255],
						opacityU16: 65535,
						side: 'both'
					}
				},
				{
					action: {
						type: 'transform',
						selection: [{ type: 'instance', id: pillarId }],
						delta: [0, 0, 0],
						copy: true,
						count: 3,
						spacing: 'multiply',
						radial: { axis: 'y', pivot: [5, 0, 5], angleDegrees: 90 }
					}
				}
			]
		});
		expect(rInside.toolResult.ok).toBe(true);
		// Original + 3 radial clones = 4 occurrences of Column
		const columnInsts = harness.graph().instances.filter((i) => i.name === 'Column');
		expect(columnInsts).toHaveLength(4);
		expect(validateAuthoringDocument(harness.graph()).editable).toBe(true);

		// 3. Scale + offset + erase on a cloned instance & fresh face
		const cloneId = columnInsts[1]!.id;
		const rEditClone = await harness.agentCall('model_ops', {
			ops: [
				{
					action: {
						type: 'scale',
						selection: [{ type: 'instance', id: cloneId }],
						factors: [1, 2, 1],
						pivot: [0, 0, 0],
						copy: false
					}
				},
				{
					action: {
						type: 'erase',
						selection: [{ type: 'instance', id: columnInsts[3]!.id }]
					}
				}
			]
		});
		expect(rEditClone.toolResult.ok).toBe(true);
		expect(harness.graph().instances.filter((i) => i.name === 'Column')).toHaveLength(3);

		// Verify scene projection & source edges on resulting model
		const proj = projectAuthoringScene(harness.d.document.snapshot(), DEFAULT_DISPLAY_STATE);
		let edgeCount = 0;
		proj.group.traverse((obj) => {
			if (obj instanceof LineSegments && obj.name === 'editor-authoring-source-edges') edgeCount += 1;
		});
		expect(edgeCount).toBeGreaterThan(0);

		// 4. Separate root face offset test (inward band on planar rectangle)
		const rOffset = await harness.agentCall('model_ops', {
			ops: [
				{
					command: {
						kind: 'CREATE_RECTANGLE',
						points: [[10, 0, 0], [14, 0, 0], [14, 0, 4], [10, 0, 4]],
						normal: [0, 1, 0]
					}
				}
			]
		});
		expect(rOffset.toolResult.ok).toBe(true);
		const padFaceId = rOffset.toolResult.result.entityIds[0] as string;
		const rInset = await harness.agentCall('model_ops', {
			ops: [{ action: { type: 'offset', faceId: padFaceId, distance: 0.5 } }]
		});
		expect(rInset.toolResult.ok).toBe(true);
		expect(validateAuthoringDocument(harness.graph()).editable).toBe(true);
	});

	test('curve, follow-me, unique, explode, entity-info, tag-*, asset-*, guide, and clear-guides families', async () => {
		const harness = await created();

		// 1. Curve + guide + clear-guides + bounds
		const rCurve = await harness.agentCall('model_ops', {
			ops: [
				{
					action: {
						type: 'curve',
						curveKind: 'arc',
						center: [0, 0, 0],
						first: [2, 0, 0],
						normal: [0, 1, 0],
						segments: 6,
						sweepDegrees: 180
					}
				},
				{ action: { type: 'guide', start: [0, 0, 0], end: [0, 2, 0], guideKind: 'line' } }
			]
		});
		expect(rCurve.toolResult.ok).toBe(true);
		expect(modelMetadata(harness.graph()).looseEdges).toHaveLength(6);
		expect(modelMetadata(harness.graph()).guides).toHaveLength(1);
		expect(rCurve.toolResult.result.bounds).not.toBeNull();

		const rClear = await harness.agentCall('model_ops', {
			ops: [{ action: { type: 'clear-guides' } }]
		});
		expect(rClear.toolResult.ok).toBe(true);
		expect(modelMetadata(harness.graph()).guides).toHaveLength(0);

		// 2. Follow-me profile along explicit root mesh edges
		const sweepHarness = await created();
		const sweepPrep = await sweepHarness.agentCall('model_ops', {
			ops: [
				{
					command: {
						kind: 'CREATE_FACE_LOOP',
						points: [[0, 0.2, -0.1], [0, 0.4, -0.1], [0, 0.4, 0.1], [0, 0.2, 0.1]],
						normal: [1, 0, 0]
					}
				},
				{
					command: {
						kind: 'CREATE_RECTANGLE',
						points: [[0, 0, 0], [4, 0, 0], [4, 0, 3], [0, 0, 3]],
						normal: [0, 1, 0]
					}
				}
			]
		});
		expect(sweepPrep.toolResult.ok).toBe(true);
		const profId = sweepPrep.toolResult.result.entityIds[0] as string;
		const rFollow = await sweepHarness.agentCall('model_ops', {
			ops: [
				{
					action: {
						type: 'follow-me',
						faceId: profId,
						edges: [
							{ start: [0, 0, 0], end: [4, 0, 0] },
							{ start: [4, 0, 0], end: [4, 0, 3] }
						]
					}
				}
			]
		});
		expect(rFollow.toolResult.ok).toBe(true);
		expect(rFollow.toolResult.result.entityIds[0]).toContain(':sweep:');
		expect(validateAuthoringDocument(sweepHarness.graph()).editable).toBe(true);

		// 3. Organization actions: CREATE_RECTANGLE(first/opposite) -> EXTRUDE_RECTANGLE -> group -> asset-create -> asset-insert -> unique -> entity-info -> tag-create/assign/visibility -> explode -> asset-delete
		const orgHarness = await created();
		const makeBox = await orgHarness.agentCall('model_ops', {
			ops: [
				{ command: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } }
			]
		});
		expect(makeBox.toolResult.ok).toBe(true);
		const rectId = makeBox.toolResult.result.entityIds[0] as string;
		const extrudeRes = await orgHarness.agentCall('model_ops', {
			ops: [{ command: { kind: 'PUSH_PULL_FACE', faceId: rectId, distance: 1.0 } }]
		});
		expect(extrudeRes.toolResult.ok).toBe(true);
		const extrudedFaces = orgHarness.graph().meshes[0]!.faces.map((f) => ({ type: 'face' as const, id: f.id }));
		const gBox = await orgHarness.agentCall('model_ops', {
			ops: [
				{ action: { type: 'group', selection: extrudedFaces, containerKind: 'group', name: 'Tile' } },
				{ action: { type: 'tag-create', name: 'Furniture' } }
			]
		});
		expect(gBox.toolResult.ok).toBe(true);
		const [tileInstId, tagId] = gBox.toolResult.result.entityIds as [string, string];

		const rAsset = await orgHarness.agentCall('model_ops', {
			ops: [
				{ action: { type: 'asset-create', instanceId: tileInstId, name: 'TileAsset' } },
				{ action: { type: 'tag-assign', instanceIds: [tileInstId], tagId } },
				{ action: { type: 'entity-info', instanceId: tileInstId, name: 'TileRenamed', visible: true } }
			]
		});
		expect(rAsset.toolResult).toEqual({ ok: true, result: expect.any(Object) });
		const assetId = rAsset.toolResult.result.entityIds[0] as string;
		expect(assetId).toContain(':asset:');

		const rInsert = await orgHarness.agentCall('model_ops', {
			ops: [
				{ action: { type: 'asset-insert', assetId, point: [4, 0, 0] } },
				{ action: { type: 'tag-visibility', tagId, visible: false } }
			]
		});
		expect(rInsert.toolResult.ok).toBe(true);
		const insertedInstId = rInsert.toolResult.result.entityIds[0] as string;
		// Hidden via tag-visibility false
		expect(modelOccurrences(orgHarness.graph()).some((o) => o.path.includes(tileInstId))).toBe(false);

		const rUniqueExplode = await orgHarness.agentCall('model_ops', {
			ops: [
				{ action: { type: 'tag-visibility', tagId, visible: true } },
				{ action: { type: 'unique', instanceId: insertedInstId } },
				{ action: { type: 'explode', instanceId: tileInstId } },
				{ action: { type: 'asset-delete', assetId } }
			]
		});
		expect(rUniqueExplode.toolResult.ok).toBe(true);
		expect(modelMetadata(orgHarness.graph()).organization?.assets).toHaveLength(0);
		expect(validateAuthoringDocument(orgHarness.graph()).editable).toBe(true);
	});
});

describe('WP7 / CP7 — MANAGED_MODULE refusal & mixed arch/freeform safety (T-E6)', () => {
	test('refuses touching managed modules across path, selection, faceId, instanceId, tag-assign; preserves arch while freeform edits succeed', async () => {
		const harness = await created();
		const mRes = await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/ground' },
				{ op: 'add', moduleId: 'house/ground', element: wall('w1', [[0, 0], [4, 0]]) }
			]
		});
		expect(mRes.toolResult.ok).toBe(true);
		const managed = readManaged(harness.graph()).get('house/ground')!;
		expect(managed.state).toBe('ok');
		const managedInstId = managed.instance!.id;
		const managedDef = harness.graph().definitions.find((d) => d.id === managed.instance!.definitionId)!;
		const managedFaceId = harness.graph().meshes.find((m) => m.id === managedDef.meshId)!.faces[0]!.id;
		const before = harness.state();

		const disallowedOps: Record<string, unknown>[] = [
			{ ops: [{ path: [managedInstId], action: { type: 'guide', start: [0, 0, 0], end: [1, 0, 0], guideKind: 'line' } }] },
			{ ops: [{ action: { type: 'erase', selection: [{ type: 'instance', id: managedInstId }] } }] },
			{ ops: [{ action: { type: 'paint', selection: [{ type: 'face', id: managedFaceId }], name: 'Red', rgba: [200, 0, 0, 255], opacityU16: 65535, side: 'front' } }] },
			{ ops: [{ command: { kind: 'PUSH_PULL_FACE', faceId: managedFaceId, distance: 0.5 } }] },
			{ ops: [{ action: { type: 'offset', faceId: managedFaceId, distance: 0.1 } }] },
			{ ops: [{ action: { type: 'unique', instanceId: managedInstId } }] },
			{ ops: [{ action: { type: 'explode', instanceId: managedInstId } }] },
			{ ops: [{ action: { type: 'entity-info', instanceId: managedInstId, name: 'Hack', visible: false } }] },
			{ ops: [{ action: { type: 'asset-create', instanceId: managedInstId, name: 'Bad' } }] },
			{ ops: [{ action: { type: 'tag-assign', instanceIds: [managedInstId], tagId: null } }] }
		];

		for (const args of disallowedOps) {
			const reply = await harness.agentCall('model_ops', args);
			expect(reply.toolResult.ok).toBe(false);
			expect(reply.toolResult.error).toMatchObject({ code: 'MANAGED_MODULE', retryable: false, detail: { moduleId: 'house/ground' } });
			expect(reply.authoring).toBeNull();
			expectUnchanged(harness, before);
		}

		// Valid freeform model_ops alongside managed module leaves arch intact and state 'ok'
		const freeform = await harness.agentCall('model_ops', {
			ops: [
				{ command: { kind: 'CREATE_RECTANGLE', points: [[6, 0, 0], [8, 0, 0], [8, 0, 2], [6, 0, 2]], normal: [0, 1, 0] } },
				{ command: { kind: 'PUSH_PULL_FACE', faceId: `${DOC}:rectangle:${harness.state().sequence}`, distance: 1.0 } }
			]
		});
		expect(freeform.toolResult.ok).toBe(true);
		expect(readManaged(harness.graph()).get('house/ground')!.state).toBe('ok');
		expect(validateAuthoringDocument(harness.graph()).editable).toBe(true);
	});
});

describe('WP7 / CP7 — Atomic rollback, budgets, Save->reopen, and AgentHost (T-RB1, T-RB3, T-RB9, T-E6)', () => {
	test('T-RB1 & T-RB3 through real model_ops: partial failure leaves graph, revision, redo stack, and sequence unchanged', async () => {
		const harness = await created();
		await harness.ok('COMMAND', { expectedRevision: 0, data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } });
		const withOwnerRect = harness.graph();
		await harness.ok('UNDO', { expectedRevision: 1 });
		const before = harness.state();
		expect(before.redo).toHaveLength(1);

		const failReply = await harness.agentCall('model_ops', {
			ops: [
				{ command: { kind: 'CREATE_RECTANGLE', points: [[3, 0, 0], [4, 0, 0], [4, 0, 1], [3, 0, 1]], normal: [0, 1, 0] } },
				{ command: { kind: 'PUSH_PULL_FACE', faceId: `${DOC}:rectangle:999`, distance: 0.5 } }
			]
		});
		expect(failReply.toolResult.ok).toBe(false);
		expect(failReply.toolResult.error).toMatchObject({ code: 'INVALID_COMMAND', detail: { opIndex: 1 } });
		expect(failReply.authoring).toBeNull();
		expectUnchanged(harness, before);

		await harness.ok('REDO', { expectedRevision: harness.revision() });
		expect(graphsEqual(harness.graph(), withOwnerRect)).toBe(true);
	});

	test('schema rejections, 32-op / 256-KiB budgets, Save->reopen round-trip, and undo/redo composite', async () => {
		const harness = await created();
		const before = harness.state();

		for (const badArgs of [
			{},
			{ ops: [] },
			{ ops: [{ command: { kind: 'UNKNOWN' } }] },
			{ ops: [{ action: { type: 'group', selection: [], containerKind: 'group', name: 'X' } }] },
			{ ops: [{ command: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] }, extra: true }] }
		]) {
			const r = await harness.agentCall('model_ops', badArgs);
			expect(r.toolResult.ok).toBe(false);
			expect(r.toolResult.error.code).toBe('INVALID_REQUEST');
			expectUnchanged(harness, before);
		}

		// > 32 ops -> BUDGET_EXCEEDED
		const thirtyThree = Array.from({ length: 33 }, (_, i) => ({
			action: { type: 'guide', start: [i, 0, 0], end: [i, 1, 0], guideKind: 'line' }
		}));
		const overOps = await harness.agentCall('model_ops', { ops: thirtyThree });
		expect(overOps.toolResult.ok).toBe(false);
		expect(overOps.toolResult.error.code).toBe('BUDGET_EXCEEDED');
		expectUnchanged(harness, before);

		// > 256 KiB -> BUDGET_EXCEEDED
		const oversized = await harness.agentCall('model_ops', {
			ops: [{ action: { type: 'guide', start: [0, 0, 0], end: [1, 0, 0], guideKind: 'line' } }],
			padding: 'x'.repeat(265 * 1024)
		} as any);
		expect(oversized.toolResult.ok).toBe(false);
		expect(oversized.toolResult.error.code).toBe('BUDGET_EXCEEDED');
		expectUnchanged(harness, before);

		// T-RB9 / Save -> reopen round-trip of model_ops composite alongside arch module
		await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/ground' },
				{ op: 'add', moduleId: 'house/ground', element: wall('w1', [[0, 0], [4, 0]]) }
			]
		});
		const preOps = harness.state();
		const s0 = preOps.sequence;
		const comp = await harness.agentCall('model_ops', {
			ops: [
				{ command: { kind: 'CREATE_RECTANGLE', points: [[10, 0, 0], [12, 0, 0], [12, 0, 2], [10, 0, 2]], normal: [0, 1, 0] } },
				{ command: { kind: 'PUSH_PULL_FACE', faceId: `${DOC}:rectangle:${s0}`, distance: 1.2 } }
			]
		});
		expect(comp.toolResult.ok).toBe(true);
		const afterComp = harness.state();
		expect(() => validateAuthoringCheckpoint(structuredClone(harness.d.authoringResult().checkpoint) as AuthoringCheckpoint)).not.toThrow();

		const written = await harness.ok('WRITE', { expectedRevision: harness.revision() });
		await harness.ok('ACK_DOWNLOAD', { expectedRevision: harness.revision(), data: { writeId: written.writeId, revision: written.revision } });

		const reopened = new Harness();
		const opened = await reopened.ok('OPEN', { data: { ownedBuffer: written.ownedBuffer } });
		expect(opened.kind).toBe('authoring');
		expect(graphsEqual(reopened.graph(), afterComp.graph)).toBe(true);
		expect(readManaged(reopened.graph()).get('house/ground')!.state).toBe('ok');

		// Agent undo reverts whole composite cleanly back to preOps graph
		const undone = await harness.agentCall('undo', { steps: 1 });
		expect(undone.toolResult.ok).toBe(true);
		expect(graphsEqual(harness.graph(), preOps.graph)).toBe(true);
	});

	test('AgentHost + AuthoringClient execute real model_ops end-to-end and undo cleanly', async () => {
		class AdapterWorker extends EventTarget {
			readonly dispatcher = new AuthoringWorkerDispatcher((message, transfer) => {
				const data = structuredClone(message, { transfer: transfer ?? [] });
				queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
			});
			postMessage(message: unknown, transfer: Transferable[] = []) {
				const data = structuredClone(message, { transfer });
				queueMicrotask(() => this.dispatcher.receive(data));
			}
			terminate() {}
		}

		const client = new AuthoringClient({
			sessionId: SESSION,
			documentIdFactory: () => DOC,
			workerFactory: () => new AdapterWorker() as unknown as Worker
		});
		try {
			await client.create();
			const host = new AgentHost({
				getClient: () => client,
				getCheckpoint: () => client.checkpoint,
				accept: () => 'rendered',
				isOwnerBusy: () => false,
				getModeling: () => ({ path: [], selection: [] }),
				getMode: () => 'authoring'
			});

			const seq = client.checkpoint!.sequence;
			const reply = await host.handle({
				id: 'm1',
				slot: 'codex',
				session: 's1',
				tool: 'model_ops',
				args: {
					ops: [
						{ command: { kind: 'CREATE_RECTANGLE', points: [[0, 0, 0], [3, 0, 0], [3, 0, 2], [0, 0, 2]], normal: [0, 1, 0] } },
						{ command: { kind: 'PUSH_PULL_FACE', faceId: `${DOC}:rectangle:${seq}`, distance: 2.0 } }
					]
				}
			});
			expect(reply.ok).toBe(true);
			expect(reply.committed!.revision).toBe(1);
			expect(reply.committed!.entityIds).toEqual([`${DOC}:rectangle:${seq}`]);
			expect((reply as any).result.bounds).toEqual({ min: [0, 0, 0], max: [3, 2, 2] });
			expect(client.checkpoint!.history.undo.at(-1)!.origin).toBe('agent:codex');

			const undoReply = await host.handle({ id: 'm2', slot: 'codex', session: 's1', tool: 'undo', args: { steps: 1 } });
			expect(undoReply.ok).toBe(true);
			expect(undoReply.committed!.revision).toBe(2);
			expect(client.checkpoint!.snapshot.graph.meshes).toHaveLength(0);
		} finally {
			await client.close();
		}
	});
});
