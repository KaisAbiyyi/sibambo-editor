import { describe, expect, test } from 'bun:test';
import type { LoadProgress, PreparedBufferDescriptor, SourceIdentity, WorkerEnvelope } from './runtime';

describe('shared runtime contracts', () => {
	test('describes a plain worker DTO without importing application models or Three.js', () => {
		const progress: LoadProgress<'decoding', 'unit'> = {
			stage: 'decoding', completed: 4, total: 8, message: 'Reading sections', unit: 'unit'
		};
		const source: SourceIdentity = { format: 'bomc-1.2', modelId: 'house2', sourceBytes: 128 };
		const buffer: PreparedBufferDescriptor = {
			key: 'positions', role: 'position', arrayType: 'float32', itemSize: 3, count: 12, byteLength: 144, transferable: true
		};
		const message: WorkerEnvelope<'progress', { progress: LoadProgress; source: SourceIdentity; buffer: PreparedBufferDescriptor }> = {
			type: 'progress', requestId: 'load-1', payload: { progress, source, buffer }
		};
		expect(structuredClone(message)).toEqual(message);
	});
});
