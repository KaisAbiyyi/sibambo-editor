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

	test('uses the established background and light positions and intensities', () => {
		const scene = new Scene();
		expect(addRendererSceneLighting(scene)).toBe('#F2F3F5');
		expect((scene.background as Color).getHexString()).toBe('f2f3f5');
		const ambient = scene.children.find((child) => child instanceof AmbientLight) as AmbientLight;
		const directional = scene.children.filter((child) => child instanceof DirectionalLight) as DirectionalLight[];
		expect(ambient.intensity).toBe(2.2);
		expect(directional.map((light) => [light.intensity, light.position.toArray()])).toEqual([
			[2.4, [10, 14, 8]], [1.2, [-8, 6, -10]]
		]);
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
