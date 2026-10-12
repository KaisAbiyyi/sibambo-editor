import { BomcDocument } from '@sibambo/bomc-document/document';
import type { BomcGraph, BomcSnapshot, DocumentEdit } from '@sibambo/bomc-document';
import { isAuthoringCheckpointShape, isRecord, type AuthoringCheckpoint, type AuthoringHistoryCheckpoint, type AuthoringJournalEntry } from './protocol.js';
import { validateAuthoringDocument as validateEditableSubset, nextModelSequence } from './model.js';

export class AuthoringHistoryError extends Error {
	constructor(message: string) { super(message); this.name = 'AuthoringHistoryError'; }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Exact recursive equality for canonical records, arrays, and scalar values. */
export function graphsEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		for (let index = 0; index < left.length; index += 1) {
			if (!Object.hasOwn(left, index) || !Object.hasOwn(right, index) || !graphsEqual(left[index], right[index])) return false;
		}
		return true;
	}
	if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord);
	const rightKeys = Object.keys(rightRecord);
	if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !Object.hasOwn(rightRecord, key))) return false;
	return leftKeys.every((key) => graphsEqual(leftRecord[key], rightRecord[key]));
}

function cloneValue<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
	if (typeof value === 'object' && value !== null && isPlainRecord(value)) {
		const cloned: Record<string, unknown> = Object.create(Object.getPrototypeOf(value));
		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) cloned[key] = cloneValue(nested);
		return cloned as T;
	}
	return value;
}

function freezeValue<T>(value: T): T {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value as Record<string, unknown>)) freezeValue(nested);
	return Object.freeze(value);
}

function cloneEntry(entry: AuthoringJournalEntry): AuthoringJournalEntry {
	return { forward: cloneValue(entry.forward), inverse: cloneValue(entry.inverse) };
}

function cloneAndFreezeEntry(entry: AuthoringJournalEntry): AuthoringJournalEntry {
	return freezeValue(cloneEntry(entry));
}

function assertJournalEntryShape(value: unknown): asserts value is AuthoringJournalEntry {
	if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'forward') || !Object.hasOwn(value, 'inverse')
		|| !Array.isArray(value.forward) || !Array.isArray(value.inverse)
		|| (value.forward.length === 0) !== (value.inverse.length === 0)) {
		throw new AuthoringHistoryError('History entry must contain paired forward and inverse edit arrays.');
	}
	if (value.forward.length !== value.inverse.length || ![1, 2, 3].includes(value.forward.length)) {
		if (isModelJournal(value)) { for (const edit of [...value.forward, ...value.inverse]) assertSupportedJournalEdit(edit); return; }
		throw new AuthoringHistoryError('History entries must use a supported authoring mesh/material/root transaction shape.');
	}
	for (const edit of [...value.forward, ...value.inverse]) assertSupportedJournalEdit(edit);
	if (isModelJournal(value)) return;
	if (value.forward.length === 1) {
		if (value.forward[0]?.type !== 'put-mesh' || value.inverse[0]?.type !== 'put-mesh') {
			throw new AuthoringHistoryError('Single-edit history entries must replace the root mesh in both directions.');
		}
	} else if (value.forward.length === 2) {
		if (value.forward[0]?.type !== 'put-material' || value.forward[1]?.type !== 'put-mesh'
			|| value.inverse[0]?.type !== 'put-mesh' || value.inverse[1]?.type !== 'delete-material') {
			throw new AuthoringHistoryError('Two-edit history entries must add the neutral material with the mesh and remove it after restoring the prior mesh.');
		}
	} else if (value.forward[0]?.type !== 'put-material' || value.forward[1]?.type !== 'put-definition'
		|| value.forward[2]?.type !== 'put-mesh' || value.inverse[0]?.type !== 'delete-mesh'
		|| value.inverse[1]?.type !== 'put-definition' || value.inverse[2]?.type !== 'delete-material') {
		throw new AuthoringHistoryError('First-rectangle history edits must use the canonical ordered material/definition/mesh transaction.');
	}
}

function isModelJournal(value: Record<string, unknown>): boolean {
	if (!Array.isArray(value.forward) || !Array.isArray(value.inverse)) return false;
	if (!value.forward.length || value.forward.length !== value.inverse.length || value.forward.length > 20000) return false;
	const roots = [value.forward, value.inverse].map(edits => edits.find((edit) => isRecord(edit) && edit.type === 'put-instance' && isRecord(edit.value) && edit.value.kind === 'root'));
	if (!roots.every(isRecord)) return false;
	const values = roots.map(root => root.value);
	return values.every(isRecord) && values[0].id === values[1].id && values.some(root => {
		if (typeof root.label !== 'string') return false;
		try { return JSON.parse(root.label)?.schema === 'sibambo-editor-model-v1'; } catch { return false; }
	});
}

function assertSupportedJournalEdit(value: unknown): asserts value is DocumentEdit {
	if (!isRecord(value) || typeof value.type !== 'string') throw new AuthoringHistoryError('History contains a malformed document edit.');
	if (value.type === 'set-name') {
		if (Object.keys(value).length !== 2 || typeof value.name !== 'string') throw new AuthoringHistoryError('History contains a malformed name edit.');
		throw new AuthoringHistoryError('Name edits are outside the authoring command contract.');
	}
	if (value.type === 'put-material' || value.type === 'put-definition' || value.type === 'put-mesh' || value.type === 'put-instance') {
		if (Object.keys(value).length !== 2 || !isRecord(value.value)) throw new AuthoringHistoryError('History contains a malformed put edit.');
		if (value.type === 'put-mesh') {
			const mesh = value.value;
			if (typeof mesh.id !== 'string' || !Array.isArray(mesh.positions) || !Array.isArray(mesh.faces)) {
				throw new AuthoringHistoryError('History contains a malformed mesh replacement.');
			}
			for (const face of mesh.faces) {
				if (!isRecord(face) || typeof face.id !== 'string' || (face.label !== null && typeof face.label !== 'string')) {
					throw new AuthoringHistoryError('History contains a malformed mesh face.');
				}
			}
		}
		return;
	}
	if (value.type === 'delete-material' || value.type === 'delete-definition' || value.type === 'delete-mesh' || value.type === 'delete-instance') {
		if (Object.keys(value).length !== 2 || typeof value.id !== 'string' || value.id.length === 0) {
			throw new AuthoringHistoryError('History contains a malformed delete edit.');
		}
		return;
	}
	throw new AuthoringHistoryError('History contains an unsupported document edit.');
}

function assertStoredJournalEntry(value: unknown): asserts value is AuthoringJournalEntry {
	assertJournalEntryShape(value);
	if (value.forward.length === 0) throw new AuthoringHistoryError('Checkpoint contains an empty history entry.');
}

function checkEditable(graph: BomcGraph) {
	const result = validateEditableSubset(graph);
	if (!result.editable) throw new AuthoringHistoryError(`Checkpoint graph is outside the authoring subset: ${result.reason}`);
}

function sequenceFromOwnedValue(documentId: string, value: string): number | null {
	for (const kind of ['rectangle', 'face', 'op']) {
		const prefix = `${documentId}:${kind}:`;
		if (!value.startsWith(prefix)) continue;
		const suffix = value.slice(prefix.length).split(':', 1)[0]!;
		if (!/^[1-9]\d*$/.test(suffix)) return null;
		const sequence = Number(suffix);
		return Number.isSafeInteger(sequence) ? sequence : null;
	}
	return null;
}

function maxSequenceInGraph(graph: BomcGraph): number {
	let max = nextModelSequence(graph) - 1;
	for (const mesh of graph.meshes) for (const face of mesh.faces) {
		const candidates = [face.id];
		if (face.label) {
			try {
				const label: unknown = JSON.parse(face.label);
				if (Array.isArray(label)) for (const item of label) if (typeof item === 'string') candidates.push(item);
			} catch { /* The subset validator reports malformed labels. */ }
		}
		for (const candidate of candidates) {
			const sequence = sequenceFromOwnedValue(graph.documentId, candidate);
			if (sequence !== null) max = Math.max(max, sequence);
		}
	}
	return max;
}

function maxSequenceInEdits(edits: readonly DocumentEdit[], documentId: string): number {
	let max = 0;
	for (const edit of edits) {
		for (const match of JSON.stringify(edit).matchAll(/:(?:rectangle|face|op):([1-9]\d*)/g)) max = Math.max(max, Number(match[1]));
	}
	for (const edit of edits) {
		if (edit.type !== 'put-mesh') continue;
		for (const face of edit.value.faces) {
			const candidates = [face.id];
			if (face.label) {
				try {
					const label: unknown = JSON.parse(face.label);
					if (Array.isArray(label)) for (const item of label) if (typeof item === 'string') candidates.push(item);
				} catch { /* Canonical graph validation/replay reports malformed labels. */ }
			}
			for (const candidate of candidates) {
				const sequence = sequenceFromOwnedValue(documentId, candidate);
				if (sequence !== null) max = Math.max(max, sequence);
			}
		}
	}
	return max;
}

function applyAndRequireChange(document: BomcDocument, edits: readonly DocumentEdit[], stage: string) {
	if (edits.length === 0) throw new AuthoringHistoryError(`Checkpoint ${stage} journal entry has no edits.`);
	const before = document.snapshot();
	document.transact(edits);
	const after = document.snapshot();
	if (graphsEqual(before.graph, after.graph)) throw new AuthoringHistoryError(`Checkpoint ${stage} journal entry is a no-op.`);
	checkEditable(after.graph);
}

function validateAndReplayHistory(snapshot: BomcSnapshot, history: AuthoringHistoryCheckpoint): void {
	const undoProbe = BomcDocument.fromGraph(snapshot.graph, snapshot.revision);
	try {
		for (let index = history.undo.length - 1; index >= 0; index -= 1) {
			applyAndRequireChange(undoProbe, history.undo[index]!.inverse, 'undo inverse');
		}
		for (let index = 0; index < history.undo.length; index += 1) {
			applyAndRequireChange(undoProbe, history.undo[index]!.forward, 'undo forward');
		}
		if (!graphsEqual(undoProbe.snapshot().graph, snapshot.graph)) throw new AuthoringHistoryError('Undo journal does not return to the checkpoint graph.');
	} finally { undoProbe.dispose(); }

	const redoProbe = BomcDocument.fromGraph(snapshot.graph, snapshot.revision);
	try {
		for (let index = history.redo.length - 1; index >= 0; index -= 1) {
			applyAndRequireChange(redoProbe, history.redo[index]!.forward, 'redo forward');
		}
		for (let index = 0; index < history.redo.length; index += 1) {
			applyAndRequireChange(redoProbe, history.redo[index]!.inverse, 'redo inverse');
		}
		if (!graphsEqual(redoProbe.snapshot().graph, snapshot.graph)) throw new AuthoringHistoryError('Redo journal does not return to the checkpoint graph.');
	} finally { redoProbe.dispose(); }
}

/** Validate canonical graphs and replay both stacks before a checkpoint is restored or published. */
export function validateAuthoringCheckpoint(
	value: unknown,
	options: { replayHistory?: boolean; reuseOwnedInput?: boolean; trustedWorkerTransition?: boolean; validateLatestEntry?: boolean } = {}
): AuthoringCheckpoint {
	if (!isAuthoringCheckpointShape(value)) throw new AuthoringHistoryError('Authoring checkpoint envelope is malformed.');
	// Worker messages are already structured-cloned into exclusively owned
	// main-thread objects; the client freezes them before publication.
	const checkpoint = options.reuseOwnedInput ? value : cloneValue(value);
	const { snapshot, sequence, history } = checkpoint;
	if (history.undo.length + history.redo.length > snapshot.revision) {
		throw new AuthoringHistoryError('Checkpoint history stack count cannot exceed the canonical revision.');
	}
	if (Object.values(snapshot.tokens).some((token) => token > snapshot.revision)) {
		throw new AuthoringHistoryError('Checkpoint revision tokens cannot exceed its revision.');
	}
	if (options.trustedWorkerTransition) {
		if (options.replayHistory) throw new AuthoringHistoryError('Worker transitions cannot bypass replay while requesting full history validation.');
		if (options.validateLatestEntry) {
			const latest = history.undo.at(-1);
			if (!latest) throw new AuthoringHistoryError('A worker command checkpoint is missing its newest journal entry.');
			assertStoredJournalEntry(latest);
		}
		if (history.savedGraph !== null && history.savedGraph.documentId !== snapshot.graph.documentId) {
			throw new AuthoringHistoryError('Saved graph belongs to another document.');
		}
		// The current snapshot is still checked against the exact application subset.
		// Earlier journals and savedGraph were validated on their admission ACK,
		// then frozen in the worker, so replaying/scanning them again is redundant.
		checkEditable(snapshot.graph);
		if (maxSequenceInGraph(snapshot.graph) >= sequence) {
				throw new AuthoringHistoryError('Checkpoint sequence would reuse a retained authoring face/operation ID.');
		}
		return checkpoint;
	}
	for (const entry of [...history.undo, ...history.redo]) assertStoredJournalEntry(entry);
	const document = BomcDocument.fromGraph(snapshot.graph, snapshot.revision);
	try {
		const canonical = document.snapshot();
		if (!graphsEqual(canonical.graph, snapshot.graph)) throw new AuthoringHistoryError('Checkpoint graph is not in canonical kernel form.');
		checkEditable(canonical.graph);
		if (history.savedGraph !== null) {
			if (history.savedGraph.documentId !== snapshot.graph.documentId) throw new AuthoringHistoryError('Saved graph belongs to another document.');
			const saved = BomcDocument.fromGraph(history.savedGraph, snapshot.revision);
			try {
				if (!graphsEqual(saved.snapshot().graph, history.savedGraph)) throw new AuthoringHistoryError('Saved graph is not in canonical kernel form.');
				checkEditable(saved.snapshot().graph);
			} finally { saved.dispose(); }
		}
		if (options.replayHistory !== false) validateAndReplayHistory(snapshot, history);
		let maxSequence = maxSequenceInGraph(snapshot.graph);
		if (history.savedGraph) maxSequence = Math.max(maxSequence, maxSequenceInGraph(history.savedGraph));
		for (const entry of [...history.undo, ...history.redo]) {
			maxSequence = Math.max(maxSequence, maxSequenceInEdits(entry.forward, snapshot.graph.documentId));
			maxSequence = Math.max(maxSequence, maxSequenceInEdits(entry.inverse, snapshot.graph.documentId));
		}
			if (maxSequence >= sequence) throw new AuthoringHistoryError('Checkpoint sequence would reuse a retained authoring face/operation ID.');
		return checkpoint;
	} finally { document.dispose(); }
}

export class AuthoringHistory {
	private undoEntries: AuthoringJournalEntry[] = [];
	private redoEntries: AuthoringJournalEntry[] = [];
	private savedGraph: BomcGraph | null;

	constructor(savedGraph: BomcGraph | null = null) {
		this.savedGraph = savedGraph === null ? null : freezeValue(cloneValue(savedGraph));
	}

	get canUndo() { return this.undoEntries.length > 0; }
	get canRedo() { return this.redoEntries.length > 0; }
	get undoCount() { return this.undoEntries.length; }
	get redoCount() { return this.redoEntries.length; }

	dirty(graph: BomcGraph): boolean {
		return this.savedGraph === null || !graphsEqual(this.savedGraph, graph);
	}

	execute(document: BomcDocument, entry: AuthoringJournalEntry): boolean {
		assertJournalEntryShape(entry);
		if (entry.forward.length === 0) return false;
		const before = document.snapshot();
		document.transact(entry.forward);
		const after = document.snapshot();
		if (graphsEqual(before.graph, after.graph)) return false;
		// The worker constructed this entry from immutable canonical snapshots and
		// newly owned geometry. Taking ownership by freezing preserves its internal
		// structural sharing; cloning the full mesh here duplicated every vertex.
		this.undoEntries.push(freezeValue(entry));
		this.redoEntries = [];
		return true;
	}

	undo(document: BomcDocument): boolean {
		const entry = this.undoEntries[this.undoEntries.length - 1];
		if (!entry) return false;
		const before = document.snapshot();
		document.transact(entry.inverse);
		const after = document.snapshot();
		if (graphsEqual(before.graph, after.graph)) return false;
		this.undoEntries.pop();
		this.redoEntries.push(entry);
		return true;
	}

	redo(document: BomcDocument): boolean {
		const entry = this.redoEntries[this.redoEntries.length - 1];
		if (!entry) return false;
		const before = document.snapshot();
		document.transact(entry.forward);
		const after = document.snapshot();
		if (graphsEqual(before.graph, after.graph)) return false;
		this.redoEntries.pop();
		this.undoEntries.push(entry);
		return true;
	}

	acknowledgeSaved(graph: BomcGraph): void {
		this.savedGraph = freezeValue(cloneValue(graph));
	}

	checkpoint(): AuthoringHistoryCheckpoint {
		// Entries and savedGraph are immutable after admission. Snapshot only the
		// two stack arrays; postMessage still provides each reply's owned copy.
		return Object.freeze({
			undo: Object.freeze([...this.undoEntries]),
			redo: Object.freeze([...this.redoEntries]),
			savedGraph: this.savedGraph
		});
	}

	restore(checkpoint: AuthoringHistoryCheckpoint): void {
		if (!Array.isArray(checkpoint.undo) || !Array.isArray(checkpoint.redo)) throw new AuthoringHistoryError('History stacks must be arrays.');
		for (const entry of [...checkpoint.undo, ...checkpoint.redo]) assertStoredJournalEntry(entry);
		this.undoEntries = checkpoint.undo.map(cloneAndFreezeEntry);
		this.redoEntries = checkpoint.redo.map(cloneAndFreezeEntry);
		this.savedGraph = checkpoint.savedGraph === null ? null : freezeValue(cloneValue(checkpoint.savedGraph));
	}
}
