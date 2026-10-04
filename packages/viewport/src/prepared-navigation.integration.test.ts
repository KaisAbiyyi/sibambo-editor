import { describe, expect, test } from 'bun:test';
import { Vector3 } from 'three';
import { nearestGroundBoundsAnchor, orbitCameraDrag, perspectiveDollyStep, type CameraDragSnapshot, type CameraPose } from './camera-navigation.js';

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } };

function clonePose(pose: CameraPose): CameraPose {
	return { position: pose.position.clone(), target: pose.target.clone() };
}

describe('prepared navigation camera integration contract', () => {
	test('acquiring the near boundary never changes the current view and drag remains tied to its start snapshot', () => {
		const live: CameraPose = { position: new Vector3(-5, 2, 5), target: new Vector3(5, 2, 5) };
		const snapshot: CameraDragSnapshot = {
			pose: clonePose(live),
			orbitAnchor: nearestGroundBoundsAnchor(live, bounds)!,
			sceneEpoch: 7
		};
		expect(live.position.toArray()).toEqual([-5, 2, 5]);
		expect(live.target.toArray()).toEqual([5, 2, 5]);
		expect(snapshot.orbitAnchor.toArray()).toEqual([0, 0, 5]);
		const zeroDelta = orbitCameraDrag(snapshot.pose, 0, 0, undefined, snapshot.orbitAnchor);
		expect(zeroDelta.position.distanceTo(live.position)).toBeLessThan(1e-10);
		expect(zeroDelta.target.distanceTo(live.target)).toBeLessThan(1e-10);

		const accumulated = orbitCameraDrag(snapshot.pose, 24, -11, undefined, snapshot.orbitAnchor);
		const sameStartNextFrame = orbitCameraDrag(snapshot.pose, 48, -22, undefined, snapshot.orbitAnchor);
		expect(accumulated.position.distanceTo(snapshot.orbitAnchor)).toBeCloseTo(snapshot.pose.position.distanceTo(snapshot.orbitAnchor), 10);
		expect(accumulated.target.distanceTo(accumulated.position)).toBeCloseTo(snapshot.pose.target.distanceTo(snapshot.pose.position), 10);
		expect(sameStartNextFrame.position.distanceTo(snapshot.orbitAnchor)).toBeCloseTo(snapshot.pose.position.distanceTo(snapshot.orbitAnchor), 10);
		expect(snapshot.pose.position.toArray()).toEqual([-5, 2, 5]);
	});

	test('pointer-ray dolly keeps the viewing vector fixed while reacquired hit depth feeds the next step', () => {
		const camera = new Vector3(-5, 1.6, 5);
		const target = new Vector3(10, 1.6, 5);
		const viewingVector = target.clone().sub(camera);
		const first = perspectiveDollyStep(5, 10, -100, undefined, 1000)!;
		const ray = new Vector3(1, 0, 0).normalize();
		const travel = ray.multiplyScalar(first.step);
		camera.add(travel);
		target.add(travel);
		expect(target.clone().sub(camera).distanceTo(viewingVector)).toBeLessThan(1e-10);
		const interiorDistance = 10 - camera.x;
		const next = perspectiveDollyStep(interiorDistance, 10, -100, first.state, 1050)!;
		expect(next.step).toBeLessThanOrEqual(Math.max(first.step * 1.5, 0.005));
		expect(camera.x + next.step).toBeGreaterThan(camera.x);
		expect(camera.x).toBeGreaterThan(-5);
	});
});
