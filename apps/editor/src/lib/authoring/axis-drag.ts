import { Ray, Vector3 } from 'three';

export type AxisDragViewport = {
	rayFromScreen(clientX: number, clientY: number): Ray | null;
	projectWorldToScreen(point: readonly [number, number, number]): { x: number; y: number; inFront: boolean; visible: boolean } | null;
	worldUnitsPerPixelAt(point: readonly [number, number, number]): number | null;
};

export type AxisDragCapture = Readonly<{
	anchor: readonly [number, number, number];
	axis: readonly [number, number, number];
	startX: number;
	startY: number;
	startParameter: number;
	projectedDirection: readonly [number, number] | null;
}>;

function finiteTuple(value: readonly number[]): boolean { return value.length === 3 && value.every(Number.isFinite); }

function normalized(value: readonly [number, number, number]): Vector3 | null {
	if (!finiteTuple(value)) return null;
	const vector = new Vector3(value[0], value[1], value[2]);
	const length = vector.length();
	if (!Number.isFinite(length) || length < 1e-12) return null;
	return vector.multiplyScalar(1 / length);
}

/** Signed parameter on anchor + axis*t at the closest point to the forward ray. */
export function closestAxisParameterToRay(
	ray: Ray,
	anchorTuple: readonly [number, number, number],
	axisTuple: readonly [number, number, number]
): number | null {
	const axis = normalized(axisTuple);
	if (!axis) return null;
	const direction = ray.direction.clone().normalize();
	const anchor = new Vector3(...anchorTuple);
	const w0 = ray.origin.clone().sub(anchor);
	const b = direction.dot(axis);
	const d = direction.dot(w0);
	const e = axis.dot(w0);
	const denominator = 1 - b * b;
	if (!Number.isFinite(denominator) || denominator < 1e-8) return null;
	const rayParameter = (b * e - d) / denominator;
	if (!Number.isFinite(rayParameter) || rayParameter < 0) return null;
	const axisParameter = (e - b * d) / denominator;
	return Number.isFinite(axisParameter) ? axisParameter : null;
}

export function captureAxisDrag(
	viewport: AxisDragViewport,
	anchor: readonly [number, number, number],
	axisTuple: readonly [number, number, number],
	startX: number,
	startY: number
): AxisDragCapture | null {
	const axis = normalized(axisTuple);
	if (!axis || !finiteTuple(anchor) || !Number.isFinite(startX) || !Number.isFinite(startY)) return null;
	const startRay = viewport.rayFromScreen(startX, startY);
	if (!startRay) return null;
	const startParameter = closestAxisParameterToRay(startRay, anchor, axis.toArray() as [number, number, number]) ?? 0;
	const projectedAnchor = viewport.projectWorldToScreen(anchor);
	const projectedUnit = viewport.projectWorldToScreen([
		anchor[0] + axis.x,
		anchor[1] + axis.y,
		anchor[2] + axis.z
	]);
	let projectedDirection: readonly [number, number] | null = null;
	if (projectedAnchor?.inFront && projectedUnit?.inFront) {
		const dx = projectedUnit.x - projectedAnchor.x;
		const dy = projectedUnit.y - projectedAnchor.y;
		const length = Math.hypot(dx, dy);
		if (Number.isFinite(length) && length >= 1e-6) projectedDirection = [dx / length, dy / length];
	}
	return Object.freeze({
		anchor: Object.freeze([anchor[0], anchor[1], anchor[2]] as const),
		axis: Object.freeze(axis.toArray() as [number, number, number]),
		startX,
		startY,
		startParameter,
		projectedDirection: projectedDirection ? Object.freeze(projectedDirection) : null
	});
}

/** Camera-scaled signed world distance for the current pointer. */
export function solveAxisDrag(viewport: AxisDragViewport, capture: AxisDragCapture, clientX: number, clientY: number): number | null {
	if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
	const ray = viewport.rayFromScreen(clientX, clientY);
	if (!ray) return null;
	const solved = closestAxisParameterToRay(ray, capture.anchor, capture.axis);
	if (solved !== null) {
		const distance = solved - capture.startParameter;
		if (Number.isFinite(distance)) return distance;
	}

	const worldPerPixel = viewport.worldUnitsPerPixelAt(capture.anchor);
	if (worldPerPixel === null || !Number.isFinite(worldPerPixel) || worldPerPixel <= 0) return null;
	const dx = clientX - capture.startX;
	const dy = clientY - capture.startY;
	const signedPixels = capture.projectedDirection
		? dx * capture.projectedDirection[0] + dy * capture.projectedDirection[1]
		: Math.abs(dx) >= Math.abs(dy) ? dx : -dy;
	const distance = signedPixels * worldPerPixel;
	return Number.isFinite(distance) ? distance : null;
}
