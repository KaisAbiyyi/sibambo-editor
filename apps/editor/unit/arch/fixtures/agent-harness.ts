/**
 * SIB-MCP-MODELING-001 WP8 — scripted (no LLM) worker harness: every call goes through the real
 * `AuthoringWorkerDispatcher`, exactly as the Editor tab drives it. No test-runner import, so `verify-cp8.ts` runs it under Node.
 */
import type { BomcGraph } from '@sibambo/bomc-document';
import { BomcDocument } from '@sibambo/bomc-document/document';
import type { ArchModule } from '../../../src/lib/arch/schema.js';
import { AuthoringWorkerDispatcher } from '../../../src/lib/authoring/bomc-authoring.worker.js';
import type { AuthoringHistory } from '../../../src/lib/authoring/history.js';
import { nextModelSequence, validateAuthoringDocument } from '../../../src/lib/authoring/model.js';
import { AUTHORING_PROTOCOL_VERSION, type AgentContext, type AuthoringWorkerMessage } from '../../../src/lib/authoring/protocol.js';

export const DOC = '7c2e4a10-3b5d-4f60-9a1c-5d6e7f8091a2';
export const CONTEXT: AgentContext = { mode: 'authoring', path: [], selection: [] };

export type ToolReply = { ok: boolean; result?: any; error?: any };

export class AgentHarness {
	readonly messages: AuthoringWorkerMessage[] = [];
	readonly dispatcher = new AuthoringWorkerDispatcher((message) => this.messages.push(message), () => crypto.randomUUID());
	context: AgentContext = CONTEXT;
	private nextId = 1;
	constructor(private readonly session = crypto.randomUUID()) {}
	get d(): any { return this.dispatcher; }
	async send(type: string, extra: Record<string, unknown> = {}): Promise<any> {
		const requestId = this.nextId++;
		this.dispatcher.receive({ protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: this.session, requestId, type, ...extra });
		for (let attempt = 0; attempt < 1000; attempt += 1) {
			const reply = this.messages.find((m) => (m.event === 'RESULT' || m.event === 'ERROR') && (m as any).requestId === requestId) as any;
			if (reply?.event === 'ERROR') throw new Error(`${type} failed: ${JSON.stringify(reply.error)}`);
			if (reply) return reply.result;
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		throw new Error(`${type} timed out`);
	}
	graph(): BomcGraph { return this.d.document.snapshot().graph; }
	revision(): number { return this.d.document.snapshot().revision; }
	history(): AuthoringHistory { return this.d.history; }
	state() {
		const checkpoint = this.history().checkpoint();
		return { graph: structuredClone(this.graph()), identity: this.graph(), revision: this.revision(), undo: [...checkpoint.undo], redo: [...checkpoint.redo], sequence: this.d.sequence as number, issued: this.d.issuedWrite };
	}
	async call(tool: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
		const write = tool === 'edit_model' || tool === 'model_ops' || tool === 'undo';
		const result = await this.send('AGENT', { expectedRevision: write ? this.revision() : null, data: { tool, args, slot: 'claude-code', context: this.context } });
		if (!write && result.authoring !== null) throw new Error(`${tool} returned an authoring result.`);
		return result.toolResult;
	}
	async ok(tool: string, args: Record<string, unknown> = {}): Promise<any> {
		const reply = await this.call(tool, args);
		if (!reply.ok) throw new Error(`${tool}: ${JSON.stringify(reply.error)}`);
		return reply.result;
	}
	async text(tool: string, args: Record<string, unknown> = {}): Promise<string> {
		const result = await this.ok(tool, args);
		if (typeof result.text !== 'string') throw new Error(`${tool} returned no text.`);
		return result.text;
	}
	async fails(tool: string, args: Record<string, unknown>): Promise<any> {
		const reply = await this.call(tool, args);
		if (reply.ok) throw new Error(`${tool} unexpectedly succeeded.`);
		return reply.error;
	}
	/** Owner action through the ordinary command path. */
	async owner(action: unknown, path: string[] = []): Promise<void> {
		await this.send('COMMAND', { expectedRevision: this.revision(), data: { kind: 'MODEL_EDIT', path, action } });
	}
	async addModule(module: ArchModule): Promise<any> {
		return this.ok('edit_model', {
			changes: [
				{ op: 'create_module', moduleId: module.moduleId, ...(module.name ? { name: module.name } : {}), transform: module.transform, materials: module.materials },
				...module.elements.map((element) => ({ op: 'add', moduleId: module.moduleId, element }))
			]
		});
	}
	rootLabel(): any {
		const graph = this.graph();
		return JSON.parse(graph.instances.find((i) => i.id === graph.rootInstanceId)!.label!);
	}
	containerOf(moduleId: string): string {
		return this.rootLabel().arch.modules.find((m: any) => m.module.moduleId === moduleId).instanceId;
	}
	meshOf(instanceId: string | null) {
		const graph = this.graph();
		const definitionId = instanceId === null ? graph.rootDefinitionId : graph.instances.find((i) => i.id === instanceId)!.definitionId;
		return graph.meshes.find((m) => m.definitionId === definitionId)!;
	}
}

export async function newDocument(name = 'Untitled', documentId = DOC): Promise<AgentHarness> {
	const harness = new AgentHarness();
	await harness.send('CREATE', { data: { documentId, name } });
	return harness;
}

/** A session restored from a graph: used for stored states no agent write can produce. */
export async function openGraph(graph: BomcGraph): Promise<AgentHarness> {
	const admission = validateAuthoringDocument(graph);
	if (!admission.editable) throw new Error(admission.reason);
	const document = BomcDocument.fromGraph(graph);
	const snapshot = structuredClone(document.snapshot());
	document.dispose();
	const harness = new AgentHarness();
	await harness.send('RESTORE_CHECKPOINT', { data: { checkpoint: { snapshot, sequence: nextModelSequence(snapshot.graph), history: { undo: [], redo: [], savedGraph: null } } } });
	return harness;
}

/** The same document with one stored module rewritten in the root metadata (baked mesh untouched, so its state stays `ok`). */
export function withStoredModule(graph: BomcGraph, moduleId: string, edit: (module: ArchModule) => void): BomcGraph {
	const copy = structuredClone(graph) as any;
	const root = copy.instances.find((i: any) => i.id === copy.rootInstanceId);
	const label = JSON.parse(root.label);
	edit(label.arch.modules.find((m: any) => m.module.moduleId === moduleId).module);
	root.label = JSON.stringify(label);
	return copy;
}
