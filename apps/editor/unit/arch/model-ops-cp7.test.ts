/**
 * SIB-MCP-MODELING-001 v2.3 WP7 / CP7 — `model_ops` (C11) tests.
 * Covers T-E6 across all ModelAction & FlatAuthoringCommand families (raw/command,
 * group/component, transform radial & linear copy, scale, unique/explode, offset,
 * curve, follow-me, paint, erase, tags, entity-info, assets, guides), nested `path`,
 * MANAGED_MODULE refusal, T-RB1/T-RB3/T-RB9 through the real `model_ops` tool,
 * budgets/schema, Save->reopen, and AgentHost end-to-end execution.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BomcGraph, DocumentEdit } from '@sibambo/bomc-document';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { DEFAULT_DISPLAY_STATE } from '@sibambo/viewport';
import { LineSegments } from 'three';
import { AgentHost } from '../../src/lib/agent/agent-host.js';
import { IDENTITY_ROW_MAJOR } from '../../src/lib/arch/convention.js';
import { readManaged } from '../../src/lib/arch/managed.js';
import { AuthoringClient } from '../../src/lib/authoring/bomc-authoring-client.js';
import { AuthoringWorkerDispatcher, compactAgentEdits } from '../../src/lib/authoring/bomc-authoring.worker.js';
import { AuthoringHistory, graphsEqual, validateAuthoringCheckpoint } from '../../src/lib/authoring/history.js';
import { buildModelEdit, modelMetadata, modelOccurrences, nextModelSequence, validateAuthoringDocument } from '../../src/lib/authoring/model.js';
import { AUTHORING_PROTOCOL_VERSION, type AuthoringCheckpoint, type AuthoringWorkerMessage, type ModelAction } from '../../src/lib/authoring/protocol.js';
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
		const rootMesh = harness.graph().meshes.find((m) => m.definitionId === harness.graph().rootDefinitionId)!;
		expect(rootMesh.faces).toHaveLength(6);
		expect(r1.toolResult.result.entityIds).not.toContain(harness.graph().rootInstanceId);
		expect(new Set(r1.toolResult.result.entityIds).size).toBe(6);
		expect([...r1.toolResult.result.entityIds].sort()).toEqual(rootMesh.faces.map((f) => f.id).sort());
		expect(r1.toolResult.result.bounds).toEqual({ min: [0, 0, 0], max: [2, 1.5, 2] });
		expect(harness.state().undo).toHaveLength(1);
		expect(harness.state().undo[0]!.origin).toBe('agent:claude-code');
		expect(validateAuthoringDocument(harness.graph()).editable).toBe(true);
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
		expect((rFollow.toolResult.result.entityIds as string[]).some((id) => id.includes(':sweep:'))).toBe(true);
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
			const hostFaces = client.checkpoint!.snapshot.graph.meshes.find((m) => m.definitionId === client.checkpoint!.snapshot.graph.rootDefinitionId)!.faces.map((f) => f.id).sort();
			expect([...reply.committed!.entityIds].sort()).toEqual(hostFaces);
			expect(reply.committed!.entityIds).not.toContain(client.checkpoint!.snapshot.graph.rootInstanceId);
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

describe('WP7 / CP7 — Complete deterministic entityIds receipts & indirect managed protection', () => {
	test('reports exact deduplicated entityIds for radial/linear copy, multi-selection ops, and metadata without synthetic root leakage', async () => {
		const runScenario = async () => {
			const harness = await created();
			const rootId = harness.graph().rootInstanceId;

			// 1. Two independent rectangular faces + linear 3-copy on BOTH selected faces -> 6 exact copied faces
			const prep = await harness.agentCall('model_ops', {
				ops: [
					{ command: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } },
					{ command: { kind: 'CREATE_RECTANGLE', first: [0, 0, 2], opposite: [1, 0, 3] } }
				]
			});
			expect(prep.toolResult.ok).toBe(true);
			const [faceA, faceB] = prep.toolResult.result.entityIds as [string, string];
			expect(prep.toolResult.result.entityIds).not.toContain(rootId);

			const linearCopy = await harness.agentCall('model_ops', {
				ops: [
					{
						action: {
							type: 'transform',
							selection: [
								{ type: 'face', id: faceA },
								{ type: 'face', id: faceB }
							],
							delta: [2, 0, 0],
							copy: true,
							count: 3,
							spacing: 'multiply',
							radial: null
						}
					}
				]
			});
			expect(linearCopy.toolResult.ok).toBe(true);
			const linearIds = linearCopy.toolResult.result.entityIds as string[];
			expect(linearIds).toHaveLength(6);
			expect(new Set(linearIds).size).toBe(6);
			expect(linearIds).not.toContain(rootId);
			expect(linearIds).not.toContain(faceA);
			expect(linearIds).not.toContain(faceB);

			// 2. Multi-selection paint + move + erase reports ALL selected faces, not only index 0 or last
			const painted = await harness.agentCall('model_ops', {
				ops: [
					{
						action: {
							type: 'paint',
							selection: [
								{ type: 'face', id: faceA },
								{ type: 'face', id: faceB }
							],
							name: 'Plaster',
							rgba: [220, 220, 210, 255],
							opacityU16: 65535,
							side: 'both'
						}
					}
				]
			});
			expect(painted.toolResult.result.entityIds).toEqual([faceA, faceB].sort());

			const moved = await harness.agentCall('model_ops', {
				ops: [
					{
						action: {
							type: 'transform',
							selection: [
								{ type: 'face', id: faceA },
								{ type: 'face', id: faceB }
							],
							delta: [0, 0.5, 0],
							copy: false,
							count: 1,
							spacing: 'multiply',
							radial: null
						}
					}
				]
			});
			expect(moved.toolResult.result.entityIds).toEqual([faceA, faceB].sort());

			// 3. Container + radial 3-copy returns ALL 3 cloned instance IDs (not just clone #3)
			const grp = await harness.agentCall('model_ops', {
				ops: [{ action: { type: 'group', selection: [{ type: 'face', id: faceA }], containerKind: 'group', name: 'Pillar' } }]
			});
			const pillarId = grp.toolResult.result.entityIds[0] as string;
			expect(grp.toolResult.result.entityIds).toEqual([pillarId]);

			const radialCopy = await harness.agentCall('model_ops', {
				ops: [
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
			expect(radialCopy.toolResult.ok).toBe(true);
			const cloneIds = radialCopy.toolResult.result.entityIds as string[];
			expect(cloneIds).toHaveLength(3);
			expect(new Set(cloneIds).size).toBe(3);
			expect(cloneIds).not.toContain(pillarId);
			expect(cloneIds).not.toContain(rootId);
			const expectedClones = harness.graph().instances.filter((i) => i.name === 'Pillar' && i.id !== pillarId).map((i) => i.id).sort();
			expect(cloneIds).toEqual(expectedClones);

			// 4. Multi-instance tag-assign + tag-create + tag-visibility + guide + clear-guides -> ZERO rootId leakage
			const multiMeta = await harness.agentCall('model_ops', {
				ops: [
					{ action: { type: 'tag-create', name: 'Columns' } },
					{ action: { type: 'guide', start: [0, 0, 0], end: [0, 3, 0], guideKind: 'line' } }
				]
			});
			expect(multiMeta.toolResult.ok).toBe(true);
			const [tagId, guideId] = multiMeta.toolResult.result.entityIds as [string, string];
			expect(multiMeta.toolResult.result.entityIds).toHaveLength(2);
			expect(tagId).toContain(':tag:');
			expect(guideId).toContain(':guide:');
			expect(multiMeta.toolResult.result.entityIds).not.toContain(rootId);

			const assigned = await harness.agentCall('model_ops', {
				ops: [
					{ action: { type: 'tag-assign', instanceIds: [cloneIds[0]!, cloneIds[1]!], tagId } },
					{ action: { type: 'tag-visibility', tagId, visible: false } },
					{ action: { type: 'clear-guides' } }
				]
			});
			expect(assigned.toolResult.ok).toBe(true);
			expect(assigned.toolResult.result.entityIds).toEqual([...[cloneIds[0]!, cloneIds[1]!].sort(), tagId, guideId]);
			expect(assigned.toolResult.result.entityIds).not.toContain(rootId);

			// clear-guides on empty guides -> [] (no rootId)
			const emptyClear = await harness.agentCall('model_ops', { ops: [{ action: { type: 'clear-guides' } }] });
			expect(emptyClear.toolResult.ok).toBe(true);
			expect(emptyClear.toolResult.result.entityIds).toEqual([]);
			expect(emptyClear.toolResult.result.entityIds).not.toContain(rootId);

			// multi-erase on two cloned instances returns both deleted IDs
			const erasedInsts = await harness.agentCall('model_ops', {
				ops: [
					{
						action: {
							type: 'erase',
							selection: [
								{ type: 'instance', id: cloneIds[0]! },
								{ type: 'instance', id: cloneIds[2]! }
							]
						}
					}
				]
			});
			expect(erasedInsts.toolResult.ok).toBe(true);
			expect(erasedInsts.toolResult.result.entityIds).toEqual([cloneIds[0]!, cloneIds[2]!].sort());

			return {
				linearIds,
				radialIds: cloneIds,
				assignedIds: assigned.toolResult.result.entityIds as string[],
				erasedIds: erasedInsts.toolResult.result.entityIds as string[]
			};
		};

		const run1 = await runScenario();
		const run2 = await runScenario();
		expect(run1).toEqual(run2);
	});

	test('indirect MANAGED_MODULE protection blocks ancestor wrappers (multi-level) and shared definition/mesh aliases while allowing safe sibling freeform ops', async () => {
		const harness = await created();
		const mRes = await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/ground' },
				{ op: 'add', moduleId: 'house/ground', element: wall('w1', [[0, 0], [4, 0]]) }
			]
		});
		expect(mRes.toolResult.ok).toBe(true);
		const managedInstId = readManaged(harness.graph()).get('house/ground')!.instance!.id;

		// Owner wraps managed instance inside Inner -> Outer ancestor containers via normal MODEL_EDIT group
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: {
				kind: 'MODEL_EDIT',
				path: [],
				action: { type: 'group', selection: [{ type: 'instance', id: managedInstId }], containerKind: 'group', name: 'InnerWrapper' }
			}
		});
		const innerId = harness.graph().instances.find((i) => i.name === 'InnerWrapper')!.id;

		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: {
				kind: 'MODEL_EDIT',
				path: [],
				action: { type: 'group', selection: [{ type: 'instance', id: innerId }], containerKind: 'group', name: 'OuterWrapper' }
			}
		});
		const outerId = harness.graph().instances.find((i) => i.name === 'OuterWrapper')!.id;
		expect(readManaged(harness.graph()).get('house/ground')!.state).toBe('ok');
		expect(validateAuthoringDocument(harness.graph()).editable).toBe(true);

		const beforeAncestor = harness.state();
		const ancestorBlockedOps: Record<string, unknown>[] = [
			{ ops: [{ action: { type: 'erase', selection: [{ type: 'instance', id: outerId }] } }] },
			{ ops: [{ action: { type: 'erase', selection: [{ type: 'instance', id: innerId }] } }] },
			{ ops: [{ action: { type: 'explode', instanceId: outerId } }] },
			{ ops: [{ action: { type: 'unique', instanceId: outerId } }] },
			{ ops: [{ action: { type: 'paint', selection: [{ type: 'instance', id: outerId }], name: 'Red', rgba: [200, 0, 0, 255], opacityU16: 65535, side: 'both' } }] },
			{ ops: [{ action: { type: 'transform', selection: [{ type: 'instance', id: outerId }], delta: [2, 0, 0], copy: false, count: 1, spacing: 'multiply', radial: null } }] },
			{ ops: [{ action: { type: 'scale', selection: [{ type: 'instance', id: outerId }], factors: [2, 1, 1], pivot: [0, 0, 0], copy: false } }] },
			{ ops: [{ action: { type: 'entity-info', instanceId: outerId, name: 'RenamedOuter', visible: false } }] },
			{ ops: [{ action: { type: 'asset-create', instanceId: outerId, name: 'WrappedAsset' } }] },
			{ ops: [{ action: { type: 'tag-assign', instanceIds: [outerId], tagId: null } }] },
			{ ops: [{ action: { type: 'group', selection: [{ type: 'instance', id: outerId }], containerKind: 'group', name: 'ThirdLevel' } }] },
			{ ops: [{ path: [outerId], action: { type: 'erase', selection: [{ type: 'instance', id: innerId }] } }] },
			{ ops: [{ path: [outerId, innerId], action: { type: 'erase', selection: [{ type: 'instance', id: managedInstId }] } }] }
		];

		for (const args of ancestorBlockedOps) {
			const reply = await harness.agentCall('model_ops', args);
			expect(reply.toolResult.ok).toBe(false);
			expect(reply.toolResult.error).toMatchObject({ code: 'MANAGED_MODULE', retryable: false, detail: { moduleId: 'house/ground' } });
			expectUnchanged(harness, beforeAncestor);
		}

		// Sibling freeform geometry inside OuterWrapper works without mutating managedInstId
		const siblingOk = await harness.agentCall('model_ops', {
			ops: [{ path: [outerId], command: { kind: 'CREATE_RECTANGLE', first: [6, 0, 0], opposite: [8, 0, 2] } }]
		});
		expect(siblingOk.toolResult.ok).toBe(true);
		expect(readManaged(harness.graph()).get('house/ground')!.state).toBe('ok');

		// Shared definition alias & shared component wrapper containing managedInst (admitted by BomcDocument/validateAuthoringDocument)
		const seq = nextModelSequence(harness.graph());
		const aliasGraph = structuredClone(harness.graph()) as any;
		const managedInst = aliasGraph.instances.find((i: any) => i.id === managedInstId)!;
		const innerCompDef = aliasGraph.definitions.find((d: any) => d.id === managedInst.ownerDefinitionId)!;
		innerCompDef.kind = 'component';
		const innerInst = aliasGraph.instances.find((i: any) => i.id === innerId)!;
		innerInst.kind = 'component';
		const outerInst = aliasGraph.instances.find((i: any) => i.id === outerId)!;
		const secondCompWrapperId = `${DOC}:instance:op:${seq}:1`;
		const aliasDefInstId = `${DOC}:instance:op:${seq}:2`;
		aliasGraph.instances.push(
			{
				...innerInst,
				id: secondCompWrapperId,
				name: 'SecondComponentWrapper',
				ownerDefinitionId: aliasGraph.rootDefinitionId
			},
			{
				...managedInst,
				id: aliasDefInstId,
				name: 'DefAlias',
				ownerDefinitionId: aliasGraph.rootDefinitionId
			}
		);
		// Recompute sorted instances list via BomcDocument
		aliasGraph.instances.sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const aliasDoc = BomcDocument.fromGraph(aliasGraph);
		const aliasSnapshot = structuredClone(aliasDoc.snapshot());
		aliasDoc.dispose();
		expect(validateAuthoringDocument(aliasSnapshot.graph).editable).toBe(true);

		const aliasHarness = new Harness();
		await aliasHarness.ok('RESTORE_CHECKPOINT', {
			data: { checkpoint: { snapshot: aliasSnapshot, sequence: nextModelSequence(aliasSnapshot.graph), history: { undo: [], redo: [], savedGraph: null } } }
		});
		const aliasBefore = aliasHarness.state();

		// Direct alias of managed definition blocks path entry & mutations
		const enterDefAlias = await aliasHarness.agentCall('model_ops', {
			ops: [{ path: [aliasDefInstId], command: { kind: 'CREATE_RECTANGLE', first: [10, 0, 0], opposite: [11, 0, 1] } }]
		});
		expect(enterDefAlias.toolResult.ok).toBe(false);
		expect(enterDefAlias.toolResult.error).toMatchObject({ code: 'MANAGED_MODULE', detail: { moduleId: 'house/ground', instanceId: aliasDefInstId } });

		for (const protectedAliasId of [aliasDefInstId, secondCompWrapperId, outerInst.id]) {
			const targetAlias = await aliasHarness.agentCall('model_ops', {
				ops: [{ action: { type: 'erase', selection: [{ type: 'instance', id: protectedAliasId }] } }]
			});
			expect(targetAlias.toolResult.ok).toBe(false);
			expect(targetAlias.toolResult.error).toMatchObject({ code: 'MANAGED_MODULE', detail: { moduleId: 'house/ground', instanceId: protectedAliasId } });
			expectUnchanged(aliasHarness, aliasBefore);
		}
		expect(readManaged(aliasHarness.graph()).get('house/ground')!.state).toBe('ok');
	});

	test('indirect MANAGED_MODULE protection blocks tag-visibility on owner-tagged module/wrapper/alias and preserves safe freeform tags + atomic composite rollback', async () => {
		const harness = await created();
		await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/ground' },
				{ op: 'add', moduleId: 'house/ground', element: wall('w1', [[0, 0], [4, 0]]) }
			]
		});
		const managedInstId = readManaged(harness.graph()).get('house/ground')!.instance!.id;

		// Owner wraps managedInst inside a wrapper group, adds a freeform group, and creates three tags
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: {
				kind: 'MODEL_EDIT',
				path: [],
				action: { type: 'group', selection: [{ type: 'instance', id: managedInstId }], containerKind: 'group', name: 'WrappedArch' }
			}
		});
		const wrapperId = harness.graph().instances.find((i) => i.name === 'WrappedArch')!.id;

		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'raw', command: { kind: 'CREATE_RECTANGLE', first: [8, 0, 0], opposite: [10, 0, 2] } } }
		});
		const freeFaceId = harness.graph().meshes.find((m) => m.definitionId === harness.graph().rootDefinitionId)!.faces[0]!.id;
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'group', selection: [{ type: 'face', id: freeFaceId }], containerKind: 'group', name: 'FreeBox' } }
		});
		const freeId = harness.graph().instances.find((i) => i.name === 'FreeBox')!.id;

		for (const tagName of ['ArchTag', 'WrapperTag', 'FreeTag']) {
			await harness.ok('COMMAND', {
				expectedRevision: harness.revision(),
				data: { kind: 'MODEL_EDIT', path: [], action: { type: 'tag-create', name: tagName } }
			});
		}
		const tags = modelMetadata(harness.graph()).organization!.tags;
		const archTagId = tags.find((t) => t.name === 'ArchTag')!.id;
		const wrapperTagId = tags.find((t) => t.name === 'WrapperTag')!.id;
		const freeTagId = tags.find((t) => t.name === 'FreeTag')!.id;

		// Owner assigns ArchTag directly inside [wrapperId] -> managedInstId, WrapperTag -> wrapperId, FreeTag -> freeId
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [wrapperId], action: { type: 'tag-assign', instanceIds: [managedInstId], tagId: archTagId } }
		});
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'tag-assign', instanceIds: [wrapperId], tagId: wrapperTagId } }
		});
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'tag-assign', instanceIds: [freeId], tagId: freeTagId } }
		});

		// Create owner undo/redo stack entry to prove atomic composite rejection leaves owner redo untouched
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'raw', command: { kind: 'CREATE_RECTANGLE', first: [12, 0, 0], opposite: [13, 0, 1] } } }
		});
		const withOwnerRedoRect = harness.graph();
		await harness.ok('UNDO', { expectedRevision: harness.revision() });
		const before = harness.state();
		expect(before.redo).toHaveLength(1);

		for (const protectedTagId of [archTagId, wrapperTagId]) {
			// Single-op tag-visibility false & true both rejected
			for (const visible of [false, true]) {
				const r = await harness.agentCall('model_ops', {
					ops: [{ action: { type: 'tag-visibility', tagId: protectedTagId, visible } }]
				});
				expect(r.toolResult.ok).toBe(false);
				expect(r.toolResult.error).toMatchObject({
					code: 'MANAGED_MODULE',
					retryable: false,
					detail: { moduleId: 'house/ground', opIndex: 0, tagId: protectedTagId }
				});
				expect(r.authoring).toBeNull();
				expectUnchanged(harness, before);
			}

			// Multi-op composite [valid freeform op (0), protected tag-visibility (1)] rejects atomically with opIndex: 1
			const composite = await harness.agentCall('model_ops', {
				ops: [
					{ command: { kind: 'CREATE_RECTANGLE', first: [20, 0, 0], opposite: [21, 0, 1] } },
					{ action: { type: 'tag-visibility', tagId: protectedTagId, visible: false } }
				]
			});
			expect(composite.toolResult.ok).toBe(false);
			expect(composite.toolResult.error).toMatchObject({
				code: 'MANAGED_MODULE',
				retryable: false,
				detail: { moduleId: 'house/ground', opIndex: 1, tagId: protectedTagId }
			});
			expect(composite.authoring).toBeNull();
			expectUnchanged(harness, before);
		}

		// Preceding failing invalid command at op 0 still surfaces INVALID_COMMAND { opIndex: 0 } rather than masking with op 1
		const invalidFirst = await harness.agentCall('model_ops', {
			ops: [
				{ command: { kind: 'PUSH_PULL_FACE', faceId: `${DOC}:rectangle:9999`, distance: 1 } },
				{ action: { type: 'tag-visibility', tagId: archTagId, visible: false } }
			]
		});
		expect(invalidFirst.toolResult.ok).toBe(false);
		expect(invalidFirst.toolResult.error).toMatchObject({ code: 'INVALID_COMMAND', detail: { opIndex: 0 } });
		expectUnchanged(harness, before);

		// Owner redo stack still works cleanly
		await harness.ok('REDO', { expectedRevision: harness.revision() });
		expect(graphsEqual(harness.graph(), withOwnerRedoRect)).toBe(true);

		// Safe freeform-only tag remains toggleable cleanly and preserves managed module
		const safeToggle = await harness.agentCall('model_ops', {
			ops: [{ action: { type: 'tag-visibility', tagId: freeTagId, visible: false } }]
		});
		expect(safeToggle.toolResult.ok).toBe(true);
		expect(safeToggle.toolResult.result.entityIds).toEqual([freeTagId]);
		expect(modelOccurrences(harness.graph()).some((o) => o.path.includes(freeId))).toBe(false);
		expect(modelOccurrences(harness.graph()).some((o) => o.path.includes(managedInstId))).toBe(true);
		expect(readManaged(harness.graph()).get('house/ground')!.state).toBe('ok');
	});

	test('indirect MANAGED_MODULE protection blocks asset-insert & asset-delete on owner-created component assets wrapping managed modules while allowing safe freeform assets', async () => {
		const harness = await created();
		await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/ground' },
				{ op: 'add', moduleId: 'house/ground', element: wall('w1', [[0, 0], [4, 0]]) }
			]
		});
		const managedInstId = readManaged(harness.graph()).get('house/ground')!.instance!.id;

		// Owner wraps managedInst inside a component container and registers it as a library asset
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: {
				kind: 'MODEL_EDIT',
				path: [],
				action: { type: 'group', selection: [{ type: 'instance', id: managedInstId }], containerKind: 'component', name: 'ArchComponent' }
			}
		});
		const compInstId = harness.graph().instances.find((i) => i.name === 'ArchComponent')!.id;
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'asset-create', instanceId: compInstId, name: 'ArchAsset' } }
		});
		const archAssetId = modelMetadata(harness.graph()).organization!.assets.find((a) => a.name === 'ArchAsset')!.id;

		// Safe freeform asset created on owner freeform box
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'raw', command: { kind: 'CREATE_RECTANGLE', first: [8, 0, 0], opposite: [9, 0, 1] } } }
		});
		const freeFaceId = harness.graph().meshes.find((m) => m.definitionId === harness.graph().rootDefinitionId)!.faces[0]!.id;
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'group', selection: [{ type: 'face', id: freeFaceId }], containerKind: 'component', name: 'FreeComp' } }
		});
		const freeCompId = harness.graph().instances.find((i) => i.name === 'FreeComp')!.id;
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'asset-create', instanceId: freeCompId, name: 'FreeAsset' } }
		});
		const freeAssetId = modelMetadata(harness.graph()).organization!.assets.find((a) => a.name === 'FreeAsset')!.id;

		// Owner redo entry check
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'raw', command: { kind: 'CREATE_RECTANGLE', first: [12, 0, 0], opposite: [13, 0, 1] } } }
		});
		await harness.ok('UNDO', { expectedRevision: harness.revision() });
		const before = harness.state();
		expect(before.redo).toHaveLength(1);

		// Refuses single-op & composite asset-insert and asset-delete against ArchAsset
		for (const badAssetOp of [
			{ action: { type: 'asset-insert', assetId: archAssetId, point: [5, 0, 0] } },
			{ action: { type: 'asset-delete', assetId: archAssetId } }
		]) {
			const single = await harness.agentCall('model_ops', { ops: [badAssetOp] });
			expect(single.toolResult.ok).toBe(false);
			expect(single.toolResult.error).toMatchObject({
				code: 'MANAGED_MODULE',
				retryable: false,
				detail: { moduleId: 'house/ground', opIndex: 0, assetId: archAssetId }
			});
			expectUnchanged(harness, before);

			const composite = await harness.agentCall('model_ops', {
				ops: [
					{ command: { kind: 'CREATE_RECTANGLE', first: [15, 0, 0], opposite: [16, 0, 1] } },
					badAssetOp
				]
			});
			expect(composite.toolResult.ok).toBe(false);
			expect(composite.toolResult.error).toMatchObject({
				code: 'MANAGED_MODULE',
				retryable: false,
				detail: { moduleId: 'house/ground', opIndex: 1, assetId: archAssetId }
			});
			expectUnchanged(harness, before);
		}

		// Even if owner erases the scene ArchComponent instance (leaving managedInst kept alive via ArchAsset alone),
		// asset-delete via model_ops is still blocked so it cannot GC & orphan the managed module!
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'erase', selection: [{ type: 'instance', id: compInstId }] } }
		});
		expect(readManaged(harness.graph()).get('house/ground')!.state).toBe('ok');
		const beforeErasedComp = harness.state();
		const delOrphaningAsset = await harness.agentCall('model_ops', {
			ops: [{ action: { type: 'asset-delete', assetId: archAssetId } }]
		});
		expect(delOrphaningAsset.toolResult.ok).toBe(false);
		expect(delOrphaningAsset.toolResult.error).toMatchObject({
			code: 'MANAGED_MODULE',
			detail: { moduleId: 'house/ground', assetId: archAssetId }
		});
		expectUnchanged(harness, beforeErasedComp);
		expect(readManaged(harness.graph()).get('house/ground')!.state).toBe('ok');

		// Safe freeform asset insert & delete continue to succeed cleanly
		const safeAssetOps = await harness.agentCall('model_ops', {
			ops: [
				{ action: { type: 'asset-insert', assetId: freeAssetId, point: [4, 0, 0] } },
				{ action: { type: 'asset-delete', assetId: freeAssetId } }
			]
		});
		expect(safeAssetOps.toolResult.ok).toBe(true);
		expect(safeAssetOps.toolResult.result.entityIds).toHaveLength(2);
		expect(safeAssetOps.toolResult.result.entityIds).toContain(freeAssetId);
		expect(readManaged(harness.graph()).get('house/ground')!.state).toBe('ok');
	});

	test('operation-level public receipt semantics across group, unique, explode, and multi-face container copies', async () => {
		const harness = await created();
		const box = await harness.agentCall('model_ops', {
			ops: [
				{ command: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } },
				{ command: { kind: 'PUSH_PULL_FACE', faceId: `${DOC}:rectangle:1`, distance: 1.0 } }
			]
		});
		const boxFaces = box.toolResult.result.entityIds as string[];
		expect(boxFaces).toHaveLength(6);

		// group reports only the newly created container instance ID (suppresses moved faces inside it)
		const grouped = await harness.agentCall('model_ops', {
			ops: [{ action: { type: 'group', selection: boxFaces.map((id) => ({ type: 'face' as const, id })), containerKind: 'group', name: 'Block' } }]
		});
		const blockId = grouped.toolResult.result.entityIds[0] as string;
		expect(grouped.toolResult.result.entityIds).toEqual([blockId]);

		// unique on blockId reports [blockId] without internal cloned mesh face IDs
		const uniqued = await harness.agentCall('model_ops', {
			ops: [{ action: { type: 'unique', instanceId: blockId } }]
		});
		expect(uniqued.toolResult.result.entityIds).toEqual([blockId]);

		// explode on blockId reports all 6 promoted faces + blockId without rootId
		const exploded = await harness.agentCall('model_ops', {
			ops: [{ action: { type: 'explode', instanceId: blockId } }]
		});
		const explodedIds = exploded.toolResult.result.entityIds as string[];
		expect(explodedIds).not.toContain(harness.graph().rootInstanceId);
		expect(explodedIds).toContain(blockId);
		expect(explodedIds.filter((id) => id.includes(':explode:'))).toHaveLength(6);
		expect(explodedIds).toHaveLength(7);
	});
});

describe('WP7 / CP7 — Mandatory T-RB9 & T-RB10 through real model_ops and v2.4 A7 isolation', () => {
	function archJson(graph: BomcGraph): string {
		return JSON.stringify((JSON.parse(graph.instances.find((i) => i.id === graph.rootInstanceId)!.label!) as any).arch);
	}

	async function setupArchRootFixture() {
		const base = BomcDocument.create({ documentId: DOC, name: 'Arch' });
		const graph = structuredClone(base.snapshot().graph) as any;
		base.dispose();
		const slabMod = {
			schemaVersion: '2.0.0',
			moduleId: 'house/ground',
			revision: 1,
			transform: [...IDENTITY_ROW_MAJOR],
			materials: [],
			elements: [{ elementId: 'slab-1', kind: 'slab', outline: [[0, 0], [4, 0], [4, 3], [0, 3]], holes: [], thickness: 0.2, topElevation: 0.2 }]
		};
		const arch = { schema: 'sibambo-arch-v2', modules: [{ instanceId: `${DOC}:instance:op:1:1`, module: slabMod, bakedMeshSha256: 'a'.repeat(64) }] };
		graph.instances[0].label = JSON.stringify({ schema: 'sibambo-editor-model-v1', guides: [], looseEdges: [], arch });
		const doc = BomcDocument.fromGraph(graph);
		const snapshot = structuredClone(doc.snapshot());
		doc.dispose();
		expect(validateAuthoringDocument(snapshot.graph).editable).toBe(true);
		const harness = new Harness();
		await harness.ok('RESTORE_CHECKPOINT', {
			data: { checkpoint: { snapshot, sequence: nextModelSequence(snapshot.graph), history: { undo: [], redo: [], savedGraph: null } } }
		});
		return harness;
	}

	const mixedModelOps = (startSeq: number) => ({
		ops: [
			{
				command: {
					kind: 'CREATE_RECTANGLE',
					points: [[0, 0, 0], [2, 0, 0], [2, 0, 1], [0, 0, 1]],
					normal: [0, 1, 0]
				}
			},
			{ command: { kind: 'PUSH_PULL_FACE', faceId: `${DOC}:rectangle:${startSeq}`, distance: 0.5 } },
			{
				command: {
					kind: 'CREATE_RECTANGLE',
					points: [[4, 0, 0], [6, 0, 0], [6, 0, 2], [4, 0, 2]],
					normal: [0, 1, 0]
				}
			},
			{ command: { kind: 'PUSH_PULL_FACE', faceId: `${DOC}:rectangle:${startSeq + 2}`, distance: 0.25 } }
		]
	});

	for (const fixture of ['fresh document (root label null)', 'document with arch metadata'] as const) {
		test(`T-RB9 4-op real model_ops passes shape, full replay, RESTORE_CHECKPOINT, origin, and undo/redo — ${fixture}`, async () => {
			const harness = fixture.startsWith('fresh') ? await created() : await setupArchRootFixture();
			const pre = harness.state();
			if (fixture.startsWith('fresh')) expect(pre.graph.instances[0]!.label).toBeNull();

			const res = await harness.agentCall('model_ops', mixedModelOps(pre.sequence), 'test');
			expect(res.toolResult.ok).toBe(true);
			expect(res.toolResult.result.changed).toBe(true);

			const post = harness.state();
			const entry = post.undo.at(-1)!;
			expect(entry.origin).toBe('agent:test');
			expect(entry.forward.length).toBe(entry.inverse.length);
			if (!fixture.startsWith('fresh')) expect(archJson(post.graph)).toBe(archJson(pre.graph));

			const checkpoint = structuredClone(harness.d.authoringResult().checkpoint) as AuthoringCheckpoint;
			expect(() => validateAuthoringCheckpoint(checkpoint)).not.toThrow();

			const restored = new Harness();
			await restored.ok('RESTORE_CHECKPOINT', { data: { checkpoint } });
			expect(restored.history().checkpoint().undo.at(-1)!.origin).toBe('agent:test');
			await restored.ok('UNDO', { expectedRevision: restored.revision() });
			expect(graphsEqual(restored.graph(), pre.graph)).toBe(true);
			await restored.ok('REDO', { expectedRevision: restored.revision() });
			expect(graphsEqual(restored.graph(), post.graph)).toBe(true);
		});
	}

	test('T-RB10 compaction via real 4-op model_ops equals raw composite and preserves unique family:id keys and root pair', async () => {
		const harness = await created();
		const pre = harness.state();
		const call = mixedModelOps(pre.sequence);

		const scratch = BomcDocument.fromGraph(pre.graph, pre.revision);
		const rawForward: DocumentEdit[] = [];
		const inverses: (readonly DocumentEdit[])[] = [];
		call.ops.forEach((op, index) => {
			const action: ModelAction = { type: 'raw', command: op.command as any };
			const edit = buildModelEdit(scratch.snapshot().graph, [], action, pre.sequence + index);
			scratch.transact(edit.forward);
			rawForward.push(...edit.forward);
			inverses.push(edit.inverse);
		});
		scratch.dispose();
		const rawInverse = [...inverses].reverse().flat();

		const res = await harness.agentCall('model_ops', call, 'test');
		expect(res.toolResult.ok).toBe(true);
		const post = harness.state();
		const entry = post.undo.at(-1)!;

		expect(entry.forward).toEqual(compactAgentEdits(rawForward));
		expect(entry.inverse).toEqual(compactAgentEdits(rawInverse));
		expect(rawForward.length).toBeGreaterThan(entry.forward.length);

		const apply = (graph: BomcGraph, edits: readonly DocumentEdit[]) => {
			const doc = BomcDocument.fromGraph(graph);
			doc.transact(edits);
			const out = doc.snapshot().graph;
			doc.dispose();
			return out;
		};
		expect(graphsEqual(apply(pre.graph, rawForward), apply(pre.graph, entry.forward))).toBe(true);
		expect(graphsEqual(apply(pre.graph, entry.forward), post.graph)).toBe(true);
		expect(graphsEqual(apply(post.graph, rawInverse), apply(post.graph, entry.inverse))).toBe(true);
		expect(graphsEqual(apply(post.graph, entry.inverse), pre.graph)).toBe(true);

		const familyKey = (edit: DocumentEdit) => {
			const id = edit.type.startsWith('put-') ? (edit as any).value.id : (edit as any).id;
			return `${edit.type.slice(edit.type.indexOf('-') + 1)}:${id}`;
		};
		const hasRootPut = (edits: readonly DocumentEdit[], graph: BomcGraph) =>
			edits.some((edit) => edit.type === 'put-instance' && edit.value.id === graph.rootInstanceId);

		for (const list of [entry.forward, entry.inverse]) {
			const keys = list.map(familyKey);
			expect(new Set(keys).size).toBe(keys.length);
			expect(hasRootPut(list, post.graph)).toBe(true);
		}
	});

	test('v2.4 A7 freeform boundary guard: model-ops.ts does not import evaluateModule or perform blanket module evaluation', () => {
		const src = readFileSync(join(import.meta.dir, '../../src/lib/arch/model-ops.ts'), 'utf8');
		expect(src).not.toContain('evaluateModule');
		expect(src).not.toContain('manifold-3d');
	});
});
