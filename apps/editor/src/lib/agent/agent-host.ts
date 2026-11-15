/**
 * SIB-MCP-MODELING-001 v2.3 C15 — main-thread host for agent tool calls.
 *
 * Applies the owner-precedence rules (A13), writer arbitration (A15) and the C5a step 8
 * main-thread contract before and after one `AuthoringClient.agent` call:
 * - accept the authoring result only after the worker reports success;
 * - a worker error never touches the checkpoint or scene (only the activity row);
 * - if accepting a committed result fails, return EDITOR_RENDER_FAILED with
 *   detail.committed === true, never retry and never roll back (invariant 3a).
 */
import { agentError } from '../arch/tools.js';
import { AuthoringClientError } from '../authoring/bomc-authoring-client.js';
import {
	AGENT_SLOT_PATTERN,
	AGENT_TOOL_NAMES,
	AGENT_WRITE_TOOLS,
	isRecord,
	type AgentContext,
	type AgentRequest,
	type AgentResult,
	type AgentToolError,
	type AgentToolName,
	type AuthoringCheckpoint,
	type AuthoringResult,
	type ModelSelection
} from '../authoring/protocol.js';

export const OWNER_BUSY_WAIT_MS = 5000;
export const OWNER_BUSY_POLL_MS = 50;
export const WRITER_LEASE_MS = 60000;
export const ACTIVITY_LIMIT = 50;

export type AgentCall = { id: string; slot: string; session: string | null; tool: string; args: unknown };
export type AgentReply = { ok: true; result: unknown } | { ok: false; error: AgentToolError };

/** `committed` marks the single committed-with-error outcome (EDITOR_RENDER_FAILED). */
export type AgentActivity = Readonly<{ at: number; slot: string; tool: string; outcome: 'ok' | 'rejected' | 'committed'; code: string | null; ms: number }>;

export type AgentHostState = Readonly<{
	paused: boolean;
	writer: string | null;
	lastCall: AgentActivity | null;
	activity: readonly AgentActivity[];
}>;

/** The part of AuthoringClient the host uses (injected for tests). */
export type AgentClientPort = {
	readonly isClosed: boolean;
	agent(data: AgentRequest['data'], expectedRevision: number | 'current' | null): Promise<AgentResult>;
};

export type AgentHostOptions<TClient extends AgentClientPort = AgentClientPort> = {
	getClient: () => TClient | null;
	getCheckpoint: () => AuthoringCheckpoint | null;
	/** The page's acceptAuthoringResult. Returning false means the page did not apply it. */
	accept: (client: TClient, result: AuthoringResult, token: unknown) => boolean | void;
	isOwnerBusy: () => boolean;
	getModeling: () => { path: readonly string[]; selection: readonly ModelSelection[] };
	getMode: () => string;
	/** Captured before the call and passed to accept (the page's request generation). */
	captureGeneration?: () => unknown;
	/** Marks the page busy while an agent write is in flight. */
	onBusy?: (busy: boolean) => void;
	onChange?: (state: AgentHostState) => void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
};

type Lease = { slot: string; last: number };

function rejected(code: string, message: string, detail?: Record<string, unknown>): AgentReply {
	return { ok: false, error: agentError(code, message, detail) };
}

/** Map an AuthoringClient/worker failure to the A16 catalogue (nothing was changed). */
export function mapClientError(error: unknown): AgentReply {
	if (error instanceof AuthoringClientError) {
		if (error.code === 'STALE_REVISION') return rejected('STALE_REVISION', error.message, { currentRevision: error.currentRevision });
		if (error.code === 'BUSY') return rejected('BUSY', error.message);
		if (error.code === 'CLOSED') return rejected('NO_EDITABLE_DOCUMENT', 'No editable authoring document is open.');
		if (error.code === 'ABORTED') return rejected('BUSY', 'The Editor authoring worker restarted; call describe_scene before retrying.');
		return rejected('INVALID_COMMAND', error.message);
	}
	return rejected('INVALID_COMMAND', error instanceof Error ? error.message : 'The Editor rejected the agent call.');
}

export class AgentHost<TClient extends AgentClientPort = AgentClientPort> {
	private readonly options: AgentHostOptions<TClient>;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private pausedValue = false;
	private lease: Lease | null = null;
	private activityValue: AgentActivity[] = [];
	private chain: Promise<unknown> = Promise.resolve();
	private disposed = false;

	constructor(options: AgentHostOptions<TClient>) {
		this.options = options;
		this.now = options.now ?? (() => Date.now());
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	get state(): AgentHostState {
		return Object.freeze({
			paused: this.pausedValue,
			writer: this.currentWriter(),
			lastCall: this.activityValue.at(-1) ?? null,
			activity: Object.freeze([...this.activityValue])
		});
	}

	setPaused(paused: boolean): void {
		this.pausedValue = paused;
		this.emit();
	}

	/** Calls are serialised: one in flight, the rest wait in arrival order (A2). */
	handle(call: AgentCall): Promise<AgentReply> {
		const run = this.chain.then(() => this.run(call), () => this.run(call));
		this.chain = run.catch(() => undefined);
		return run;
	}

	dispose(): void {
		this.disposed = true;
		this.lease = null;
	}

	private currentWriter(): string | null {
		if (!this.lease || this.now() - this.lease.last >= WRITER_LEASE_MS) return null;
		return this.lease.slot;
	}

	private async run(call: AgentCall): Promise<AgentReply> {
		const started = this.now();
		const slot = typeof call?.slot === 'string' ? call.slot : '';
		const tool = typeof call?.tool === 'string' ? call.tool : '';
		const finish = (reply: AgentReply, outcome: AgentActivity['outcome'] = reply.ok ? 'ok' : 'rejected') => {
			this.record({ at: started, slot, tool, outcome, code: reply.ok ? null : reply.error.code, ms: Math.max(0, this.now() - started) });
			return reply;
		};
		if (this.disposed) return finish(rejected('EDITOR_OFFLINE', 'The Editor agent host was closed.'));
		if (!(AGENT_TOOL_NAMES as readonly string[]).includes(tool)) return finish(rejected('INVALID_REQUEST', `Unknown tool ${tool || '(none)'}.`));
		if (!AGENT_SLOT_PATTERN.test(slot)) return finish(rejected('INVALID_REQUEST', 'Agent slot is malformed.'));
		if (!isRecord(call.args)) return finish(rejected('INVALID_REQUEST', 'Tool arguments must be an object.'));
		const name = tool as AgentToolName;
		const args = call.args;
		const write = AGENT_WRITE_TOOLS.has(name);
		if (write && this.pausedValue) return finish(rejected('PAUSED_BY_OWNER', 'The owner paused agent writes. Reads still work.'));
		if (!this.editable(write)) return finish(rejected('NO_EDITABLE_DOCUMENT', 'Open or create a model in authoring mode first.'));

		// A13 owner precedence: wait up to 5 s while the owner is busy, then BUSY (retryable).
		const deadline = this.now() + OWNER_BUSY_WAIT_MS;
		while (this.options.isOwnerBusy()) {
			if (this.disposed) return finish(rejected('EDITOR_OFFLINE', 'The Editor agent host was closed.'));
			if (this.now() >= deadline) return finish(rejected('BUSY', 'The owner is busy in the Editor (editing or saving).'));
			await this.sleep(OWNER_BUSY_POLL_MS);
		}
		if (!this.editable(write)) return finish(rejected('NO_EDITABLE_DOCUMENT', 'Open or create a model in authoring mode first.'));
		const client = this.options.getClient()!;
		const checkpoint = this.options.getCheckpoint()!;

		let expectedRevision: number | 'current' | null = null;
		if (write) {
			// A15 writer arbitration.
			const writer = this.currentWriter();
			if (writer !== null && writer !== slot) {
				const retryAfterMs = Math.max(1, WRITER_LEASE_MS - (this.now() - this.lease!.last));
				return finish(rejected('LEASE_HELD', `Agent ${writer} holds the writer role.`, { writer, retryAfterMs }));
			}
			const base = args.baseRevision;
			if (base !== undefined && base !== null) {
				if (!Number.isSafeInteger(base) || (base as number) < 0) return finish(rejected('INVALID_REQUEST', 'baseRevision must be a non-negative integer.'));
				if (base !== checkpoint.snapshot.revision) {
					return finish(rejected('STALE_REVISION', `The document is at revision ${checkpoint.snapshot.revision}.`, { currentRevision: checkpoint.snapshot.revision }));
				}
				expectedRevision = base as number;
			} else expectedRevision = 'current';
			this.lease = { slot, last: this.now() };
		}

		const modeling = this.options.getModeling();
		const context: AgentContext = {
			mode: this.options.getMode() === 'authoring' ? 'authoring' : 'viewer',
			path: [...modeling.path],
			selection: structuredClone([...modeling.selection]) as ModelSelection[]
		};
		const token = this.options.captureGeneration?.();
		if (write) this.options.onBusy?.(true);
		try {
			let result: AgentResult;
			try {
				result = await client.agent({ tool: name, args, slot, context }, expectedRevision);
			} catch (error) {
				return finish(mapClientError(error));
			}
			if (!result.toolResult.ok) return finish({ ok: false, error: result.toolResult.error });
			if (result.authoring === null) return finish({ ok: true, result: result.toolResult.result });
			let accepted = false;
			try { accepted = this.options.accept(client, result.authoring, token) !== false; }
			catch { accepted = false; }
			if (!accepted) {
				const receipt = result.toolResult.result;
				const entityIds = isRecord(receipt) && Array.isArray(receipt.entityIds) ? receipt.entityIds : [];
				return finish(rejected('EDITOR_RENDER_FAILED', 'The worker committed the change, but the Editor could not show it.', {
					committed: true, revision: result.authoring.checkpoint.snapshot.revision, entityIds
				}), 'committed');
			}
			return finish({ ok: true, result: result.toolResult.result });
		} finally {
			if (write) this.options.onBusy?.(false);
		}
	}

	private editable(write: boolean): boolean {
		const client = this.options.getClient();
		if (!client || client.isClosed || !this.options.getCheckpoint()) return false;
		return !write || this.options.getMode() === 'authoring';
	}

	private record(activity: AgentActivity) {
		this.activityValue = [...this.activityValue, Object.freeze(activity)].slice(-ACTIVITY_LIMIT);
		this.emit();
	}

	private emit() {
		try { this.options.onChange?.(this.state); } catch { /* observers do not own host state */ }
	}
}
