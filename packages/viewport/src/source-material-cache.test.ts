import { describe, expect, test } from 'bun:test';
import { Color, SRGBColorSpace, Texture } from 'three';
import { RuntimeMaterialCache } from './source-material-cache';

describe('source material cache integration', () => {
	test('keeps descriptor colors and textures when group overrides are undefined', () => {
		const texture = new Texture();
		texture.name = 'assets/brick.png';
		let onSettled: ((result: { path: string; ok: boolean }) => void) | undefined;
		const resolver = {
			getTexture: () => texture,
			onTextureSettled: (listener: (result: { path: string; ok: boolean }) => void) => {
				onSettled = listener;
				return () => {};
			}
		};
		const cache = new RuntimeMaterialCache([{
			index: 0, id: 'descriptor-brick', name: 'Brick', baseColorRgba: [0.2, 0.4, 0.6, 0.8],
			opacity: 0.5, colorSpace: 'srgb', textureAsset: 'assets/brick.png'
		}], resolver);

		const material = cache.get(0, 'double', {
			index: 0, id: 'group-brick', name: undefined, baseColor: undefined, baseColorRgba: undefined,
			opacity: undefined, colorSpace: undefined, textureAsset: undefined
		});
		expect(material.map).toBe(texture);
		expect(material.name).toBe('Brick');
		expect(material.opacity).toBeCloseTo(0.4);
		expect(material.color.getHexString()).toBe('ffffff');

		onSettled?.({ path: 'assets/brick.png', ok: false });
		const expected = new Color().setRGB(0.2, 0.4, 0.6, SRGBColorSpace);
		expect(material.map).toBeNull();
		expect(material.color.getHexString()).toBe(expected.getHexString());
		cache.dispose();
		texture.dispose();
	});

	test('renders historical group baseColor when no material descriptor exists', () => {
		const resolver = { getTexture: () => null, onTextureSettled: () => () => {} };
		const cache = new RuntimeMaterialCache([], resolver);
		const material = cache.get(undefined, 'double', { index: -1, id: 'historical-face', baseColor: '#336699' });
		expect(material.color.getHexString()).toBe(new Color('#336699').getHexString());
		cache.dispose();
	});
});
