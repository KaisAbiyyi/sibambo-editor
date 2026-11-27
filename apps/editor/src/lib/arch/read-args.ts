/**
 * SIB-MCP-MODELING-001 v2.3 C1/A16/A18 — argument checks shared by the read tools.
 *
 * `null` means "not given": the relay forwards every optional parameter, unset ones as null. Unknown keys, wrong types and
 * out-of-range values are INVALID_REQUEST with a JSON pointer; an oversized request is BUDGET_EXCEEDED.
 */
import { AgentToolFailure } from './errors.js';
import { utf8Bytes } from './schema.js';

const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;

export function invalid(message: string, pointer: string): AgentToolFailure {
	return new AgentToolFailure('INVALID_REQUEST', message, { pointer });
}

/** Rejects unknown keys and oversized requests; returns the arguments without nulls. */
export function strictArgs(tool: string, raw: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
	let bytes: number;
	try {
		bytes = utf8Bytes(JSON.stringify(raw));
	} catch {
		throw new AgentToolFailure('INVALID_REQUEST', `${tool} arguments must be JSON-serializable.`);
	}
	if (bytes > MAX_REQUEST_BYTES) throw new AgentToolFailure('BUDGET_EXCEEDED', `${tool} request (${bytes} B) exceeds 256 KiB.`, { bytes });
	for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw invalid(`${tool} has no argument ${JSON.stringify(key)}. Valid: ${allowed.join(', ')}.`, `/${key}`);
	return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null && value !== undefined));
}

export function optionalString(args: Record<string, unknown>, key: string, max = 256): string | null {
	const value = args[key];
	if (value === undefined) return null;
	if (typeof value !== 'string' || value.length === 0 || value.length > max) throw invalid(`${key} must be a string of 1..${max} characters.`, `/${key}`);
	return value;
}

export function integer(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
	const value = args[key];
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid(`${key} must be an integer from ${min} to ${max}.`, `/${key}`);
	return value as number;
}

export function choice<T extends string>(args: Record<string, unknown>, key: string, values: readonly T[], fallback: T): T {
	const value = args[key];
	if (value === undefined) return fallback;
	if (!values.includes(value as T)) throw invalid(`${key} must be one of ${values.join(', ')}.`, `/${key}`);
	return value as T;
}

export function point3(value: unknown, pointer: string): [number, number, number] {
	if (!Array.isArray(value) || value.length !== 3 || value.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw invalid('Expected [x, y, z] with finite numbers.', pointer);
	return [value[0], value[1], value[2]];
}

/** A16/A18: results stay within the 4 MiB relay frame; the caller asks for less instead of receiving a truncated frame. */
export function assertResultSize(result: unknown): void {
	const bytes = utf8Bytes(JSON.stringify(result));
	if (bytes > MAX_RESULT_BYTES - 64 * 1024) {
		throw new AgentToolFailure('BUDGET_EXCEEDED', `The result (${bytes} B) does not fit the 4 MiB limit; ask for fewer ids, a smaller pageSize or a smaller limit.`, { bytes }, 'Nothing was changed. Ask for fewer ids, a smaller pageSize or a smaller limit.');
	}
}
