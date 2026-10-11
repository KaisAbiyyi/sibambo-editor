import { graphsEqual, validateAuthoringCheckpoint } from './history.js';
import { hasEntityId } from './geometry.js';
import {
	AUTHORING_PROTOCOL_VERSION,
	hasExactKeys,
	isAuthoringCheckpointShape,
	isAuthoringCommand,
	isRecord,
	isUuid,
	isSafeRevision,
	isWorkerReadyMessage,
	type AuthoringCheckpoint,
	type AuthoringCommand,
	type AuthoringErrorCode,
	type AuthoringRequest,
	type AuthoringResult,
	type OpenResult,
	type WorkerProgressMessage,
	type WorkerResultMessage,
	type WriteResult
} from './protocol.js';

const CLIENT_QUEUE_LIMIT = 32;

type WorkerPort = Pick<Worker, 'postMessage' | 'terminate' | 'addEventListener' | 'removeEventListener'>;
type WorkerFactory = () => WorkerPort;
type ProgressHandler = (progress: WorkerProgressMessage['progress']) => void;

export class AuthoringClientError extends Error {
	readonly code: AuthoringErrorCode;
	readonly currentRevision: number | null;
	constructor(code: AuthoringErrorCode, message: string, currentRevision: number | null = null) {
		super(message);
		this.name = 'AuthoringClientError';
		this.code = code;
		this.currentRevision = currentRevision;
	}
}

type RequestEntry = {
	requestId: number;
	type: AuthoringRequest['type'];
	build: () => AuthoringRequest;
	sequenceIncrement?: number;
	command?: AuthoringCommand;
	transfer?: Transferable[];
	signal?: AbortSignal;
	onProgress?: ProgressHandler;
	acknowledges?: { writeId: string; revision: number };
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	removeAbort?: () => void;
	internalRestore?: boolean;
	closeHandshake?: boolean;
	settled: boolean;
};

type ClientOptions = {
	workerFactory?: WorkerFactory;
	sessionId?: string;
	documentIdFactory?: () => string;
};

export type AuthoringRecoveryState = Readonly<{
	phase: 'ready' | 'restoring' | 'failed' | 'closed';
	error: string | null;
}>;

type RecoveryListener = (state: AuthoringRecoveryState) => void;

function uuid(): string {
	if (typeof globalThis.crypto?.randomUUID !== 'function') throw new AuthoringClientError('INTERNAL_ERROR', 'crypto.randomUUID is unavailable.');
	return globalThis.crypto.randomUUID();
}

function makeWorker(): WorkerPort {
	return new Worker(new URL('./bomc-authoring.worker.ts', import.meta.url), { type: 'module' });
}

function eventListener(handler: (event: Event) => void): EventListener {
	return (event) => handler(event);
}

function validProgress(value: unknown): value is WorkerProgressMessage['progress'] {
	if (!isRecord(value) || Object.keys(value).some((key) => !['phase', 'revision', 'completedSections', 'totalSections', 'sectionType'].includes(key))) return false;
	if (Object.keys(value).length < 4 || Object.keys(value).length > 5) return false;
	return ['validate', 'encode', 'compress', 'assemble', 'hash', 'complete'].includes(String(value.phase))
		&& isSafeRevision(value.revision)
		&& Number.isSafeInteger(value.completedSections) && (value.completedSections as number) >= 0
		&& Number.isSafeInteger(value.totalSections) && (value.totalSections as number) >= 0
		&& (value.sectionType === undefined || (Number.isSafeInteger(value.sectionType) && (value.sectionType as number) >= 0));
}

function validWriteStats(value: unknown, totalBytes: number): boolean {
	if (!isRecord(value) || Object.keys(value).length !== 14) return false;
	const arrays = ['encodedSectionTypes', 'reusedSectionTypes', 'compressionAttemptTypes'];
	for (const key of arrays) {
		const items = value[key];
		if (!Array.isArray(items) || items.some((item) => !Number.isSafeInteger(item) || (item as number) < 0)) return false;
	}
	const sectionMaps = ['rawSectionBytes', 'storedSectionBytes'];
	for (const key of sectionMaps) {
		const map = value[key];
		if (!isRecord(map) || Object.entries(map).some(([section, bytes]) => !/^(0|[1-9]\d*)$/.test(section)
			|| !Number.isSafeInteger(bytes) || (bytes as number) < 0)) return false;
	}
	const counters = ['totalBytes', 'cacheBytes', 'knownPeakBinaryBytes'];
	for (const key of counters) if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) return false;
	if (value.totalBytes !== totalBytes) return false;
	const timings = ['validationMs', 'encodeMs', 'compressMs', 'assemblyMs', 'hashMs', 'totalMs'];
	for (const key of timings) if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || (value[key] as number) < 0) return false;
	return true;
}

function validWriteResult(value: unknown, checkpoint: AuthoringCheckpoint | null): value is WriteResult {
	if (!isRecord(value) || Object.keys(value).length !== 7 || value.kind !== 'write' || !isUuid(value.writeId)
		|| typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)
		|| !isSafeRevision(value.revision) || !Number.isSafeInteger(value.length) || (value.length as number) <= 0
		|| !(value.ownedBuffer instanceof ArrayBuffer) || value.ownedBuffer.byteLength !== value.length
		|| !validWriteStats(value.stats, value.length as number)) return false;
	return checkpoint !== null && value.revision === checkpoint.snapshot.revision;
}

function isErrorCode(value: unknown): value is AuthoringErrorCode {
	return typeof value === 'string' && [
		'INVALID_COMMAND', 'STALE_REVISION', 'BUSY', 'CLOSED', 'ABORTED', 'INVALID_DOCUMENT', 'INVALID_SOURCE',
		'UNSUPPORTED_FEATURE', 'RESOURCE_LIMIT', 'OBSERVER_ERROR', 'INTERNAL_ERROR'
	].includes(value);
}

function deriveDirty(checkpoint: AuthoringCheckpoint): boolean {
	const saved = checkpoint.history.savedGraph;
	return saved === null || !graphsEqual(saved, checkpoint.snapshot.graph);
}

function freezeValue<T>(value: T): T {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value as Record<string, unknown>)) freezeValue(nested);
	return Object.freeze(value);
}

function validateAuthoringResult(value: unknown, fullHistory = false, trustedWorkerTransition = false, validateLatestEntry = false): AuthoringResult | null {
	if (!isRecord(value) || (Object.keys(value).length !== 5 && Object.keys(value).length !== 6)
		|| Object.keys(value).some((key) => !['kind', 'checkpoint', 'canUndo', 'canRedo', 'dirty', 'commandResult'].includes(key))
		|| value.kind !== 'authoring' || typeof value.canUndo !== 'boolean'
		|| typeof value.canRedo !== 'boolean' || typeof value.dirty !== 'boolean'
		|| !isAuthoringCheckpointShape(value.checkpoint)) return null;
	let checkpoint: AuthoringCheckpoint;
	try {
		checkpoint = validateAuthoringCheckpoint(value.checkpoint, {
			replayHistory: fullHistory,
			reuseOwnedInput: true,
			trustedWorkerTransition,
			validateLatestEntry
		});
	} catch { return null; }
	if (value.canUndo !== (checkpoint.history.undo.length > 0)
		|| value.canRedo !== (checkpoint.history.redo.length > 0)
		|| value.dirty !== deriveDirty(checkpoint)) return null;
	if (value.commandResult !== undefined && (!isRecord(value.commandResult)
		|| Object.keys(value.commandResult).length !== 1 || typeof value.commandResult.entityId !== 'string' || !value.commandResult.entityId)) return null;
	return { ...value, checkpoint } as unknown as AuthoringResult;
}

/** Lazy owner of one canonical authoring worker and its acknowledged checkpoint. */
export class AuthoringClient {
	readonly sessionId: string;
	private readonly workerFactory: WorkerFactory;
	private readonly documentIdFactory: () => string;
	private worker: WorkerPort | null = null;
	private generation = 0;
	private ready = false;
	private readonly queue: RequestEntry[] = [];
	private readonly pending = new Map<number, RequestEntry>();
	private active: RequestEntry | null = null;
	private nextRequestId = 1;
	private checkpointValue: AuthoringCheckpoint | null = null;
	private issuedWriteValue: { writeId: string; revision: number } | null = null;
	private restoreErrorValue: Error | null = null;
	private closed = false;
	private closing = false;
	private recoveryPending = false;
	private restoreSourceCheckpointValue: AuthoringCheckpoint | null = null;
	private readonly restoreWaiters: Array<{
		resolve: (value: AuthoringResult) => void;
		reject: (error: unknown) => void;
	}> = [];
	private cancelRestoreWriteId: string | null = null;
	private cancelRestorePromise: Promise<AuthoringResult> | null = null;
	private closeResolve: (() => void) | null = null;
	private closePromise: Promise<void> | null = null;
	private readonly currentListeners = new WeakMap<WorkerPort, { message: EventListener; error: EventListener; messageerror: EventListener }>();
	private readonly recoveryListeners = new Set<RecoveryListener>();

	constructor(options: ClientOptions = {}) {
		const sessionId = options.sessionId ?? uuid();
		if (!isUuid(sessionId)) throw new AuthoringClientError('INVALID_COMMAND', 'sessionId must be a UUID.');
		this.sessionId = sessionId;
		this.workerFactory = options.workerFactory ?? makeWorker;
		this.documentIdFactory = options.documentIdFactory ?? uuid;
	}

	get checkpoint(): AuthoringCheckpoint | null { return this.checkpointValue; }
	get restoreError(): Error | null { return this.restoreErrorValue; }
	get isRestoring() { return this.recoveryPending; }
	get isClosed() { return this.closed || this.closing; }

	subscribeRecovery(listener: RecoveryListener): () => void {
		this.recoveryListeners.add(listener);
		try { listener(this.recoveryState()); } catch { /* recovery observers do not own client state */ }
		return () => { this.recoveryListeners.delete(listener); };
	}

	create(documentId = this.documentIdFactory()): Promise<AuthoringResult> {
		if (!isUuid(documentId)) return Promise.reject(new AuthoringClientError('INVALID_COMMAND', 'documentId must be a UUID.'));
		return this.enqueue<AuthoringResult>('CREATE', (requestId) => ({
			protocolVersion: AUTHORING_PROTOCOL_VERSION,
			sessionId: this.sessionId,
			requestId,
			type: 'CREATE',
			data: { documentId, name: 'Untitled' }
		}));
	}

	open(source: ArrayBuffer): Promise<OpenResult> {
		let ownedBuffer: ArrayBuffer;
		try { ownedBuffer = source.slice(0); }
		catch { return Promise.reject(new AuthoringClientError('INVALID_SOURCE', 'Unable to copy the source BOMC bytes.')); }
		return this.enqueue<OpenResult>('OPEN', (requestId) => ({
			protocolVersion: AUTHORING_PROTOCOL_VERSION,
			sessionId: this.sessionId,
			requestId,
			type: 'OPEN',
			data: { ownedBuffer }
		}), { transfer: [ownedBuffer] });
	}

	restoreCheckpoint(checkpoint: AuthoringCheckpoint): Promise<AuthoringResult> {
		let validated: AuthoringCheckpoint;
		try { validated = validateAuthoringCheckpoint(checkpoint); }
		catch (error) { return Promise.reject(new AuthoringClientError('INVALID_COMMAND', error instanceof Error ? error.message : 'Invalid checkpoint.')); }
		return this.enqueue<AuthoringResult>('RESTORE_CHECKPOINT', (requestId) => ({
			protocolVersion: AUTHORING_PROTOCOL_VERSION,
			sessionId: this.sessionId,
			requestId,
			type: 'RESTORE_CHECKPOINT',
			data: { checkpoint: validated }
		}));
	}

	command(command: AuthoringCommand, options: { signal?: AbortSignal } = {}): Promise<AuthoringResult> {
		if (!isAuthoringCommand(command)) return Promise.reject(new AuthoringClientError('INVALID_COMMAND', 'Authoring command is malformed.'));
		const clonePoint = (point: readonly [number, number, number]) => [point[0], point[1], point[2]] as const;
		let ownedCommand: AuthoringCommand;
		if (command.kind === 'CREATE_RECTANGLE') {
			ownedCommand = 'points' in command
				? { kind: 'CREATE_RECTANGLE', points: command.points.map(clonePoint), normal: clonePoint(command.normal) }
				: { kind: 'CREATE_RECTANGLE', first: clonePoint(command.first), opposite: clonePoint(command.opposite) };
		} else if (command.kind === 'CREATE_FACE_LOOP') {
			ownedCommand = { kind: 'CREATE_FACE_LOOP', points: command.points.map(clonePoint), normal: clonePoint(command.normal) };
		} else if (command.kind === 'PUSH_PULL_FACE') {
			ownedCommand = { kind: 'PUSH_PULL_FACE', faceId: command.faceId, distance: command.distance };
		} else {
			ownedCommand = { kind: 'EXTRUDE_RECTANGLE', entityId: command.entityId, distance: command.distance };
		}
		const sequenceIncrement = ownedCommand.kind === 'EXTRUDE_RECTANGLE' ? 0 : 1;
		return this.enqueue<AuthoringResult>('COMMAND', (requestId) => {
			const revision = this.requireCheckpoint().snapshot.revision;
			return { protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: this.sessionId, requestId, type: 'COMMAND', expectedRevision: revision, data: ownedCommand };
		}, { ...options, sequenceIncrement, command: ownedCommand });
	}

	undo(options: { signal?: AbortSignal } = {}): Promise<AuthoringResult> {
		return this.enqueue<AuthoringResult>('UNDO', (requestId) => ({
			protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: this.sessionId, requestId,
			type: 'UNDO', expectedRevision: this.requireCheckpoint().snapshot.revision
		}), options);
	}

	redo(options: { signal?: AbortSignal } = {}): Promise<AuthoringResult> {
		return this.enqueue<AuthoringResult>('REDO', (requestId) => ({
			protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: this.sessionId, requestId,
			type: 'REDO', expectedRevision: this.requireCheckpoint().snapshot.revision
		}), options);
	}

	write(options: { signal?: AbortSignal; onProgress?: ProgressHandler } = {}): Promise<WriteResult> {
		return this.enqueue<WriteResult>('WRITE', (requestId) => ({
			protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: this.sessionId, requestId,
			type: 'WRITE', expectedRevision: this.requireCheckpoint().snapshot.revision
		}), options);
	}

	acknowledgeDownload(writeId: string, revision: number, options: { signal?: AbortSignal } = {}): Promise<AuthoringResult> {
		if (!isUuid(writeId) || !isSafeRevision(revision)) {
			return Promise.reject(new AuthoringClientError('INVALID_COMMAND', 'Download acknowledgment identity or revision is malformed.'));
		}
		return this.enqueue<AuthoringResult>('ACK_DOWNLOAD', (requestId) => ({
			protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: this.sessionId, requestId,
			type: 'ACK_DOWNLOAD', expectedRevision: this.requireCheckpoint().snapshot.revision,
			data: { writeId, revision }
		}), { ...options, acknowledges: { writeId, revision } });
	}

	/** Restore the latest client checkpoint after a produced download was not acknowledged. */
	cancelUnacknowledgedWrite(writeId: string): Promise<AuthoringResult> {
		if (!isUuid(writeId)) return Promise.reject(new AuthoringClientError('INVALID_COMMAND', 'Write cancellation identity is malformed.'));
		if (this.closed || this.closing) return Promise.reject(new AuthoringClientError('CLOSED', 'Authoring client is closed.'));
		if (this.cancelRestorePromise && this.cancelRestoreWriteId === writeId) return this.cancelRestorePromise;
		if (!this.issuedWriteValue || this.issuedWriteValue.writeId !== writeId) {
			return Promise.reject(new AuthoringClientError('INVALID_COMMAND', 'Only the exact unacknowledged write can be cancelled.'));
		}
		const checkpoint = this.checkpointValue;
		if (!checkpoint) return Promise.reject(new AuthoringClientError('CLOSED', 'No acknowledged checkpoint is available to restore.'));
		if (this.recoveryPending) {
			if (this.restoreSourceCheckpointValue !== checkpoint || this.queue.length > 0
				|| (this.active !== null && !this.active.internalRestore)) {
				return Promise.reject(new AuthoringClientError('BUSY', 'Unrelated authoring work prevents write cancellation.'));
			}
		} else if (this.active || this.queue.length) {
			return Promise.reject(new AuthoringClientError('BUSY', 'Unrelated authoring work prevents write cancellation.'));
		}

		let resolveRestore!: (value: AuthoringResult) => void;
		let rejectRestore!: (error: unknown) => void;
		const restore = new Promise<AuthoringResult>((resolve, reject) => {
			resolveRestore = resolve;
			rejectRestore = reject;
		});
		this.cancelRestoreWriteId = writeId;
		let cancellation!: Promise<AuthoringResult>;
		cancellation = restore.then((result) => {
			if (this.issuedWriteValue?.writeId === writeId) this.issuedWriteValue = null;
			return result;
		}).finally(() => {
			if (this.cancelRestorePromise === cancellation) {
				this.cancelRestorePromise = null;
				this.cancelRestoreWriteId = null;
			}
		});
		this.cancelRestorePromise = cancellation;
		this.beginRestore(checkpoint).then(resolveRestore, rejectRestore);
		return cancellation;
	}

	/** Retry a failed crash/cancel recovery from the latest unchanged ACK checkpoint. */
	retryRestore(): Promise<AuthoringResult> {
		if (this.closed || this.closing) return Promise.reject(new AuthoringClientError('CLOSED', 'Authoring client is closed.'));
		if (!this.checkpointValue) return Promise.reject(new AuthoringClientError('CLOSED', 'No acknowledged checkpoint is available to restore.'));
		if (this.active || this.queue.length) return Promise.reject(new AuthoringClientError('BUSY', 'Authoring requests are still active.'));
		return this.beginRestore(this.checkpointValue);
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = new Promise<void>((resolve) => { this.closeResolve = resolve; });
		for (const entry of this.queue.splice(0)) this.settle(entry, new AuthoringClientError('CLOSED', 'Authoring client closed.'));
		if (!this.worker) {
			this.finishClose();
			return this.closePromise;
		}
		if (this.active || !this.ready || !this.checkpointValue) {
			if (this.active) this.settle(this.active, new AuthoringClientError('CLOSED', 'Authoring client closed.'));
			this.finishClose();
			return this.closePromise;
		}
		const requestId = this.allocateRequestId();
		if (requestId === null) {
			this.finishClose();
			return this.closePromise;
		}
		const entry = this.makeEntry<unknown>('CLOSE', (id) => ({
			protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: this.sessionId, requestId: id, type: 'CLOSE'
		}), requestId, { closeHandshake: true });
		this.active = entry;
		this.pending.set(requestId, entry);
		try { this.worker.postMessage(entry.build(), []); }
		catch { this.finishClose(); }
		return this.closePromise;
	}

	private enqueue<T>(type: AuthoringRequest['type'], build: (requestId: number) => AuthoringRequest, options: { signal?: AbortSignal; transfer?: Transferable[]; onProgress?: ProgressHandler; acknowledges?: { writeId: string; revision: number }; sequenceIncrement?: number; command?: AuthoringCommand } = {}): Promise<T> {
		if (this.closed || this.closing) return Promise.reject(new AuthoringClientError('CLOSED', 'Authoring client is closed.'));
		if (this.restoreErrorValue || this.recoveryPending) return Promise.reject(new AuthoringClientError('BUSY', 'Authoring worker is recovering; retry restore before editing.'));
		if (options.signal?.aborted) return Promise.reject(new AuthoringClientError('ABORTED', 'Authoring request was aborted before it was queued.'));
		if (this.pending.size >= CLIENT_QUEUE_LIMIT) return Promise.reject(new AuthoringClientError('BUSY', 'Authoring request queue is full.'));
		const requestId = this.allocateRequestId();
		if (requestId === null) return Promise.reject(new AuthoringClientError('RESOURCE_LIMIT', 'Authoring request ID range is exhausted.'));
		let resolvePromise!: (value: T) => void;
		let rejectPromise!: (error: unknown) => void;
		const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
		const entry = this.makeEntry<T>(type, build, requestId, {
			transfer: options.transfer,
			signal: options.signal,
			onProgress: options.onProgress,
			acknowledges: options.acknowledges,
				sequenceIncrement: options.sequenceIncrement,
				command: options.command,
			resolve: resolvePromise as (value: unknown) => void,
			reject: rejectPromise
		});
		this.pending.set(requestId, entry);
		if (entry.signal) {
			const onAbort = () => this.abortEntry(entry);
			entry.signal.addEventListener('abort', onAbort, { once: true });
			entry.removeAbort = () => entry.signal?.removeEventListener('abort', onAbort);
		}
		this.queue.push(entry);
		this.ensureWorker();
		this.sendNext();
		return promise;
	}

	private makeEntry<T>(
		type: AuthoringRequest['type'],
		build: (requestId: number) => AuthoringRequest,
		requestId: number,
		options: Partial<Pick<RequestEntry, 'transfer' | 'signal' | 'onProgress' | 'acknowledges' | 'sequenceIncrement' | 'command' | 'resolve' | 'reject' | 'internalRestore' | 'closeHandshake'>> = {}
	): RequestEntry {
		return {
			requestId,
			type,
			build: () => build(requestId),
			transfer: options.transfer,
			signal: options.signal,
			onProgress: options.onProgress,
			acknowledges: options.acknowledges,
				sequenceIncrement: options.sequenceIncrement,
				command: options.command,
			resolve: options.resolve ?? (() => undefined),
			reject: options.reject ?? (() => undefined),
			internalRestore: options.internalRestore,
			closeHandshake: options.closeHandshake,
			settled: false
		};
	}

	private allocateRequestId(): number | null {
		if (!Number.isSafeInteger(this.nextRequestId) || this.nextRequestId <= 0) return null;
		const id = this.nextRequestId;
		this.nextRequestId = id >= Number.MAX_SAFE_INTEGER ? Number.NaN : id + 1;
		return id;
	}

	private ensureWorker() {
		if (this.worker || this.closed || this.closing) return;
		let worker: WorkerPort;
		try { worker = this.workerFactory(); }
		catch (error) {
			const failure = error instanceof Error ? error : new Error('Unable to create authoring worker.');
			const clientError = new AuthoringClientError('INTERNAL_ERROR', failure.message);
			const restoreEntry = [...this.pending.values()].find((entry) => entry.internalRestore);
			if (restoreEntry) this.failRestore(clientError);
			else {
				for (const entry of this.queue.splice(0)) {
					this.pending.delete(entry.requestId);
					this.settle(entry, clientError);
				}
				this.pending.clear();
			}
			return;
		}
		this.generation += 1;
		const generation = this.generation;
		this.worker = worker;
		this.ready = false;
		const message = eventListener((event) => this.handleMessage(generation, (event as MessageEvent).data));
		const error = eventListener((event) => this.handleTransportFailure(generation, new Error((event as ErrorEvent).message || 'Authoring worker error.')));
		const messageerror = eventListener(() => this.handleTransportFailure(generation, new Error('Authoring worker message could not be deserialized.')));
		this.currentListeners.set(worker, { message, error, messageerror });
		worker.addEventListener('message', message);
		worker.addEventListener('error', error);
		worker.addEventListener('messageerror', messageerror);
	}

	private sendNext() {
		if (!this.worker || !this.ready || this.active || this.recoveryPending || this.closed || this.closing) return;
		const entry = this.queue.shift();
		if (!entry) return;
		if (entry.signal?.aborted) {
			this.pending.delete(entry.requestId);
			this.settle(entry, new AuthoringClientError('ABORTED', 'Authoring request was aborted before it was sent.'));
			this.sendNext();
			return;
		}
		this.active = entry;
		try {
			const request = entry.build();
			try {
				this.worker.postMessage(request, entry.transfer ?? []);
				entry.transfer = undefined;
			} catch (error) {
				this.handleTransportFailure(this.generation, error instanceof Error ? error : new Error('Unable to send authoring request.'));
			}
		} catch (error) {
			this.finishEntry(entry, error instanceof Error ? error : new AuthoringClientError('INVALID_COMMAND', 'Unable to construct authoring request.'));
			this.sendNext();
		}
	}

	private handleMessage(generation: number, value: unknown) {
		if (generation !== this.generation || !this.worker) return;
		if (isRecord(value) && value.event === 'READY') {
			if (!isWorkerReadyMessage(value)) {
				this.handleTransportFailure(generation, new Error('Malformed authoring worker READY message.'));
				return;
			}
			if (this.ready) return;
			this.ready = true;
			if (this.recoveryPending) this.sendRestoreRequest();
			else this.sendNext();
			return;
		}
		if (!isRecord(value)) return;
		const sessionId = value.sessionId;
		const requestId = value.requestId;
		if (sessionId !== this.sessionId || typeof requestId !== 'number' || requestId !== this.active?.requestId) return;
		const active = this.active;
		if (!active) return;
		if (value.protocolVersion !== AUTHORING_PROTOCOL_VERSION || (value.event !== 'PROGRESS' && value.event !== 'RESULT' && value.event !== 'ERROR')) {
			this.handleTransportFailure(generation, new Error('Malformed matching authoring worker reply.'));
			return;
		}
		if (value.event === 'PROGRESS') {
			if (!hasExactKeys(value, ['protocolVersion', 'event', 'sessionId', 'requestId', 'progress'])
				|| active.type !== 'WRITE' || !validProgress(value.progress)) {
				this.handleTransportFailure(generation, new Error('Malformed matching authoring progress reply.'));
				return;
			}
			try { active.onProgress?.(value.progress); }
			catch (error) { this.abortEntry(active, new AuthoringClientError('OBSERVER_ERROR', error instanceof Error ? error.message : 'Progress observer failed.')); }
			return;
		}
		if (value.event === 'RESULT' && !hasExactKeys(value, ['protocolVersion', 'event', 'sessionId', 'requestId', 'requestType', 'result'])) {
			this.handleTransportFailure(generation, new Error('Malformed matching authoring result envelope.'));
			return;
		}
		if (value.requestType !== active.type) {
			this.handleTransportFailure(generation, new Error('Authoring worker reply type does not match its request.'));
			return;
		}
		if (value.event === 'ERROR') {
			if (!hasExactKeys(value, ['protocolVersion', 'event', 'sessionId', 'requestId', 'requestType', 'error'])
				|| !isRecord(value.error) || !hasExactKeys(value.error, ['code', 'message', 'currentRevision'])
				|| !isErrorCode(value.error.code) || typeof value.error.message !== 'string'
				|| (value.error.currentRevision !== null && !isSafeRevision(value.error.currentRevision))) {
				this.handleTransportFailure(generation, new Error('Malformed matching authoring error reply.'));
				return;
			}
			const error = new AuthoringClientError(value.error.code, value.error.message, value.error.currentRevision as number | null);
			if (active.closeHandshake) {
				this.finishClose();
				return;
			}
			if (active.internalRestore) {
				this.failRestore(error);
				return;
			}
			this.finishEntry(active, error);
			if (error.code === 'STALE_REVISION' && error.currentRevision !== this.checkpointValue?.snapshot.revision) {
				this.handleTransportFailure(generation, error);
			} else {
				this.sendNext();
			}
			return;
		}
		const message = value as unknown as WorkerResultMessage;
		if (active.closeHandshake) {
			if (message.result?.kind !== 'closed') {
				this.finishClose();
				return;
			}
			this.finishClose();
			return;
		}
		const result = this.validateResultFor(active, message.result);
		if (!result) {
			this.handleTransportFailure(generation, new Error('Malformed matching authoring result; no partial checkpoint was published.'));
			return;
		}
		let deliveredResult: unknown = result;
		if (isAuthoringResultValue(result)) {
			const trustedTransition = active.type === 'COMMAND' || active.type === 'UNDO' || active.type === 'REDO' || active.type === 'ACK_DOWNLOAD';
			const checked = validateAuthoringResult(result, active.type === 'RESTORE_CHECKPOINT', trustedTransition, active.type === 'COMMAND');
			if (!checked) {
				this.handleTransportFailure(generation, new Error('Authoring checkpoint failed validation; no partial checkpoint was published.'));
				return;
			}
			if (!this.validateAuthoringSemantics(active, checked)) {
				this.handleTransportFailure(generation, new Error('Authoring reply violates its request-specific state contract; no partial checkpoint was published.'));
				return;
			}
			if (trustedTransition) this.reuseAcknowledgedHistory(active, checked);
			const frozenCheckpoint = freezeValue(checked.checkpoint);
			const publishedResult = { ...checked, checkpoint: frozenCheckpoint };
			this.checkpointValue = frozenCheckpoint;
				if (active.internalRestore) {
					this.recoveryPending = false;
					this.restoreErrorValue = null;
					this.restoreSourceCheckpointValue = null;
					this.notifyRecovery();
					this.finishEntry(active, publishedResult);
				this.resolveRestoreWaiters(publishedResult);
				this.sendNext();
				return;
			}
			deliveredResult = publishedResult;
		}
		if (active.type === 'WRITE' && result && typeof result === 'object' && 'writeId' in result && 'revision' in result) {
			const write = result as WriteResult;
			this.issuedWriteValue = { writeId: write.writeId, revision: write.revision };
		}
		if (active.acknowledges && this.issuedWriteValue?.writeId === active.acknowledges.writeId
			&& this.issuedWriteValue.revision === active.acknowledges.revision) {
			this.issuedWriteValue = null;
		}
		this.finishEntry(active, deliveredResult);
		this.sendNext();
	}

	private validateResultFor(entry: RequestEntry, result: unknown): unknown | null {
		if (entry.type === 'CREATE' || entry.type === 'RESTORE_CHECKPOINT' || entry.type === 'COMMAND' || entry.type === 'UNDO' || entry.type === 'REDO' || entry.type === 'ACK_DOWNLOAD') {
			return isAuthoringResultValue(result) ? result : null;
		}
		if (entry.type === 'OPEN') {
			if (isAuthoringResultValue(result)) return result;
			if (isRecord(result) && Object.keys(result).length === 3 && result.kind === 'viewer'
				&& typeof result.reason === 'string' && result.reason.length > 0 && typeof result.authoringValidationPerformed === 'boolean') return result;
			return null;
		}
		if (entry.type === 'WRITE') return validWriteResult(result, this.checkpointValue) ? result : null;
		if (entry.type === 'CLOSE') return isRecord(result) && hasExactKeys(result, ['kind']) && result.kind === 'closed' ? result : null;
		return null;
	}

	private validateAuthoringSemantics(entry: RequestEntry, result: AuthoringResult): boolean {
		const checkpoint = result.checkpoint;
		const previous = this.checkpointValue;
		if (entry.type === 'COMMAND') {
			if (!result.commandResult || !hasEntityId(checkpoint.snapshot.graph, result.commandResult.entityId)) return false;
			if (!previous || checkpoint.snapshot.revision !== previous.snapshot.revision + 1
					|| checkpoint.sequence !== previous.sequence + (entry.sequenceIncrement ?? 0)
					|| checkpoint.history.undo.length !== previous.history.undo.length + 1 || checkpoint.history.redo.length !== 0) return false;
			const command = entry.command;
			if (!command) return false;
			if (command.kind === 'CREATE_RECTANGLE') {
				if (result.commandResult.entityId !== `${previous.snapshot.graph.documentId}:rectangle:${previous.sequence}`) return false;
			} else if (command.kind === 'CREATE_FACE_LOOP') {
				if (result.commandResult.entityId !== `${previous.snapshot.graph.documentId}:face:${previous.sequence}`) return false;
			} else if (command.kind === 'PUSH_PULL_FACE') {
				if (result.commandResult.entityId !== command.faceId || !hasEntityId(previous.snapshot.graph, command.faceId)) return false;
			} else if (result.commandResult.entityId !== command.entityId || !hasEntityId(previous.snapshot.graph, command.entityId)) return false;
		} else if (result.commandResult !== undefined) return false;
		if (entry.type === 'UNDO' || entry.type === 'REDO') {
			if (!previous || checkpoint.sequence !== previous.sequence) return false;
			const shouldMove = entry.type === 'UNDO' ? previous.history.undo.length > 0 : previous.history.redo.length > 0;
			if (checkpoint.snapshot.revision !== previous.snapshot.revision + Number(shouldMove)) return false;
			const expectedUndo = previous.history.undo.length + (entry.type === 'REDO' && shouldMove ? 1 : entry.type === 'UNDO' && shouldMove ? -1 : 0);
			const expectedRedo = previous.history.redo.length + (entry.type === 'UNDO' && shouldMove ? 1 : entry.type === 'REDO' && shouldMove ? -1 : 0);
			if (checkpoint.history.undo.length !== expectedUndo || checkpoint.history.redo.length !== expectedRedo) return false;
		}
		if ((entry.type === 'COMMAND' || entry.type === 'UNDO' || entry.type === 'REDO') && previous) {
			const beforeSaved = previous.history.savedGraph;
			const afterSaved = checkpoint.history.savedGraph;
			if (beforeSaved === null ? afterSaved !== null : afterSaved === null || !graphsEqual(beforeSaved, afterSaved)) return false;
		}
		if (entry.type === 'ACK_DOWNLOAD' && (!previous
			|| checkpoint.snapshot.revision !== previous.snapshot.revision || checkpoint.sequence !== previous.sequence
			|| checkpoint.history.undo.length !== previous.history.undo.length
			|| checkpoint.history.redo.length !== previous.history.redo.length)) return false;
		if (entry.type === 'CREATE') {
			return checkpoint.snapshot.revision === 0 && checkpoint.sequence === 1
				&& checkpoint.snapshot.graph.name === 'Untitled' && checkpoint.snapshot.graph.meshes.length === 0
				&& checkpoint.history.undo.length === 0 && checkpoint.history.redo.length === 0
				&& checkpoint.history.savedGraph === null && result.dirty;
		}
		if (entry.type === 'OPEN') {
			return checkpoint.history.undo.length === 0 && checkpoint.history.redo.length === 0
				&& checkpoint.history.savedGraph !== null && graphsEqual(checkpoint.history.savedGraph, checkpoint.snapshot.graph)
				&& !result.dirty;
		}
		if (entry.type === 'ACK_DOWNLOAD') return !result.dirty
			&& checkpoint.history.savedGraph !== null && graphsEqual(checkpoint.history.savedGraph, checkpoint.snapshot.graph);
		return true;
	}

	private reuseAcknowledgedHistory(entry: RequestEntry, result: AuthoringResult): void {
		const previous = this.checkpointValue;
		if (!previous) return;
		const incoming = result.checkpoint.history;
		let undo: AuthoringCheckpoint['history']['undo'];
		let redo: AuthoringCheckpoint['history']['redo'];
		let savedGraph: AuthoringCheckpoint['history']['savedGraph'];
		if (entry.type === 'COMMAND') {
			undo = [...previous.history.undo, incoming.undo.at(-1)!];
			redo = [];
			savedGraph = previous.history.savedGraph;
		} else if (entry.type === 'UNDO') {
			const moved = previous.history.undo.at(-1);
			undo = moved ? previous.history.undo.slice(0, -1) : previous.history.undo;
			redo = moved ? [...previous.history.redo, moved] : previous.history.redo;
			savedGraph = previous.history.savedGraph;
		} else if (entry.type === 'REDO') {
			const moved = previous.history.redo.at(-1);
			undo = moved ? [...previous.history.undo, moved] : previous.history.undo;
			redo = moved ? previous.history.redo.slice(0, -1) : previous.history.redo;
			savedGraph = previous.history.savedGraph;
		} else if (entry.type === 'ACK_DOWNLOAD') {
			undo = previous.history.undo;
			redo = previous.history.redo;
			savedGraph = result.checkpoint.snapshot.graph;
		} else return;
		result.checkpoint.history = Object.freeze({
			undo: Object.isFrozen(undo) ? undo : Object.freeze([...undo]),
			redo: Object.isFrozen(redo) ? redo : Object.freeze([...redo]),
			savedGraph
		});
	}

	private handleTransportFailure(generation: number, error: Error) {
		if (generation !== this.generation || this.closed || this.closing) return;
		const active = this.active;
		if (active?.internalRestore) {
			this.failRestore(error);
			return;
		}
		const failure = error instanceof AuthoringClientError ? error : new AuthoringClientError('INTERNAL_ERROR', error.message);
		if (active) this.finishEntry(active, failure);
		for (const entry of this.queue.splice(0)) this.settle(entry, failure);
		this.pending.clear();
		this.active = null;
		this.terminateWorker();
		if (this.checkpointValue) {
			this.scheduleRestore(this.checkpointValue);
			} else {
				this.recoveryPending = false;
				this.restoreErrorValue = failure;
				this.notifyRecovery();
			}
		}

	private abortEntry(entry: RequestEntry, override?: AuthoringClientError) {
		if (entry.settled) return;
		if (this.active === entry) {
			const reason = override ?? new AuthoringClientError('ABORTED', 'Active authoring request was aborted.');
			if (this.closing || this.closed) {
				this.finishEntry(entry, new AuthoringClientError('CLOSED', 'Authoring client closed.'));
				this.finishClose();
			} else {
				this.handleTransportFailure(this.generation, reason);
			}
			return;
		}
		const index = this.queue.indexOf(entry);
		if (index >= 0) {
			this.queue.splice(index, 1);
			this.pending.delete(entry.requestId);
			this.settle(entry, override ?? new AuthoringClientError('ABORTED', 'Queued authoring request was aborted before it was sent.'));
		}
	}

	private restoreCheckpointValue: AuthoringCheckpoint | null = null;

	private beginRestore(checkpoint: AuthoringCheckpoint): Promise<AuthoringResult> {
		return new Promise<AuthoringResult>((resolve, reject) => {
			if (this.recoveryPending) {
				if (this.restoreSourceCheckpointValue !== checkpoint) {
					reject(new AuthoringClientError('BUSY', 'A different authoring checkpoint is already restoring.'));
					return;
				}
				this.restoreWaiters.push({ resolve, reject });
				return;
			}
			this.restoreWaiters.push({ resolve, reject });
			this.scheduleRestore(checkpoint);
		});
	}

	private scheduleRestore(checkpoint: AuthoringCheckpoint) {
		this.recoveryPending = true;
		this.restoreErrorValue = null;
		this.restoreSourceCheckpointValue = checkpoint;
		this.notifyRecovery();
		this.terminateWorker();
		const id = this.allocateRequestId();
		if (id === null) {
			this.recoveryPending = false;
			this.restoreSourceCheckpointValue = null;
			this.restoreErrorValue = new AuthoringClientError('RESOURCE_LIMIT', 'Authoring request ID range is exhausted.');
			this.notifyRecovery();
			this.rejectRestoreWaiters(this.restoreErrorValue);
			return;
		}
		let frozenCheckpoint: AuthoringCheckpoint;
		try { frozenCheckpoint = freezeValue(validateAuthoringCheckpoint(checkpoint, { replayHistory: true })); }
		catch (error) {
			const failure = new AuthoringClientError('INVALID_COMMAND', error instanceof Error ? error.message : 'Checkpoint failed restore validation.');
				this.recoveryPending = false;
				this.restoreSourceCheckpointValue = null;
				this.restoreErrorValue = failure;
				this.notifyRecovery();
				this.rejectRestoreWaiters(failure);
			return;
		}
		const entry = this.makeEntry<AuthoringResult>('RESTORE_CHECKPOINT', (requestId) => ({
			protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: this.sessionId, requestId,
			type: 'RESTORE_CHECKPOINT', data: { checkpoint: frozenCheckpoint }
		}), id, { internalRestore: true });
		this.pending.set(id, entry);
		this.restoreCheckpointValue = frozenCheckpoint;
		this.ensureWorker();
		if (this.ready) this.sendRestoreRequest();
	}

	private sendRestoreRequest() {
		if (!this.worker || !this.ready || !this.recoveryPending || this.active) return;
		const entry = [...this.pending.values()].find((candidate) => candidate.internalRestore);
		const checkpoint = this.restoreCheckpointValue ?? this.checkpointValue;
		if (!entry || !checkpoint) {
			this.failRestore(new Error('No acknowledged checkpoint is available to restore.'));
			return;
		}
		this.active = entry;
		try { this.worker.postMessage(entry.build(), []); }
		catch (error) { this.failRestore(error instanceof Error ? error : new Error('Unable to send RESTORE_CHECKPOINT.')); }
	}

	private failRestore(error: Error) {
		const failure = error instanceof AuthoringClientError ? error : new AuthoringClientError('INTERNAL_ERROR', error.message);
		if (this.active?.internalRestore) this.finishEntry(this.active, failure);
		else {
			const entry = [...this.pending.values()].find((candidate) => candidate.internalRestore);
			if (entry) {
				this.pending.delete(entry.requestId);
				this.settle(entry, failure);
			}
		}
		this.active = null;
		this.recoveryPending = false;
		this.restoreErrorValue = failure;
		this.terminateWorker();
		this.restoreCheckpointValue = null;
		this.restoreSourceCheckpointValue = null;
		this.notifyRecovery();
		this.rejectRestoreWaiters(failure);
	}

	private recoveryState(): AuthoringRecoveryState {
		if (this.closed || this.closing) return Object.freeze({ phase: 'closed', error: null });
		if (this.recoveryPending) return Object.freeze({ phase: 'restoring', error: null });
		if (this.restoreErrorValue) return Object.freeze({ phase: 'failed', error: this.restoreErrorValue.message });
		return Object.freeze({ phase: 'ready', error: null });
	}

	private notifyRecovery() {
		if (!this.recoveryListeners.size) return;
		const state = this.recoveryState();
		for (const listener of [...this.recoveryListeners]) {
			try { listener(state); } catch { /* recovery observers do not own client state */ }
		}
	}

	private resolveRestoreWaiters(result: AuthoringResult) {
		for (const waiter of this.restoreWaiters.splice(0)) waiter.resolve(result);
	}

	private rejectRestoreWaiters(error: unknown) {
		for (const waiter of this.restoreWaiters.splice(0)) waiter.reject(error);
	}

	private requireCheckpoint(): AuthoringCheckpoint {
		if (!this.checkpointValue) throw new AuthoringClientError('CLOSED', 'No acknowledged authoring checkpoint is available.');
		return this.checkpointValue;
	}

	private finishEntry(entry: RequestEntry, value: unknown) {
		if (this.active === entry) this.active = null;
		this.pending.delete(entry.requestId);
		if (value instanceof Error) this.settle(entry, value);
		else this.settle(entry, undefined, value);
	}

	private settle(entry: RequestEntry, error?: unknown, value?: unknown) {
		if (entry.settled) return;
		entry.settled = true;
		entry.removeAbort?.();
		if (error !== undefined) entry.reject(error);
		else entry.resolve(value);
		if (entry.internalRestore) {
			this.restoreCheckpointValue = null;
		}
	}

	private detachWorker(worker: WorkerPort) {
		const listeners = this.currentListeners.get(worker);
		if (listeners) {
			worker.removeEventListener('message', listeners.message);
			worker.removeEventListener('error', listeners.error);
			worker.removeEventListener('messageerror', listeners.messageerror);
			this.currentListeners.delete(worker);
		}
	}

	private terminateWorker() {
		// Advance the generation before removing listeners so late replies from an
		// old worker cannot match an identical session ID after restore.
		this.generation += 1;
		const worker = this.worker;
		this.worker = null;
		this.ready = false;
		if (worker) {
			this.detachWorker(worker);
			worker.terminate();
		}
	}

	private finishClose() {
		if (this.closed) return;
		this.closed = true;
		this.closing = false;
		this.recoveryPending = false;
		const error = new AuthoringClientError('CLOSED', 'Authoring client closed.');
		if (this.active && !this.active.closeHandshake) this.settle(this.active, error);
		this.active = null;
		for (const entry of this.queue.splice(0)) this.settle(entry, error);
		this.pending.clear();
		this.checkpointValue = null;
		this.issuedWriteValue = null;
		this.restoreCheckpointValue = null;
		this.restoreSourceCheckpointValue = null;
		this.restoreErrorValue = null;
		this.rejectRestoreWaiters(error);
		this.terminateWorker();
		this.notifyRecovery();
		this.recoveryListeners.clear();
		this.closeResolve?.();
		this.closeResolve = null;
	}
}

function isAuthoringResultValue(value: unknown): value is AuthoringResult {
	return isRecord(value) && value.kind === 'authoring';
}
