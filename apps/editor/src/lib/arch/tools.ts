/**
 * SIB-MCP-MODELING-001 v2.3 C5 & WP6 (C10/A12) — agent tool dispatcher used by the authoring worker.
 *
 * WP6 activates `edit_model` and `undo`. Later packages replace the remaining placeholders:
 * `model_ops` (WP7), perception/checks (WP8), `get_floor_plan` (WP9).
 *
 * Contract enforced by the worker:
 * - a tool never mutates the document, history or sequence; it receives a frozen snapshot;
 * - a write tool returns staged builders, which the worker commits only through
 *   `stageAndCommit` as one composite history entry (C5a); a read tool returns a payload;
 * - agent `undo` returns `{kind:'undo', steps}` and the worker runs the atomic C5a step 7.
 * Error helpers live in pure `./errors.ts` so the main thread (`AgentHost`) never imports the kernel.
 */
import type { BomcGraph, DocumentEdit } from '@sibambo/bomc-document';
import {
	AGENT_WRITE_TOOLS,
	type AgentContext,
	type AgentToolName,
	type AgentToolResult
} from '../authoring/protocol.js';
import { agentError, AgentToolFailure, toAgentToolFailure } from './errors.js';
import { sharedKernel, type Kernel } from './kernel.js';
import { planModelOps } from './model-ops.js';
import { planEditModel } from './patch.js';

export { agentError, AgentToolFailure, toAgentToolFailure };

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
	kernel?: Kernel;
}>;

export type ToolOutcome =
	| { kind: 'result'; toolResult: AgentToolResult }
	/** `ops`: a model_ops call (failure → INVALID_COMMAND {opIndex}); `single`: one builder (catalogue code kept). */
	| { kind: 'write'; builders: readonly AgentEditBuilder[]; failure: 'ops' | 'single'; receipt: (commit: AgentCommit) => unknown }
	| { kind: 'undo'; steps: number };

export function isAgentWriteTool(tool: AgentToolName): boolean {
	return AGENT_WRITE_TOOLS.has(tool);
}

/** WP7: `edit_model` (C10), `model_ops` (C11), and `undo` (A12) are active; remaining tools return `NOT_IMPLEMENTED`. */
export function runTool(tool: AgentToolName, args: Record<string, unknown>, ctx: ToolContext): ToolOutcome | Promise<ToolOutcome> {
	if (tool === 'undo') {
		const extraKeys = Object.keys(args).filter((k) => k !== 'steps');
		if (extraKeys.length > 0) {
			return {
				kind: 'result',
				toolResult: { ok: false, error: agentError('INVALID_REQUEST', `Unexpected argument(s) for undo: ${extraKeys.join(', ')}.`) }
			};
		}
		const steps = args.steps === undefined ? 1 : args.steps;
		if (!Number.isSafeInteger(steps) || (steps as number) < 1 || (steps as number) > 10) {
			return {
				kind: 'result',
				toolResult: { ok: false, error: agentError('INVALID_REQUEST', 'steps must be an integer from 1 to 10.') }
			};
		}
		return { kind: 'undo', steps: steps as number };
	}

	if (tool === 'model_ops') {
		try {
			const plan = planModelOps(ctx.graph, args);
			return {
				kind: 'write',
				builders: plan.builders,
				failure: 'ops',
				receipt: plan.receipt
			};
		} catch (error) {
			const failure = toAgentToolFailure(error);
			return { kind: 'result', toolResult: { ok: false, error: failure.body } };
		}
	}

	if (tool === 'edit_model') {
		return (async () => {
			try {
				const kernel = ctx.kernel ?? sharedKernel;
				await kernel.init();
				const plan = planEditModel(ctx.graph, args, kernel);
				return {
					kind: 'write' as const,
					builders: plan.builders,
					failure: 'single' as const,
					receipt: plan.receipt
				};
			} catch (error) {
				const failure = toAgentToolFailure(error);
				return { kind: 'result' as const, toolResult: { ok: false as const, error: failure.body } };
			}
		})();
	}

	return {
		kind: 'result',
		toolResult: { ok: false, error: agentError('NOT_IMPLEMENTED', `Tool ${tool} is not available in this Editor build yet.`, { tool }) }
	};
}
