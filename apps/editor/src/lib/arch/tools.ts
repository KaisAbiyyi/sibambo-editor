/**
 * SIB-MCP-MODELING-001 v2.3 C5 — agent tool dispatcher used by the authoring worker.
 *
 * WP3 delivers only the plumbing: every A14 tool returns a NOT_IMPLEMENTED placeholder, so no
 * agent read or write tool is exposed yet. Later packages replace the placeholders:
 * edit_model + undo (WP6), model_ops (WP7), perception/checks (WP8), get_floor_plan (WP9).
 *
 * Contract for later tools (enforced by the worker, not here):
 * - a tool never mutates the document, history or sequence; it receives a frozen snapshot;
 * - a write tool returns staged builders, which the worker commits only through
 *   `stageAndCommit` as one composite history entry (C5a); a read tool returns a payload;
 * - agent `undo` returns `{kind:'undo', steps}` and the worker runs the atomic C5a step 7.
 * This module is pure and must never import the geometry kernel.
 */
import type { BomcGraph, DocumentEdit } from '@sibambo/bomc-document';
import {
	AGENT_WRITE_TOOLS,
	type AgentContext,
	type AgentToolError,
	type AgentToolName,
	type AgentToolResult
} from '../authoring/protocol.js';

/** One staged op: the edits it applies to the staged graph and their exact inverse. */
export type AgentEdit = { entityId: string; forward: readonly DocumentEdit[]; inverse: readonly DocumentEdit[] };
/** Builds op k against the staged graph produced by ops 0…k−1, with sequence S + k. */
export type AgentEditBuilder = (stagedGraph: BomcGraph, sequence: number) => AgentEdit;
/** Result of a C5a commit. `changed:false` means nothing was committed. */
export type AgentCommit = { changed: boolean; entityIds: string[]; revision: number };

export type ToolContext = Readonly<{
	graph: BomcGraph;
	revision: number;
	sequence: number;
	context: AgentContext;
	slot: string;
	undoCount: number;
	topOrigins: (count: number) => (string | null)[];
}>;

export type ToolOutcome =
	| { kind: 'result'; toolResult: AgentToolResult }
	/** `ops`: a model_ops call (failure → INVALID_COMMAND {opIndex}); `single`: one builder (catalogue code kept). */
	| { kind: 'write'; builders: readonly AgentEditBuilder[]; failure: 'ops' | 'single'; receipt: (commit: AgentCommit) => unknown }
	| { kind: 'undo'; steps: number };

/** A16 catalogue: retryability and the next action the agent should take. */
const CATALOGUE: Readonly<Record<string, { retryable: boolean; nextAction: string }>> = {
	NOT_IMPLEMENTED: { retryable: false, nextAction: 'This Editor build does not implement the tool yet. Tell the owner; do not retry.' },
	INVALID_REQUEST: { retryable: false, nextAction: 'Fix the arguments and call again.' },
	INVALID_COMMAND: { retryable: false, nextAction: 'Nothing was changed. Read the message, fix the operation and call again.' },
	BUDGET_EXCEEDED: { retryable: false, nextAction: 'Nothing was changed. Split the change into smaller calls.' },
	NOTHING_TO_UNDO: { retryable: false, nextAction: 'There are not that many entries to undo. Call describe_scene.' },
	UNDO_NOT_AGENT: { retryable: false, nextAction: 'The entries include owner work. Do not undo it; tell the owner.' },
	MANAGED_MODULE: { retryable: false, nextAction: 'Use edit_model for managed architecture modules.' },
	BUSY: { retryable: true, nextAction: 'The owner is busy in the Editor. Wait a moment and retry.' },
	STALE_REVISION: { retryable: true, nextAction: 'The document changed. Call describe_scene, then retry with the current revision.' },
	NO_EDITABLE_DOCUMENT: { retryable: false, nextAction: 'Stop and ask the owner to create or open a model in authoring mode.' },
	PAUSED_BY_OWNER: { retryable: false, nextAction: 'The owner paused agent writes. Stop and tell the owner; reads still work.' },
	LEASE_HELD: { retryable: true, nextAction: 'Another agent is writing. Retry after detail.retryAfterMs.' },
	EDITOR_OFFLINE: { retryable: true, nextAction: 'Ask the owner to open the Editor and press Hubungkan agent.' },
	EDITOR_RENDER_FAILED: { retryable: false, nextAction: 'The change WAS committed. Do not repeat it; call describe_scene, then tell the owner.' }
};

export function agentError(code: string, message: string, detail?: Record<string, unknown>): AgentToolError {
	const entry = CATALOGUE[code] ?? { retryable: false, nextAction: 'Tell the owner.' };
	const error: AgentToolError = { code, message, retryable: entry.retryable, nextAction: entry.nextAction };
	if (detail !== undefined) error.detail = detail;
	return error;
}

/** Tool-domain failure raised inside the worker: nothing was changed (invariant 3). */
export class AgentToolFailure extends Error {
	readonly body: AgentToolError;
	constructor(code: string, message: string, detail?: Record<string, unknown>) {
		super(message);
		this.name = 'AgentToolFailure';
		this.body = agentError(code, message, detail);
	}
}

export function isAgentWriteTool(tool: AgentToolName): boolean {
	return AGENT_WRITE_TOOLS.has(tool);
}

/** WP3: no tool is implemented, so nothing is exposed and nothing can change. */
export function runTool(tool: AgentToolName, _args: Record<string, unknown>, _ctx: ToolContext): ToolOutcome {
	return {
		kind: 'result',
		toolResult: { ok: false, error: agentError('NOT_IMPLEMENTED', `Tool ${tool} is not available in this Editor build yet.`, { tool }) }
	};
}
