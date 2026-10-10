import { describe, expect, test } from 'bun:test';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { buildRectangleEdit, journalEntry } from '../../src/lib/authoring/geometry.js';
import { AuthoringHistory, graphsEqual, validateAuthoringCheckpoint } from '../../src/lib/authoring/history.js';

const DOCUMENT_ID = 'a4f2d141-64e1-4c62-8d0d-53623f71a220';

describe('canonical authoring history', () => {
	test('moves journals only after successful transactions and skips graph-identical edits', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		const history = new AuthoringHistory(null);
		try {
			const first = buildRectangleEdit(document.snapshot().graph, `${DOCUMENT_ID}:rectangle:1`, [0, 0, 0], [2, 0, 3]);
			expect(history.execute(document, journalEntry(first))).toBe(true);
			const afterCreate = document.snapshot();
			const mesh = afterCreate.graph.meshes[0]!;
			expect(history.execute(document, {
				forward: [{ type: 'put-mesh', value: mesh }],
				inverse: [{ type: 'put-mesh', value: mesh }]
			})).toBe(false);
			expect(document.snapshot()).toEqual(afterCreate);
			expect(history.undoCount).toBe(1);
			expect(history.redoCount).toBe(0);

			const beforeFailure = history.checkpoint();
			const beforeGraph = document.snapshot();
			expect(() => history.execute(document, {
				forward: [{ type: 'delete-mesh', id: `${DOCUMENT_ID}:missing-mesh` }],
				inverse: [{ type: 'put-mesh', value: mesh }]
			})).toThrow();
			expect(document.snapshot()).toEqual(beforeGraph);
			expect(history.checkpoint()).toEqual(beforeFailure);
		} finally { document.dispose(); }
	});

	test('matches saved graph after edit then undo and restores both journal stacks by replay', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		const history = new AuthoringHistory(null);
		try {
			const first = buildRectangleEdit(document.snapshot().graph, `${DOCUMENT_ID}:rectangle:1`, [0, 0, 0], [2, 0, 3]);
			history.execute(document, journalEntry(first));
			const saved = document.snapshot().graph;
			history.acknowledgeSaved(saved);
			const second = buildRectangleEdit(document.snapshot().graph, `${DOCUMENT_ID}:rectangle:2`, [4, 0, 0], [6, 0, 3]);
			history.execute(document, journalEntry(second));
			expect(history.dirty(document.snapshot().graph)).toBe(true);
			history.undo(document);
			expect(history.dirty(document.snapshot().graph)).toBe(false);

			const checkpoint = validateAuthoringCheckpoint({
				snapshot: document.snapshot(), sequence: 3, history: history.checkpoint()
			});
			expect(checkpoint.history.undo).toHaveLength(1);
			expect(checkpoint.history.redo).toHaveLength(1);
			const restored = BomcDocument.fromGraph(checkpoint.snapshot.graph, checkpoint.snapshot.revision);
			const restoredHistory = new AuthoringHistory();
			try {
				restoredHistory.restore(checkpoint.history);
				expect(restoredHistory.dirty(restored.snapshot().graph)).toBe(false);
				expect(restoredHistory.canUndo).toBe(true);
				expect(restoredHistory.canRedo).toBe(true);
			} finally { restored.dispose(); }
		} finally { document.dispose(); }
	});

	test('checkpoints share only immutable journal entries and keep prior stack snapshots stable', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		const history = new AuthoringHistory(null);
		try {
			const first = buildRectangleEdit(document.snapshot().graph, `${DOCUMENT_ID}:rectangle:1`, [0, 0, 0], [2, 0, 3]);
			const firstEntry = journalEntry(first);
			history.execute(document, firstEntry);
			const prior = history.checkpoint();
			const second = buildRectangleEdit(document.snapshot().graph, `${DOCUMENT_ID}:rectangle:2`, [4, 0, 0], [6, 0, 3]);
			const secondEntry = journalEntry(second);
			history.execute(document, secondEntry);
			const current = history.checkpoint();

			expect(prior.undo).toHaveLength(1);
			expect(current.undo).toHaveLength(2);
			expect(prior.undo).not.toBe(current.undo);
			expect(prior.undo[0]).toBe(firstEntry);
			expect(prior.undo[0]).toBe(current.undo[0]);
			expect(current.undo[1]).toBe(secondEntry);
			expect(Object.isFrozen(firstEntry)).toBe(true);
			expect(Object.isFrozen(prior)).toBe(true);
			expect(Object.isFrozen(prior.undo)).toBe(true);
			expect(Object.isFrozen(prior.undo[0]!.forward)).toBe(true);
			const storedEdit = prior.undo[0]!.forward[0]!;
			expect(Object.isFrozen(storedEdit)).toBe(true);
			if ('value' in storedEdit) expect(Object.isFrozen(storedEdit.value)).toBe(true);
			expect(() => (prior.undo as unknown[]).pop()).toThrow();
		} finally { document.dispose(); }
	});

	test('uses exact recursive scalar equality including negative zero and object key sets', () => {
		expect(graphsEqual({ value: -0 }, { value: 0 })).toBe(false);
		expect(graphsEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
		expect(graphsEqual({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
		expect(graphsEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
	});

	test('rejects malformed or revision-unbounded restored journal checkpoints', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Untitled' });
		try {
			const graph = document.snapshot();
			const empty = { snapshot: graph, sequence: 1, history: { undo: [], redo: [], savedGraph: null } };
			expect(validateAuthoringCheckpoint(empty)).toEqual(empty);
			expect(() => validateAuthoringCheckpoint({ ...empty, history: { ...empty.history, undo: [null] } })).toThrow();
		} finally { document.dispose(); }
	});
});
