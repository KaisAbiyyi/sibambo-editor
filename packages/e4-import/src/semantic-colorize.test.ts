import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { colorizePixel, colorizeRgba, type SemanticColorizeMode } from './semantic-colorize';

type PixelVector = { input: number[]; output: number[] };
type VectorCase = { mode: SemanticColorizeMode; deltas: [number, number, number]; pixels: PixelVector[] };
const oracle = JSON.parse(readFileSync(`${import.meta.dir}/test-fixtures/semantic-colorize-ruby-v1.json`, 'utf8')) as {
	caseCount: number; vectors: VectorCase[];
	pngCase: { width: number; height: number; sourceRgba: number[][]; mode: SemanticColorizeMode; deltas: [number, number, number]; expectedRgba: number[][]; expectedRgbaSha256: string };
};

describe('producer-exact semantic color transform', () => {
	test('matches all 1,408 independent Ruby RGBA vectors byte for byte', async () => {
		let checked = 0;
		for (const vector of oracle.vectors) {
			const input = Uint8Array.from(vector.pixels.flatMap((pixel) => pixel.input));
			const expected = Uint8Array.from(vector.pixels.flatMap((pixel) => pixel.output));
			const result = await colorizeRgba(input, vector.pixels.length, 1, vector.mode, vector.deltas);
			expect(Array.from(result.data)).toEqual(Array.from(expected));
			checked += vector.pixels.length;
		}
		expect(checked).toBe(1408);
		expect(oracle.caseCount).toBe(1408);
	});

	test('keeps the known SketchUp conversion regression exact', () => {
		expect(colorizePixel(115, 137, 98, 1, [92.58741048890613, 0.13725490868091583, -0.11229892646129502])).toEqual([147, 156, 158]);
	});

	test('transforms transparent and translucent PNG oracle pixels without losing RGB', async () => {
		const input = Uint8Array.from(oracle.pngCase.sourceRgba.flat());
		const result = await colorizeRgba(input, oracle.pngCase.width, oracle.pngCase.height, oracle.pngCase.mode, oracle.pngCase.deltas);
		expect(Array.from(result.data)).toEqual(oracle.pngCase.expectedRgba.flat());
		expect(createHash('sha256').update(result.data).digest('hex')).toBe(oracle.pngCase.expectedRgbaSha256);
		expect(result.data[3]).toBe(0);
		expect(result.data[0]).not.toBe(0);
	});

	test('bounds memo insertion at 65,536 keys and leaves input untouched', async () => {
		const pixels = 65_537;
		const input = new Uint8Array(pixels * 4);
		for (let index = 0; index < pixels; index += 1) {
			input[index * 4] = (index >>> 16) & 0xff;
			input[index * 4 + 1] = (index >>> 8) & 0xff;
			input[index * 4 + 2] = index & 0xff;
			input[index * 4 + 3] = index & 0xff;
		}
		const before = input.slice();
		const result = await colorizeRgba(input, pixels, 1, 1, [0, 0, 0]);
		expect(result.maxMemoEntries).toBe(65_536);
		expect(input).toEqual(before);
		expect(result.data).not.toBe(input);
	});

	test('cancels after the first 32,768-pixel event-loop yield', async () => {
		const input = new Uint8Array(32_769 * 4);
		let checks = 0;
		const isCancelled = () => { checks += 1; return checks === 3; };
		await expect(colorizeRgba(input, 32_769, 1, 1, [0, 0, 0], { isCancelled })).rejects.toThrow('BOMC load cancelled');
		expect(checks).toBe(3);
	});

	test('rejects invalid dimensions, unsafe products and non-tight RGBA input', async () => {
		const empty = new Uint8Array();
		await expect(colorizeRgba(empty, 0, 1, 1, [0, 0, 0])).rejects.toThrow('dimensions');
		await expect(colorizeRgba(empty, Number.MAX_SAFE_INTEGER, 2, 1, [0, 0, 0])).rejects.toThrow(/dimensions|byte length/);
		await expect(colorizeRgba(new Uint8Array(3), 1, 1, 1, [0, 0, 0])).rejects.toThrow('byte length');
	});
});
