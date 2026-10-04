import { Camera, MOUSE, OrthographicCamera, PerspectiveCamera, Quaternion, Spherical, Vector3 } from 'three';

export type CameraPose = { position: Vector3; target: Vector3 };
export type CameraDragSnapshot = { pose: CameraPose; orbitAnchor: Vector3; sceneEpoch: number };
export type CameraPreset = 'top' | 'front' | 'iso';
export type CameraPresetBounds = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
export type NavigationTool = 'pan' | 'orbit';
export type CameraNavigationAction = NavigationTool | null;
export type DollyBurstState = { direction: 1 | -1; lastTimeMs: number; lastAppliedStep: number };

const GROUND_Y = 0;
const ANCHOR_EPSILON = 1e-7;
export const ORBIT_RADIANS_PER_PIXEL = 0.003;
const WORLD_UP = new Vector3(0, 1, 0);
const TOP_VIEW_UP = new Vector3(0, 0, -1);

/**
 * Camera roll is not part of the Editor navigation model. Prefer the world-up
 * axis, with a deterministic fallback for near-vertical views where lookAt
 * would otherwise become singular.
 */
export function uprightCameraUp(pose: CameraPose): Vector3 {
	const forward = pose.target.clone().sub(pose.position);
	if (forward.lengthSq() < ANCHOR_EPSILON) return WORLD_UP.clone();
	forward.normalize();
	return Math.abs(forward.dot(WORLD_UP)) > 0.9995 ? TOP_VIEW_UP.clone() : WORLD_UP.clone();
}

/**
 * Resolve the editor orbit anchor from the camera's centre ray.
 *
 * Sibambo Editor treats Three.js Y as vertical, so the navigation anchor is the
 * point where the current forward ray meets the world ground plane (Y=0).
 * This keeps the pivot in front of the camera and prevents zoom from shrinking
 * the orbit radius toward an arbitrary picked point.
 */
export function groundPlaneAnchor(pose: CameraPose, groundY = GROUND_Y): Vector3 | null {
	const direction = pose.target.clone().sub(pose.position);
	if (direction.lengthSq() < ANCHOR_EPSILON) return null;
	direction.normalize();
	if (Math.abs(direction.y) < ANCHOR_EPSILON) return null;
	const distance = (groundY - pose.position.y) / direction.y;
	if (!Number.isFinite(distance) || distance <= ANCHOR_EPSILON) return null;
	return pose.position.clone().add(direction.multiplyScalar(distance));
}

/** Preserve the camera direction while replacing its target with the grounded centre-ray anchor. */
export function groundedCameraPose(pose: CameraPose, groundY = GROUND_Y): CameraPose {
	const anchor = groundPlaneAnchor(pose, groundY);
	return anchor ? { position: pose.position.clone(), target: anchor } : { position: pose.position.clone(), target: pose.target.clone() };
}

/**
 * Keep middle mapped to ROTATE for both modifier states. OrbitControls itself
 * interprets Shift + ROTATE as PAN; mapping Shift + middle to MOUSE.PAN would
 * make its modifier branch rotate instead.
 */
export function middleMouseAction() {
	return MOUSE.ROTATE;
}

/** Map the shared Orbit/Pan tool to OrbitControls' primary-button action. */
export function orbitControlsMouseAction(tool: NavigationTool) {
	return tool === 'pan' ? MOUSE.PAN : MOUSE.ROTATE;
}

export function resolveNavigationShortcut(key: string, code: string, modifiers = false): CameraNavigationAction {
	if (modifiers) return null;
	const normalized = key.toLowerCase();
	if (normalized === 'h' || normalized === 'p') return 'pan';
	if (normalized === 'o' || normalized === 'r' || code === 'Space') return 'orbit';
	return null;
}

/** Apply the app-neutral keyboard policy and report whether it handled this input. */
export function handleNavigationShortcut(
	event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'preventDefault'>,
	onAction: (action: NavigationTool) => void,
	canHandle = true
): boolean {
	if (!canHandle) return false;
	const action = resolveNavigationShortcut(event.key, event.code, event.ctrlKey || event.metaKey || event.altKey);
	if (!action) return false;
	event.preventDefault();
	onAction(action);
	return true;
}

/** Apply the shared H/P and orbit shortcuts to the primary OrbitControls button. */
export function applyNavigationShortcutToControls(
	event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'preventDefault'>,
	controls: { mouseButtons: { LEFT?: number | null | undefined } },
	canHandle = true
) {
	return handleNavigationShortcut(event, (tool) => {
		controls.mouseButtons.LEFT = orbitControlsMouseAction(tool);
	}, canHandle);
}

/** Resolve camera drag input consistently for pointer-driven viewport controllers. */
export function resolvePointerNavigationAction(
	activeButtons: ReadonlySet<number>,
	shiftKey: boolean,
	activeTool: NavigationTool
): CameraNavigationAction {
	const isMiddle = activeButtons.has(1);
	const isLeftAndMiddle = activeButtons.has(0) && isMiddle;
	if (isLeftAndMiddle || (isMiddle && shiftKey)) return 'pan';
	if (isMiddle) return 'orbit';
	if (activeButtons.has(0)) return activeTool;
	return null;
}

/** A deterministic, model-centred preset independent of the current camera pose. */
export function cameraPresetPose(bounds: CameraPresetBounds, name: CameraPreset): CameraPose {
	const target = new Vector3(
		(bounds.min.x + bounds.max.x) / 2,
		(bounds.min.y + bounds.max.y) / 2,
		(bounds.min.z + bounds.max.z) / 2
	);
	const span = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z, 1) * 1.6;
	const offset = name === 'top' ? new Vector3(0, 1, 0.0001) : name === 'front' ? new Vector3(0, 0, 1) : new Vector3(1, 0.72, 1);
	return { position: target.clone().add(offset.normalize().multiplyScalar(span)), target };
}

export function nearestGroundBoundsAnchor(pose: CameraPose, bounds: CameraPresetBounds): Vector3 | null {
	const values = [bounds.min.x, bounds.min.z, bounds.max.x, bounds.max.z];
	if (!values.every(Number.isFinite) || bounds.max.x < bounds.min.x || bounds.max.z < bounds.min.z) return null;
	const originX = pose.position.x;
	const originZ = pose.position.z;
	if (!Number.isFinite(originX) || !Number.isFinite(originZ)) return null;
	if (originX >= bounds.min.x && originX <= bounds.max.x && originZ >= bounds.min.z && originZ <= bounds.max.z) return null;
	const forward = pose.target.clone().sub(pose.position);
	if (!forward.toArray().every(Number.isFinite) || forward.lengthSq() < ANCHOR_EPSILON) return null;
	forward.normalize();
	const horizontalLength = Math.hypot(forward.x, forward.z);
	if (!Number.isFinite(horizontalLength) || horizontalLength <= 1e-7) return null;
	const dx = forward.x / horizontalLength;
	const dz = forward.z / horizontalLength;
	let entry = Number.NEGATIVE_INFINITY;
	let exit = Number.POSITIVE_INFINITY;
	for (const [origin, direction, minimum, maximum] of [
		[originX, dx, bounds.min.x, bounds.max.x],
		[originZ, dz, bounds.min.z, bounds.max.z]
	] as const) {
		if (direction === 0) {
			if (origin < minimum || origin > maximum) return null;
			continue;
		}
		const first = (minimum - origin) / direction;
		const second = (maximum - origin) / direction;
		entry = Math.max(entry, Math.min(first, second));
		exit = Math.min(exit, Math.max(first, second));
		if (entry > exit) return null;
	}
	if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0 || exit < entry) return null;
	const x = originX + dx * entry;
	const z = originZ + dz * entry;
	return Number.isFinite(x) && Number.isFinite(z) ? new Vector3(x, GROUND_Y, z) : null;
}

export function perspectiveDollyStep(
	depth: number,
	span: number,
	deltaPixels: number,
	previous: DollyBurstState | undefined,
	nowMs: number
): { step: number; state: DollyBurstState } | null {
	if (!Number.isFinite(depth) || depth < 0 || !Number.isFinite(span) || !Number.isFinite(deltaPixels) || deltaPixels === 0 || !Number.isFinite(nowMs)) return null;
	const normalizedSpan = span <= 0 ? 0.001 : span;
	const epsilon = Math.max(normalizedSpan * 1e-6, 1e-6);
	const magnitude = Math.max(0.08, Math.min(2.5, Math.abs(deltaPixels) / 100));
	const floor = Math.max(normalizedSpan * 0.0005, 0.0005);
	const desired = Math.max(depth * 0.18, floor) * magnitude;
	const direction: 1 | -1 = deltaPixels < 0 ? 1 : -1;
	const priorIsValid = previous !== undefined
		&& (previous.direction === 1 || previous.direction === -1)
		&& Number.isFinite(previous.lastTimeMs)
		&& Number.isFinite(previous.lastAppliedStep)
		&& previous.lastAppliedStep > 0;
	const sameBurst = priorIsValid && previous.direction === direction && nowMs >= previous.lastTimeMs && nowMs - previous.lastTimeMs <= 250;
	const maximumIncrease = priorIsValid ? Math.max(previous.lastAppliedStep * 1.5, floor * magnitude) : desired;
	const step = Math.max(epsilon, sameBurst ? Math.min(desired, maximumIncrease) : desired);
	if (!Number.isFinite(step) || step <= 0) return null;
	return { step, state: { direction, lastTimeMs: nowMs, lastAppliedStep: step } };
}

export function orbitCameraDrag(
	start: CameraPose,
	deltaX: number,
	deltaY: number,
	radiansPerPixel = ORBIT_RADIANS_PER_PIXEL,
	orbitAnchor?: Vector3
): CameraPose {
	if (orbitAnchor) {
		const forward = start.target.clone().sub(start.position).normalize();
		const yaw = new Quaternion().setFromAxisAngle(WORLD_UP, -deltaX * radiansPerPixel);
		const yawedForward = forward.clone().applyQuaternion(yaw).normalize();
		const elevation = Math.asin(Math.max(-1, Math.min(1, forward.y)));
		const nextElevation = Math.max(-Math.PI / 2 + 0.035, Math.min(Math.PI / 2 - 0.035, elevation - deltaY * radiansPerPixel));
		const startRight = new Vector3().crossVectors(forward, uprightCameraUp(start)).normalize().applyQuaternion(yaw).normalize();
		const right = new Vector3().crossVectors(yawedForward, WORLD_UP);
		if (right.lengthSq() <= 1e-12) right.copy(startRight);
		else right.normalize();
		const pitch = new Quaternion().setFromAxisAngle(right, nextElevation - elevation);
		const rotation = pitch.multiply(yaw);
		return {
			position: orbitAnchor.clone().add(start.position.clone().sub(orbitAnchor).applyQuaternion(rotation)),
			target: orbitAnchor.clone().add(start.target.clone().sub(orbitAnchor).applyQuaternion(rotation))
		};
	}
	const grounded = groundedCameraPose(start);
	const offset = grounded.position.clone().sub(grounded.target);
	const spherical = new Spherical().setFromVector3(offset);
	// Yaw and pitch both orbit the grounded anchor, but roll is never introduced.
	// Sensitivity is fixed in radians-per-pointer-pixel and therefore independent
	// of zoom distance. Clamp only the poles to prevent the camera from flipping.
	spherical.theta -= deltaX * radiansPerPixel;
	spherical.phi = Math.max(0.035, Math.min(Math.PI - 0.035, spherical.phi - deltaY * radiansPerPixel));
	return {
		position: grounded.target.clone().add(new Vector3().setFromSpherical(spherical)),
		target: grounded.target.clone()
	};
}
export function panCameraDrag(camera: Camera, start: CameraPose, deltaX: number, deltaY: number, viewportHeight: number): CameraPose {
	const grounded = groundedCameraPose(start);
	const direction = grounded.target.clone().sub(grounded.position).normalize();
	const right = new Vector3().crossVectors(direction, camera.up).normalize();
	const up = new Vector3().crossVectors(right, direction).normalize();
	// Pan is defined in screen pixels at the grounded orbit-anchor depth. One
	// pointer pixel maps to one projected pixel there, so sensitivity does not
	// change arbitrarily after zooming.
	const verticalSpan = camera instanceof PerspectiveCamera
		? 2 * Math.tan(camera.getEffectiveFOV() * Math.PI / 360) * grounded.position.distanceTo(grounded.target)
		: camera instanceof OrthographicCamera ? Math.abs(camera.top - camera.bottom) / Math.max(camera.zoom, 0.0001) : 2;
	const worldPerPixel = verticalSpan / Math.max(viewportHeight, 1);
	const translation = right.multiplyScalar(-deltaX * worldPerPixel).add(up.multiplyScalar(deltaY * worldPerPixel));
	const translated = {
		position: grounded.position.clone().add(translation),
		target: grounded.target.clone().add(translation)
	};
	// Keep the viewing direction fixed, then re-intersect the centre ray with
	// Y=0 so the next orbit starts from the same navigation model.
	return groundedCameraPose(translated);
}

