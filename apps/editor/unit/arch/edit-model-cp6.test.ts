/**
 * SIB-MCP-MODELING-001 v2.3 WP6 / CP6 & v2.4 A4/A7 — `edit_model` and agent `undo` tests.
 * Covers T-E1…T-E5, T-E7, v2.4 A4/A7 mandatory `purpose:'write'` negative test, findings diff
 * capping, orphan/detach rules, Save→reopen round-trip, and main-thread kernel isolation.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BomcGraph } from '@sibambo/bomc-document';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { AgentHost } from '../../src/lib/agent/agent-host.js';
import { IDENTITY_ROW_MAJOR } from '../../src/lib/arch/convention.js';
import { evaluateModule } from '../../src/lib/arch/evaluate.js';
import { createKernel } from '../../src/lib/arch/kernel.js';
import { effectiveModuleTransform, readManaged } from '../../src/lib/arch/managed.js';
import type { ArchModule } from '../../src/lib/arch/schema.js';
import { AuthoringClient } from '../../src/lib/authoring/bomc-authoring-client.js';
import { AuthoringWorkerDispatcher } from '../../src/lib/authoring/bomc-authoring.worker.js';
import { AuthoringHistory, graphsEqual, validateAuthoringCheckpoint } from '../../src/lib/authoring/history.js';
import { buildModelEdit, modelMetadata, nextModelSequence, validateAuthoringDocument } from '../../src/lib/authoring/model.js';
import { AUTHORING_PROTOCOL_VERSION, type AuthoringCheckpoint, type AuthoringWorkerMessage } from '../../src/lib/authoring/protocol.js';
import { g8, g9, opening, space, wall } from './fixtures/modules.js';

const DOC = '8f3a1c2b-9d4e-4f50-8a1b-2c3d4e5f6a7b';
const SESSION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const CONTEXT = { mode: 'authoring', path: [], selection: [] } as const;

type Reply = { event: 'RESULT'; result: any } | { event: 'ERROR'; error: { code: string; message: string; currentRevision: number | null } };

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
	async agentCall(tool: string, args: Record<string, unknown>, slot = 'claude-code', expectedRevision: number | null = tool === 'describe_scene' ? null : this.revision()) {
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

function slab(elementId = 'slab-1', topElevation = 0) {
	return {
		elementId,
		kind: 'slab' as const,
		outline: [[0, 0], [4, 0], [4, 3], [0, 3]] as [number, number][],
		holes: [],
		thickness: 0.2,
		topElevation
	};
}

describe('WP6 / CP6 — edit_model ops & rules (T-E1)', () => {
	test('create_module, add, update, set_material, remove_material, set_module, remove (cascade), remove_module', async () => {
		const harness = await created();
		const brick = { materialId: 'brick', rgba: [180, 90, 70, 255] as [number, number, number, number], opacity: 1 };
		const plaster = { materialId: 'plaster', rgba: [230, 230, 225, 255] as [number, number, number, number], opacity: 1 };

		// 1. Create module with material + room walls + door + slab + space in one call
		const r1 = await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/ground', name: 'Ground Floor', materials: [brick] },
				{ op: 'add', moduleId: 'house/ground', element: wall('shell', [[0, 0], [4, 0], [4, 3], [0, 3]], { closed: true, side: 'right', materialId: 'brick' }) },
				{ op: 'add', moduleId: 'house/ground', element: opening('door-1', 'shell', 1.0, 0.9, 2.1, 0, 'door') },
				{ op: 'add', moduleId: 'house/ground', element: slab() },
				{ op: 'add', moduleId: 'house/ground', element: space('sp-1', 'Living', [2, 1.5]) }
			]
		});
		expect(r1.toolResult.ok).toBe(true);
		expect(r1.toolResult.result.revision).toBe(1);
		expect(r1.toolResult.result.modules).toHaveLength(1);
		expect(r1.toolResult.result.modules[0]).toMatchObject({
			moduleId: 'house/ground',
			revision: 1,
			added: ['door-1', 'shell', 'slab-1', 'sp-1'],
			updated: [],
			removed: []
		});
		expect(r1.toolResult.result.modules[0].stats.faces).toBeGreaterThan(0);
		expect(r1.toolResult.result.modules[0].stats.hardEdges).toBeGreaterThan(0);
		expect(r1.toolResult.result.modules[0].stats.triangles).toBeGreaterThan(0);
		expect(r1.toolResult.result.findings.totals.ERROR).toBe(0);
		expect(validateAuthoringDocument(harness.graph()).editable).toBe(true);

		// 2. set_material + update wall + set_module transform
		const shifted = [1, 0, 0, 5, 0, 1, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1];
		const r2 = await harness.agentCall('edit_model', {
			changes: [
				{ op: 'set_material', moduleId: 'house/ground', material: plaster },
				{ op: 'update', moduleId: 'house/ground', elementId: 'shell', set: { materialId: 'plaster' } },
				{ op: 'set_module', moduleId: 'house/ground', name: 'Renamed', transform: shifted }
			]
		});
		expect(r2.toolResult.ok).toBe(true);
		expect(r2.toolResult.result.modules[0]).toMatchObject({
			moduleId: 'house/ground',
			revision: 2,
			added: [],
			updated: ['shell'],
			removed: []
		});
		const managed2 = readManaged(harness.graph()).get('house/ground')!;
		expect(managed2.state).toBe('ok');
		expect(managed2.entry.module.name).toBe('Renamed');
		expect(effectiveModuleTransform(managed2)).toEqual(shifted);

		// 3. remove_material refuses while referenced (plaster), succeeds when unreferenced (brick)
		const refBefore = harness.state();
		const remMatRef = await harness.agentCall('edit_model', {
			changes: [{ op: 'remove_material', moduleId: 'house/ground', materialId: 'plaster' }]
		});
		expect(remMatRef.toolResult.ok).toBe(false);
		expect(remMatRef.toolResult.error.code).toBe('INVALID_ELEMENT');
		expectUnchanged(harness, refBefore);

		const r3 = await harness.agentCall('edit_model', {
			changes: [
				{ op: 'remove_material', moduleId: 'house/ground', materialId: 'brick' },
				{ op: 'set_module', moduleId: 'house/ground', name: null }
			]
		});
		expect(r3.toolResult.ok).toBe(true);
		const managed3 = readManaged(harness.graph()).get('house/ground')!;
		expect(managed3.entry.module.name).toBeUndefined();
		expect(managed3.entry.module.materials.map((m) => m.materialId)).toEqual(['plaster']);

		// 4. remove wall hosting an opening: fails without cascade, succeeds with cascade:true
		const casBefore = harness.state();
		const noCascade = await harness.agentCall('edit_model', {
			changes: [{ op: 'remove', moduleId: 'house/ground', elementId: 'shell' }]
		});
		expect(noCascade.toolResult.ok).toBe(false);
		expect(noCascade.toolResult.error.code).toBe('INVALID_ELEMENT');
		expectUnchanged(harness, casBefore);

		const r4 = await harness.agentCall('edit_model', {
			changes: [{ op: 'remove', moduleId: 'house/ground', elementId: 'shell', cascade: true }]
		});
		expect(r4.toolResult.ok).toBe(true);
		expect(r4.toolResult.result.modules[0].removed).toEqual(['door-1', 'shell']);
		// sp-1 is now unenclosed ERROR
		expect(r4.toolResult.result.findings.totals.ERROR).toBeGreaterThanOrEqual(1);

		// 5. remove_module deletes container, definition, mesh, and arch entry
		const r5 = await harness.agentCall('edit_model', {
			changes: [{ op: 'remove_module', moduleId: 'house/ground' }]
		});
		expect(r5.toolResult.ok).toBe(true);
		expect(readManaged(harness.graph()).size).toBe(0);
		expect(harness.graph().instances.filter((i) => i.id !== harness.graph().rootInstanceId)).toHaveLength(0);
		expect(validateAuthoringDocument(harness.graph()).editable).toBe(true);
	});

	test('multi-module single call + owner move transform preservation', async () => {
		const harness = await created();
		const res = await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/a' },
				{ op: 'add', moduleId: 'house/a', element: slab('s-a') },
				{ op: 'create_module', moduleId: 'house/b' },
				{ op: 'add', moduleId: 'house/b', element: slab('s-b', 3) }
			]
		});
		expect(res.toolResult.ok).toBe(true);
		expect(res.toolResult.result.modules.map((m: any) => m.moduleId)).toEqual(['house/a', 'house/b']);
		expect(harness.state().undo).toHaveLength(1);

		// Owner moves house/a container by (+3, 0, -4) in runtime Y-up
		const recA = readManaged(harness.graph()).get('house/a')!;
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: {
				kind: 'MODEL_EDIT',
				path: [],
				action: {
					type: 'transform',
					selection: [{ type: 'instance', id: recA.instance!.id }],
					delta: [3, 0, -4],
					copy: false,
					count: 1,
					spacing: 'multiply',
					radial: null
				}
			}
		});
		const movedTransform = effectiveModuleTransform(readManaged(harness.graph()).get('house/a')!);
		expect(movedTransform[3]).toBeCloseTo(3, 6);
		expect(movedTransform[7]).toBeCloseTo(4, 6);

		// Agent edits house/a elements without set_module.transform -> owner move stays!
		const r2 = await harness.agentCall('edit_model', {
			changes: [{ op: 'add', moduleId: 'house/a', element: wall('w1', [[0, 0], [4, 0]]) }]
		});
		expect(r2.toolResult.ok).toBe(true);
		const afterTransform = effectiveModuleTransform(readManaged(harness.graph()).get('house/a')!);
		expect(afterTransform[3]).toBeCloseTo(3, 6);
		expect(afterTransform[7]).toBeCloseTo(4, 6);
	});

	test('detached module refuses edits with MODULE_DETACHED; orphan allows remove_module or create_module replacement', async () => {
		const harness = await created();
		await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/ground' },
				{ op: 'add', moduleId: 'house/ground', element: slab() }
			]
		});
		const instId = readManaged(harness.graph()).get('house/ground')!.instance!.id;
		const meshId = harness.graph().definitions.find((d) => d.id === readManaged(harness.graph()).get('house/ground')!.instance!.definitionId)!.meshId!;
		const faceId = harness.graph().meshes.find((m) => m.id === meshId)!.faces[0]!.id;

		// Owner edits inside the managed group (push-pull on a face) -> detaches module
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [instId], action: { type: 'raw', command: { kind: 'PUSH_PULL_FACE', faceId, distance: 0.1 } } }
		});
		expect(readManaged(harness.graph()).get('house/ground')!.state).toBe('detached');

		const detachedBefore = harness.state();
		const detachedErr = await harness.agentCall('edit_model', {
			changes: [{ op: 'add', moduleId: 'house/ground', element: wall('w1', [[0, 0], [2, 0]]) }]
		});
		expect(detachedErr.toolResult.ok).toBe(false);
		expect(detachedErr.toolResult.error.code).toBe('MODULE_DETACHED');
		expectUnchanged(harness, detachedBefore);

		// Owner undoes push-pull, then erases the container -> orphaned
		await harness.ok('UNDO', { expectedRevision: harness.revision() });
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'erase', selection: [{ type: 'instance', id: instId }] } }
		});
		expect(readManaged(harness.graph()).get('house/ground')!.state).toBe('orphaned');

		// Regular add on orphan refuses NOT_FOUND
		const orphanErr = await harness.agentCall('edit_model', {
			changes: [{ op: 'add', moduleId: 'house/ground', element: wall('w1', [[0, 0], [2, 0]]) }]
		});
		expect(orphanErr.toolResult.ok).toBe(false);
		expect(orphanErr.toolResult.error.code).toBe('NOT_FOUND');

		// create_module replaces orphan entry (A20)
		const replaced = await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/ground' },
				{ op: 'add', moduleId: 'house/ground', element: slab('new-slab') }
			]
		});
		expect(replaced.toolResult.ok).toBe(true);
		expect(readManaged(harness.graph()).get('house/ground')!.state).toBe('ok');

		// Erase again and remove_module deletes orphan entry cleanly
		const newInstId = readManaged(harness.graph()).get('house/ground')!.instance!.id;
		await harness.ok('COMMAND', {
			expectedRevision: harness.revision(),
			data: { kind: 'MODEL_EDIT', path: [], action: { type: 'erase', selection: [{ type: 'instance', id: newInstId }] } }
		});
		const removedOrphan = await harness.agentCall('edit_model', {
			changes: [{ op: 'remove_module', moduleId: 'house/ground' }]
		});
		expect(removedOrphan.toolResult.ok).toBe(true);
		expect(readManaged(harness.graph()).size).toBe(0);
	});
});

describe('WP6 / CP6 — history, origin & checkpoint replay (T-E2)', () => {
	test('one history entry per edit_model call with origin agent:<slot>, passes full checkpoint replay', async () => {
		const harness = await created();
		const g8Mod = g8();
		const res = await harness.agentCall(
			'edit_model',
			{
				changes: [
					{ op: 'create_module', moduleId: 'house/g8' },
					...g8Mod.elements.map((el) => ({ op: 'add', moduleId: 'house/g8', element: el }))
				]
			},
			'claude-code'
		);
		expect(res.toolResult.ok).toBe(true);
		expect(harness.revision()).toBe(1);
		const cp = harness.history().checkpoint();
		expect(cp.undo).toHaveLength(1);
		expect(cp.undo[0]!.origin).toBe('agent:claude-code');

		const fullCheckpoint = structuredClone(harness.d.authoringResult().checkpoint) as AuthoringCheckpoint;
		expect(() => validateAuthoringCheckpoint(fullCheckpoint)).not.toThrow();

		const restored = new Harness();
		await restored.ok('RESTORE_CHECKPOINT', { data: { checkpoint: fullCheckpoint } });
		expect(restored.history().checkpoint().undo[0]!.origin).toBe('agent:claude-code');
		await restored.ok('UNDO', { expectedRevision: restored.revision() });
		expect(readManaged(restored.graph()).size).toBe(0);
		await restored.ok('REDO', { expectedRevision: restored.revision() });
		expect(readManaged(restored.graph()).get('house/g8')!.state).toBe('ok');
	});
});

describe('WP6 / CP6 — receipt findings diff & caps (T-E3)', () => {
	test('reports new findings on defective room and resolved findings once fixed; caps lists at 10', async () => {
		const harness = await created();
		const g9Mod = g9();
		const r1 = await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/gap' },
				...g9Mod.elements.map((el) => ({ op: 'add', moduleId: 'house/gap', element: el })),
				{ op: 'add', moduleId: 'house/gap', element: opening('narrow-door', 'w1', 1.0, 0.60, 2.0, 0, 'door') }
			]
		});
		expect(r1.toolResult.ok).toBe(true);
		const f1 = r1.toolResult.result.findings;
		expect(f1.new.some((f: any) => f.code === 'WALL_GAP' && Array.isArray(f.fix) && f.fix[0] === 4 && f.fix[1] === 3)).toBe(true);
		expect(f1.new.some((f: any) => f.code === 'DOOR_CLEARANCE' && f.elementId === 'narrow-door')).toBe(true);
		expect(f1.resolved).toEqual([]);
		expect(f1.totals.WARNING).toBeGreaterThanOrEqual(2);

		// Fix the wall gap and widen the door
		const r2 = await harness.agentCall('edit_model', {
			changes: [
				{ op: 'update', moduleId: 'house/gap', elementId: 'w3', set: { path: [[4, 3], [0, 3]] } },
				{ op: 'update', moduleId: 'house/gap', elementId: 'narrow-door', set: { width: 0.90 } }
			]
		});
		expect(r2.toolResult.ok).toBe(true);
		const f2 = r2.toolResult.result.findings;
		expect(f2.resolved.some((k: string) => k.startsWith('WALL_GAP:house/gap:'))).toBe(true);
		expect(f2.resolved.some((k: string) => k.startsWith('DOOR_CLEARANCE:house/gap:narrow-door:'))).toBe(true);
		expect(f2.totals.WARNING).toBe(0);
		expect(f2.totals.ERROR).toBe(0);

		// Cap check: 12 disconnected free-end walls produce > 10 new findings, capped at 10 in receipt.findings.new & resolved
		const manyWalls = Array.from({ length: 12 }, (_, i) => ({
			op: 'add',
			moduleId: 'house/many',
			element: wall(`wf-${i}`, [[i * 2, 0], [i * 2 + 1, 0]])
		}));
		const rMany = await harness.agentCall('edit_model', {
			changes: [{ op: 'create_module', moduleId: 'house/many' }, ...manyWalls]
		});
		expect(rMany.toolResult.ok).toBe(true);
		expect(rMany.toolResult.result.findings.new).toHaveLength(10);
		expect(rMany.toolResult.result.findings.totals.INFO).toBe(24); // 2 free ends per isolated wall

		const rClear = await harness.agentCall('edit_model', {
			changes: [{ op: 'remove_module', moduleId: 'house/many' }]
		});
		expect(rClear.toolResult.ok).toBe(true);
		expect(rClear.toolResult.result.findings.resolved).toHaveLength(10);
	});
});

describe('WP6 / CP6 — agent undo & owner/agent history interplay (T-E4)', () => {
	test('undo(steps) reverts multiple agent edit_model calls atomically and refuses crossing owner entries', async () => {
		const harness = await created();
		// Owner creates a rectangle first
		await harness.ok('COMMAND', { expectedRevision: 0, data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } });
		// Agent makes two edit_model calls
		await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/ground' },
				{ op: 'add', moduleId: 'house/ground', element: slab() }
			]
		});
		await harness.agentCall('edit_model', {
			changes: [{ op: 'add', moduleId: 'house/ground', element: wall('w1', [[0, 0], [4, 0]]) }]
		});
		expect(harness.revision()).toBe(3);

		// Trying undo(3) hits owner's entry -> UNDO_NOT_AGENT, nothing changed
		const beforeBlocked = harness.state();
		const blocked = await harness.agentCall('undo', { steps: 3 });
		expect(blocked.toolResult.ok).toBe(false);
		expect(blocked.toolResult.error.code).toBe('UNDO_NOT_AGENT');
		expectUnchanged(harness, beforeBlocked);

		// Invalid args -> INVALID_REQUEST
		const badSteps = await harness.agentCall('undo', { steps: 0 });
		expect(badSteps.toolResult.ok).toBe(false);
		expect(badSteps.toolResult.error.code).toBe('INVALID_REQUEST');
		const extraArg = await harness.agentCall('undo', { steps: 1, extra: true });
		expect(extraArg.toolResult.ok).toBe(false);
		expect(extraArg.toolResult.error.code).toBe('INVALID_REQUEST');
		expectUnchanged(harness, beforeBlocked);

		// undo(2) reverts both agent calls in ONE atomic transact (revision +1)
		const u2 = await harness.agentCall('undo', { steps: 2 });
		expect(u2.toolResult.ok).toBe(true);
		expect(u2.toolResult.result).toEqual({ undone: 2, revision: 4 });
		expect(readManaged(harness.graph()).size).toBe(0);
		expect(harness.history().checkpoint().undo).toHaveLength(1);
		expect(harness.history().checkpoint().redo).toHaveLength(2);

		// Next undo() hits owner entry -> UNDO_NOT_AGENT
		const uOwner = await harness.agentCall('undo', {});
		expect(uOwner.toolResult.ok).toBe(false);
		expect(uOwner.toolResult.error.code).toBe('UNDO_NOT_AGENT');

		// Owner REDO restores both agent entries one by one, and owner UNDO reverts them cleanly
		await harness.ok('REDO', { expectedRevision: harness.revision() });
		await harness.ok('REDO', { expectedRevision: harness.revision() });
		expect(readManaged(harness.graph()).get('house/ground')!.entry.module.elements).toHaveLength(2);
		await harness.ok('UNDO', { expectedRevision: harness.revision() });
		expect(readManaged(harness.graph()).get('house/ground')!.entry.module.elements).toHaveLength(1);

		// Fresh doc: NOTHING_TO_UNDO
		const empty = await created();
		const nothing = await empty.agentCall('undo', {});
		expect(nothing.toolResult.ok).toBe(false);
		expect(nothing.toolResult.error.code).toBe('NOTHING_TO_UNDO');
	});
});

describe('WP6 / CP6 — Save -> reopen round-trip (T-E5 / Invariant 7)', () => {
	test('WRITE -> ACK_DOWNLOAD -> OPEN in fresh worker restores authoring document with identical arch metadata', async () => {
		const harness = await created();
		const g8Mod = g8();
		const wallMat = { materialId: 'terracotta', rgba: [190, 95, 72, 255] as [number, number, number, number], opacity: 1 };
		await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/g8', name: 'G8 Room', materials: [wallMat] },
				...g8Mod.elements.map((el) => ({
					op: 'add',
					moduleId: 'house/g8',
					element: el.kind === 'wall' ? { ...el, materialId: 'terracotta' } : el
				}))
			]
		});
		const preGraph = harness.graph();
		const preArchJson = JSON.stringify(modelMetadata(preGraph).arch);
		const preManaged = readManaged(preGraph).get('house/g8')!;
		expect(preManaged.state).toBe('ok');

		const writeRes = await harness.ok('WRITE', { expectedRevision: harness.revision() });
		await harness.ok('ACK_DOWNLOAD', { expectedRevision: harness.revision(), data: { writeId: writeRes.writeId, revision: writeRes.revision } });

		const reopened = new Harness();
		const openRes = await reopened.ok('OPEN', { data: { ownedBuffer: writeRes.ownedBuffer } });
		expect(openRes.kind).toBe('authoring');
		expect(validateAuthoringDocument(reopened.graph()).editable).toBe(true);
		expect(JSON.stringify(modelMetadata(reopened.graph()).arch)).toBe(preArchJson);
		const postManaged = readManaged(reopened.graph()).get('house/g8')!;
		expect(postManaged.state).toBe('ok');
		expect(postManaged.entry.bakedMeshSha256).toBe(preManaged.entry.bakedMeshSha256);

		// Follow-up edit_model and agent undo succeed on the reopened authoring document
		const followUp = await reopened.agentCall('edit_model', {
			changes: [{ op: 'add', moduleId: 'house/g8', element: slab() }]
		});
		expect(followUp.toolResult.ok).toBe(true);
		expect(readManaged(reopened.graph()).get('house/g8')!.entry.module.revision).toBe(2);
		const undone = await reopened.agentCall('undo', { steps: 1 });
		expect(undone.toolResult.ok).toBe(true);
		expect(readManaged(reopened.graph()).get('house/g8')!.entry.module.revision).toBe(1);
	});
});

describe('WP6 / CP6 — v2.4 A4/A7 write-purpose enforcement & rejected-call invariance (T-E7)', () => {
	test('v2.4 A4/A7 negative test: staggered continuation passes purpose:read evaluation but is REJECTED by edit_model (purpose:write)', async () => {
		const kernel = createKernel();
		await kernel.init();
		const staggeredWalls = [
			wall('w-left', [[0, 0], [2, 0]], { side: 'left', thickness: 0.15 }),
			wall('w-right', [[2, 0], [4, 0]], { side: 'right', thickness: 0.15 })
		];
		const readEval = evaluateModule(
			{
				schemaVersion: '2.0.0',
				moduleId: 'house/stagger',
				revision: 1,
				transform: [...IDENTITY_ROW_MAJOR],
				materials: [],
				elements: staggeredWalls
			},
			kernel
		);
		expect(readEval.diagnostics).toHaveLength(1);
		expect(readEval.diagnostics[0]!.code).toBe('WALL_STAGGERED_CONTINUATION');

		const harness = await created();
		await harness.ok('COMMAND', { expectedRevision: 0, data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } });
		const withRect = harness.graph();
		await harness.ok('UNDO', { expectedRevision: 1 });
		const before = harness.state();
		expect(before.redo).toHaveLength(1);

		const res = await harness.agentCall('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: 'house/stagger' },
				...staggeredWalls.map((el) => ({ op: 'add', moduleId: 'house/stagger', element: el }))
			]
		});
		expect(res.toolResult.ok).toBe(false);
		expect(res.toolResult.error).toMatchObject({
			code: 'INVALID_GEOMETRY',
			retryable: false,
			detail: { moduleId: 'house/stagger', elementId: 'w-left', reason: 'WALL_STAGGERED_CONTINUATION', at: [2, 0] }
		});
		expect(res.toolResult.error.nextAction).toContain('same side');
		expectUnchanged(harness, before);

		// Owner redo stack survived untouched
		await harness.ok('REDO', { expectedRevision: harness.revision() });
		expect(graphsEqual(harness.graph(), withRect)).toBe(true);
	});

	test('T-E7 all rejected edit_model calls leave graph, revision, stacks and sequence unchanged', async () => {
		const harness = await created();
		await harness.ok('COMMAND', { expectedRevision: 0, data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } });
		await harness.ok('UNDO', { expectedRevision: 1 });
		const before = harness.state();

		const rejectedCalls: Record<string, unknown>[] = [
			{}, // missing changes -> INVALID_REQUEST
			{ changes: [] }, // empty changes -> INVALID_REQUEST
			{ changes: Array.from({ length: 65 }, (_, i) => ({ op: 'create_module', moduleId: `house/m-${i}` })) }, // > 64 -> BUDGET_EXCEEDED
			{ changes: [{ op: 'remove_module', moduleId: 'house/missing' }] }, // NOT_FOUND
			{ changes: [{ op: 'create_module', moduleId: 'house/bad', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] }] }, // singular transform -> INVALID_ELEMENT
			{
				changes: [
					{ op: 'create_module', moduleId: 'house/collinear' },
					{ op: 'add', moduleId: 'house/collinear', element: wall('a', [[0, 0], [4, 0]]) },
					{ op: 'add', moduleId: 'house/collinear', element: wall('b', [[1, 0], [3, 0]]) }
				]
			}, // WALL_COLLINEAR_OVERLAP -> INVALID_GEOMETRY
			{
				changes: [
					{ op: 'create_module', moduleId: 'house/immut' },
					{ op: 'add', moduleId: 'house/immut', element: wall('w1', [[0, 0], [3, 0]]) },
					{ op: 'update', moduleId: 'house/immut', elementId: 'w1', set: { kind: 'slab' } }
				]
			} // immutable kind -> INVALID_ELEMENT
		];

		for (const args of rejectedCalls) {
			const reply = await harness.agentCall('edit_model', args);
			expect(reply.toolResult.ok).toBe(false);
			expect(reply.authoring).toBeNull();
			expectUnchanged(harness, before);
		}
	});
});

describe('WP6 / CP6 — main-thread isolation & AgentHost end-to-end', () => {
	test('AgentHost does not import arch/tools or manifold-3d and executes real edit_model + undo via AuthoringClient', async () => {
		const hostSource = readFileSync(join(import.meta.dir, '../../src/lib/agent/agent-host.ts'), 'utf8');
		expect(hostSource).not.toContain('arch/tools');
		expect(hostSource).not.toContain('manifold-3d');

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
			let acceptedRevision = 0;
			const host = new AgentHost({
				getClient: () => client,
				getCheckpoint: () => client.checkpoint,
				accept: (_c, result) => {
					acceptedRevision = result.checkpoint.snapshot.revision;
					return 'rendered';
				},
				isOwnerBusy: () => false,
				getModeling: () => ({ path: [], selection: [] }),
				getMode: () => 'authoring'
			});

			const writeReply = await host.handle({
				id: 'req-1',
				slot: 'claude-code',
				session: 'sess-1',
				tool: 'edit_model',
				args: {
					changes: [
						{ op: 'create_module', moduleId: 'house/ground' },
						{ op: 'add', moduleId: 'house/ground', element: wall('w1', [[0, 0], [4, 0]]) }
					]
				}
			});
			expect(writeReply.ok).toBe(true);
			expect(writeReply.committed).toBeDefined();
			expect(writeReply.committed!.revision).toBe(1);
			expect(writeReply.committed!.entityIds).toHaveLength(1);
			expect(acceptedRevision).toBe(1);
			expect(client.checkpoint!.history.undo.at(-1)!.origin).toBe('agent:claude-code');

			const undoReply = await host.handle({
				id: 'req-2',
				slot: 'claude-code',
				session: 'sess-1',
				tool: 'undo',
				args: { steps: 1 }
			});
			expect(undoReply.ok).toBe(true);
			expect(undoReply.committed!.revision).toBe(2);
			expect(readManaged(client.checkpoint!.snapshot.graph).size).toBe(0);
		} finally {
			await client.close();
		}
	});
});
