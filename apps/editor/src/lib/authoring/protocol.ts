import type {
	BomcDocumentErrorCode,
	BomcGraph,
	BomcSnapshot,
	DocumentEdit
} from '@sibambo/bomc-document';
import type { BomcWriteProgress, BomcWriteStats } from '@sibambo/bomc-document/types';

export const AUTHORING_PROTOCOL_VERSION = 'sibambo-editor-authoring-1' as const;

export type AuthoringPoint = readonly [number, number, number];

export type AuthoringCommand =
	| { kind: 'CREATE_RECTANGLE'; first: AuthoringPoint; opposite: AuthoringPoint }
	| { kind: 'EXTRUDE_RECTANGLE'; entityId: string; distance: number };

export type AuthoringJournalEntry = {
	forward: readonly DocumentEdit[];
	inverse: readonly DocumentEdit[];
};

export type AuthoringHistoryCheckpoint = {
	undo: readonly AuthoringJournalEntry[];
	redo: readonly AuthoringJournalEntry[];
	savedGraph: BomcGraph | null;
};

/** Structured-clone-safe canonical worker state. GPU data is deliberately absent. */
export type AuthoringCheckpoint = {
	snapshot: BomcSnapshot;
	sequence: number;
	history: AuthoringHistoryCheckpoint;
};

type RequestBase = {
	protocolVersion: typeof AUTHORING_PROTOCOL_VERSION;
	sessionId: string;
	requestId: number;
};

export type CreateRequest = RequestBase & {
	type: 'CREATE';
	data: { documentId: string; name: 'Untitled' };
};
export type OpenRequest = RequestBase & {
	type: 'OPEN';
	data: { ownedBuffer: ArrayBuffer };
};
export type RestoreCheckpointRequest = RequestBase & {
	type: 'RESTORE_CHECKPOINT';
	data: { checkpoint: AuthoringCheckpoint };
};
export type CommandRequest = RequestBase & {
	type: 'COMMAND';
	expectedRevision: number;
	data: AuthoringCommand;
};
export type UndoRequest = RequestBase & { type: 'UNDO'; expectedRevision: number };
export type RedoRequest = RequestBase & { type: 'REDO'; expectedRevision: number };
export type WriteRequest = RequestBase & { type: 'WRITE'; expectedRevision: number };
export type AckDownloadRequest = RequestBase & {
	type: 'ACK_DOWNLOAD';
	expectedRevision: number;
	data: { writeId: string; revision: number };
};
export type CloseRequest = RequestBase & { type: 'CLOSE' };

export type AuthoringRequest =
	| CreateRequest
	| OpenRequest
	| RestoreCheckpointRequest
	| CommandRequest
	| UndoRequest
	| RedoRequest
	| WriteRequest
	| AckDownloadRequest
	| CloseRequest;

export type AuthoringResult = {
	kind: 'authoring';
	checkpoint: AuthoringCheckpoint;
	canUndo: boolean;
	canRedo: boolean;
	dirty: boolean;
	commandResult?: { entityId: string };
};

export type ViewerOnlyResult = {
	kind: 'viewer';
	reason: string;
	authoringValidationPerformed: boolean;
};

export type OpenResult = AuthoringResult | ViewerOnlyResult;

export type WriteResult = {
	kind: 'write';
	writeId: string;
	revision: number;
	sha256: string;
	length: number;
	stats: BomcWriteStats;
	ownedBuffer: ArrayBuffer;
};

export type ClosedResult = { kind: 'closed' };

export type AuthoringResultByRequest = {
	CREATE: AuthoringResult;
	OPEN: OpenResult;
	RESTORE_CHECKPOINT: AuthoringResult;
	COMMAND: AuthoringResult;
	UNDO: AuthoringResult;
	REDO: AuthoringResult;
	WRITE: WriteResult;
	ACK_DOWNLOAD: AuthoringResult;
	CLOSE: ClosedResult;
};

export type WorkerReadyMessage = {
	protocolVersion: typeof AUTHORING_PROTOCOL_VERSION;
	event: 'READY';
	sessionId: null;
};

export type WorkerProgressMessage = {
	protocolVersion: typeof AUTHORING_PROTOCOL_VERSION;
	event: 'PROGRESS';
	sessionId: string;
	requestId: number;
	progress: BomcWriteProgress;
};

export type WorkerResultMessage<TType extends AuthoringRequest['type'] = AuthoringRequest['type']> = {
	protocolVersion: typeof AUTHORING_PROTOCOL_VERSION;
	event: 'RESULT';
	sessionId: string;
	requestId: number;
	requestType: TType;
	result: AuthoringResultByRequest[TType];
};

export type AuthoringErrorCode =
	| 'INVALID_COMMAND'
	| 'STALE_REVISION'
	| 'BUSY'
	| 'CLOSED'
	| 'ABORTED'
	| BomcDocumentErrorCode;

export type WorkerErrorMessage = {
	protocolVersion: typeof AUTHORING_PROTOCOL_VERSION;
	event: 'ERROR';
	sessionId: string;
	requestId: number;
	requestType: AuthoringRequest['type'] | null;
	error: { code: AuthoringErrorCode; message: string; currentRevision: number | null };
};

export type AuthoringWorkerMessage =
	| WorkerReadyMessage
	| WorkerProgressMessage
	| WorkerResultMessage
	| WorkerErrorMessage;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_PROTOTYPES = new Set([Object.prototype, null]);

export function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	return RECORD_PROTOTYPES.has(Object.getPrototypeOf(value));
}

export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export function isUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isSafeRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isPositiveRequestId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isPoint(value: unknown): value is AuthoringPoint {
	return Array.isArray(value) && value.length === 3
		&& value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
		&& Object.is(value[1], 0);
}

export function isAuthoringCommand(value: unknown): value is AuthoringCommand {
	if (!isRecord(value) || typeof value.kind !== 'string') return false;
	if (value.kind === 'CREATE_RECTANGLE') {
		return hasExactKeys(value, ['kind', 'first', 'opposite']) && isPoint(value.first) && isPoint(value.opposite);
	}
	if (value.kind === 'EXTRUDE_RECTANGLE') {
		return hasExactKeys(value, ['kind', 'entityId', 'distance'])
			&& typeof value.entityId === 'string' && value.entityId.length > 0
			&& typeof value.distance === 'number' && Number.isFinite(value.distance);
	}
	return false;
}

export function isAuthoringRequest(value: unknown): value is AuthoringRequest {
	if (!isRecord(value)
		|| value.protocolVersion !== AUTHORING_PROTOCOL_VERSION
		|| !isUuid(value.sessionId)
		|| !isPositiveRequestId(value.requestId)
		|| typeof value.type !== 'string') return false;

	const base = ['protocolVersion', 'sessionId', 'requestId', 'type'];
	if (value.type === 'CREATE') {
		return hasExactKeys(value, [...base, 'data']) && isRecord(value.data)
			&& hasExactKeys(value.data, ['documentId', 'name'])
			&& isUuid(value.data.documentId) && value.data.name === 'Untitled';
	}
	if (value.type === 'OPEN') {
		return hasExactKeys(value, [...base, 'data']) && isRecord(value.data)
			&& hasExactKeys(value.data, ['ownedBuffer']) && value.data.ownedBuffer instanceof ArrayBuffer;
	}
	if (value.type === 'RESTORE_CHECKPOINT') {
		return hasExactKeys(value, [...base, 'data']) && isRecord(value.data)
			&& hasExactKeys(value.data, ['checkpoint']) && isRecord(value.data.checkpoint);
	}
	if (value.type === 'COMMAND') {
		return hasExactKeys(value, [...base, 'expectedRevision', 'data'])
			&& isSafeRevision(value.expectedRevision) && isAuthoringCommand(value.data);
	}
	if (value.type === 'UNDO' || value.type === 'REDO' || value.type === 'WRITE') {
		return hasExactKeys(value, [...base, 'expectedRevision']) && isSafeRevision(value.expectedRevision);
	}
	if (value.type === 'ACK_DOWNLOAD') {
		return hasExactKeys(value, [...base, 'expectedRevision', 'data'])
			&& isSafeRevision(value.expectedRevision) && isRecord(value.data)
			&& hasExactKeys(value.data, ['writeId', 'revision']) && isUuid(value.data.writeId)
			&& isSafeRevision(value.data.revision);
	}
	if (value.type === 'CLOSE') return hasExactKeys(value, base);
	return false;
}

export function isWorkerReadyMessage(value: unknown): value is WorkerReadyMessage {
	return isRecord(value) && hasExactKeys(value, ['protocolVersion', 'event', 'sessionId'])
		&& value.protocolVersion === AUTHORING_PROTOCOL_VERSION && value.event === 'READY' && value.sessionId === null;
}

export function isAuthoringCheckpointShape(value: unknown): value is AuthoringCheckpoint {
	if (!isRecord(value) || !hasExactKeys(value, ['snapshot', 'sequence', 'history'])
		|| !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1
		|| !isRecord(value.snapshot) || !hasExactKeys(value.snapshot, ['graph', 'revision', 'tokens'])
		|| !isSafeRevision(value.snapshot.revision) || !isRecord(value.snapshot.graph)
		|| !isRecord(value.snapshot.tokens) || !hasExactKeys(value.snapshot.tokens, [
			'name', 'strings', 'layout', 'materials', 'definitions', 'instances', 'transforms', 'geometry'
		]) || !isRecord(value.history) || !hasExactKeys(value.history, ['undo', 'redo', 'savedGraph'])) return false;
	const tokens = value.snapshot.tokens;
	if (Object.values(tokens).some((token) => !isSafeRevision(token))) return false;
	const history = value.history;
	if (!Array.isArray(history.undo) || !Array.isArray(history.redo)) return false;
	if (history.savedGraph !== null && !isRecord(history.savedGraph)) return false;
	const validEntry = (entry: unknown) => isRecord(entry)
		&& hasExactKeys(entry, ['forward', 'inverse'])
		&& Array.isArray(entry.forward) && Array.isArray(entry.inverse);
	for (const entry of [...history.undo, ...history.redo]) if (!validEntry(entry)) return false;
	return true;
}
