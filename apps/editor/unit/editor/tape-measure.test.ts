import { describe, expect, test } from 'bun:test';
import { Vector3 } from 'three';
import { formatTapeDistance, TapeMeasure } from '../../src/lib/editor/tape-measure';

describe('TapeMeasure', () => {
	test('runs click A, preview, click B and returns Euclidean distance', () => {
		const tape = new TapeMeasure();
		expect(tape.click(new Vector3(0, 0, 0))).toBeNull();
		tape.move(new Vector3(1, 2, 2));
		expect(tape.distanceM).toBe(3);
		const result = tape.click(new Vector3(1, 2, 2));
		expect(result?.distanceM).toBe(3);
		expect(tape.phase).toBe('idle');
	});

	test('escape-style cancellation clears preview and unit formatting stays compact', () => {
		const tape = new TapeMeasure(); tape.click(new Vector3()); tape.move(new Vector3(0.5, 0, 0)); tape.cancel();
		expect(tape.first).toBeNull();
		expect(formatTapeDistance(0.5)).toBe('50.0 cm');
		expect(formatTapeDistance(2.438)).toBe('2.438 m');
	});
});
