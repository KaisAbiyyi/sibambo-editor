/**
 * SIB-MCP-MODELING-001 v2.3 C12/A17 — `arch/textfmt.ts`: deterministic number and string formatting for
 * agent perception, plus the host-side completion of the `describe_scene` header.
 *
 * Pure: no kernel, document or three.js import, so the main thread (`AgentHost`) may import it.
 *
 * Text and JSON never diverge (T-P6): tools first build one data object whose numbers are already rounded with
 * `m3`/`a2`/`d1`, then render text from that object only.
 */

const rounded = (value: number, scale: number): number => {
	const r = Math.round(value * scale) / scale;
	return r === 0 ? 0 : r; // `-0.000` prints as `0.000` (A17)
};

/** Metres, 3 dp. */
export const m3 = (value: number): number => rounded(value, 1e3);
/** Square metres, 2 dp. */
export const a2 = (value: number): number => rounded(value, 1e2);
/** Degrees, 1 dp. */
export const d1 = (value: number): number => rounded(value, 10);

export type P2 = [number, number];
export type P3 = [number, number, number];
export type Bounds3 = { min: P3; max: P3 };

export const p2 = (p: readonly number[]): P2 => [m3(p[0]!), m3(p[1]!)];
export const p3 = (p: readonly number[]): P3 => [m3(p[0]!), m3(p[1]!), m3(p[2]!)];

export const fm = (value: number): string => m3(value).toFixed(3);
export const fa = (value: number): string => a2(value).toFixed(2);
export const fd = (value: number): string => d1(value).toFixed(1);
export const fp = (p: readonly number[]): string => `(${p.map(fm).join(',')})`;
export const fbounds = (b: Bounds3 | null): string =>
	b ? ['x', 'y', 'z'].map((axis, k) => `${axis}[${fm(b.min[k]!)},${fm(b.max[k]!)}]`).join(' ') : 'bounds none';

/** `+x/-x/…` when within 1e-6 of an axis, else the 3-dp vector. */
export function fnormal(n: readonly number[]): string {
	for (let k = 0; k < 3; k++) {
		const others = [0, 1, 2].filter((j) => j !== k);
		if (Math.abs(Math.abs(n[k]!) - 1) <= 1e-6 && others.every((j) => Math.abs(n[j]!) <= 1e-6)) return (n[k]! > 0 ? '+' : '-') + 'xyz'[k];
	}
	return fp(n);
}

/**
 * Document strings (names, tags) are untrusted: quoted and escaped so that they can never start a new line, end the
 * quotation, or reorder the text (line/paragraph separators, C1 controls, bidi and zero-width characters).
 */
export function q(value: string): string {
	return JSON.stringify(value).replace(
		/[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
		(c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
	);
}

/** Same escaping without the surrounding quotes, for a message that embeds a document string. */
export const line = (value: string): string => q(value).slice(1, -1).replace(/\\"/g, '"');

/** `… and N more` line, or nothing. */
export const more = (hidden: number, hint: string): string[] => (hidden > 0 ? [`… and ${hidden} more (${hint})`] : []);

// ─── describe_scene header status ────────────────────────────────────────────────────────────────────────────────

/** What the worker prints: writer and pause state live on the main thread (A13/A15), never in the worker. */
export const AGENT_STATUS_UNKNOWN = 'agents: writer unknown · paused unknown';
export type AgentStatus = { writer: string | null; paused: boolean };

/**
 * Completes a `describe_scene` result with the host's writer/pause state. Only the end of the first text line, or the
 * JSON `agents` member, is touched, and only when it still holds the worker's `unknown` value; any other value (including
 * a foreign result shape) is returned unchanged. The C5 request envelope therefore stays exactly `{mode, path, selection}`.
 */
export function withAgentStatus(result: unknown, status: AgentStatus): unknown {
	if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
	const value = result as Record<string, unknown>;
	if (typeof value.text === 'string') {
		const end = value.text.indexOf('\n');
		const head = end < 0 ? value.text : value.text.slice(0, end);
		if (!head.endsWith(AGENT_STATUS_UNKNOWN)) return result;
		const line = `agents: writer ${status.writer ?? 'none'} · paused ${status.paused ? 'yes' : 'no'}`;
		return { ...value, text: head.slice(0, -AGENT_STATUS_UNKNOWN.length) + line + (end < 0 ? '' : value.text.slice(end)) };
	}
	if (value.tool === 'describe_scene' && value.agents === null) return { ...value, agents: { writer: status.writer, paused: status.paused } };
	return result;
}
