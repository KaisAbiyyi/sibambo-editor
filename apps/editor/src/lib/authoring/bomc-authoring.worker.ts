import { BomcDocument, BomcDocumentError } from '@sibambo/bomc-document/document';
import { readWebBomc } from '@sibambo/bomc-document/reader';
import { BomcWriter } from '@sibambo/bomc-document/writer';
import type { BomcGraph } from '@sibambo/bomc-document';
import { BomcContainer } from '@sibambo/e4-import';
import { authoringProfileReason } from '../profile-authority.js';
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
import { AuthoringHistory, AuthoringHistoryError, validateAuthoringCheckpoint } from './history.js';
import {
	AUTHORING_PROTOCOL_VERSION,
	isAuthoringRequest,
	isRecord,
	isUuid,
	isPositiveRequestId,
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

	private async execute(request: AuthoringRequest): Promise<AuthoringResult | OpenResult | WriteResult | ClosedResult> {
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
		}
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
			// Inspect encoded authority before considering any embedded BWEB authoring graph.
			// The canonical reader below still validates the complete zero-loss contract.
			if (container.has(20)) {
				const contract = await container.load(20);
				if (!contract || contract.byteLength !== 76 || new DataView(contract.buffer, contract.byteOffset, contract.byteLength).getUint16(0, true) !== 1) {
					throw new BomcDocumentError('INVALID_SOURCE', 'BOMC encoding contract is invalid.');
				}
				const profile = ({ 1: 'exact', 2: 'research', 3: 'visual' } as Record<number, string>)[contract[2]!];
				if (!profile) throw new BomcDocumentError('INVALID_SOURCE', 'BOMC encoding contract profile is invalid.');
				const reason = authoringProfileReason(profile);
				if (reason) return { kind: 'viewer', reason, authoringValidationPerformed: false };
			}
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
			container.release(20);
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
		let entityId: string;
		let pair: GeometryEdit;
		let consumesSequence = false;
		if (request.data.kind === 'MODEL_EDIT') {
			const edit = buildModelEdit(graph, request.data.path, request.data.action, this.sequence);
			entityId = edit.entityId;
			pair = { forward: edit.forward, inverse: edit.inverse };
			consumesSequence = true;
		} else if (request.data.kind === 'CREATE_RECTANGLE') {
			if (!Number.isSafeInteger(this.sequence) || this.sequence < 1 || this.sequence >= Number.MAX_SAFE_INTEGER) {
				throw new AuthoringGeometryError('Authoring operation sequence is exhausted.');
			}
			entityId = `${graph.documentId}:rectangle:${this.sequence}`;
			if ('points' in request.data) {
				pair = buildPlanarRectangleEdit(graph, entityId, request.data.points, request.data.normal);
			} else {
				validateRectangleInput(request.data.first, request.data.opposite);
				pair = buildRectangleEdit(graph, entityId, request.data.first, request.data.opposite);
			}
			consumesSequence = true;
		} else if (request.data.kind === 'CREATE_FACE_LOOP') {
			if (!Number.isSafeInteger(this.sequence) || this.sequence < 1 || this.sequence >= Number.MAX_SAFE_INTEGER) {
				throw new AuthoringGeometryError('Authoring operation sequence is exhausted.');
			}
			entityId = `${graph.documentId}:face:${this.sequence}`;
			pair = buildFaceLoopEdit(graph, entityId, request.data.points, request.data.normal, 'line');
			consumesSequence = true;
		} else if (request.data.kind === 'PUSH_PULL_FACE') {
			if (!Number.isSafeInteger(this.sequence) || this.sequence < 1 || this.sequence >= Number.MAX_SAFE_INTEGER) {
				throw new AuthoringGeometryError('Authoring operation sequence is exhausted.');
			}
			entityId = request.data.faceId;
			pair = buildPushPullFaceEdit(graph, request.data.faceId, request.data.distance, this.sequence);
			consumesSequence = true;
		} else {
			entityId = request.data.entityId;
			pair = buildExtrusionEdit(graph, entityId, request.data.distance);
		}
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
