/**
 * SIB-MCP-MODELING-001 v2.3 C15 — WebSocket link from the Editor tab to the local agent relay.
 *
 * Local-demo only: the URL must be loopback `ws://…/agent`. Each (re)connect obtains a fresh
 * single-use ticket through the same BFF route the draft client uses (McpConnection.ticket);
 * the ticket goes only in the first HELLO frame, never in a URL, field, storage or log.
 * Calls are dispatched to the host one at a time and answered with `agent_result`.
 */
import { McpConnection, McpHttpError, McpScopeError, type WebSocketTicket } from '../mcp/connection';
import type { AgentCall, AgentReply } from './agent-host';

export const AGENT_CALL_FRAME_LIMIT = 1024 * 1024;
export const AGENT_RESULT_FRAME_LIMIT = 4 * 1024 * 1024;
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type AgentLinkPhase = 'connecting' | 'connected' | 'reconnecting' | 'superseded' | 'error' | 'closed';
export type AgentLinkStatus = Readonly<{ phase: AgentLinkPhase; error: string; calls: number; lastCallAt: number | null }>;

type SocketLike = {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code?: number; reason?: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
};

export type AgentLinkOptions = {
	projectId: string;
	csrf: string;
	/** Loopback agent socket URL, e.g. ws://127.0.0.1:8765/agent. */
	url: string;
	host: { handle(call: AgentCall): Promise<AgentReply> };
	changed: (status: AgentLinkStatus) => void;
	tickets?: { ticket(project: string, csrf: string, refreshSession?: boolean): Promise<WebSocketTicket>; dispose?(): void };
	socketFactory?: (url: string) => SocketLike;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	now?: () => number;
};

const OPEN = 1;

/** Derive the agent socket URL from the session's loopback draft URL (`/draft` → `/agent`). */
export function agentUrlFromDraftUrl(draftUrl: string): string {
	const url = new URL(draftUrl);
	url.pathname = '/agent';
	return url.toString();
}

export function assertAgentUrl(value: string): void {
	const url = new URL(value);
	if (url.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(url.hostname) || url.pathname !== '/agent'
		|| url.search || url.hash || url.username || url.password) {
		throw new Error('Agent link is local-demo only: expected a loopback ws://…/agent URL.');
	}
}

function parseCall(raw: unknown): AgentCall | 'superseded' | null {
	if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > AGENT_CALL_FRAME_LIMIT) return null;
	let message: unknown;
	try { message = JSON.parse(raw); } catch { return null; }
	if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
	const frame = message as Record<string, unknown>;
	if (frame.type === 'superseded') return 'superseded';
	if (frame.type !== 'agent_call') return null;
	const keys = Object.keys(frame).sort().join(',');
	if (keys !== 'args,id,session,slot,tool,type') return null;
	if (typeof frame.id !== 'string' || frame.id.length < 1 || frame.id.length > 128) return null;
	if (typeof frame.slot !== 'string' || typeof frame.tool !== 'string' || frame.tool.length > 64) return null;
	if (frame.session !== null && (typeof frame.session !== 'string' || frame.session.length > 128)) return null;
	return { id: frame.id, slot: frame.slot, session: frame.session as string | null, tool: frame.tool, args: frame.args };
}

export class AgentLink {
	private readonly options: AgentLinkOptions;
	private readonly tickets: NonNullable<AgentLinkOptions['tickets']>;
	private readonly ownsTickets: boolean;
	private socket: SocketLike | null = null;
	private generation = 0;
	private attempts = 0;
	private retryHandle: unknown = null;
	private queue: AgentCall[] = [];
	private pumping = false;
	private statusValue: AgentLinkStatus = Object.freeze({ phase: 'connecting', error: '', calls: 0, lastCallAt: null });
	private stopped = false;

	constructor(options: AgentLinkOptions) {
		assertAgentUrl(options.url);
		this.options = options;
		this.ownsTickets = !options.tickets;
		this.tickets = options.tickets ?? new McpConnection();
		void this.connect(false);
	}

	get status(): AgentLinkStatus { return this.statusValue; }

	/** Owner pressed Putuskan, or the page is going away. */
	dispose(): void {
		this.stopped = true;
		this.generation += 1;
		this.clearRetry();
		this.queue = [];
		const socket = this.socket;
		this.socket = null;
		try { socket?.close(1000, 'owner disconnected'); } catch { /* already closed */ }
		if (this.ownsTickets) this.tickets.dispose?.();
		this.update({ phase: 'closed', error: '' });
	}

	private update(patch: Partial<AgentLinkStatus>) {
		this.statusValue = Object.freeze({ ...this.statusValue, ...patch });
		try { this.options.changed(this.statusValue); } catch { /* observers do not own link state */ }
	}

	private clearRetry() {
		if (this.retryHandle !== null) (this.options.clearTimer ?? ((handle) => clearTimeout(handle as number)))(this.retryHandle);
		this.retryHandle = null;
	}

	private async connect(refreshSession: boolean) {
		if (this.stopped) return;
		const generation = ++this.generation;
		this.update({ phase: this.attempts ? 'reconnecting' : 'connecting' });
		let ticket: WebSocketTicket;
		try {
			ticket = await this.tickets.ticket(this.options.projectId, this.options.csrf, refreshSession);
		} catch (error) {
			if (this.stopped || generation !== this.generation) return;
			if (error instanceof McpScopeError || (error instanceof McpHttpError && [401, 403].includes(error.status))) {
				this.fail(error.message);
			} else this.scheduleReconnect();
			return;
		}
		if (this.stopped || generation !== this.generation) return;
		let socket: SocketLike;
		try { socket = (this.options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike))(this.options.url); }
		catch { this.scheduleReconnect(); return; }
		this.socket = socket;
		let attachment: string | null = ticket.ticket;
		const current = () => !this.stopped && generation === this.generation && this.socket === socket;
		socket.onopen = () => {
			if (!current()) { socket.close(); return; }
			socket.send(JSON.stringify({ type: 'HELLO', ticket: attachment, projectId: this.options.projectId, epoch: null, lastAppliedRevision: 0, lastRenderedRevision: 0 }));
			attachment = null;
			this.attempts = 0;
			this.update({ phase: 'connected', error: '' });
		};
		socket.onmessage = (event) => {
			if (!current()) return;
			const parsed = parseCall(event.data);
			if (parsed === null) return; // ping and malformed frames are ignored
			if (parsed === 'superseded') { this.supersede(); return; }
			this.queue.push(parsed);
			void this.pump(generation);
		};
		socket.onclose = () => {
			if (!current()) return;
			this.socket = null;
			this.scheduleReconnect();
		};
		socket.onerror = () => { if (current()) { try { socket.close(); } catch { /* closing */ } } };
	}

	private async pump(generation: number) {
		if (this.pumping) return;
		this.pumping = true;
		try {
			while (this.queue.length && !this.stopped && generation === this.generation) {
				const call = this.queue.shift()!;
				this.update({ calls: this.statusValue.calls + 1, lastCallAt: (this.options.now ?? Date.now)() });
				let reply: AgentReply;
				try { reply = await this.options.host.handle(call); }
				catch (error) {
					reply = { ok: false, error: { code: 'INVALID_COMMAND', message: error instanceof Error ? error.message : 'Agent host failure.', retryable: false, nextAction: 'Tell the owner.' } };
				}
				this.reply(generation, call.id, reply);
			}
		} finally { this.pumping = false; }
	}

	private reply(generation: number, id: string, reply: AgentReply) {
		const socket = this.socket;
		if (!socket || generation !== this.generation || socket.readyState !== OPEN) return; // relay reports EDITOR_OFFLINE
		let frame = JSON.stringify(reply.ok ? { type: 'agent_result', id, ok: true, result: reply.result } : { type: 'agent_result', id, ok: false, error: reply.error });
		if (new TextEncoder().encode(frame).length > AGENT_RESULT_FRAME_LIMIT) {
			frame = JSON.stringify({ type: 'agent_result', id, ok: false, error: {
				code: 'BUDGET_EXCEEDED', message: 'The tool result exceeds 4 MiB.', retryable: false, nextAction: 'Ask for a smaller page or limit.'
			} });
		}
		try { socket.send(frame); } catch { /* socket closing; relay reports EDITOR_OFFLINE */ }
	}

	private supersede() {
		this.stopped = true;
		this.generation += 1;
		this.clearRetry();
		this.queue = [];
		const socket = this.socket;
		this.socket = null;
		try { socket?.close(1000, 'superseded'); } catch { /* closing */ }
		this.update({ phase: 'superseded', error: 'Agent tersambung di tab lain.' });
	}

	private fail(message: string) {
		this.stopped = true;
		this.generation += 1;
		this.clearRetry();
		this.update({ phase: 'error', error: message });
	}

	private scheduleReconnect() {
		if (this.stopped) return;
		this.clearRetry();
		// Calls from the dead socket cannot be answered; the relay already reports EDITOR_OFFLINE.
		this.queue = [];
		const delay = RECONNECT_DELAYS_MS[Math.min(this.attempts, RECONNECT_DELAYS_MS.length - 1)]!;
		this.attempts += 1;
		this.update({ phase: 'reconnecting', error: 'Sambungan relay terputus; mencoba lagi.' });
		this.retryHandle = (this.options.setTimer ?? ((callback, ms) => setTimeout(callback, ms)))(() => {
			this.retryHandle = null;
			void this.connect(true);
		}, delay);
	}
}
