import { afterEach, describe, expect, test } from 'bun:test';
import { AmbientLight, Color, DirectionalLight, Scene, SRGBColorSpace, ACESFilmicToneMapping } from 'three';
import { addRendererSceneLighting, applyRendererColorDefaults, SIBAMBO_CAMERA_DEFAULTS } from './renderer-defaults';
import { createFallbackTextMaterial } from './fallback-text';

const originalDocument = globalThis.document;

describe('shared viewport rendering defaults', () => {
	test('matches the established camera and renderer color pipeline', () => {
		const renderer = { outputColorSpace: '', toneMapping: 0, toneMappingExposure: 0 };
		applyRendererColorDefaults(renderer);
		expect(SIBAMBO_CAMERA_DEFAULTS).toEqual({ fov: 42, near: 0.05, far: 2000 });
		expect(renderer).toEqual({ outputColorSpace: SRGBColorSpace, toneMapping: ACESFilmicToneMapping, toneMappingExposure: 1 });
	});

	test('matches the legacy light and background defaults in both color modes', () => {
		for (const [darkMode, background] of [[false, '#F2F3F5'], [true, '#20242A']] as const) {
			const scene = new Scene();
			expect(addRendererSceneLighting(scene, darkMode)).toBe(background);
			expect((scene.background as Color).getHexString()).toBe(background.slice(1).toLowerCase());
			const ambient = scene.children.find((child) => child instanceof AmbientLight) as AmbientLight;
			const directional = scene.children.filter((child) => child instanceof DirectionalLight) as DirectionalLight[];
			expect([ambient.color.getHexString(), ambient.intensity]).toEqual(['f8fbff', 2.2]);
			expect(directional.map((light) => [light.color.getHexString(), light.intensity, light.position.toArray()])).toEqual([
				['fff2df', 2.4, [10, 14, 8]], ['8fc7d8', 1.2, [-8, 6, -10]]
			]);
		}
	});

	test('renders fallback labels into a disposable glyph texture', () => {
		let drawn = '';
		const context = {
			clearRect() {}, fillRect() {}, fillText(text: string) { drawn = text; },
			fillStyle: '', textAlign: '', textBaseline: '', font: ''
		};
		const canvas = { width: 0, height: 0, getContext: () => context };
		Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
		const { material, texture } = createFallbackTextMaterial('Room label');
		expect(drawn).toBe('Room label');
		expect(material.map).toBe(texture);
		expect(texture?.colorSpace).toBe(SRGBColorSpace);
		material.dispose(); texture?.dispose();
	});
});

afterEach(() => {
	if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
	else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
});
