import { describe, expect, test } from 'bun:test';
import { Vector3 } from 'three';
import { nearestGroundBoundsAnchor, orbitCameraDrag, perspectiveDollyStep, type CameraPose } from './camera-navigation.js';

const bounds = { min: { x: 0, y: -1, z: 0 }, max: { x: 10, y: 3, z: 10 } };

describe('prepared camera navigation math contract', () => {
	test('bounds pivot is the first positive entry from outside and never the far exit', () => {
		const pose: CameraPose = { position: new Vector3(-5, 2, 5), target: new Vector3(5, 2, 5) };
		expect(nearestGroundBoundsAnchor(pose, bounds)?.toArray()).toEqual([0, 0, 5]);
		expect(nearestGroundBoundsAnchor({ position: new Vector3(5, 4, 5), target: new Vector3(6, 4, 5) }, bounds)).toBeNull();
		expect(nearestGroundBoundsAnchor({ position: new Vector3(-5, 2, 12), target: new Vector3(-4, 2, 12) }, bounds)).toBeNull();
		expect(nearestGroundBoundsAnchor({ position: new Vector3(-5, 2, 5), target: new Vector3(-5, 2, 6) }, bounds)).toBeNull();
		expect(nearestGroundBoundsAnchor(pose, { min: { x: 2, y: 0, z: 0 }, max: { x: 1, y: 0, z: 1 } })).toBeNull();
	});

	test('near-bound rays reject misses and resolve an equal-axis corner entry deterministically', () => {
		expect(nearestGroundBoundsAnchor({ position: new Vector3(-5, 2, 5), target: new Vector3(-6, 2, 5) }, bounds)).toBeNull();
		expect(nearestGroundBoundsAnchor({ position: new Vector3(-5, 2, 5), target: new Vector3(-5, 2, 6) }, bounds)).toBeNull();
		expect(nearestGroundBoundsAnchor({ position: new Vector3(-5, 2, 5), target: new Vector3(-5, 3, 5) }, bounds)).toBeNull();
		const cornerPose: CameraPose = { position: new Vector3(-5, 2, 15), target: new Vector3(5, 2, 5) };
		expect(nearestGroundBoundsAnchor(cornerPose, bounds)?.toArray()).toEqual([0, 0, 10]);
		expect(nearestGroundBoundsAnchor(cornerPose, bounds)?.toArray()).toEqual([0, 0, 10]);
	});

	test('explicit-pivot orbit preserves camera radius and viewing-target distance without grounding the rotated target', () => {
		const start: CameraPose = { position: new Vector3(4, 3, 9), target: new Vector3(1, 2, 0) };
		const pivot = new Vector3(0, 0, 0);
		const next = orbitCameraDrag(start, 24, -11, undefined, pivot);
		expect(next.position.distanceTo(pivot)).toBeCloseTo(start.position.distanceTo(pivot), 10);
		expect(next.position.distanceTo(next.target)).toBeCloseTo(start.position.distanceTo(start.target), 10);
		expect(next.target.y).not.toBe(0);
	});

	test('explicit-pivot orbit has stable zero-delta and yaw/pitch signs without mutating its start', () => {
		const start: CameraPose = { position: new Vector3(-5, 0, 0), target: new Vector3(0, 0, 0) };
		const positionBefore = start.position.clone();
		const targetBefore = start.target.clone();
		const pivot = new Vector3(0, 0, 0);
		const unchanged = orbitCameraDrag(start, 0, 0, undefined, pivot);
		expect(unchanged.position.distanceTo(start.position)).toBeLessThan(1e-12);
		expect(unchanged.target.distanceTo(start.target)).toBeLessThan(1e-12);
		const yawed = orbitCameraDrag(start, 20, 0, undefined, pivot);
		expect(yawed.target.clone().sub(yawed.position).z).toBeGreaterThan(0);
		const pitched = orbitCameraDrag(start, 0, 20, undefined, pivot);
		expect(pitched.target.clone().sub(pitched.position).y).toBeLessThan(0);
		expect(start.position.distanceTo(positionBefore)).toBe(0);
		expect(start.target.distanceTo(targetBefore)).toBe(0);
	});

	test('vertical orbit uses a stable fallback axis and clamps away from the pole', () => {
		const start: CameraPose = { position: new Vector3(0, 10, 0), target: new Vector3(0, 0, 0) };
		const next = orbitCameraDrag(start, 10, 10_000, undefined, new Vector3(0, 0, 0));
		expect(next.position.toArray().every(Number.isFinite)).toBe(true);
		expect(next.position.distanceTo(start.position)).toBeGreaterThan(0);
		expect(next.position.distanceTo(new Vector3(0, 0, 0))).toBeCloseTo(10, 10);
	});

	test('dolly rejects invalid inputs, keeps a nonzero floor, and caps only upward acceleration in one burst', () => {
		expect(perspectiveDollyStep(Number.NaN, 10, -100, undefined, 0)).toBeNull();
		expect(perspectiveDollyStep(1, 10, 0, undefined, 0)).toBeNull();
		expect(perspectiveDollyStep(1, 10, -1, undefined, Number.POSITIVE_INFINITY)).toBeNull();
		const first = perspectiveDollyStep(100, 10, -100, undefined, 1000)!;
		const accelerated = perspectiveDollyStep(1000, 10, -100, first.state, 1100)!;
		expect(accelerated.step).toBeCloseTo(first.step * 1.5, 10);
		const decreased = perspectiveDollyStep(1, 10, -100, accelerated.state, 1200)!;
		expect(decreased.step).toBeLessThan(accelerated.step);
		const reversed = perspectiveDollyStep(1000, 10, 100, decreased.state, 1250)!;
		expect(reversed.state.direction).toBe(-1);
		expect(reversed.step).toBeGreaterThan(decreased.step);
		expect(perspectiveDollyStep(0, 0, -1, undefined, 0)!.step).toBeGreaterThan(0);
	});

	test('dolly slows as the ray nears a wall and resets acceleration after burst expiry, reversal, time reversal, or invalid state', () => {
		const first = perspectiveDollyStep(10, 10, -100, undefined, 1000)!;
		const nearWall = perspectiveDollyStep(1, 10, -100, first.state, 1100)!;
		expect(nearWall.step).toBeLessThan(first.step);
		const expired = perspectiveDollyStep(100, 10, -100, first.state, 1251)!;
		expect(expired.step).toBeCloseTo(18, 10);
		const reversed = perspectiveDollyStep(100, 10, 100, first.state, 1100)!;
		expect(reversed.step).toBeCloseTo(18, 10);
		const backwards = perspectiveDollyStep(100, 10, -100, first.state, 999)!;
		expect(backwards.step).toBeCloseTo(18, 10);
		const invalidPrevious = perspectiveDollyStep(100, 10, -100, { direction: 1, lastTimeMs: 1000, lastAppliedStep: -1 }, 1100)!;
		expect(invalidPrevious.step).toBeCloseTo(18, 10);
	});
});
