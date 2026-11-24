/**
 * SIB-MCP-MODELING-001 v2.3 WP3 / CP3 — worker AGENT plumbing and the C5a atomic write contract.
 * Covers AGENT request validation, the origin round trip through history checkpoints, the
 * WP3 NOT_IMPLEMENTED tool surface, and T-RB1…T-RB7c, T-RB9…T-RB11. stageAndCommit is fed a
 * test-only builder list made from buildModelEdit with {type:'raw', command} actions (the same
 * lowering model_ops uses); flat buildCommandEdit edits are never fed to it.
 */
import { describe, expect, test } from 'bun:test';
import { BomcDocument, BomcDocumentError } from '@sibambo/bomc-document/document';
import type { BomcGraph, DocumentEdit } from '@sibambo/bomc-document';
import { buildModelEdit, nextModelSequence, validateAuthoringDocument } from '../../src/lib/authoring/model.js';
import { AuthoringHistory, AuthoringHistoryError, graphsEqual, validateAuthoringCheckpoint } from '../../src/lib/authoring/history.js';
import { AuthoringWorkerDispatcher, compactAgentEdits } from '../../src/lib/authoring/bomc-authoring.worker.js';
import { AuthoringClient } from '../../src/lib/authoring/bomc-authoring-client.js';
import {
	AUTHORING_PROTOCOL_VERSION,
	isAuthoringCheckpointShape,
	isAuthoringRequest,
	type AgentResult,
	type AuthoringCheckpoint,
	type AuthoringJournalEntry,
	type AuthoringWorkerMessage,
	type FlatAuthoringCommand
} from '../../src/lib/authoring/protocol.js';
import { AgentToolFailure, type AgentEditBuilder, type ToolOutcome } from '../../src/lib/arch/tools.js';
import { AgentHost } from '../../src/lib/agent/agent-host.js';
import { IDENTITY_ROW_MAJOR } from '../../src/lib/arch/convention.js';

const DOC = '6f1c2b3a-4d5e-4f60-8a7b-9c8d7e6f5a4b';
const SESSION = '0b7c6d5e-4f3a-4b2c-9d1e-0f9a8b7c6d5e';
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
	/** Snapshot of everything invariant 3 protects. */
	state() {
		const checkpoint = this.history().checkpoint();
		return { graph: this.graph(), revision: this.revision(), undo: [...checkpoint.undo], redo: [...checkpoint.redo], sequence: this.d.sequence as number };
	}
	agent(tool: string, expectedRevision: number | null, args: Record<string, unknown> = {}) {
		return this.send('AGENT', { expectedRevision, data: { tool, args, slot: 'test', context: CONTEXT } });
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

/** Test-only seam: the real document with `transact` replaced; every other member forwards to it. */
function withTransact(document: BomcDocument, transact: (edits: readonly DocumentEdit[]) => number): BomcDocument {
	return new Proxy(document, {
		get(target, key) {
			if (key === 'transact') return transact;
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

function failure(run: () => unknown): AgentToolFailure {
	try { run(); } catch (error) { if (error instanceof AgentToolFailure) return error; throw error; }
	throw new Error('expected an AgentToolFailure');
}

const rectanglePoints = (x0: number, z0: number, x1: number, z1: number) => [[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]] as const;
const raw = (command: FlatAuthoringCommand | ((sequence: number) => FlatAuthoringCommand)): AgentEditBuilder =>
	(graph, sequence) => buildModelEdit(graph, [], { type: 'raw', command: typeof command === 'function' ? command(sequence) : command }, sequence);
const rectangle = (x0: number, z0: number, x1: number, z1: number) =>
	raw({ kind: 'CREATE_RECTANGLE', points: rectanglePoints(x0, z0, x1, z1), normal: [0, 1, 0] });
/** Push-pull the rectangle created by the previous op (its face id embeds sequence − 1). */
const pushPrevious = (distance: number) => raw((sequence) => ({ kind: 'PUSH_PULL_FACE', faceId: `${DOC}:rectangle:${sequence - 1}`, distance }));
const pushMissing = raw({ kind: 'PUSH_PULL_FACE', faceId: `${DOC}:rectangle:999`, distance: 0.5 });
const mixedOps = () => [rectangle(0, 0, 2, 1), pushPrevious(0.5), rectangle(4, 0, 6, 2), pushPrevious(0.25)];

function family(edit: DocumentEdit): string {
	const id = edit.type.startsWith('put-') ? (edit as any).value.id : (edit as any).id;
	return `${edit.type.slice(edit.type.indexOf('-') + 1)}:${id}`;
}
const hasRootPut = (edits: readonly DocumentEdit[], graph: BomcGraph) =>
	edits.some((edit) => edit.type === 'put-instance' && edit.value.id === graph.rootInstanceId);

function slabModule() {
	return {
		schemaVersion: '2.0.0', moduleId: 'house/ground', revision: 1, transform: [...IDENTITY_ROW_MAJOR], materials: [],
		elements: [{ elementId: 'slab-1', kind: 'slab', outline: [[0, 0], [4, 0], [4, 3], [0, 3]], holes: [], thickness: 0.2, topElevation: 0.2 }]
	};
}

/** A fresh document whose root label already carries `arch` (one orphan entry, admitted per C9a). */
function archGraph(): BomcGraph {
	const base = BomcDocument.create({ documentId: DOC, name: 'Arch' });
	const graph = structuredClone(base.snapshot().graph) as any;
	base.dispose();
	const arch = { schema: 'sibambo-arch-v2', modules: [{ instanceId: `${DOC}:instance:op:1:1`, module: slabModule(), bakedMeshSha256: 'a'.repeat(64) }] };
	graph.instances[0].label = JSON.stringify({ schema: 'sibambo-editor-model-v1', guides: [], looseEdges: [], arch });
	const document = BomcDocument.fromGraph(graph);
	const canonical = structuredClone(document.snapshot().graph);
	document.dispose();
	return canonical;
}

async function restoredArch() {
	const graph = archGraph();
	expect(validateAuthoringDocument(graph).editable).toBe(true);
	const document = BomcDocument.fromGraph(graph);
	const snapshot = structuredClone(document.snapshot());
	document.dispose();
	const harness = new Harness();
	await harness.ok('RESTORE_CHECKPOINT', { data: { checkpoint: { snapshot, sequence: nextModelSequence(graph), history: { undo: [], redo: [], savedGraph: null } } } });
	return harness;
}

const archJson = (graph: BomcGraph) => JSON.stringify(JSON.parse(graph.instances.find((i) => i.id === graph.rootInstanceId)!.label!).arch);

describe('AGENT request envelope (C5)', () => {
	const base = { protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: SESSION, requestId: 1, type: 'AGENT' };
	const data = { tool: 'describe_scene', args: {}, slot: 'claude-code', context: { mode: 'authoring', path: ['a'], selection: [{ type: 'face', id: 'f' }, { type: 'edge', start: [0, 0, 0], end: [1, 0, 0] }] } };

	test('accepts exact keys with a null or safe expectedRevision', () => {
		expect(isAuthoringRequest({ ...base, expectedRevision: null, data })).toBe(true);
		expect(isAuthoringRequest({ ...base, expectedRevision: 3, data: { ...data, tool: 'edit_model' } })).toBe(true);
	});

	test('rejects extra or missing keys, unknown tools, bad slots, bad context and bad revisions', () => {
		expect(isAuthoringRequest({ ...base, expectedRevision: null, data, extra: 1 })).toBe(false);
		expect(isAuthoringRequest({ ...base, data })).toBe(false);
		expect(isAuthoringRequest({ ...base, expectedRevision: null, data: { ...data, tool: 'run_script' } })).toBe(false);
		expect(isAuthoringRequest({ ...base, expectedRevision: null, data: { ...data, slot: 'Claude' } })).toBe(false);
		expect(isAuthoringRequest({ ...base, expectedRevision: null, data: { ...data, args: [] } })).toBe(false);
		expect(isAuthoringRequest({ ...base, expectedRevision: -1, data })).toBe(false);
		expect(isAuthoringRequest({ ...base, expectedRevision: null, data: { ...data, context: { ...data.context, mode: 'draft' } } })).toBe(false);
		expect(isAuthoringRequest({ ...base, expectedRevision: null, data: { ...data, context: { ...data.context, selection: [{ type: 'face' }] } } })).toBe(false);
		expect(isAuthoringRequest({ ...base, expectedRevision: null, data: { ...data, extra: true } })).toBe(false);
	});
});

describe('worker AGENT path (WP3 exposes no tool)', () => {
	test('read tools return NOT_IMPLEMENTED with authoring null and change nothing, even while a download awaits ACK', async () => {
		const harness = await created();
		const before = harness.state();
		const reply = await harness.agent('describe_scene', null);
		expect(reply.event).toBe('RESULT');
		const result = (reply as any).result as AgentResult;
		expect(result).toEqual({ kind: 'agent', authoring: null, toolResult: { ok: false, error: expect.objectContaining({ code: 'NOT_IMPLEMENTED', retryable: false }) } });
		expectUnchanged(harness, before);
		await harness.ok('WRITE', { expectedRevision: harness.revision() });
		expect((await harness.agent('check_model', null)).event).toBe('RESULT');
	});

	test('write tools check the CAS revision and the pending download before the tool runs', async () => {
		const harness = await created();
		await harness.ok('COMMAND', { expectedRevision: 0, data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } });
		const before = harness.state();
		const stale = await harness.agent('edit_model', 0);
		expect(stale).toMatchObject({ event: 'ERROR', error: { code: 'STALE_REVISION', currentRevision: 1 } });
		const current = await harness.agent('model_ops', 1);
		expect((current as any).result.toolResult.error.code).toBe('INVALID_REQUEST');
		await harness.ok('WRITE', { expectedRevision: 1 });
		expect(await harness.agent('undo', 1)).toMatchObject({ event: 'ERROR', error: { code: 'BUSY' } });
		expectUnchanged(harness, before);
	});

	test('AGENT cannot start a session and a malformed AGENT envelope is rejected', async () => {
		const fresh = new Harness();
		expect(await fresh.agent('describe_scene', null)).toMatchObject({ event: 'ERROR', error: { code: 'INVALID_COMMAND' } });
		const harness = await created();
		const reply = await harness.send('AGENT', { expectedRevision: null, data: { tool: 'describe_scene', args: {}, slot: 'test', context: CONTEXT, extra: 1 } });
		expect(reply).toMatchObject({ event: 'ERROR', error: { code: 'INVALID_COMMAND', message: 'Malformed authoring request envelope.' } });
	});
});

describe('C5a stageAndCommit (T-RB1…T-RB6)', () => {
	test('T-RB1 a failing op leaves graph, revision, both stacks and sequence untouched', async () => {
		const harness = await created();
		await harness.ok('COMMAND', { expectedRevision: 0, data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } });
		const before = harness.state();
		const error = failure(() => harness.d.stageAndCommit([rectangle(3, 0, 4, 1), pushMissing], 'test'));
		expect(error.body).toMatchObject({ code: 'INVALID_COMMAND', detail: { opIndex: 1 } });
		expectUnchanged(harness, before);
	});

	test('T-RB2 three valid ops commit exactly one entry with origin agent:test; undo/redo move the whole call', async () => {
		const harness = await created();
		const before = harness.state();
		const commit = harness.d.stageAndCommit([rectangle(0, 0, 2, 1), pushPrevious(0.5), rectangle(4, 0, 5, 1)], 'test');
		expect(commit).toMatchObject({ changed: true, revision: before.revision + 1 });
		expect(commit.entityIds).toHaveLength(3);
		const after = harness.state();
		expect(after.undo).toHaveLength(before.undo.length + 1);
		expect(after.undo.at(-1)!.origin).toBe('agent:test');
		expect(after.revision).toBe(before.revision + 1);
		expect(after.sequence).toBe(Math.max(before.sequence + 3, nextModelSequence(after.graph)));
		await harness.ok('UNDO', { expectedRevision: after.revision });
		expect(graphsEqual(harness.graph(), before.graph)).toBe(true);
		await harness.ok('REDO', { expectedRevision: harness.revision() });
		expect(graphsEqual(harness.graph(), after.graph)).toBe(true);
	});

	test('T-RB3 the owner redo stack survives a failed agent call', async () => {
		const harness = await created();
		await harness.ok('COMMAND', { expectedRevision: 0, data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } });
		const withRectangle = harness.graph();
		await harness.ok('UNDO', { expectedRevision: 1 });
		const before = harness.state();
		expect(before.redo).toHaveLength(1);
		failure(() => harness.d.stageAndCommit([rectangle(3, 0, 4, 1), pushMissing], 'test'));
		expectUnchanged(harness, before);
		await harness.ok('REDO', { expectedRevision: harness.revision() });
		expect(graphsEqual(harness.graph(), withRectangle)).toBe(true);
	});

	test('T-RB4 a no-op builder commits nothing and keeps the redo stack and sequence', async () => {
		const harness = await created();
		await harness.ok('COMMAND', { expectedRevision: 0, data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } });
		await harness.ok('UNDO', { expectedRevision: 1 });
		const before = harness.state();
		const commit = harness.d.stageAndCommit([() => ({ entityId: 'none', forward: [], inverse: [] })], 'test');
		expect(commit).toEqual({ changed: false, entityIds: ['none'], revision: before.revision });
		expectUnchanged(harness, before);
	});

	test('T-RB5 AuthoringHistory.execute with an invalid forward throws and leaves document and stacks unchanged', () => {
		const document = BomcDocument.create({ documentId: DOC, name: 'T-RB5' });
		const history = new AuthoringHistory(null);
		const run = (builder: AgentEditBuilder, sequence: number) => {
			const edit = builder(document.snapshot().graph, sequence);
			history.execute(document, { forward: edit.forward, inverse: edit.inverse });
		};
		run(rectangle(0, 0, 1, 1), 1);
		run(rectangle(2, 0, 3, 1), 2);
		history.undo(document);
		const graph = document.snapshot().graph, revision = document.snapshot().revision;
		const stacks = history.checkpoint();
		const edit = rectangle(5, 0, 6, 1)(graph, 3);
		const forward = edit.forward.map((item) => item.type === 'put-mesh' ? { ...item, value: { ...item.value, definitionId: 'missing-definition' } } : item) as DocumentEdit[];
		expect(() => history.execute(document, { forward, inverse: edit.inverse })).toThrow();
		expect(graphsEqual(document.snapshot().graph, graph)).toBe(true);
		expect(document.snapshot().revision).toBe(revision);
		expect(history.checkpoint().undo).toEqual(stacks.undo);
		expect(history.checkpoint().redo).toEqual(stacks.redo);
		document.dispose();
	});

	test('T-RB6 a pending download makes the call BUSY before staging; after ACK it succeeds', async () => {
		const harness = await created();
		await harness.ok('COMMAND', { expectedRevision: 0, data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } });
		const write = await harness.ok('WRITE', { expectedRevision: 1 });
		const before = harness.state();
		let builderCalls = 0;
		const counting: AgentEditBuilder = (graph, sequence) => { builderCalls += 1; return rectangle(3, 0, 4, 1)(graph, sequence); };
		let busy: unknown = null;
		try { harness.d.stageAndCommit([counting], 'test'); } catch (error) { busy = error; }
		expect(busy).toBeInstanceOf(BomcDocumentError);
		expect((busy as BomcDocumentError).code).toBe('BUSY');
		expect(builderCalls).toBe(0);
		expectUnchanged(harness, before);
		await harness.ok('ACK_DOWNLOAD', { expectedRevision: 1, data: { writeId: write.writeId, revision: write.revision } });
		expect(harness.d.stageAndCommit([counting], 'test').changed).toBe(true);
		expect(builderCalls).toBe(1);
	});

	test('a composite over the 20000-edit bound is BUDGET_EXCEEDED with nothing applied', async () => {
		const harness = await created();
		const before = harness.state();
		const many = Array.from({ length: 20001 }, (_, index) => ({ type: 'delete-material', id: `${DOC}:material:op:x${index}` }) as DocumentEdit);
		const error = failure(() => harness.d.stageAndCommit([(graph: BomcGraph) => ({ entityId: 'x', forward: [], inverse: [] }), () => ({ entityId: 'y', forward: [], inverse: many })], 'test'));
		expect(error.body.code).toBe('BUDGET_EXCEEDED');
		expectUnchanged(harness, before);
	});
});

describe('C5a step 7 agent undo (T-RB7a/b/c)', () => {
	function spyHistory(harness: Harness) {
		const history = harness.history() as any;
		const calls = { undo: 0, redo: 0 };
		const undo = history.undo.bind(history), redo = history.redo.bind(history);
		history.undo = (...args: unknown[]) => { calls.undo += 1; return undo(...args); };
		history.redo = (...args: unknown[]) => { calls.redo += 1; return redo(...args); };
		return calls;
	}

	test('T-RB7a an owner entry inside steps → UNDO_NOT_AGENT, nothing undone', async () => {
		const harness = await created();
		await harness.ok('COMMAND', { expectedRevision: 0, data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } });
		harness.d.stageAndCommit([rectangle(3, 0, 4, 1)], 'test');
		const before = harness.state();
		const calls = spyHistory(harness);
		const error = failure(() => harness.d.agentUndo(2));
		expect(error.body.code).toBe('UNDO_NOT_AGENT');
		expectUnchanged(harness, before);
		expect(calls).toEqual({ undo: 0, redo: 0 });
		expect(failure(() => harness.d.agentUndo(3)).body.code).toBe('NOTHING_TO_UNDO');
		expect(failure(() => harness.d.agentUndo(11)).body.code).toBe('INVALID_REQUEST');
		expectUnchanged(harness, before);
	});

	async function threeAgentCalls() {
		const harness = await created();
		const before = harness.state();
		harness.d.stageAndCommit([rectangle(0, 0, 1, 1)], 'test');
		harness.d.stageAndCommit([rectangle(2, 0, 3, 1), pushPrevious(0.5)], 'test');
		harness.d.stageAndCommit([rectangle(5, 0, 6, 1)], 'test');
		return { harness, before, after: harness.state() };
	}

	test('T-RB7b undo(3) over three agent entries: revision +1 exactly, stacks equal three sequential undos', async () => {
		const { harness, before, after } = await threeAgentCalls();
		const calls = spyHistory(harness);
		harness.d.agentUndo(3);
		const undone = harness.state();
		expect(undone.revision).toBe(after.revision + 1);
		expect(graphsEqual(undone.graph, before.graph)).toBe(true);
		expect(undone.sequence).toBe(after.sequence);
		expect(undone.undo).toHaveLength(0);
		expect(undone.redo).toHaveLength(3);
		undone.redo.forEach((entry, index) => expect(entry).toBe(after.undo[after.undo.length - 1 - index]!));
		expect(calls).toEqual({ undo: 0, redo: 0 });

		// Reference fixture: identical calls, then three sequential owner undos.
		const reference = await threeAgentCalls();
		for (let step = 0; step < 3; step += 1) await reference.harness.ok('UNDO', { expectedRevision: reference.harness.revision() });
		expect(reference.harness.state().redo).toEqual(undone.redo);
		expect(graphsEqual(reference.harness.graph(), undone.graph)).toBe(true);

		for (let step = 0; step < 3; step += 1) await harness.ok('REDO', { expectedRevision: harness.revision() });
		expect(graphsEqual(harness.graph(), after.graph)).toBe(true);
	});

	test('T-RB7c undoMany is one transact; a failing commit or a no-op pre-check changes nothing and never calls redo', async () => {
		// History level: exactly one transact on success; a throwing transact changes nothing.
		const { harness, after } = await threeAgentCalls();
		const document = harness.d.document as BomcDocument;
		const history = harness.history();
		let transacts = 0;
		const counting = withTransact(document, (edits) => { transacts += 1; return document.transact(edits); });
		const probe = await threeAgentCalls();
		const probeDocument = probe.harness.d.document as BomcDocument;
		const throwing = withTransact(probeDocument, () => { throw new Error('injected transact failure'); });
		const probeBefore = probe.harness.state();
		expect(() => probe.harness.history().undoMany(throwing, 2)).toThrow('injected transact failure');
		expectUnchanged(probe.harness, probeBefore);
		expect(history.undoMany(counting, 2)).toBe(true);
		expect(transacts).toBe(1);
		expect(harness.revision()).toBe(after.revision + 1);
		expect(() => history.undoMany(document, 2)).toThrow(AuthoringHistoryError);

		// Dispatcher level: the scratch pre-check passes, then the live commit throws.
		const commitCase = await threeAgentCalls();
		const before = commitCase.harness.state();
		const calls = spyHistory(commitCase.harness);
		const live = commitCase.harness.d.document as any;
		const original = live.transact.bind(live);
		live.transact = () => { live.transact = original; throw new Error('injected commit failure'); };
		const commitError = failure(() => commitCase.harness.d.agentUndo(3));
		expect(commitError.body).toMatchObject({ code: 'INVALID_COMMAND', detail: { reason: 'UNDO_COMMIT_REJECTED' } });
		expectUnchanged(commitCase.harness, before);
		expect(calls).toEqual({ undo: 0, redo: 0 });

		// Pre-check failure: an agent entry whose inverse equals the current state → UNDO_NOOP.
		const noop = await threeAgentCalls();
		const graph = noop.harness.graph();
		const root = graph.instances.find((i) => i.id === graph.rootInstanceId)!;
		const stale: AuthoringJournalEntry = Object.freeze({ forward: [{ type: 'put-instance', value: root }], inverse: [{ type: 'put-instance', value: root }], origin: 'agent:test' });
		(noop.harness.history() as any).undoEntries.push(stale);
		const noopBefore = noop.harness.state();
		const noopCalls = spyHistory(noop.harness);
		const noopError = failure(() => noop.harness.d.agentUndo(2));
		expect(noopError.body).toMatchObject({ code: 'INVALID_COMMAND', detail: { reason: 'UNDO_NOOP' } });
		expectUnchanged(noop.harness, noopBefore);
		expect(noopCalls).toEqual({ undo: 0, redo: 0 });
	});
});

describe('composite journals (T-RB9, T-RB10)', () => {
	for (const fixture of ['fresh document (root label null)', 'document with arch metadata'] as const) {
		test(`T-RB9 mixed model_ops composite passes shape, full replay, restore and undo/redo — ${fixture}`, async () => {
			const harness = fixture.startsWith('fresh') ? await created() : await restoredArch();
			const pre = harness.state();
			if (fixture.startsWith('fresh')) expect(pre.graph.instances[0]!.label).toBeNull();
			const commit = harness.d.stageAndCommit(mixedOps(), 'test');
			expect(commit.changed).toBe(true);
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

	test('T-RB10 compaction is equivalent to the raw composite and leaves one edit per family:id', async () => {
		const harness = await created();
		const pre = harness.state();
		// Recompute the raw composite exactly as stageAndCommit stages it.
		const scratch = BomcDocument.fromGraph(pre.graph, pre.revision);
		const rawForward: DocumentEdit[] = [];
		const inverses: (readonly DocumentEdit[])[] = [];
		mixedOps().forEach((builder, index) => {
			const edit = builder(scratch.snapshot().graph, pre.sequence + index);
			scratch.transact(edit.forward);
			rawForward.push(...edit.forward);
			inverses.push(edit.inverse);
		});
		scratch.dispose();
		const rawInverse = [...inverses].reverse().flat();
		harness.d.stageAndCommit(mixedOps(), 'test');
		const post = harness.state();
		const entry = post.undo.at(-1)!;
		expect(entry.forward).toEqual(compactAgentEdits(rawForward));
		expect(entry.inverse).toEqual(compactAgentEdits(rawInverse));
		expect(rawForward.length).toBeGreaterThan(entry.forward.length);

		const apply = (graph: BomcGraph, edits: readonly DocumentEdit[]) => {
			const document = BomcDocument.fromGraph(graph);
			document.transact(edits);
			const result = document.snapshot().graph;
			document.dispose();
			return result;
		};
		expect(graphsEqual(apply(pre.graph, rawForward), apply(pre.graph, entry.forward))).toBe(true);
		expect(graphsEqual(apply(pre.graph, entry.forward), post.graph)).toBe(true);
		expect(graphsEqual(apply(post.graph, rawInverse), apply(post.graph, entry.inverse))).toBe(true);
		expect(graphsEqual(apply(post.graph, entry.inverse), pre.graph)).toBe(true);
		for (const list of [entry.forward, entry.inverse]) {
			const keys = list.map(family);
			expect(new Set(keys).size).toBe(keys.length);
			expect(hasRootPut(list, post.graph)).toBe(true);
		}
	});
});

describe('origin preservation (T-RB11)', () => {
	test('checkpoint → structuredClone → restore keeps agent origins; owner entries stay without origin', async () => {
		const harness = await created();
		await harness.ok('COMMAND', { expectedRevision: 0, data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [1, 0, 1] } });
		harness.d.stageAndCommit([rectangle(3, 0, 4, 1)], 'claude-code');
		const checkpoint = structuredClone(harness.history().checkpoint());
		expect(Object.keys(checkpoint.undo[0]!)).toEqual(['forward', 'inverse']);
		expect(checkpoint.undo[1]!.origin).toBe('agent:claude-code');
		const restored = new AuthoringHistory();
		restored.restore(checkpoint);
		expect(restored.checkpoint().undo[1]!.origin).toBe('agent:claude-code');
		expect(Object.hasOwn(restored.checkpoint().undo[0]!, 'origin')).toBe(false);
		expect(restored.topOrigins(2)).toEqual(['agent:claude-code', null]);
		const full = structuredClone(harness.d.authoringResult().checkpoint);
		expect(isAuthoringCheckpointShape(full)).toBe(true);
		expect(() => validateAuthoringCheckpoint(full)).not.toThrow();
	});

	test("origin 'owner' or an unknown extra key is rejected by assertJournalEntryShape", async () => {
		const harness = await created();
		const graph = harness.graph();
		const edit = rectangle(0, 0, 1, 1)(graph, 1);
		const document = BomcDocument.fromGraph(graph);
		const history = new AuthoringHistory(null);
		expect(() => history.execute(document, { forward: edit.forward, inverse: edit.inverse, origin: 'owner' })).toThrow(AuthoringHistoryError);
		expect(() => history.execute(document, { forward: edit.forward, inverse: edit.inverse, extra: 1 } as any)).toThrow(AuthoringHistoryError);
		expect(document.snapshot().revision).toBe(0);
		expect(() => history.restore({ undo: [{ forward: edit.forward, inverse: edit.inverse, origin: 'owner' }], redo: [], savedGraph: null })).toThrow(AuthoringHistoryError);
		document.dispose();
		// A real agent checkpoint whose origin is forged: the envelope shape admits any string,
		// history validation rejects anything but `agent:<slot>`.
		harness.d.stageAndCommit([rectangle(0, 0, 1, 1)], 'test');
		const genuine = structuredClone(harness.d.authoringResult().checkpoint) as any;
		expect(() => validateAuthoringCheckpoint(genuine)).not.toThrow();
		const forged = structuredClone(genuine);
		forged.history.undo[0].origin = 'owner';
		expect(isAuthoringCheckpointShape(forged)).toBe(true);
		expect(() => validateAuthoringCheckpoint(forged)).toThrow(AuthoringHistoryError);
		const extra = structuredClone(genuine);
		extra.history.undo[0].note = 'x';
		expect(isAuthoringCheckpointShape(extra)).toBe(false);
	});
});

describe('AuthoringClient.agent end-to-end (C5 plumbing)', () => {
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

	test('read placeholder leaves the checkpoint; committed write and agent undo publish validated checkpoints', async () => {
		let worker!: AdapterWorker;
		const client = new AuthoringClient({ sessionId: SESSION, documentIdFactory: () => DOC, workerFactory: () => (worker = new AdapterWorker()) as unknown as Worker });
		try {
			await client.create();
			const initial = client.checkpoint!;
			const read = await client.agent({ tool: 'describe_scene', args: {}, slot: 'codex', context: CONTEXT as any }, null);
			expect(read.toolResult.ok).toBe(false);
			expect(read.authoring).toBeNull();
			expect(client.checkpoint).toBe(initial);
			await expect(client.agent({ tool: 'edit_model', args: {}, slot: 'codex', context: CONTEXT as any }, null)).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
			await expect(client.agent({ tool: 'nope' as any, args: {}, slot: 'codex', context: CONTEXT as any }, null)).rejects.toMatchObject({ code: 'INVALID_COMMAND' });

			// Substitute the tool runner on this worker instance to drive the write/undo outcomes.
			let next: ToolOutcome = { kind: 'write', builders: mixedOps(), failure: 'ops', receipt: (commit) => commit };
			(worker.dispatcher as any).agentTools = () => next;
			const written = await client.agent({ tool: 'model_ops', args: {}, slot: 'codex', context: CONTEXT as any }, 'current');
			expect(written.toolResult.ok).toBe(true);
			expect(written.authoring!.checkpoint.snapshot.revision).toBe(initial.snapshot.revision + 1);
			expect(client.checkpoint!.history.undo.at(-1)!.origin).toBe('agent:codex');
			expect(client.checkpoint).toBe(written.authoring!.checkpoint);

			const failed = (next = { kind: 'write', builders: [rectangle(8, 0, 9, 1), pushMissing], failure: 'ops', receipt: (commit) => commit },
				await client.agent({ tool: 'model_ops', args: {}, slot: 'codex', context: CONTEXT as any }, 'current'));
			expect(failed).toMatchObject({ authoring: null, toolResult: { ok: false, error: { code: 'INVALID_COMMAND', detail: { opIndex: 1 } } } });
			expect(client.checkpoint).toBe(written.authoring!.checkpoint);

			next = { kind: 'undo', steps: 1 };
			const undone = await client.agent({ tool: 'undo', args: { steps: 1 }, slot: 'codex', context: CONTEXT as any }, 'current');
			expect(undone.authoring!.checkpoint.snapshot.revision).toBe(initial.snapshot.revision + 2);
			expect(client.checkpoint!.history.undo).toHaveLength(0);
			expect(client.checkpoint!.history.redo.at(-1)!.origin).toBe('agent:codex');
			expect(graphsEqual(client.checkpoint!.snapshot.graph, initial.snapshot.graph)).toBe(true);
			const redone = await client.redo();
			expect(redone.checkpoint.history.undo.at(-1)!.origin).toBe('agent:codex');
		} finally { await client.close(); }
	});

	test('review finding 1: a projection failure after a real commit is EDITOR_RENDER_FAILED; the committed checkpoint is kept, nothing retried or rolled back', async () => {
		let worker!: AdapterWorker;
		const client = new AuthoringClient({ sessionId: SESSION, documentIdFactory: () => DOC, workerFactory: () => (worker = new AdapterWorker()) as unknown as Worker });
		try {
			await client.create();
			(worker.dispatcher as any).agentTools = () => ({ kind: 'write', builders: mixedOps(), failure: 'ops', receipt: (commit: any) => commit });
			let agentCalls = 0;
			const port = { get isClosed() { return client.isClosed; }, agent: (...args: Parameters<AuthoringClient['agent']>) => { agentCalls += 1; return client.agent(...args); } };
			const accepted: number[] = [];
			const host = new AgentHost({
				getClient: () => port,
				getCheckpoint: () => client.checkpoint,
				accept: (_c, result) => { accepted.push(result.checkpoint.snapshot.revision); return 'render-failed'; },
				isOwnerBusy: () => false,
				getModeling: () => ({ path: [], selection: [] }),
				getMode: () => 'authoring'
			});
			const before = client.checkpoint!;
			const reply = await host.handle({ id: 'r1', slot: 'codex', session: null, tool: 'model_ops', args: {} });
			const committedRevision = before.snapshot.revision + 1;
			expect(reply).toMatchObject({ ok: false, error: { code: 'EDITOR_RENDER_FAILED', retryable: false, detail: { committed: true, revision: committedRevision } } });
			expect(agentCalls).toBe(1);
			expect(accepted).toEqual([committedRevision]);
			expect(client.checkpoint!.snapshot.revision).toBe(committedRevision);
			expect(client.checkpoint!.history.undo.at(-1)!.origin).toBe('agent:codex');
			const dispatcher = worker.dispatcher as any;
			expect(dispatcher.document.snapshot().revision).toBe(committedRevision);
			expect(dispatcher.history.checkpoint().undo).toHaveLength(1);
			expect(dispatcher.history.checkpoint().redo).toHaveLength(0);
		} finally { await client.close(); }
	});
});
