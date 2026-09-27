import { describe, expect, test } from 'bun:test';
import { filterTrianglesBySourceFaces } from './source-face-filter';

describe('source face viewport filtering', () => {
	test('keeps source triangles mapped to the selected face and preserves index width', () => {
		const indices = new Uint16Array([0, 1, 2, 2, 3, 0, 4, 5, 6]);
		const sourceFaces = new Uint32Array([10, 10, 20]);

		expect(filterTrianglesBySourceFaces(indices, sourceFaces, new Set([10]))).toEqual(new Uint16Array([0, 1, 2, 2, 3, 0]));
		expect(filterTrianglesBySourceFaces(new Uint32Array([0, 1, 2]), new Uint32Array([20]), new Set([20]))).toBeInstanceOf(Uint32Array);
	});

	test('fails closed for isolated geometry without aligned source face evidence', () => {
		expect(filterTrianglesBySourceFaces(new Uint16Array([0, 1, 2]), undefined, new Set([10]))).toEqual(new Uint16Array());
		expect(() => filterTrianglesBySourceFaces(new Uint16Array([0, 1, 2, 2, 3, 0]), new Uint32Array([10]), new Set([10]))).toThrow(/triangle/i);
	});

	test('returns original indices when isolation is cleared', () => {
		const indices = new Uint16Array([0, 1, 2]);
		expect(filterTrianglesBySourceFaces(indices, undefined, null)).toBe(indices);
	});
});
