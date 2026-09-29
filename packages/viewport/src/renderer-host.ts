import { OrthographicCamera, PerspectiveCamera, Scene, Vector3 } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { SceneProfile } from '@sibambo/contracts';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyNavigationShortcutToControls, cameraPresetPose, middleMouseAction, orbitControlsMouseAction, uprightCameraUp, type CameraPreset, type CameraPresetBounds } from './camera-navigation.js';
import { DEFAULT_DISPLAY_STATE, displayStateFromLegacyMode, legacyViewModeFromDisplayState, normalizeDisplayState, type DisplayState, type ViewMode } from './material-state.js';
import { addRendererSceneLighting, applyRendererColorDefaults, SIBAMBO_CAMERA_DEFAULTS } from './renderer-defaults.js';
import { createViewerRenderer, isWebGlRenderer, type RendererBackendName, type ViewerRenderer } from './renderer-backend.js';
import { renderProfilePolicy, resolveRenderProfile } from './render-profile.js';

export type ViewportCamera = PerspectiveCamera | OrthographicCamera;

export type ViewportRendererHostOptions = {
	search?: string;
	darkMode?: boolean;
	maxPixelRatio?: number;
	initialCameraPosition?: [number, number, number];
	/** Disable built-in OrbitControls when a compatibility adapter owns input. */
	navigationEnabled?: boolean;
};

/** Shared renderer, scene, camera, navigation, mode, capture and frame owner. */
export class ViewportRendererHost {
	readonly scene = new Scene();
	readonly renderer: ViewerRenderer;
	readonly canvas: HTMLCanvasElement;
	readonly backend: RendererBackendName;
	readonly initializationMs: number;
	readonly fallbackReason?: string;
	readonly pixelRatio: number;
	camera: ViewportCamera;
	readonly controls: OrbitControls;
	displayState: DisplayState = normalizeDisplayState(DEFAULT_DISPLAY_STATE);
	viewMode: ViewMode = 'solid';

	private readonly resizeObserver: ResizeObserver;
	private frameHandle = 0;
	private disposed = false;
	private onResize?: (width: number, height: number) => void;
	private beforeRender?: () => boolean;
	private onFrameRendered?: (frameMs: number) => void;
	private readonly navigationEnabled: boolean;
	private composer: EffectComposer | null = null;
	private renderPass: RenderPass | null = null;
	private ssaoPass: SSAOPass | null = null;
	private outputPass: OutputPass | null = null;
	private ambientOcclusionEnabled = false;
	private clipBounds: CameraPresetBounds | null = null;
	get supportsAmbientOcclusion() { return isWebGlRenderer(this.renderer); }
	get layoutSize() { return { width: this.host.clientWidth, height: this.host.clientHeight }; }

	private constructor(
		private readonly host: HTMLElement,
		result: Awaited<ReturnType<typeof createViewerRenderer>>,
		options: ViewportRendererHostOptions
	) {
		this.renderer = result.renderer;
		this.backend = result.backend;
		this.initializationMs = result.initializationMs;
		this.fallbackReason = result.fallbackReason;
		this.navigationEnabled = options.navigationEnabled ?? true;
		const search = options.search ?? window.location.search;
		const profilePolicy = renderProfilePolicy(resolveRenderProfile(search));
		const maxPixelRatio = options.maxPixelRatio ?? profilePolicy.maxPixelRatio;
		this.pixelRatio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
		this.renderer.setPixelRatio(this.pixelRatio);
		applyRendererColorDefaults(this.renderer);
		addRendererSceneLighting(this.scene, options.darkMode ?? false);

		this.camera = new PerspectiveCamera(
			SIBAMBO_CAMERA_DEFAULTS.fov,
			1,
			SIBAMBO_CAMERA_DEFAULTS.near,
			SIBAMBO_CAMERA_DEFAULTS.far
		);
		const [x, y, z] = options.initialCameraPosition ?? [12, 9, 14];
		this.camera.position.set(x, y, z);

		this.canvas = this.renderer.domElement;
		this.canvas.setAttribute('aria-label', 'Interactive 3D model viewport');
		this.canvas.tabIndex = 0;
		this.canvas.style.display = 'block';
		this.canvas.style.width = '100%';
		this.canvas.style.height = '100%';
		this.host.replaceChildren(this.canvas);
		this.controls = this.createControls();
		this.controls.enabled = this.navigationEnabled;

		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(host);
		this.resize();
	}

	static async mount(host: HTMLElement, options: ViewportRendererHostOptions = {}): Promise<ViewportRendererHost> {
		const result = await createViewerRenderer(options.search ?? window.location.search);
		try {
			return new ViewportRendererHost(host, result, options);
		} catch (error) {
			result.renderer.dispose();
			throw error;
		}
	}

	setCamera(camera: ViewportCamera) {
		this.camera = camera;
		this.controls.object = camera;
		if (this.renderPass) this.renderPass.camera = camera;
		if (this.ssaoPass) this.ssaoPass.camera = camera;
		this.resize();
	}

	setOrbitControlsEnabled(enabled: boolean) {
		this.controls.enabled = enabled;
	}

	setViewMode(mode: ViewMode) {
		this.setDisplayState(displayStateFromLegacyMode(mode));
	}

	setDisplayState(state: DisplayState) {
		this.displayState = normalizeDisplayState(state);
		this.viewMode = legacyViewModeFromDisplayState(this.displayState);
		this.setAmbientOcclusionEnabled(this.displayState.effects.ambientOcclusion);
		this.requestRender();
	}

	setAmbientOcclusionEnabled(enabled: boolean) {
		if (enabled && this.supportsAmbientOcclusion && !this.composer) this.setupPostProcessing();
		this.ambientOcclusionEnabled = Boolean(enabled) && this.composer !== null && this.ssaoPass !== null;
		if (this.ssaoPass) this.ssaoPass.enabled = this.ambientOcclusionEnabled;
		this.requestRender();
	}

	/** Apply the shared fit policy to caller-derived bounds. */
	focusBounds(bounds: CameraPresetBounds) {
		this.clipBounds = bounds;
		const center = new Vector3(
			(bounds.min.x + bounds.max.x) / 2,
			(bounds.min.y + bounds.max.y) / 2,
			(bounds.min.z + bounds.max.z) / 2
		);
		const radius = Math.max(new Vector3(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z).length() / 2, 0.5);
		const distance = this.camera instanceof PerspectiveCamera ? radius / Math.sin(this.camera.fov * Math.PI / 360) * 1.22 : Math.max(radius * 2.4, 1);
		this.controls.target.copy(center);
		this.camera.position.copy(center).add(new Vector3(distance * 1.15, distance * 0.9, distance * 1.25));
		this.camera.up.copy(uprightCameraUp({ position: this.camera.position, target: center }));
		this.camera.lookAt(center);
		this.camera.near = Math.max(radius / 10000, 0.001);
		this.camera.far = Math.max(radius * 100, distance * 3);
		if (this.camera instanceof OrthographicCamera) {
			const height = radius * 2.4; const aspect = Math.max(1, this.host.clientWidth) / Math.max(1, this.host.clientHeight);
			this.camera.left = -height * aspect / 2; this.camera.right = height * aspect / 2; this.camera.top = height / 2; this.camera.bottom = -height / 2;
		}
		this.camera.updateProjectionMatrix();
		this.controls.update();
		this.requestRender();
	}

	updateClipRange(bounds: CameraPresetBounds) {
		this.clipBounds = bounds;
		const span = Math.max(
			bounds.max.x - bounds.min.x,
			bounds.max.y - bounds.min.y,
			bounds.max.z - bounds.min.z,
			0.001
		);
		const distance = Math.max(this.camera.position.distanceTo(this.controls.target), span * 0.0001);
		const near = Math.max(0.00005, Math.min(span * 0.0005, distance * 0.02));
		const far = Math.max(span * 40, distance + span * 8, near * 2000, 1);
		this.camera.near = near;
		this.camera.far = far;
		this.camera.updateProjectionMatrix();
		if (this.ssaoPass) {
			this.ssaoPass.minDistance = Math.max(span * 0.00008, 0.00001);
			this.ssaoPass.maxDistance = Math.max(span * 0.018, this.ssaoPass.minDistance * 10);
			this.ssaoPass.kernelRadius = Math.max(3, Math.min(24, 6 + Math.log10(span + 1) * 4));
		}
		this.requestRender();
	}

	view(bounds: CameraPresetBounds, name: CameraPreset) {
		const { position, target } = cameraPresetPose(bounds, name);
		this.camera.position.copy(position);
		this.controls.target.copy(target);
		this.camera.up.copy(uprightCameraUp({ position, target }));
		this.camera.lookAt(target);
		this.controls.update();
		this.updateClipRange(bounds);
		this.requestRender();
	}

	/** Applies a native scene camera while retaining the shared control target. */
	applySceneCamera(scene: SceneProfile | null) {
		if (!scene?.useCamera || !scene.camera) return;
		const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight), aspect = width / height;
		const target = fromSketchUp(scene.camera.targetM);
		const eye = fromSketchUp(scene.camera.eyeM);
		if (eye.distanceTo(target) < 1e-6) eye.copy(target).add(new Vector3(0, 0, 1));
		if (scene.camera.projection === 'orthographic') {
			const heightM = Math.max(scene.camera.orthographicHeightM ?? 1, 1e-4);
			if (!(this.camera instanceof OrthographicCamera)) this.setCamera(new OrthographicCamera(-heightM * aspect / 2, heightM * aspect / 2, heightM / 2, -heightM / 2, SIBAMBO_CAMERA_DEFAULTS.near, SIBAMBO_CAMERA_DEFAULTS.far));
			const camera = this.camera as OrthographicCamera;
			camera.left = -heightM * aspect / 2; camera.right = heightM * aspect / 2; camera.top = heightM / 2; camera.bottom = -heightM / 2;
			camera.near = SIBAMBO_CAMERA_DEFAULTS.near; camera.far = Math.max(SIBAMBO_CAMERA_DEFAULTS.far, eye.distanceTo(target) * 100); camera.updateProjectionMatrix();
		} else {
			if (!(this.camera instanceof PerspectiveCamera)) this.setCamera(new PerspectiveCamera(SIBAMBO_CAMERA_DEFAULTS.fov, aspect, SIBAMBO_CAMERA_DEFAULTS.near, SIBAMBO_CAMERA_DEFAULTS.far));
			const camera = this.camera as PerspectiveCamera;
			camera.aspect = aspect;
			let fov = scene.camera.fieldOfViewDegrees ?? SIBAMBO_CAMERA_DEFAULTS.fov;
			if (scene.camera.fovIsHeight === false) {
				const horizontalRadians = fov * Math.PI / 180;
				fov = Math.atan(Math.tan(horizontalRadians / 2) / aspect) * 360 / Math.PI;
			}
			camera.fov = Math.max(1, Math.min(179, fov));
			camera.near = SIBAMBO_CAMERA_DEFAULTS.near; camera.far = Math.max(SIBAMBO_CAMERA_DEFAULTS.far, eye.distanceTo(target) * 100); camera.updateProjectionMatrix();
		}
		this.camera.position.copy(eye);
		this.camera.up.copy(uprightCameraUp({ position: eye, target }));
		this.camera.lookAt(target);
		this.controls.target.copy(target); this.controls.update();
		this.requestRender();
	}

	capturePng() {
		this.renderNow();
		return this.canvas.toDataURL('image/png');
	}

	setResizeHandler(handler?: (width: number, height: number) => void) {
		this.onResize = handler;
		this.resize();
	}

	setFrameHandlers(beforeRender?: () => boolean, onFrameRendered?: (frameMs: number) => void) {
		this.beforeRender = beforeRender;
		this.onFrameRendered = onFrameRendered;
	}

	requestRender() {
		if (this.disposed || this.frameHandle) return;
		this.frameHandle = requestAnimationFrame(this.frame);
	}

	/** Render once synchronously, such as immediately before reading the drawing buffer. */
	renderNow() {
		if (this.disposed) return;
		if (this.frameHandle) {
			cancelAnimationFrame(this.frameHandle);
			this.frameHandle = 0;
		}
		const startedAt = performance.now();
		if (this.ambientOcclusionEnabled && this.composer) this.composer.render();
		else this.renderer.render(this.scene, this.camera);
		this.onFrameRendered?.(performance.now() - startedAt);
	}

	resize() {
		if (this.disposed) return;
		const width = Math.max(this.host.clientWidth, 1);
		const height = Math.max(this.host.clientHeight, 1);
		this.renderer.setSize(width, height, false);
		this.composer?.setSize(width, height);
		if (this.camera instanceof PerspectiveCamera) {
			this.camera.aspect = width / height;
		} else {
			const frustumHeight = this.camera.top - this.camera.bottom;
			this.camera.left = -frustumHeight * width / height / 2;
			this.camera.right = frustumHeight * width / height / 2;
		}
		this.camera.updateProjectionMatrix();
		this.onResize?.(width, height);
		this.requestRender();
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.canvas.removeEventListener('pointerdown', this.handlePointerDownCapture, true);
		this.canvas.removeEventListener('pointerup', this.restoreMiddleMouseMapping);
		this.canvas.removeEventListener('pointercancel', this.restoreMiddleMouseMapping);
		window.removeEventListener('keydown', this.handleNavigationKeyDown);
		this.controls.dispose();
		this.ssaoPass?.dispose();
		this.outputPass?.dispose();
		this.composer?.dispose();
		this.ssaoPass = null; this.outputPass = null; this.renderPass = null; this.composer = null;
		if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
		this.frameHandle = 0;
		this.resizeObserver.disconnect();
		this.renderer.dispose();
		this.canvas.remove();
	}

	private frame = () => {
		this.frameHandle = 0;
		const controlsChanged = this.controls.enabled && this.controls.enableDamping ? this.controls.update() : false;
		const continueRendering = (this.beforeRender?.() ?? false) || controlsChanged;
		this.renderNow();
		if (continueRendering) this.requestRender();
	};

	private setupPostProcessing() {
		if (!isWebGlRenderer(this.renderer)) return;
		this.composer = new EffectComposer(this.renderer);
		this.composer.setPixelRatio(this.pixelRatio);
		this.renderPass = new RenderPass(this.scene, this.camera);
		const size = this.layoutSize;
		this.ssaoPass = new SSAOPass(this.scene, this.camera, Math.max(size.width, 1), Math.max(size.height, 1), 16);
		this.ssaoPass.enabled = false;
		this.ssaoPass.kernelRadius = 8;
		this.outputPass = new OutputPass();
		this.composer.addPass(this.renderPass);
		this.composer.addPass(this.ssaoPass);
		this.composer.addPass(this.outputPass);
	}

	private createControls() {
		const controls = new OrbitControls(this.camera, this.canvas);
		controls.enableDamping = false;
		controls.minDistance = 0;
		controls.maxDistance = Infinity;
		controls.minZoom = 1e-8;
		controls.maxZoom = 1e8;
		controls.zoomToCursor = true;
		controls.mouseButtons.MIDDLE = middleMouseAction();
		controls.mouseButtons.LEFT = orbitControlsMouseAction('orbit');
		controls.target.set(0, 0, 0);
		controls.addEventListener('change', () => {
			if (this.clipBounds) this.updateClipRange(this.clipBounds);
			else this.requestRender();
		});
		this.canvas.addEventListener('pointerdown', this.handlePointerDownCapture, true);
		this.canvas.addEventListener('pointerup', this.restoreMiddleMouseMapping);
		this.canvas.addEventListener('pointercancel', this.restoreMiddleMouseMapping);
		window.addEventListener('keydown', this.handleNavigationKeyDown);
		return controls;
	}

	private handlePointerDownCapture = (event: PointerEvent) => {
		if (event.button === 1) this.controls.mouseButtons.MIDDLE = middleMouseAction();
	};
	private restoreMiddleMouseMapping = () => { this.controls.mouseButtons.MIDDLE = middleMouseAction(); };
	private handleNavigationKeyDown = (event: KeyboardEvent) => {
		const target = event.target as HTMLElement | null;
		const canHandle = !target?.closest('input, textarea, select, [contenteditable="true"]')
			&& (document.activeElement === this.canvas || this.host.contains(target));
		applyNavigationShortcutToControls(event, this.controls, canHandle);
	};
}

function fromSketchUp(value: [number, number, number]) { return new Vector3(value[0], value[2], -value[1]); }
