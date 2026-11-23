/**
 * SIB-MCP-MODELING-001 v2.3 A16 — pure A16 error catalogue and geometry-side error carrier.
 *
 * Pure: no geometry kernel import, so the main thread (`AgentHost`) and worker may both import it
 * without pulling `manifold-3d` into the main-thread bundle.
 */
import type { AgentToolError } from '../authoring/protocol.js';
import { ArchSchemaError } from './schema.js';

export type ArchErrorCode = 'INVALID_GEOMETRY' | 'BUDGET_EXCEEDED';

export type ArchErrorDetail = {
	moduleId?: string;
	elementId?: string;
	reason: string;
	at?: readonly [number, number];
};

export class ArchError extends Error {
	readonly code: ArchErrorCode;
	readonly detail: ArchErrorDetail;
	constructor(code: ArchErrorCode, detail: ArchErrorDetail, message?: string) {
		super(message ?? `${code} ${detail.reason}${detail.elementId ? ` (${detail.elementId})` : ''}`);
		this.name = 'ArchError';
		this.code = code;
		this.detail = detail;
	}
	/** Same error with the module id filled in (the evaluator knows it, the wall solver does not). */
	withModule(moduleId: string): ArchError {
		return this.detail.moduleId === moduleId
			? this
			: new ArchError(this.code, { ...this.detail, moduleId }, this.message);
	}
}

export function invalidGeometry(reason: string, elementId?: string, at?: readonly [number, number]): ArchError {
	return new ArchError('INVALID_GEOMETRY', { reason, ...(elementId === undefined ? {} : { elementId }), ...(at ? { at } : {}) });
}

export function budgetExceeded(reason: string, elementId?: string): ArchError {
	return new ArchError('BUDGET_EXCEEDED', { reason, ...(elementId === undefined ? {} : { elementId }) });
}

/** A16 catalogue: retryability and the next action the agent should take. */
export const AGENT_ERROR_CATALOGUE: Readonly<Record<string, { retryable: boolean; nextAction: string }>> = {
	NOT_IMPLEMENTED: { retryable: false, nextAction: 'This Editor build does not implement the tool yet. Tell the owner; do not retry.' },
	INVALID_REQUEST: { retryable: false, nextAction: 'Fix the arguments and call again.' },
	INVALID_COMMAND: { retryable: false, nextAction: 'Nothing was changed. Read the message, fix the operation and call again.' },
	INVALID_ELEMENT: { retryable: false, nextAction: 'Nothing was changed. Fix the invalid element or pointer in detail and call again.' },
	INVALID_GEOMETRY: { retryable: false, nextAction: 'Nothing was changed. Fix the geometric defect in detail and call again.' },
	BUDGET_EXCEEDED: { retryable: false, nextAction: 'Nothing was changed. Split the change into smaller calls.' },
	MODULE_DETACHED: { retryable: false, nextAction: 'The owner edited inside this managed module. Tell the owner; they may Undo their edit.' },
	MANAGED_MODULE: { retryable: false, nextAction: 'Use edit_model for managed architecture modules.' },
	NOTHING_TO_UNDO: { retryable: false, nextAction: 'There are not that many entries to undo. Call describe_scene.' },
	UNDO_NOT_AGENT: { retryable: false, nextAction: 'The entries include owner work. Do not undo it; tell the owner.' },
	NOT_FOUND: { retryable: false, nextAction: 'Target module, element, or material was not found. Call describe_scene.' },
	BUSY: { retryable: true, nextAction: 'The owner is busy in the Editor. Wait a moment and retry.' },
	STALE_REVISION: { retryable: true, nextAction: 'The document changed. Call describe_scene, then retry with the current revision.' },
	NO_EDITABLE_DOCUMENT: { retryable: false, nextAction: 'Stop and ask the owner to create or open a model in authoring mode.' },
	PAUSED_BY_OWNER: { retryable: false, nextAction: 'The owner paused agent writes. Stop and tell the owner; reads still work.' },
	LEASE_HELD: { retryable: true, nextAction: 'Another agent is writing. Retry after detail.retryAfterMs.' },
	EDITOR_OFFLINE: { retryable: true, nextAction: 'Ask the owner to open the Editor and press Hubungkan agent.' },
	EDITOR_TIMEOUT: { retryable: true, nextAction: 'The Editor may still finish; call describe_scene before retrying.' },
	SERVICE_OFFLINE: { retryable: true, nextAction: 'Ask the owner to run node tooling/local-demo/launch.mjs.' },
	EDITOR_RENDER_FAILED: { retryable: false, nextAction: 'The change WAS committed. Do not repeat it; call describe_scene, then tell the owner.' }
};

export function agentError(code: string, message: string, detail?: Record<string, unknown>): AgentToolError {
	const entry = AGENT_ERROR_CATALOGUE[code] ?? { retryable: false, nextAction: 'Tell the owner.' };
	const error: AgentToolError = { code, message, retryable: entry.retryable, nextAction: entry.nextAction };
	if (detail !== undefined) error.detail = detail;
	return error;
}

/** Tool-domain failure raised inside the worker: nothing was changed (invariant 3). */
export class AgentToolFailure extends Error {
	readonly body: AgentToolError;
	constructor(code: string, message: string, detail?: Record<string, unknown>, nextAction?: string) {
		super(message);
		this.name = 'AgentToolFailure';
		this.body = agentError(code, message, detail);
		if (nextAction !== undefined) this.body.nextAction = nextAction;
	}
}

/** Convert an internal arch/schema error to an A16 AgentToolFailure (nothing changed). */
export function toAgentToolFailure(error: unknown): AgentToolFailure {
	if (error instanceof AgentToolFailure) return error;
	if (error instanceof ArchError) {
		const nextAction = error.detail.reason === 'WALL_STAGGERED_CONTINUATION'
			? 'Put both walls on the same side, or add a connecting wall.'
			: undefined;
		return new AgentToolFailure(error.code, error.message, { ...error.detail }, nextAction);
	}
	if (error instanceof ArchSchemaError) {
		return new AgentToolFailure('INVALID_ELEMENT', error.message, { pointer: error.pointer });
	}
	return new AgentToolFailure('INVALID_COMMAND', error instanceof Error ? error.message : 'Unexpected architectural edit failure.');
}
