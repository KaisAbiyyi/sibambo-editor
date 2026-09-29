import { describe, expect, test } from 'bun:test';
import { EditorSession } from '../../src/lib/editor/EditorSession';
import { createPlane, createRectangle } from '../../src/lib/editor/geometry/editable-geometry';
import type { ResearchProvenance } from '@sibambo/contracts';

const artifactSha256 = 'a'.repeat(64);
const provenance: ResearchProvenance = {
	schema: 'sibambo-research-provenance-v1',
	engine: 'e4',
	artifact: { sha256: artifactSha256, bytes: 3, format: 'bomc-1.2', profile: 'exact' },
	producer: { label: 'test' },
	model: { id: 'source-model' },
	capture: { id: 'capture-1', exportedAt: '2026-09-26T00:00:00.000Z', evidence: 'unit test', method: 'operator-attested' }
};

describe('EditorSession ownership', () => {
	test('keeps hash-bound source identity separate from editable geometry', async () => {
		const file = new File([new Uint8Array([1, 2, 3])], 'source.bomc');
		const sourceBytes = new Uint8Array(await file.arrayBuffer());
		const session = new EditorSession(file, provenance, artifactSha256);
		const face = createRectangle('edit-1', createPlane([0, 0, 0], [0, 1, 0]), [0, 0, 0], [2, 0, 2]);

		session.editableGeometry.set(face);

		expect(session.source.artifactSha256).toBe(artifactSha256);
		expect(session.source.modelId).toBe('source-model');
		expect(session.source.evidenceLevel).toBe('provenance-matched');
		expect(session.source.provenance?.artifact.sha256).toBe(artifactSha256);
		expect(session.editableGeometry.values()).toEqual([face]);
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(sourceBytes);
	});

	test('stores file-only provenance explicitly as null without inventing a model ID', () => {
		const file = new File([new Uint8Array([1, 2, 3])], 'source.bomc');
		const session = new EditorSession(file, null, artifactSha256, 'exact');

		expect(session.source.evidenceLevel).toBe('file-only');
		expect(session.source.provenance).toBeNull();
		expect(session.source.modelId).toBeNull();
		expect(session.source.profile).toBe('exact');
	});

	test('attaches matching provenance to the session only after profile and hash checks', () => {
		const file = new File([new Uint8Array([1, 2, 3])], 'source.bomc');
		const session = new EditorSession(file, null, artifactSha256, 'exact');
		session.attachProvenance(provenance);

		expect(session.source.evidenceLevel).toBe('provenance-matched');
		expect(session.source.provenance?.model.id).toBe('source-model');

		const fileOnly = new EditorSession(file, null, artifactSha256, 'exact');
		expect(() => fileOnly.attachProvenance({ ...provenance, artifact: { ...provenance.artifact, profile: 'research' } })).toThrow(/profile/i);
		expect(fileOnly.source.evidenceLevel).toBe('file-only');
		expect(fileOnly.source.provenance).toBeNull();
	});

	test('rejects an artifact hash that differs from imported provenance', () => {
		const file = new File([new Uint8Array([1, 2, 3])], 'source.bomc');
		expect(() => new EditorSession(file, provenance, 'b'.repeat(64))).toThrow(/hash/i);
	});

	test('clears only app-owned edits when the session closes', () => {
		const file = new File([new Uint8Array([1, 2, 3])], 'source.bomc');
		const session = new EditorSession(file, provenance, artifactSha256);
		session.editableGeometry.set(createRectangle('edit-1', createPlane([0, 0, 0], [0, 1, 0]), [0, 0, 0], [2, 0, 2]));

		session.dispose();
		expect(session.editableGeometry.size).toBe(0);
		expect(session.isClosed).toBe(true);
	});
});
