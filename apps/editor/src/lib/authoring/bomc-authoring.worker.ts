import { BomcDocument, BomcDocumentError } from '@sibambo/bomc-document/document';
import { readWebBomc } from '@sibambo/bomc-document/reader';
import { BomcWriter } from '@sibambo/bomc-document/writer';
import type { BomcGraph, DocumentEdit } from '@sibambo/bomc-document';
import { BomcContainer } from '@sibambo/e4-import';
import { AgentToolFailure, runTool, type AgentCommit, type AgentEditBuilder } from '../arch/tools.js';
import {
	AuthoringGeometryError,
	buildExtrusionEdit,
	buildFaceLoopEdit,
	buildPlanarRectangleEdit,
	buildPushPullFaceEdit,
	buildRectangleEdit,
	validateRectangleInput,
	type GeometryEdit
} from './geometry.js';
import { buildModelEdit, nextModelSequence as nextAuthoringSequence, validateAuthoringDocument as validateEditableSubset } from './model.js';
import { AuthoringHistory, AuthoringHistoryError, graphsEqual, validateAuthoringCheckpoint } from './history.js';
import {
	AGENT_SLOT_PATTERN,
	AGENT_WRITE_TOOLS,
	AUTHORING_PROTOCOL_VERSION,
	isAuthoringRequest,
	isRecord,
	isUuid,
	isPositiveRequestId,
	type AgentRequest,
	type AgentResult,
	type AuthoringCommand,
	type AuthoringCheckpoint,
	type AuthoringErrorCode,
	type AuthoringRequest,
	type AuthoringResult,
	type AuthoringWorkerMessage,
	type ClosedResult,
	type OpenResult,
	type WorkerErrorMessage,
	type WorkerProgressMessage,
	type WorkerResultMessage,
	type WriteResult
} from './protocol.js';

type PostMessage = (message: AuthoringWorkerMessage, transfer?: Transferable[]) => void;
type IssuedWrite = { writeId: string; revision: number; graph: BomcGraph };
type CachedResponse = { message: WorkerResultMessage | WorkerErrorMessage; writeBytesTransferred: boolean };

const RESPONSE_CACHE_LIMIT = 32;
const REQUEST_QUEUE_LIMIT = 32;

function makeUuid(): string {
	if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('crypto.randomUUID is unavailable in this worker.');
	return globalThis.crypto.randomUUID();
}

function currentErrorCode(error: unknown): AuthoringErrorCode {
	if (error instanceof BomcDocumentError) return error.code;
	if (error instanceof AuthoringGeometryError) return 'INVALID_COMMAND';
	if (error instanceof AuthoringHistoryError) return 'INVALID_COMMAND';
	if (error instanceof AuthoringStaleRevisionError) return error.code;
	return 'INTERNAL_ERROR';
}

function safeMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unexpected authoring worker failure.';
}

function lifecycleType(type: AuthoringRequest['type']) {
	return type === 'CREATE' || type === 'OPEN' || type === 'RESTORE_CHECKPOINT';
}

/** v2.3 C5a: composite journals hold at most this many compacted edits (isModelJournal bound). */
const AGENT_COMPOSITE_EDIT_LIMIT = 20000;
const AGENT_UNDO_MAX_STEPS = 10;
const EDIT_FAMILY: Readonly<Record<string, string>> = {
	'put-material': 'material', 'delete-material': 'material',
	'put-definition': 'definition', 'delete-definition': 'definition',
	'put-mesh': 'mesh', 'delete-mesh': 'mesh',
	'put-instance': 'instance', 'delete-instance': 'instance'
};

function editKey(edit: DocumentEdit, index: number): string {
	const family = EDIT_FAMILY[edit.type];
	if (!family) return `unkeyed:${index}`; // never compacted; execute rejects unsupported edits
	const id = edit.type.startsWith('put-') ? (edit as { value: { id: string } }).value.id : (edit as { id: string }).id;
	return `${family}:${id}`;
}

/**
 * v2.3 C5a step 4: keep only the LAST edit per `family:id`, in the order of those last
 * occurrences. Transact applies edits sequentially and only each id's final value is validated,
 * so the compacted list reaches the same final graph as the raw list.
 */
export function compactAgentEdits(edits: readonly DocumentEdit[]): DocumentEdit[] {
	const last = new Map<string, number>();
	edits.forEach((edit, index) => last.set(editKey(edit, index), index));
	return edits.filter((edit, index) => last.get(editKey(edit, index)) === index);
}

type CommandEdit = { entityId: string; pair: GeometryEdit; consumesSequence: boolean };

/**
 * The owner COMMAND edit builder, extracted unchanged from `AuthoringWorkerDispatcher.command`
 * (v2.3 WP3). Owner commands keep committing it directly through `history.execute`; agent
 * writes never use it (agent ops are lowered to MODEL_EDIT and built with buildModelEdit).
 */
export function buildCommandEdit(graph: BomcGraph, command: AuthoringCommand, sequence: number): CommandEdit {
	let entityId: string;
	let pair: GeometryEdit;
	let consumesSequence = false;
	if (command.kind === 'MODEL_EDIT') {
		const edit = buildModelEdit(graph, command.path, command.action, sequence);
		entityId = edit.entityId;
		pair = { forward: edit.forward, inverse: edit.inverse };
		consumesSequence = true;
	} else if (command.kind === 'CREATE_RECTANGLE') {
		if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) {
			throw new AuthoringGeometryError('Authoring operation sequence is exhausted.');
		}
		entityId = `${graph.documentId}:rectangle:${sequence}`;
		if ('points' in command) {
			pair = buildPlanarRectangleEdit(graph, entityId, command.points, command.normal);
		} else {
			validateRectangleInput(command.first, command.opposite);
			pair = buildRectangleEdit(graph, entityId, command.first, command.opposite);
		}
		consumesSequence = true;
	} else if (command.kind === 'CREATE_FACE_LOOP') {
		if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) {
			throw new AuthoringGeometryError('Authoring operation sequence is exhausted.');
		}
		entityId = `${graph.documentId}:face:${sequence}`;
		pair = buildFaceLoopEdit(graph, entityId, command.points, command.normal, 'line');
		consumesSequence = true;
	} else if (command.kind === 'PUSH_PULL_FACE') {
		if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) {
			throw new AuthoringGeometryError('Authoring operation sequence is exhausted.');
		}
		entityId = command.faceId;
		pair = buildPushPullFaceEdit(graph, command.faceId, command.distance, sequence);
		consumesSequence = true;
	} else {
		entityId = command.entityId;
		pair = buildExtrusionEdit(graph, entityId, command.distance);
	}
	return { entityId, pair, consumesSequence };
}

/**
 * The complete in-worker authority. Exported so unit tests can exercise the
 * actual dispatcher with a structured-clone MessagePort adapter.
 */
export class AuthoringWorkerDispatcher {
	private readonly post: PostMessage;
	private readonly uuid: () => string;
	private readonly queue: AuthoringRequest[] = [];
	private readonly inFlight = new Set<number>();
	private readonly responseCache = new Map<number, CachedResponse>();
	private sessionId: string | null = null;
	private lastRequestId = 0;
	private active = false;
	private closed = false;
	private document: BomcDocument | null = null;
	private writer: BomcWriter | null = null;
	private history: AuthoringHistory | null = null;
	private sequence = 1;
	private issuedWrite: IssuedWrite | null = null;
	/** The C5 tool dispatcher (arch/tools.ts). Unit tests substitute it per instance. */
	private readonly agentTools: typeof runTool = runTool;

	constructor(post: PostMessage, uuid: () => string = makeUuid) {
		this.post = post;
		this.uuid = uuid;
		this.post({ protocolVersion: AUTHORING_PROTOCOL_VERSION, event: 'READY', sessionId: null });
	}

	receive(value: unknown): void {
		if (!isAuthoringRequest(value)) {
			this.rejectMalformed(value);
			return;
		}
		const request = value;
		if (this.sessionId === null) {
			if (!lifecycleType(request.type)) {
				this.sendError(request.sessionId, request.requestId, request.type, 'INVALID_COMMAND', 'The first worker request must create, open, or restore a document.');
				return;
			}
			this.sessionId = request.sessionId;
		} else if (request.sessionId !== this.sessionId) {
			this.sendError(request.sessionId, request.requestId, request.type, 'INVALID_COMMAND', 'Request belongs to a different authoring session.');
			return;
		}

		const cached = this.responseCache.get(request.requestId);
		if (cached) {
			if (cached.writeBytesTransferred) {
				this.sendError(request.sessionId, request.requestId, request.type, 'INVALID_COMMAND', 'The duplicate WRITE response buffer was already transferred.');
			} else {
				this.post(cached.message);
			}
			return;
		}
		if (this.inFlight.has(request.requestId)) return;
		if (request.requestId <= this.lastRequestId) {
			this.sendError(request.sessionId, request.requestId, request.type, 'INVALID_COMMAND', 'An unknown old request ID cannot be replayed.');
			return;
		}
		this.lastRequestId = request.requestId;
		if (this.closed && request.type !== 'CLOSE') {
			this.cacheError(request, 'CLOSED', 'Authoring worker is closed.');
			return;
		}
		if (this.queue.length + Number(this.active) >= REQUEST_QUEUE_LIMIT) {
			this.cacheError(request, 'BUSY', 'Authoring worker queue is full.');
			return;
		}
		this.queue.push(request);
		this.inFlight.add(request.requestId);
		void this.pump();
	}

	private rejectMalformed(value: unknown) {
		if (!isRecord(value) || value.protocolVersion !== AUTHORING_PROTOCOL_VERSION
			|| !isUuid(value.sessionId) || !isPositiveRequestId(value.requestId)) return;
		const requestType = typeof value.type === 'string' ? value.type as AuthoringRequest['type'] : null;
		this.sendError(value.sessionId, value.requestId, requestType, 'INVALID_COMMAND', 'Malformed authoring request envelope.');
	}

	private async pump() {
		if (this.active) return;
		this.active = true;
		try {
			while (this.queue.length > 0) {
				const request = this.queue.shift()!;
				try {
					const result = await this.execute(request);
					const message: WorkerResultMessage = {
						protocolVersion: AUTHORING_PROTOCOL_VERSION,
						event: 'RESULT',
						sessionId: request.sessionId,
						requestId: request.requestId,
						requestType: request.type,
						result
					};
					const writeBytesTransferred = result.kind === 'write';
					this.remember(request.requestId, { message, writeBytesTransferred });
					this.post(message, writeBytesTransferred ? [result.ownedBuffer] : undefined);
				} catch (error) {
					this.cacheError(request, currentErrorCode(error), safeMessage(error));
				} finally {
					this.inFlight.delete(request.requestId);
				}
			}
		} finally {
			this.active = false;
		}
	}

	private async execute(request: AuthoringRequest): Promise<AuthoringResult | OpenResult | WriteResult | ClosedResult | AgentResult> {
		if (this.closed && request.type === 'CLOSE') return { kind: 'closed' };
		switch (request.type) {
			case 'CREATE': return this.create(request);
			case 'OPEN': return await this.open(request);
			case 'RESTORE_CHECKPOINT': return this.restore(request.data.checkpoint);
			case 'COMMAND': return this.command(request);
			case 'UNDO': this.requireRevision(request.expectedRevision); this.requireActiveDocument(); this.history!.undo(this.document!); return this.authoringResult();
			case 'REDO': this.requireRevision(request.expectedRevision); this.requireActiveDocument(); this.history!.redo(this.document!); return this.authoringResult();
			case 'WRITE': return await this.write(request.requestId, request.expectedRevision);
			case 'ACK_DOWNLOAD': return this.acknowledgeDownload(request);
			case 'CLOSE': this.closeState(); return { kind: 'closed' };
			case 'AGENT': return await this.agent(request);
		}
	}

	/**
	 * C5: one agent tool call. Read tools ignore expectedRevision and never mutate. Write tools
	 * check the CAS revision, then commit only through stageAndCommit / agentUndo. Tool-domain
	 * failures become `toolResult.ok === false` with nothing changed; worker-level failures
	 * (STALE_REVISION, BUSY, CLOSED) stay ordinary worker errors.
	 */
	private async agent(request: AgentRequest): Promise<AgentResult> {
		this.requireActiveDocument();
		const { tool, args, slot, context } = request.data;
		const write = AGENT_WRITE_TOOLS.has(tool);
		if (write && request.expectedRevision !== null) this.requireRevision(request.expectedRevision);
		const snapshot = this.document!.snapshot();
		const history = this.history!;
		try {
			const outcome = this.agentTools(tool, args, Object.freeze({
				graph: snapshot.graph,
				revision: snapshot.revision,
				sequence: this.sequence,
				context,
				slot,
				undoCount: history.undoCount,
				topOrigins: (count: number) => history.topOrigins(count)
			}));
			if (outcome.kind === 'result') return { kind: 'agent', toolResult: outcome.toolResult, authoring: null };
			if (!write) throw new AuthoringHistoryError(`Read tool ${tool} attempted a document change.`);
			if (outcome.kind === 'write') {
				const commit = this.stageAndCommit(outcome.builders, slot, outcome.failure);
				let receipt: unknown;
				try { receipt = outcome.receipt(commit); }
				catch { receipt = commit; }
				return { kind: 'agent', toolResult: { ok: true, result: receipt }, authoring: commit.changed ? this.authoringResult() : null };
			}
			this.agentUndo(outcome.steps);
			const revision = this.document!.snapshot().revision;
			return { kind: 'agent', toolResult: { ok: true, result: { undone: outcome.steps, revision } }, authoring: this.authoringResult() };
		} catch (error) {
			if (error instanceof AgentToolFailure) return { kind: 'agent', toolResult: { ok: false, error: error.body }, authoring: null };
			throw error;
		}
	}

	/**
	 * v2.3 C5a stage-then-commit. Every op is built and applied on a scratch copy; only a fully
	 * staged call is committed, as ONE composite history entry with origin `agent:<slot>`.
	 * Any failure leaves graph, revision, both history stacks and sequence untouched; no
	 * rollback through undo/redo/inverse edits ever happens.
	 */
	private stageAndCommit(builders: readonly AgentEditBuilder[], slot: string, failure: 'ops' | 'single' = 'ops'): AgentCommit {
		// 1. Guards before staging (the revision CAS already ran in agent()).
		this.requireActiveDocument();
		if (this.issuedWrite) throw new BomcDocumentError('BUSY', 'Editing is locked while a BOMC download awaits acknowledgment.');
		if (!AGENT_SLOT_PATTERN.test(slot)) throw new AgentToolFailure('INVALID_REQUEST', 'Agent slot is malformed.');
		const live = this.document!.snapshot();
		const start = this.sequence;
		const forwardRaw: DocumentEdit[] = [];
		const inverses: (readonly DocumentEdit[])[] = [];
		const entityIds: string[] = [];
		// 2. Stage on a scratch copy; the live document, history, sequence and issuedWrite are not touched.
		const scratch = BomcDocument.fromGraph(live.graph, live.revision);
		try {
			for (let index = 0; index < builders.length; index += 1) {
				try {
					const edit = builders[index]!(scratch.snapshot().graph, start + index);
					scratch.transact(edit.forward);
					forwardRaw.push(...edit.forward);
					inverses.push(edit.inverse);
					entityIds.push(edit.entityId);
				} catch (error) {
					// 3. Failure during staging: nothing was applied anywhere. A single-builder call keeps
					// its catalogue code; a model_ops op k always reports INVALID_COMMAND {opIndex:k}.
					if (failure === 'single') {
						if (error instanceof AgentToolFailure) throw error;
						throw new AgentToolFailure('INVALID_COMMAND', safeMessage(error));
					}
					throw new AgentToolFailure('INVALID_COMMAND', safeMessage(error), { opIndex: index });
				}
			}
		} finally { scratch.dispose(); }

		// 4. Commit one compacted composite entry.
		const forward = compactAgentEdits(forwardRaw);
		const inverse = compactAgentEdits([...inverses].reverse().flat());
		// 5. No-op. history.execute rejects an empty journal shape, so an empty composite returns
		// here, before execute: no entry, redo stack and sequence untouched.
		if (forward.length === 0 && inverse.length === 0) return { changed: false, entityIds, revision: live.revision };
		if (forward.length > AGENT_COMPOSITE_EDIT_LIMIT || inverse.length > AGENT_COMPOSITE_EDIT_LIMIT) {
			throw new AgentToolFailure('BUDGET_EXCEEDED', `The composite change has more than ${AGENT_COMPOSITE_EDIT_LIMIT} edits.`, { edits: Math.max(forward.length, inverse.length) });
		}
		if (forward.length !== inverse.length) {
			throw new AgentToolFailure('INVALID_COMMAND', 'Composite forward and inverse journals have different lengths.', { reason: 'COMMIT_REJECTED' });
		}
		let changed: boolean;
		try {
			changed = this.history!.execute(this.document!, { forward, inverse, origin: `agent:${slot}` });
		} catch (error) {
			throw new AgentToolFailure('INVALID_COMMAND', safeMessage(error), { reason: 'COMMIT_REJECTED' });
		}
		if (!changed) return { changed: false, entityIds, revision: live.revision };
		// 6. Success.
		this.sequence = Math.max(start + builders.length, nextAuthoringSequence(this.document!.snapshot().graph));
		return { changed: true, entityIds, revision: this.document!.snapshot().revision };
	}

	/**
	 * v2.3 C5a step 7: failure-atomic agent undo of the top `steps` entries. All guards and a
	 * scratch pre-check run before anything changes; the commit is one AuthoringHistory.undoMany
	 * transact (revision +1). Never sequential undo, never redo-based recovery.
	 */
	private agentUndo(steps: number): void {
		this.requireActiveDocument();
		if (this.issuedWrite) throw new BomcDocumentError('BUSY', 'Editing is locked while a BOMC download awaits acknowledgment.');
		if (!Number.isSafeInteger(steps) || steps < 1 || steps > AGENT_UNDO_MAX_STEPS) {
			throw new AgentToolFailure('INVALID_REQUEST', `steps must be an integer from 1 to ${AGENT_UNDO_MAX_STEPS}.`);
		}
		const history = this.history!;
		if (steps > history.undoCount) {
			throw new AgentToolFailure('NOTHING_TO_UNDO', `Only ${history.undoCount} history entries can be undone.`, { available: history.undoCount });
		}
		const origins = history.topOrigins(steps);
		if (origins.some((origin) => origin === null || !origin.startsWith('agent:'))) {
			throw new AgentToolFailure('UNDO_NOT_AGENT', 'The requested entries include owner work; nothing was undone.', { origins });
		}
		const snapshot = this.document!.snapshot();
		const entries = history.checkpoint().undo.slice(-steps).reverse();
		const probe = BomcDocument.fromGraph(snapshot.graph, snapshot.revision);
		try {
			for (const entry of entries) {
				const before = probe.snapshot();
				try { probe.transact(entry.inverse); }
				catch (error) { throw new AgentToolFailure('INVALID_COMMAND', safeMessage(error), { reason: 'UNDO_REJECTED' }); }
				const after = probe.snapshot();
				if (graphsEqual(before.graph, after.graph)) {
					throw new AgentToolFailure('INVALID_COMMAND', 'An agent history entry would not change the document; nothing was undone.', { reason: 'UNDO_NOOP' });
				}
				const admission = validateEditableSubset(after.graph);
				if (!admission.editable) throw new AgentToolFailure('INVALID_COMMAND', admission.reason, { reason: 'UNDO_REJECTED' });
			}
		} finally { probe.dispose(); }
		let changed: boolean;
		try { changed = history.undoMany(this.document!, steps); }
		catch (error) { throw new AgentToolFailure('INVALID_COMMAND', safeMessage(error), { reason: 'UNDO_COMMIT_REJECTED' }); }
		if (!changed) throw new AgentToolFailure('INVALID_COMMAND', 'Agent undo did not change the document; nothing was undone.', { reason: 'UNDO_COMMIT_REJECTED' });
	}

	private create(request: Extract<AuthoringRequest, { type: 'CREATE' }>): AuthoringResult {
		if (this.document) throw new BomcDocumentError('INVALID_DOCUMENT', 'An authoring document is already active.');
		const document = BomcDocument.create({ documentId: request.data.documentId, name: 'Untitled' });
		this.attachDocument(document, new AuthoringHistory(null), 1);
		return this.authoringResult();
	}

	private async open(request: Extract<AuthoringRequest, { type: 'OPEN' }>): Promise<OpenResult> {
		if (this.document) throw new BomcDocumentError('INVALID_DOCUMENT', 'An authoring document is already active.');
		let container: BomcContainer;
		try { container = new BomcContainer(request.data.ownedBuffer); }
		catch (cause) {
			if (cause instanceof BomcDocumentError) throw cause;
			throw new BomcDocumentError('INVALID_SOURCE', safeMessage(cause), cause);
		}

		try {
			if (!container.has(241)) {
				return { kind: 'viewer', reason: 'BOMC has no Editor authoring section.', authoringValidationPerformed: false };
			}
			const descriptor = container.descriptor(241);
			if (!descriptor) {
				return { kind: 'viewer', reason: 'BOMC has no Editor authoring section.', authoringValidationPerformed: false };
			}
			if (descriptor.codec === 2 || descriptor.codec === 3) {
				return { kind: 'viewer', reason: `Editor authoring section codec ${descriptor.codec} is unsupported.`, authoringValidationPerformed: false };
			}

			let authoringSection: Uint8Array | undefined;
			try { authoringSection = await container.load(241); }
			catch (cause) { throw new BomcDocumentError('INVALID_SOURCE', `Editor authoring section is invalid: ${safeMessage(cause)}`, cause); }
			if (!authoringSection) throw new BomcDocumentError('INVALID_SOURCE', 'Editor authoring section could not be loaded.');
			const hasBwebMagic = authoringSection.byteLength >= 4
				&& authoringSection[0] === 0x42 && authoringSection[1] === 0x57
				&& authoringSection[2] === 0x45 && authoringSection[3] === 0x42;
			if (!hasBwebMagic) {
				return { kind: 'viewer', reason: 'BOMC does not contain the recognized BWEB authoring section.', authoringValidationPerformed: false };
			}
			if (authoringSection.byteLength < 20) {
				throw new BomcDocumentError('INVALID_SOURCE', 'Recognized BWEB authoring section is truncated.');
			}
			const schema = new DataView(authoringSection.buffer, authoringSection.byteOffset, authoringSection.byteLength).getUint16(4, true);
			if (schema !== 1) {
				return { kind: 'viewer', reason: `BWEB authoring schema ${schema} is unsupported.`, authoringValidationPerformed: false };
			}

			let document: BomcDocument;
			try { document = await readWebBomc(new Uint8Array(request.data.ownedBuffer)); }
			catch (cause) {
				if (cause instanceof BomcDocumentError && cause.code === 'UNSUPPORTED_FEATURE') {
					return { kind: 'viewer', reason: cause.message, authoringValidationPerformed: true };
				}
				throw cause;
			}
			const snapshot = document.snapshot();
			const subset = validateEditableSubset(snapshot.graph);
			if (!subset.editable) {
				document.dispose();
				return { kind: 'viewer', reason: subset.reason, authoringValidationPerformed: true };
			}
				this.attachDocument(document, new AuthoringHistory(snapshot.graph), nextAuthoringSequence(snapshot.graph));
			return this.authoringResult();
		} finally {
			container.release(241);
		}
	}

	private restore(value: AuthoringCheckpoint): AuthoringResult {
		if (this.document) throw new BomcDocumentError('INVALID_DOCUMENT', 'An authoring document is already active.');
		const checkpoint = validateAuthoringCheckpoint(value);
		const document = BomcDocument.fromGraph(checkpoint.snapshot.graph, checkpoint.snapshot.revision);
		const history = new AuthoringHistory();
		history.restore(checkpoint.history);
		this.attachDocument(document, history, checkpoint.sequence);
		return this.authoringResult();
	}

	private command(request: Extract<AuthoringRequest, { type: 'COMMAND' }>): AuthoringResult {
		this.requireRevision(request.expectedRevision);
		this.requireActiveDocument();
		const graph = this.document!.snapshot().graph;
		const { entityId, pair, consumesSequence } = buildCommandEdit(graph, request.data, this.sequence);
		const changed = this.history!.execute(this.document!, pair);
		if (changed && consumesSequence) this.sequence += 1;
		const result = this.authoringResult();
		if (changed) result.commandResult = { entityId };
		return result;
	}

	private async write(requestId: number, expectedRevision: number) {
		this.requireRevision(expectedRevision);
		this.requireActiveDocument();
		if (this.issuedWrite) throw new BomcDocumentError('BUSY', 'A completed download is awaiting acknowledgment.');
		const before = this.document!.snapshot();
		const writer = this.writer!;
		try {
			const result = await writer.write({ onProgress: (progress) => {
				const message: WorkerProgressMessage = {
					protocolVersion: AUTHORING_PROTOCOL_VERSION,
					event: 'PROGRESS',
					sessionId: this.sessionId!,
					requestId,
					progress
				};
				this.post(message);
			} });
			if (result.revision !== before.revision || this.document!.snapshot().revision !== before.revision) {
				throw new BomcDocumentError('INTERNAL_ERROR', 'Canonical revision changed during the locked BOMC write.');
			}
			this.issuedWrite = { writeId: this.uuid(), revision: before.revision, graph: before.graph };
			const owned = new Uint8Array(result.bytes);
			return {
				kind: 'write',
				writeId: this.issuedWrite.writeId,
				revision: result.revision,
				sha256: result.sha256,
				length: owned.byteLength,
				stats: result.stats,
				ownedBuffer: owned.buffer as ArrayBuffer
			} as const;
		} catch (error) {
			this.issuedWrite = null;
			throw error;
		}
	}

	private acknowledgeDownload(request: Extract<AuthoringRequest, { type: 'ACK_DOWNLOAD' }>): AuthoringResult {
		this.requireRevision(request.expectedRevision, true);
		this.requireActiveDocument();
		const issued = this.issuedWrite;
		if (!issued || issued.writeId !== request.data.writeId || issued.revision !== request.data.revision
			|| issued.revision !== request.expectedRevision || issued.revision !== this.document!.snapshot().revision) {
			throw new AuthoringGeometryError('Download acknowledgment does not match the issued current-revision write.');
		}
		this.history!.acknowledgeSaved(issued.graph);
		this.issuedWrite = null;
		return this.authoringResult();
	}

	private attachDocument(document: BomcDocument, history: AuthoringHistory, sequence: number) {
		this.document = document;
		this.writer = new BomcWriter(document, { compressionMode: 'auto' });
		this.history = history;
		this.sequence = sequence;
		this.issuedWrite = null;
	}

	private requireActiveDocument() {
		if (!this.document || !this.writer || !this.history) throw new BomcDocumentError('CLOSED', 'No editable authoring document is active.');
	}

	private requireRevision(expected: number, allowIssuedWrite = false) {
		this.requireActiveDocument();
		const current = this.document!.snapshot().revision;
		if (expected !== current) throw new AuthoringStaleRevisionError(current);
		if (this.issuedWrite && !allowIssuedWrite) throw new BomcDocumentError('BUSY', 'Editing is locked while a BOMC download awaits acknowledgment.');
	}

	private authoringResult(): AuthoringResult {
		this.requireActiveDocument();
		const snapshot = this.document!.snapshot();
		const checkpoint: AuthoringCheckpoint = {
			snapshot,
			sequence: this.sequence,
			history: this.history!.checkpoint()
		};
		return {
			kind: 'authoring',
			checkpoint,
			canUndo: this.history!.canUndo,
			canRedo: this.history!.canRedo,
			dirty: this.history!.dirty(snapshot.graph)
		};
	}

	private closeState() {
		if (this.closed) return;
		this.closed = true;
		this.writer?.dispose();
		this.writer = null;
		this.document?.dispose();
		this.document = null;
		this.history = null;
		this.sequence = 1;
		this.issuedWrite = null;
		this.queue.length = 0;
		this.inFlight.clear();
		this.responseCache.clear();
	}

	private sendError(sessionId: string, requestId: number, requestType: AuthoringRequest['type'] | null, code: AuthoringErrorCode, message: string) {
		const reply: WorkerErrorMessage = {
			protocolVersion: AUTHORING_PROTOCOL_VERSION,
			event: 'ERROR',
			sessionId,
			requestId,
			requestType,
			error: { code, message, currentRevision: this.document?.snapshot().revision ?? null }
		};
		this.post(reply);
	}

	private cacheError(request: AuthoringRequest, code: AuthoringErrorCode, message: string) {
		const reply: WorkerErrorMessage = {
			protocolVersion: AUTHORING_PROTOCOL_VERSION,
			event: 'ERROR',
			sessionId: request.sessionId,
			requestId: request.requestId,
			requestType: request.type,
			error: { code, message, currentRevision: this.document?.snapshot().revision ?? null }
		};
		this.remember(request.requestId, { message: reply, writeBytesTransferred: false });
		this.post(reply);
	}

	private remember(requestId: number, cached: CachedResponse) {
		this.responseCache.delete(requestId);
		this.responseCache.set(requestId, cached);
		while (this.responseCache.size > RESPONSE_CACHE_LIMIT) {
			const oldest = this.responseCache.keys().next().value as number | undefined;
			if (oldest === undefined) break;
			this.responseCache.delete(oldest);
		}
	}
}

class AuthoringStaleRevisionError extends Error {
	readonly code = 'STALE_REVISION' as const;
	readonly revision: number;
	constructor(revision: number) { super(`Expected revision does not match the worker's current revision ${revision}.`); this.name = 'AuthoringStaleRevisionError'; this.revision = revision; }
}

// The pure dispatcher above is also the unit-test adapter. Install it only in
// an actual WorkerGlobalScope so importing this file from Bun never binds a
// process-wide message handler.
const workerGlobal = globalThis as typeof globalThis & {
	postMessage?: (message: unknown, transfer?: Transferable[]) => void;
	onmessage?: ((event: MessageEvent) => void) | null;
	WorkerGlobalScope?: { prototype: object };
};
const workerGlobalScopePrototype = workerGlobal.WorkerGlobalScope?.prototype;
if (workerGlobalScopePrototype && Object.prototype.isPrototypeOf.call(workerGlobalScopePrototype, globalThis)) {
	const dispatcher = new AuthoringWorkerDispatcher((message, transfer) => workerGlobal.postMessage!(message, transfer));
	workerGlobal.onmessage = (event) => dispatcher.receive(event.data);
}
