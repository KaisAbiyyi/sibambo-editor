import { describe, expect, test } from 'bun:test';
import { PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { SnapManager } from '../../../src/lib/editor/snapping/SnapManager';

describe('SnapManager', () => {
	const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
	camera.position.set(0, 0, 10);
	camera.lookAt(0, 0, 0);
	camera.updateMatrixWorld(true);
	camera.updateProjectionMatrix();

	const canvasWidth = 1000;
	const canvasHeight = 1000;

	test('derives stable U/V plane basis for horizontal and vertical planes', () => {
		const snapManager = new SnapManager();
		
		// Ground plane (Z up)
		const groundBasis = snapManager.getPlaneBasis(new Vector3(0, 0, 1));
		expect(groundBasis.normal.z).toBeCloseTo(1);
		expect(groundBasis.u.x).toBeCloseTo(1);
		expect(groundBasis.v.y).toBeCloseTo(1);

		// Vertical wall plane (X normal)
		const wallBasis = snapManager.getPlaneBasis(new Vector3(1, 0, 0));
		expect(wallBasis.normal.x).toBeCloseTo(1);
		expect(wallBasis.u.y).toBeCloseTo(1);
		expect(wallBasis.v.z).toBeCloseTo(1);
	});

	test('snaps to endpoint within screen tolerance', () => {
		const snapManager = new SnapManager();
		const activePlane = snapManager.getPlaneBasis(new Vector3(0, 0, 1));

		// Ray pointing directly at (1, 1, 0)
		const raycaster = new Raycaster();
		// Screen coords for (1, 1, 0) when camera is at (0, 0, 10)
		const p1 = new Vector3(1, 1, 0).project(camera);
		const pointerPx = new Vector2(((p1.x + 1) / 2) * canvasWidth, ((-p1.y + 1) / 2) * canvasHeight);

		raycaster.setFromCamera(new Vector2(p1.x, p1.y), camera);

		const result = snapManager.resolveSnap({
			raycaster,
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx,
			activePlane,
			editableShapes: [{
				id: 's1',
				kind: 'face',
				shape: 'derived',
				plane: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
				outer: [[1, 1, 0], [3, 1, 0], [3, 3, 0]],
				holes: [],
				color: '#ffffff'
			}]
		});

		expect(result).not.toBeNull();
		expect(result?.kind).toBe('endpoint');
		expect(result?.label).toBe('Endpoint');
		expect(result?.point.x).toBeCloseTo(1);
		expect(result?.point.y).toBeCloseTo(1);
	});

	test('snaps to midpoint of an edge', () => {
		const snapManager = new SnapManager();
		const activePlane = snapManager.getPlaneBasis(new Vector3(0, 0, 1));

		// Edge between (0, 0, 0) and (2, 0, 0) => midpoint at (1, 0, 0)
		const midPoint = new Vector3(1, 0, 0);
		const p1 = midPoint.clone().project(camera);
		const pointerPx = new Vector2(((p1.x + 1) / 2) * canvasWidth, ((-p1.y + 1) / 2) * canvasHeight);

		const raycaster = new Raycaster();
		raycaster.setFromCamera(new Vector2(p1.x, p1.y), camera);

		const result = snapManager.resolveSnap({
			raycaster,
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx,
			activePlane,
			editableShapes: [{
				id: 's1',
				kind: 'face',
				shape: 'derived',
				plane: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
				outer: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]],
				holes: [],
				color: '#ffffff'
			}]
		});

		expect(result).not.toBeNull();
		expect(result?.kind).toBe('midpoint');
		expect(result?.label).toBe('Midpoint');
		expect(result?.point.x).toBeCloseTo(1);
		expect(result?.point.y).toBeCloseTo(0);
	});

	test('does not snap to endpoint outside screen tolerance radius', () => {
		const snapManager = new SnapManager();
		snapManager.tolerancePx = 10;
		const activePlane = snapManager.getPlaneBasis(new Vector3(0, 0, 1));

		// Endpoint at (2, 2, 0)
		const p1 = new Vector3(2, 2, 0).project(camera);
		// Pointer 50px away
		const pointerPx = new Vector2(((p1.x + 1) / 2) * canvasWidth + 50, ((-p1.y + 1) / 2) * canvasHeight + 50);

		const raycaster = new Raycaster();
		const normPointer = new Vector2(
			(pointerPx.x / canvasWidth) * 2 - 1,
			-(pointerPx.y / canvasHeight) * 2 + 1
		);
		raycaster.setFromCamera(normPointer, camera);

		const result = snapManager.resolveSnap({
			raycaster,
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx,
			activePlane,
			editableShapes: [{
				id: 's1',
				kind: 'face',
				shape: 'derived',
				plane: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
				outer: [[2, 2, 0], [4, 2, 0], [4, 4, 0]],
				holes: [],
				color: '#ffffff'
			}]
		});

		expect(result).not.toBeNull();
		expect(result?.kind).toBe('face'); // Fallback to face when candidate is outside 10px
	});

	test('supports Shift lock and Escape clearing', () => {
		const snapManager = new SnapManager();
		const activePlane = snapManager.getPlaneBasis(new Vector3(0, 0, 1));

		const refA = new Vector3(0, 0, 0);
		const lockDir = new Vector3(1, 0, 0);
		snapManager.setShiftLock(true, lockDir);

		expect(snapManager.shiftLocked).toBe(true);

		const raycaster = new Raycaster();
		raycaster.setFromCamera(new Vector2(0.2, 0.2), camera);

		const result = snapManager.resolveSnap({
			raycaster,
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx: new Vector2(600, 400),
			activePlane,
			referencePointA: refA
		});

		expect(result?.kind).toBe('axis');
		expect(result?.label).toBe('Constrained');
		expect(result?.point.y).toBeCloseTo(0); // Constrained to X axis

		snapManager.clear();
		expect(snapManager.shiftLocked).toBe(false);
		expect(snapManager.lockedDirection).toBeNull();
	});
});
