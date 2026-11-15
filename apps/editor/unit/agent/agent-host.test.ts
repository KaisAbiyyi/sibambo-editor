/**
 * SIB-MCP-MODELING-001 v2.3 WP3 / CP3 — AgentHost owner precedence (A13), writer arbitration
 * (A15) and the C5a step 8 main-thread contract, including T-RB8 and T-RB12.
 */
import { describe, expect, test } from 'bun:test';
import { AgentHost, OWNER_BUSY_WAIT_MS, WRITER_LEASE_MS, type AgentClientPort, type AgentHostOptions } from '../../src/lib/agent/agent-host.js';
import { AuthoringClientError } from '../../src/lib/authoring/bomc-authoring-client.js';
import type { AgentRequest, AgentResult, AuthoringCheckpoint, AuthoringResult } from '../../src/lib/authoring/protocol.js';

const REVISION = 7;
const checkpoint = { snapshot: { revision: REVISION } } as unknown as AuthoringCheckpoint;

function committed(revision = REVISION + 1, entityIds = ['e1']): AgentResult {
	const authoring = { kind: 'authoring', checkpoint: { snapshot: { revision } }, canUndo: true, canRedo: false, dirty: true } as unknown as AuthoringResult;
	return { kind: 'agent', toolResult: { ok: true, result: { changed: true, entityIds, revision } }, authoring };
}

class FakeClient implements AgentClientPort {
	isClosed = false;
	calls: { data: AgentRequest['data']; expectedRevision: number | 'current' | null }[] = [];
	reply: (data: AgentRequest['data']) => Promise<AgentResult> = async (data) => ({
		kind: 'agent', authoring: null, toolResult: { ok: true, result: { tool: data.tool } }
	});
	agent(data: AgentRequest['data'], expectedRevision: number | 'current' | null) {
		this.calls.push({ data, expectedRevision });
		return this.reply(data);
	}
}

function setup(overrides: Partial<AgentHostOptions<FakeClient>> = {}) {
	let clock = 1_000_000;
	const client = new FakeClient();
	const accepted: AuthoringResult[] = [];
	const busy: boolean[] = [];
	const state = { ownerBusy: false, mode: 'authoring', client: client as FakeClient | null, checkpoint: checkpoint as AuthoringCheckpoint | null };
	const host = new AgentHost<FakeClient>({
		getClient: () => state.client,
		getCheckpoint: () => state.checkpoint,
		accept: (_client, result) => { accepted.push(result); return true; },
		isOwnerBusy: () => state.ownerBusy,
		getModeling: () => ({ path: ['outer'], selection: [{ type: 'face', id: 'f1' }] }),
		getMode: () => state.mode,
		captureGeneration: () => 'generation-1',
		onBusy: (value) => busy.push(value),
		now: () => clock,
		sleep: async (ms) => { clock += ms; },
		...overrides
	});
	return { host, client, accepted, busy, state, advance: (ms: number) => { clock += ms; } };
}

const call = (tool: string, slot = 'claude-code', args: unknown = {}) => ({ id: 'c1', slot, session: 's', tool, args });

describe('AgentHost request checks', () => {
	test('unknown tools, malformed slots and non-object args are INVALID_REQUEST', async () => {
		const { host, client } = setup();
		expect(await host.handle(call('run_script'))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
		expect(await host.handle(call('describe_scene', 'Bad Slot'))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
		expect(await host.handle(call('describe_scene', 'codex', []))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
		expect(client.calls).toHaveLength(0);
	});

	test('reads carry context and expectedRevision null; writes bind the current revision', async () => {
		const { host, client } = setup();
		expect(await host.handle(call('describe_scene'))).toEqual({ ok: true, result: { tool: 'describe_scene' } });
		expect(client.calls[0]).toEqual({
			data: { tool: 'describe_scene', args: {}, slot: 'claude-code', context: { mode: 'authoring', path: ['outer'], selection: [{ type: 'face', id: 'f1' }] } },
			expectedRevision: null
		});
		await host.handle(call('edit_model'));
		expect(client.calls[1]!.expectedRevision).toBe('current');
	});
});

describe('AgentHost pause and mode (A13)', () => {
	test('paused: writes PAUSED_BY_OWNER, reads still work', async () => {
		const { host, client } = setup();
		host.setPaused(true);
		expect(await host.handle(call('model_ops'))).toMatchObject({ ok: false, error: { code: 'PAUSED_BY_OWNER', retryable: false } });
		expect(await host.handle(call('describe_scene'))).toMatchObject({ ok: true });
		expect(client.calls.map((c) => c.data.tool)).toEqual(['describe_scene']);
		host.setPaused(false);
		expect(await host.handle(call('model_ops'))).toMatchObject({ ok: true });
	});

	test('no document or viewer mode → NO_EDITABLE_DOCUMENT for writes; reads need a document', async () => {
		const { host, client, state } = setup();
		state.mode = 'imported';
		expect(await host.handle(call('edit_model'))).toMatchObject({ ok: false, error: { code: 'NO_EDITABLE_DOCUMENT' } });
		expect(await host.handle(call('describe_scene'))).toMatchObject({ ok: true });
		expect(client.calls.at(-1)!.data.context.mode).toBe('viewer');
		state.client = null;
		expect(await host.handle(call('describe_scene'))).toMatchObject({ ok: false, error: { code: 'NO_EDITABLE_DOCUMENT' } });
		state.client = client; state.checkpoint = null;
		expect(await host.handle(call('undo'))).toMatchObject({ ok: false, error: { code: 'NO_EDITABLE_DOCUMENT' } });
	});
});

describe('AgentHost owner busy wait (A13)', () => {
	test('waits while the owner is busy and proceeds when free', async () => {
		let polls = 0;
		const { host, client, state } = setup({ isOwnerBusy: () => { polls += 1; return polls < 4; } });
		void state;
		expect(await host.handle(call('edit_model'))).toMatchObject({ ok: true });
		expect(polls).toBe(4);
		expect(client.calls).toHaveLength(1);
	});

	test('fails BUSY (retryable) after 5 s without calling the worker', async () => {
		const { host, client, state } = setup();
		state.ownerBusy = true;
		const started = Date.now();
		const reply = await host.handle(call('edit_model'));
		expect(reply).toMatchObject({ ok: false, error: { code: 'BUSY', retryable: true } });
		expect(client.calls).toHaveLength(0);
		expect(host.state.lastCall!.ms).toBeGreaterThanOrEqual(OWNER_BUSY_WAIT_MS);
		expect(Date.now() - started).toBeLessThan(2000); // fake clock
	});
});

describe('AgentHost writer lease (A15)', () => {
	test('another slot inside the 60 s window gets LEASE_HELD; the holder renews; the lease expires', async () => {
		const { host, client, advance } = setup();
		expect(await host.handle(call('edit_model', 'claude-code'))).toMatchObject({ ok: true });
		expect(host.state.writer).toBe('claude-code');
		advance(10_000);
		const held = await host.handle(call('model_ops', 'codex'));
		expect(held).toMatchObject({ ok: false, error: { code: 'LEASE_HELD', retryable: true, detail: { writer: 'claude-code', retryAfterMs: WRITER_LEASE_MS - 10_000 } } });
		expect(await host.handle(call('describe_scene', 'codex'))).toMatchObject({ ok: true }); // reads never need the lease
		advance(30_000);
		expect(await host.handle(call('edit_model', 'claude-code'))).toMatchObject({ ok: true }); // renews
		advance(59_000);
		expect(await host.handle(call('edit_model', 'codex'))).toMatchObject({ ok: false, error: { code: 'LEASE_HELD' } });
		advance(1_000);
		expect(host.state.writer).toBeNull();
		expect(await host.handle(call('edit_model', 'codex'))).toMatchObject({ ok: true });
		expect(host.state.writer).toBe('codex');
		expect(client.calls.filter((c) => c.data.tool !== 'describe_scene').map((c) => c.data.slot)).toEqual(['claude-code', 'claude-code', 'codex']);
	});
});

describe('AgentHost stale revision and worker errors', () => {
	test('baseRevision must equal the acknowledged revision', async () => {
		const { host, client } = setup();
		expect(await host.handle(call('edit_model', 'codex', { baseRevision: REVISION - 1 }))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION', detail: { currentRevision: REVISION } } });
		expect(client.calls).toHaveLength(0);
		expect(await host.handle(call('edit_model', 'codex', { baseRevision: REVISION }))).toMatchObject({ ok: true });
		expect(client.calls[0]!.expectedRevision).toBe(REVISION);
		expect(await host.handle(call('edit_model', 'codex', { baseRevision: 'x' }))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
	});

	test('worker errors map to the catalogue, never accept, and are logged as rejected', async () => {
		const { host, client, accepted, busy } = setup();
		const cases: [AuthoringClientError, string][] = [
			[new AuthoringClientError('STALE_REVISION', 'stale', 9), 'STALE_REVISION'],
			[new AuthoringClientError('BUSY', 'download pending'), 'BUSY'],
			[new AuthoringClientError('CLOSED', 'closed'), 'NO_EDITABLE_DOCUMENT'],
			[new AuthoringClientError('INVALID_COMMAND', 'kernel says no'), 'INVALID_COMMAND']
		];
		for (const [error, code] of cases) {
			client.reply = async () => { throw error; };
			expect(await host.handle(call('model_ops'))).toMatchObject({ ok: false, error: { code } });
		}
		client.reply = async () => ({ kind: 'agent', authoring: null, toolResult: { ok: false, error: { code: 'UNDO_NOT_AGENT', message: 'm', retryable: false, nextAction: 'n' } } });
		expect(await host.handle(call('undo'))).toMatchObject({ ok: false, error: { code: 'UNDO_NOT_AGENT' } });
		expect(accepted).toHaveLength(0);
		expect(host.state.activity.every((row) => row.outcome === 'rejected')).toBe(true);
		expect(busy.filter((value) => value).length).toBe(busy.filter((value) => !value).length);
	});
});

describe('AgentHost committed results (C5a step 8)', () => {
	test('a committed write is accepted once with the captured generation and logged ok', async () => {
		const tokens: unknown[] = [];
		const { host, client, accepted, busy } = setup({ accept: (_c, result, token) => { accepted.push(result); tokens.push(token); return true; } });
		client.reply = async () => committed();
		expect(await host.handle(call('model_ops'))).toEqual({ ok: true, result: { changed: true, entityIds: ['e1'], revision: REVISION + 1 } });
		expect(accepted).toHaveLength(1);
		expect(tokens).toEqual(['generation-1']);
		expect(busy).toEqual([true, false]);
		expect(host.state.lastCall).toMatchObject({ tool: 'model_ops', outcome: 'ok', code: null });
	});

	test('T-RB8 + T-RB12: accept throws → EDITOR_RENDER_FAILED, committed detail, no retry, no second accept, logged committed', async () => {
		let accepts = 0;
		const { host, client } = setup({ accept: () => { accepts += 1; throw new Error('render exploded'); } });
		client.reply = async () => committed(REVISION + 1, ['a', 'b']);
		const reply = await host.handle(call('model_ops'));
		expect(reply).toEqual({
			ok: false,
			error: {
				code: 'EDITOR_RENDER_FAILED', retryable: false, message: expect.any(String), nextAction: expect.stringContaining('committed'),
				detail: { committed: true, revision: REVISION + 1, entityIds: ['a', 'b'] }
			}
		});
		expect(client.calls).toHaveLength(1);
		expect(accepts).toBe(1);
		expect(host.state.lastCall).toMatchObject({ outcome: 'committed', code: 'EDITOR_RENDER_FAILED' });
		expect(host.state.lastCall!.outcome).not.toBe('rejected');
	});

	test('accept returning false (page moved on) is also a committed EDITOR_RENDER_FAILED', async () => {
		const { host, client } = setup({ accept: () => false });
		client.reply = async () => ({ ...committed(REVISION + 1), toolResult: { ok: true, result: { undone: 1, revision: REVISION + 1 } } });
		expect(await host.handle(call('undo'))).toMatchObject({ ok: false, error: { code: 'EDITOR_RENDER_FAILED', detail: { committed: true, revision: REVISION + 1, entityIds: [] } } });
	});
});

describe('AgentHost serialisation and activity log', () => {
	test('calls run one at a time in arrival order; the log keeps the last 50', async () => {
		const { host, client } = setup();
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		client.reply = async (data) => { order.push(`start:${data.tool}`); if (data.tool === 'describe_scene') await gate; order.push(`end:${data.tool}`); return { kind: 'agent', authoring: null, toolResult: { ok: true, result: null } }; };
		const first = host.handle(call('describe_scene'));
		const second = host.handle(call('check_model'));
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(order).toEqual(['start:describe_scene']);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(['start:describe_scene', 'end:describe_scene', 'start:check_model', 'end:check_model']);
		for (let index = 0; index < 60; index += 1) await host.handle(call('measure'));
		expect(host.state.activity).toHaveLength(50);
	});

	test('a disposed host answers without touching the client', async () => {
		const { host, client } = setup();
		host.dispose();
		expect(await host.handle(call('describe_scene'))).toMatchObject({ ok: false, error: { code: 'EDITOR_OFFLINE' } });
		expect(client.calls).toHaveLength(0);
	});
});
