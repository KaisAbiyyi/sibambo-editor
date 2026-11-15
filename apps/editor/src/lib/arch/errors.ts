/**
 * SIB-MCP-MODELING-001 v2.3 A16 — geometry-side error carrier.
 *
 * Kernel, wall and element code throws `ArchError`; the WP6/WP7 tool layer maps it to the catalogue body
 * `{code, message, retryable:false, detail:{moduleId, elementId, reason, at?}}`.
 * Pure: no kernel import, so the main thread may import it too.
 */
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
