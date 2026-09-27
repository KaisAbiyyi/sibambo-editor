import { Camera, Raycaster, Vector2, Vector3 } from 'three';

export type PushPullSolveParams = {
	anchorPoint: Vector3;
	faceNormal: Vector3;
	raycaster: Raycaster;
	camera: Camera;
	canvasWidth: number;
	canvasHeight: number;
	pointerPx: Vector2;
	startPointerPx: Vector2;
};

export type PushPullSolveResult = {
	distance: number;
	label: string;
	isDegenerate: boolean;
	extrusionAxisLine: {
		start: Vector3;
		end: Vector3;
		anchor: Vector3;
		normal: Vector3;
	};
};

export const EXTRUSION_EPSILON = 0.001; // 1 mm

export class PushPullSolver {
	solve(params: PushPullSolveParams): PushPullSolveResult | null {
		const {
			anchorPoint,
			faceNormal,
			raycaster,
			camera,
			canvasWidth,
			canvasHeight,
			pointerPx,
			startPointerPx
		} = params;

		if (
			!faceNormal ||
			!Number.isFinite(faceNormal.x) ||
			!Number.isFinite(faceNormal.y) ||
			!Number.isFinite(faceNormal.z)
		) {
			return null;
		}

		const normal = faceNormal.clone().normalize();
		if (normal.lengthSq() < 1e-6) return null;

		const anchor = anchorPoint.clone();

		const O = raycaster.ray.origin.clone();
		const D = raycaster.ray.direction.clone().normalize();

		const k = normal.dot(D);
		const sinSq = 1 - k * k;

		let rawDistance = 0;
		let isDegenerate = false;

		// Primary 3D solver: if sinSq >= 0.01 (~5.7° away from parallel)
		if (sinSq >= 0.01) {
			const V = anchor.clone().sub(O); // V = A - O
			// t = V . (k * D - N) / (1 - k^2)
			const numerator = V.dot(D.clone().multiplyScalar(k).sub(normal));
			rawDistance = numerator / sinSq;
		} else {
			// Degenerate camera alignment fallback
			isDegenerate = true;

			const pA = projectToScreen(anchor, camera, canvasWidth, canvasHeight);
			const pAN = projectToScreen(anchor.clone().add(normal), camera, canvasWidth, canvasHeight);

			const screenDir = pAN.clone().sub(pA);
			let screenNormalDir = screenDir.clone();
			if (screenNormalDir.lengthSq() < 1e-6) {
				screenNormalDir.set(0, -1);
			} else {
				screenNormalDir.normalize();
			}

			const deltaPx = pointerPx.clone().sub(startPointerPx);
			const signedPixelMotion = deltaPx.dot(screenNormalDir);

			const worldUnitsPerPx = getWorldUnitsPerPixel(anchor, camera, canvasHeight);
			rawDistance = signedPixelMotion * worldUnitsPerPx;
		}

		const distance = Math.abs(rawDistance) < EXTRUSION_EPSILON ? 0 : rawDistance;

		let label = '0.000 m';
		if (distance > 0) {
			label = `+${distance.toFixed(3)} m`;
		} else if (distance < 0) {
			label = `${distance.toFixed(3)} m`;
		}

		const axisLen = Math.max(Math.abs(distance) + 1.5, 2.5);
		const start = anchor.clone().add(normal.clone().multiplyScalar(-axisLen));
		const end = anchor.clone().add(normal.clone().multiplyScalar(axisLen));

		return {
			distance,
			label,
			isDegenerate,
			extrusionAxisLine: {
				start,
				end,
				anchor,
				normal
			}
		};
	}
}

export function projectToScreen(point: Vector3, camera: Camera, width: number, height: number): Vector2 {
	const p = point.clone().project(camera);
	return new Vector2(((p.x + 1) / 2) * width, ((-p.y + 1) / 2) * height);
}

export function getWorldUnitsPerPixel(worldPoint: Vector3, camera: Camera, canvasHeight: number): number {
	if ('isPerspectiveCamera' in camera && (camera as any).isPerspectiveCamera) {
		const persp = camera as any;
		const camPos = camera.position;
		const camDir = new Vector3();
		camera.getWorldDirection(camDir);
		const dist = Math.abs(worldPoint.clone().sub(camPos).dot(camDir));
		const fovRad = (persp.fov * Math.PI) / 180;
		return (2 * Math.max(dist, 0.1) * Math.tan(fovRad / 2)) / Math.max(canvasHeight, 1);
	} else if ('isOrthographicCamera' in camera && (camera as any).isOrthographicCamera) {
		const ortho = camera as any;
		return Math.abs(ortho.top - ortho.bottom) / Math.max(canvasHeight, 1);
	}
	return 0.005;
}
