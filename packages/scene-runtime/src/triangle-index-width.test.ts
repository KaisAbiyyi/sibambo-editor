import { describe, expect, test } from 'bun:test';
import { triangleIndexArray } from './triangle-index-width';

describe('triangle index width', () => {
	test('preserves sparse references beyond the unsigned 16-bit vertex range', () => {
		const indices = triangleIndexArray([65_536, 65_537, 65_538]);
		expect(indices).toBeInstanceOf(Uint32Array);
		expect([...indices]).toEqual([65_536, 65_537, 65_538]);
	});

	test('keeps compact indices within the unsigned 16-bit range', () => {
		const indices = triangleIndexArray([0, 65_535, 3]);
		expect(indices).toBeInstanceOf(Uint16Array);
		expect([...indices]).toEqual([0, 65_535, 3]);
	});
});
