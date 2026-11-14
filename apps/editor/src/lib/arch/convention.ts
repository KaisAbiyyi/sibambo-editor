/**
 * SIB-MCP-MODELING-001 v2.1 A10 — coordinate convention between ArchModule
 * semantics (+Z up, metres, row-major transforms) and the Editor authoring
 * graph (three.js Y-up runtime frame, column-major `Instance.matrix`).
 *
 * Branch B1: baked mesh positions stay module-local Z-up and the managed
 * container's `Instance.matrix = columnMajor(CONVENTION · T)`.
 */

export type Matrix16 = readonly number[];

/** Row-major CONVENTION: (x, y, z) -> (x, z, -y). */
export const CONVENTION_ROW_MAJOR: Matrix16 = Object.freeze([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
/** Column-major array of CONVENTION, as stored in `Instance.matrix`. */
export const CONVENTION_COLUMN_MAJOR: Matrix16 = Object.freeze([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
/** Row-major CONVENTION⁻¹ (its transpose; CONVENTION is a rotation). */
export const CONVENTION_INVERSE_ROW_MAJOR: Matrix16 = Object.freeze([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
export const IDENTITY_ROW_MAJOR: Matrix16 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function assertMatrix(m: Matrix16, label: string): void {
	if (!Array.isArray(m) || m.length !== 16 || m.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
		throw new Error(`${label} must contain 16 finite numbers.`);
	}
}

/** Row-major product a · b. */
export function multiplyRowMajor(a: Matrix16, b: Matrix16): number[] {
	const out = new Array<number>(16).fill(0);
	for (let row = 0; row < 4; row++)
		for (let col = 0; col < 4; col++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) sum += a[row * 4 + k]! * b[k * 4 + col]!;
			out[row * 4 + col] = sum + 0;
		}
	return out;
}

/** Transpose between row-major and column-major layouts (the operation is its own inverse). */
export function transpose(m: Matrix16): number[] {
	const out = new Array<number>(16);
	for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) out[col * 4 + row] = m[row * 4 + col]! + 0;
	return out;
}

/** Module row-major transform T -> column-major `Instance.matrix` = columnMajor(CONVENTION · T). */
export function toInstanceMatrix(transform: Matrix16): number[] {
	assertMatrix(transform, 'transform');
	return transpose(multiplyRowMajor(CONVENTION_ROW_MAJOR, transform));
}

/** Column-major `Instance.matrix` -> module row-major transform T = CONVENTION⁻¹ · rowMajor(m). */
export function fromInstanceMatrix(matrix: Matrix16): number[] {
	assertMatrix(matrix, 'matrix');
	return multiplyRowMajor(CONVENTION_INVERSE_ROW_MAJOR, transpose(matrix)).map((v) => v + 0);
}
