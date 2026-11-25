/**
 * SIB-MCP-MODELING-001 v2.3 C5 & WP6 (C10/A12) — agent tool dispatcher used by the authoring worker.
 *
 * Active: `edit_model` and `undo` (WP6), `model_ops` (WP7), perception and checks (WP8). `get_floor_plan` (WP9) is still
 * a placeholder; `read_guide` is answered by the relay.
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
import { checkModel, parseCheckArgs } from './checks.js';
import {
	describeElement, describeScene, measure, parseElementArgs, parseMeasureArgs, parseRegionArgs, parseSceneArgs, queryRegion
} from './perception.js';
import { assertResultSize } from './read-args.js';
import { needsKernel, readScene, type ReadScene } from './read-model.js';

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

/** Parses the arguments of a read tool and returns what to compute once the scene is indexed; `null` for any other tool. */
function readTool(tool: AgentToolName, raw: Record<string, unknown>, ctx: ToolContext): ((scene: ReadScene) => Record<string, unknown>) | null {
	switch (tool) {
		case 'describe_scene': {
			const args = parseSceneArgs(raw);
			return (scene) => describeScene(scene, ctx.revision, ctx.context, args);
		}
		case 'describe_element': {
			const args = parseElementArgs(raw);
			return (scene) => describeElement(scene, ctx.revision, args);
		}
		case 'query_region': {
			const args = parseRegionArgs(raw);
			return (scene) => queryRegion(scene, ctx.revision, args);
		}
		case 'measure': {
			const args = parseMeasureArgs(raw);
			return (scene) => measure(scene, ctx.revision, args);
		}
		case 'check_model': {
			const args = parseCheckArgs(raw);
			return (scene) => checkModel(scene, ctx.revision, args);
		}
		default:
			return null;
	}
}

/** Read tools (WP8): arguments are checked before any work; the frozen snapshot is only read (invariant 9). */
async function runReadTool(compute: (scene: ReadScene) => Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
	try {
		const kernel = ctx.kernel ?? sharedKernel;
		if (needsKernel(ctx.graph)) await kernel.init();
		const result = compute(readScene(ctx.graph, kernel));
		assertResultSize(result);
		return { kind: 'result', toolResult: { ok: true, result } };
	} catch (error) {
		return { kind: 'result', toolResult: { ok: false, error: toAgentToolFailure(error).body } };
	}
}

/** Active tools per package (header); the rest return `NOT_IMPLEMENTED`. */
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
			const plan = planModelOps(ctx.graph, args, ctx.sequence);
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

	let compute: ReturnType<typeof readTool>;
	try {
		compute = readTool(tool, args, ctx);
	} catch (error) {
		return { kind: 'result', toolResult: { ok: false, error: toAgentToolFailure(error).body } };
	}
	if (compute) return runReadTool(compute, ctx);

	return {
		kind: 'result',
		toolResult: { ok: false, error: agentError('NOT_IMPLEMENTED', `Tool ${tool} is not available in this Editor build yet.`, { tool }) }
	};
}
