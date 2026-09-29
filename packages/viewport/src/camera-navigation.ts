import { Camera, MOUSE, OrthographicCamera, PerspectiveCamera, Spherical, Vector3 } from 'three';

export type CameraPose = { position: Vector3; target: Vector3 };
export type CameraPreset = 'top' | 'front' | 'iso';
export type CameraPresetBounds = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
export type NavigationTool = 'pan' | 'orbit';
export type CameraNavigationAction = NavigationTool | null;

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

export function orbitCameraDrag(start: CameraPose, deltaX: number, deltaY: number, radiansPerPixel = 0.006): CameraPose {
	const offset = start.position.clone().sub(start.target);
	const spherical = new Spherical().setFromVector3(offset);
	spherical.theta -= deltaX * radiansPerPixel;
	spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, spherical.phi - deltaY * radiansPerPixel));
	return { position: start.target.clone().add(new Vector3().setFromSpherical(spherical)), target: start.target.clone() };
}
export function panCameraDrag(camera: Camera, start: CameraPose, deltaX: number, deltaY: number, viewportHeight: number): CameraPose {
	const direction = start.target.clone().sub(start.position).normalize();
	const right = new Vector3().crossVectors(direction, camera.up).normalize();
	const up = new Vector3().crossVectors(right, direction).normalize();
	// Pan is defined in screen pixels at the orbit-anchor depth. This makes a
	// 1 px pointer drag move the model by 1 px on screen instead of applying an
	// arbitrary world-space sensitivity. Camera and anchor translate identically.
	const verticalSpan = camera instanceof PerspectiveCamera
		? 2 * Math.tan(camera.getEffectiveFOV() * Math.PI / 360) * start.position.distanceTo(start.target)
		: camera instanceof OrthographicCamera ? Math.abs(camera.top - camera.bottom) / Math.max(camera.zoom, 0.0001) : 2;
	const worldPerPixel = verticalSpan / Math.max(viewportHeight, 1);
	const translation = right.multiplyScalar(-deltaX * worldPerPixel).add(up.multiplyScalar(deltaY * worldPerPixel));
	return { position: start.position.clone().add(translation), target: start.target.clone().add(translation) };
}

