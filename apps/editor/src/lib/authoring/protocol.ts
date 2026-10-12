import type {
	BomcDocumentErrorCode,
	BomcGraph,
	BomcSnapshot,
	DocumentEdit
} from '@sibambo/bomc-document';
import type { BomcWriteProgress, BomcWriteStats } from '@sibambo/bomc-document/types';

export const AUTHORING_PROTOCOL_VERSION = 'sibambo-editor-authoring-1' as const;

export type AuthoringPoint = readonly [number, number, number];

export type FlatAuthoringCommand =
	| { kind: 'CREATE_RECTANGLE'; first: AuthoringPoint; opposite: AuthoringPoint }
	| { kind: 'CREATE_RECTANGLE'; points: readonly AuthoringPoint[]; normal: AuthoringPoint }
	| { kind: 'CREATE_FACE_LOOP'; points: readonly AuthoringPoint[]; normal: AuthoringPoint }
	| { kind: 'PUSH_PULL_FACE'; faceId: string; distance: number }
	| { kind: 'EXTRUDE_RECTANGLE'; entityId: string; distance: number };

export type ModelSelection =
	| { type: 'face'; id: string }
	| { type: 'instance'; id: string }
	| { type: 'edge'; start: AuthoringPoint; end: AuthoringPoint };
export type ModelAction =
	| { type: 'raw'; command: FlatAuthoringCommand }
	| { type: 'group'; selection: readonly ModelSelection[]; containerKind: 'group' | 'component'; name: string }
	| { type: 'erase'; selection: readonly ModelSelection[] }
	| { type: 'transform'; selection: readonly ModelSelection[]; delta: AuthoringPoint; copy: boolean; count: number; spacing: 'multiply' | 'divide'; radial: { axis: 'x' | 'y' | 'z'; pivot: AuthoringPoint; angleDegrees: number } | null }
	| { type: 'unique' | 'explode'; instanceId: string }
	| { type: 'offset'; faceId: string; distance: number }
	| { type: 'scale'; selection: readonly ModelSelection[]; factors: AuthoringPoint; pivot: AuthoringPoint; copy: boolean }
	| { type: 'curve'; curveKind: 'circle' | 'polygon' | 'arc'; center: AuthoringPoint; first: AuthoringPoint; normal: AuthoringPoint; segments: number; sweepDegrees: number }
	| { type: 'follow-me'; faceId: string; edges: readonly { start: AuthoringPoint; end: AuthoringPoint }[] }
	| { type: 'tag-create'; name: string }
	| { type: 'tag-visibility'; tagId: string; visible: boolean }
	| { type: 'tag-assign'; instanceIds: readonly string[]; tagId: string | null }
	| { type: 'entity-info'; instanceId: string; name: string; visible: boolean }
	| { type: 'asset-create'; instanceId: string; name: string }
	| { type: 'asset-insert'; assetId: string; point: AuthoringPoint }
	| { type: 'asset-delete'; assetId: string }
	| { type: 'paint'; selection: readonly ModelSelection[]; name: string; rgba: readonly [number,number,number,number]; opacityU16: number; side: 'front' | 'back' | 'both' }
	| { type: 'guide'; start: AuthoringPoint; end: AuthoringPoint; guideKind: 'line' | 'point' }
	| { type: 'clear-guides' };
export type AuthoringCommand = FlatAuthoringCommand | { kind: 'MODEL_EDIT'; path: readonly string[]; action: ModelAction };

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
			&& value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate));
}

function isPointLoop(value: unknown): value is readonly AuthoringPoint[] {
	return Array.isArray(value) && value.length >= 3 && value.length <= 256 && value.every(isPoint);
}

function isModelAction(value: unknown): value is ModelAction {
	if (!isRecord(value) || typeof value.type !== 'string') return false;
	const selection = (items: unknown) => Array.isArray(items) && items.length > 0 && items.length <= 4096 && items.every(item =>
		isRecord(item) && ((item.type === 'face' || item.type === 'instance')
			? hasExactKeys(item, ['type','id']) && typeof item.id === 'string' && item.id.length > 0
			: item.type === 'edge' && hasExactKeys(item, ['type','start','end']) && isPoint(item.start) && isPoint(item.end)));
	if (value.type === 'raw') return hasExactKeys(value, ['type','command']) && isRecord(value.command) && value.command.kind !== 'MODEL_EDIT' && isAuthoringCommand(value.command);
	if (value.type === 'group') return hasExactKeys(value, ['type','selection','containerKind','name']) && selection(value.selection) && ['group','component'].includes(String(value.containerKind)) && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 128;
	if (value.type === 'erase') return hasExactKeys(value, ['type','selection']) && selection(value.selection);
	if (value.type === 'unique' || value.type === 'explode') return hasExactKeys(value,['type','instanceId']) && typeof value.instanceId === 'string' && value.instanceId.length > 0;
	if (value.type === 'offset') return hasExactKeys(value,['type','faceId','distance']) && typeof value.faceId === 'string' && typeof value.distance === 'number' && Number.isFinite(value.distance);
	if (value.type === 'scale') return hasExactKeys(value,['type','selection','factors','pivot','copy']) && selection(value.selection) && isPoint(value.factors) && isPoint(value.pivot) && typeof value.copy === 'boolean';
	if (value.type === 'curve') return hasExactKeys(value,['type','curveKind','center','first','normal','segments','sweepDegrees']) && ['circle','polygon','arc'].includes(String(value.curveKind)) && isPoint(value.center) && isPoint(value.first) && isPoint(value.normal) && Number.isInteger(value.segments) && Number(value.segments)>=3 && Number(value.segments)<=256 && typeof value.sweepDegrees==='number' && Number.isFinite(value.sweepDegrees);
	if (value.type === 'follow-me') return hasExactKeys(value,['type','faceId','edges']) && typeof value.faceId==='string' && Array.isArray(value.edges) && value.edges.length>0 && value.edges.length<=256 && value.edges.every(e=>isRecord(e)&&hasExactKeys(e,['start','end'])&&isPoint(e.start)&&isPoint(e.end));
	const name=(v:unknown)=>typeof v==='string'&&v.trim().length>0&&v.length<=128;
	if(value.type==='tag-create')return hasExactKeys(value,['type','name'])&&name(value.name);
	if(value.type==='tag-visibility')return hasExactKeys(value,['type','tagId','visible'])&&typeof value.tagId==='string'&&typeof value.visible==='boolean';
	if(value.type==='tag-assign')return hasExactKeys(value,['type','instanceIds','tagId'])&&Array.isArray(value.instanceIds)&&value.instanceIds.length>0&&value.instanceIds.length<=4096&&value.instanceIds.every(id=>typeof id==='string')&&(value.tagId===null||typeof value.tagId==='string');
	if(value.type==='entity-info')return hasExactKeys(value,['type','instanceId','name','visible'])&&typeof value.instanceId==='string'&&name(value.name)&&typeof value.visible==='boolean';
	if(value.type==='asset-create')return hasExactKeys(value,['type','instanceId','name'])&&typeof value.instanceId==='string'&&name(value.name);
	if(value.type==='asset-insert')return hasExactKeys(value,['type','assetId','point'])&&typeof value.assetId==='string'&&isPoint(value.point);
	if(value.type==='asset-delete')return hasExactKeys(value,['type','assetId'])&&typeof value.assetId==='string';
	if(value.type==='paint')return hasExactKeys(value,['type','selection','name','rgba','opacityU16','side'])&&selection(value.selection)&&name(value.name)&&Array.isArray(value.rgba)&&value.rgba.length===4&&value.rgba.every(v=>Number.isInteger(v)&&v>=0&&v<=255)&&Number.isInteger(value.opacityU16)&&Number(value.opacityU16)>=0&&Number(value.opacityU16)<=65535&&['front','back','both'].includes(String(value.side));
	if (value.type === 'guide') return hasExactKeys(value,['type','start','end','guideKind']) && isPoint(value.start) && isPoint(value.end) && ['line','point'].includes(String(value.guideKind));
	if (value.type === 'clear-guides') return hasExactKeys(value,['type']);
	if (value.type === 'transform') {
		const radial=value.radial;
		return hasExactKeys(value,['type','selection','delta','copy','count','spacing','radial']) && selection(value.selection) && isPoint(value.delta) && typeof value.copy === 'boolean' && Number.isInteger(value.count) && Number(value.count)>=1 && Number(value.count)<=100 && ['multiply','divide'].includes(String(value.spacing))
			&& (radial===null || isRecord(radial) && hasExactKeys(radial,['axis','pivot','angleDegrees']) && ['x','y','z'].includes(String(radial.axis)) && isPoint(radial.pivot) && typeof radial.angleDegrees==='number' && Number.isFinite(radial.angleDegrees));
	}
	return false;
}

export function isAuthoringCommand(value: unknown): value is AuthoringCommand {
	if (isRecord(value) && value.kind === 'MODEL_EDIT') {
		return hasExactKeys(value, ['kind', 'path', 'action']) && Array.isArray(value.path) && value.path.length <= 32
			&& value.path.every(id => typeof id === 'string' && id.length > 0) && isModelAction(value.action);
	}
	if (!isRecord(value) || typeof value.kind !== 'string') return false;
	if (value.kind === 'CREATE_RECTANGLE') {
		if (hasExactKeys(value, ['kind', 'first', 'opposite'])) {
			return isPoint(value.first) && isPoint(value.opposite) && Object.is(value.first[1], 0) && Object.is(value.opposite[1], 0);
		}
		return hasExactKeys(value, ['kind', 'points', 'normal']) && Array.isArray(value.points) && value.points.length === 4
			&& value.points.every(isPoint) && isPoint(value.normal);
	}
	if (value.kind === 'CREATE_FACE_LOOP') {
		return hasExactKeys(value, ['kind', 'points', 'normal']) && isPointLoop(value.points) && isPoint(value.normal);
	}
	if (value.kind === 'PUSH_PULL_FACE') {
		return hasExactKeys(value, ['kind', 'faceId', 'distance'])
			&& typeof value.faceId === 'string' && value.faceId.length > 0
			&& typeof value.distance === 'number' && Number.isFinite(value.distance);
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
