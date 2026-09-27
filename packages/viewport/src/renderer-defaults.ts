import { ACESFilmicToneMapping, AmbientLight, Color, DirectionalLight, SRGBColorSpace, type Scene } from 'three';

/** Rendering setup retained from the established Sibambo model viewport. */
export const SIBAMBO_CAMERA_DEFAULTS = { fov: 42, near: 0.05, far: 2000 } as const;

export function applyRendererColorDefaults(renderer: { outputColorSpace: string; toneMapping: number; toneMappingExposure: number }) {
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1;
}

export function addRendererSceneLighting(scene: Scene, darkMode = false) {
	const background = darkMode ? '#20242A' : '#F2F3F5';
	scene.background = new Color(background);
	scene.add(new AmbientLight('#f8fbff', 2.2));
	const key = new DirectionalLight('#fff2df', 2.4);
	key.position.set(10, 14, 8);
	scene.add(key);
	const fill = new DirectionalLight('#8fc7d8', 1.2);
	fill.position.set(-8, 6, -10);
	scene.add(fill);
	return background;
}
