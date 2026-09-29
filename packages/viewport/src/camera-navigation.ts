import { Camera, MOUSE, OrthographicCamera, PerspectiveCamera, Spherical, Vector3 } from 'three';

export type CameraPose = { position: Vector3; target: Vector3 };
export type CameraPreset = 'top' | 'front' | 'iso';
export type CameraPresetBounds = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
export type NavigationTool = 'pan' | 'orbit';
export type CameraNavigationAction = NavigationTool | null;

const GROUND_Y = 0;
const ANCHOR_EPSILON = 1e-7;
export const ORBIT_RADIANS_PER_PIXEL = 0.003;

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

export function orbitCameraDrag(start: CameraPose, deltaX: number, deltaY: number, radiansPerPixel = ORBIT_RADIANS_PER_PIXEL): CameraPose {
	const grounded = groundedCameraPose(start);
	const offset = grounded.position.clone().sub(grounded.target);
	const spherical = new Spherical().setFromVector3(offset);
	// Angular sensitivity is intentionally independent of camera-anchor distance.
	// Zoom changes framing, not degrees-per-pointer-pixel.
	spherical.theta -= deltaX * radiansPerPixel;
	spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, spherical.phi - deltaY * radiansPerPixel));
	return { position: grounded.target.clone().add(new Vector3().setFromSpherical(spherical)), target: grounded.target.clone() };
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

