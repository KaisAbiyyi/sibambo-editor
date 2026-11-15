/**
 * SIB-MCP-MODELING-001 v2.3 WP3 — AgentLink frames against the WP2 relay handshake
 * (Builder service/agent_relay.py::AgentSocket): HELLO first with a fresh single-use ticket,
 * exact agent_call / agent_result keys, superseded stops reconnecting, loopback-only URL.
 */
import { describe, expect, test } from 'bun:test';
import { AgentLink, agentUrlFromDraftUrl, assertAgentUrl, RECONNECT_DELAYS_MS, type AgentLinkStatus } from '../../src/lib/agent/agent-link.js';
import { McpHttpError } from '../../src/lib/mcp/connection.js';
import type { AgentCall, AgentReply } from '../../src/lib/agent/agent-host.js';

class FakeSocket {
	readyState = 0;
	sent: string[] = [];
	closed: { code?: number; reason?: string } | null = null;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	constructor(readonly url: string) {}
	send(data: string) { this.sent.push(data); }
	close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; }
	open() { this.readyState = 1; this.onopen?.({}); }
	receive(data: unknown) { this.onmessage?.({ data }); }
	drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}

const TICKET = 'T'.repeat(43);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(handle: (call: AgentCall) => Promise<AgentReply> = async (call) => ({ ok: true, result: { echo: call.tool } })) {
	const sockets: FakeSocket[] = [];
	const statuses: AgentLinkStatus[] = [];
	const timers: { callback: () => void; ms: number }[] = [];
	const tickets: { refresh: boolean }[] = [];
	let ticketFailure: Error | null = null;
	const handled: AgentCall[] = [];
	const link = new AgentLink({
		projectId: 'local-demo', csrf: 'c'.repeat(32), url: 'ws://127.0.0.1:8765/agent',
		host: { handle: async (call) => { handled.push(call); return handle(call); } },
		changed: (status) => statuses.push(status),
		tickets: { ticket: async (project, _csrf, refresh = false) => {
			tickets.push({ refresh });
			if (ticketFailure) throw ticketFailure;
			return { contract: 'se04-owner-mcp-v1', projectId: project, ticket: TICKET, ticketExpiresAt: new Date(Date.now() + 20000).toISOString() };
		} },
		socketFactory: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
		setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
		clearTimer: () => undefined
	});
	return { link, sockets, statuses, timers, tickets, handled, failTickets: (error: Error | null) => { ticketFailure = error; } };
}

describe('AgentLink', () => {
	test('only a loopback ws://…/agent URL is accepted; the draft URL maps to /agent', () => {
		expect(agentUrlFromDraftUrl('ws://127.0.0.1:8765/draft')).toBe('ws://127.0.0.1:8765/agent');
		expect(() => assertAgentUrl('ws://127.0.0.1:8765/agent')).not.toThrow();
		for (const bad of ['wss://127.0.0.1:8765/agent', 'ws://example.com/agent', 'ws://127.0.0.1:8765/draft', 'ws://127.0.0.1:8765/agent?ticket=x']) {
			expect(() => assertAgentUrl(bad)).toThrow();
		}
	});

	test('sends HELLO with the ticket only in the first frame, then answers agent_call with exact keys', async () => {
		const { link, sockets, handled } = setup();
		await flush();
		const socket = sockets[0]!;
		expect(socket.url).toBe('ws://127.0.0.1:8765/agent');
		socket.open();
		expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'HELLO', ticket: TICKET, projectId: 'local-demo', epoch: null, lastAppliedRevision: 0, lastRenderedRevision: 0 });
		expect(link.status.phase).toBe('connected');
		socket.receive(JSON.stringify({ type: 'agent_call', id: 'r1', slot: 'codex', session: 'abc', tool: 'describe_scene', args: { limit: 5 } }));
		await flush(); await flush();
		expect(handled).toEqual([{ id: 'r1', slot: 'codex', session: 'abc', tool: 'describe_scene', args: { limit: 5 } }]);
		expect(JSON.parse(socket.sent[1]!)).toEqual({ type: 'agent_result', id: 'r1', ok: true, result: { echo: 'describe_scene' } });
		expect(socket.sent.slice(1).every((frame) => !frame.includes(TICKET))).toBe(true);
		link.dispose();
	});

	test('ping, malformed and extra-key frames are ignored; errors reply ok:false', async () => {
		const { link, sockets, handled } = setup(async () => ({ ok: false, error: { code: 'BUSY', message: 'm', retryable: true, nextAction: 'n' } }));
		await flush();
		const socket = sockets[0]!;
		socket.open();
		socket.receive(JSON.stringify({ type: 'ping' }));
		socket.receive('not json');
		socket.receive(JSON.stringify({ type: 'agent_call', id: 'r1', slot: 'codex', session: null, tool: 'undo', args: {}, extra: 1 }));
		socket.receive(new ArrayBuffer(4));
		await flush();
		expect(handled).toHaveLength(0);
		socket.receive(JSON.stringify({ type: 'agent_call', id: 'r2', slot: 'codex', session: null, tool: 'undo', args: {} }));
		await flush(); await flush();
		expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'agent_result', id: 'r2', ok: false, error: { code: 'BUSY', message: 'm', retryable: true, nextAction: 'n' } });
		link.dispose();
	});

	test('reconnects with backoff and a fresh ticket; superseded stops for good', async () => {
		const { link, sockets, timers, tickets, statuses } = setup();
		await flush();
		sockets[0]!.open();
		sockets[0]!.drop();
		expect(link.status.phase).toBe('reconnecting');
		expect(timers.map((t) => t.ms)).toEqual([RECONNECT_DELAYS_MS[0]]);
		timers[0]!.callback();
		await flush();
		expect(tickets).toEqual([{ refresh: false }, { refresh: true }]);
		sockets[1]!.open();
		sockets[1]!.receive(JSON.stringify({ type: 'superseded' }));
		expect(link.status).toMatchObject({ phase: 'superseded', error: 'Agent tersambung di tab lain.' });
		expect(sockets[1]!.closed).not.toBeNull();
		sockets[1]!.onclose?.({ code: 1000 });
		expect(timers).toHaveLength(1);
		expect(statuses.at(-1)!.phase).toBe('superseded');
	});

	test('a rejected owner session (401) stops with an error instead of retrying', async () => {
		const setupResult = setup();
		setupResult.failTickets(new McpHttpError(401, 'Sesi login habis. Masuk ulang.'));
		await flush();
		setupResult.sockets[0]!.drop();
		setupResult.timers[0]!.callback();
		await flush();
		expect(setupResult.link.status).toMatchObject({ phase: 'error', error: 'Sesi login habis. Masuk ulang.' });
		expect(setupResult.timers).toHaveLength(1);
	});
});
