import { expect, test } from 'bun:test';
import { Texture } from 'three';
import { RuntimeMaterialCache, type RuntimeTextureResolver, type SourceMaterialDescriptor } from './source-material-cache';

test('semantic texture map uses a white multiplier, keeps opacity, and disposes its listener/materials', () => {
	const path = 'bomc/textures/semantic-verified-1x1.png';
	const texture = new Texture();
	let available = false;
	let settled: ((event: { path: string; ok: boolean }) => void) | undefined;
	let unsubscribed = false;
	const resolver: RuntimeTextureResolver = {
		getTexture: (assetPath) => assetPath === path && available ? texture : null,
		onTextureSettled: (listener) => {
			settled = listener;
			return () => { unsubscribed = true; settled = undefined; };
		}
	};
	const descriptor: SourceMaterialDescriptor = {
		index: 0, id: 'semantic-material', name: 'Semantic material', baseColorRgba: [0.7, 0.25, 0.1, 0.4],
		opacity: 0.5, colorSpace: 'srgb', textureAsset: path
	};
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		const cache = new RuntimeMaterialCache([descriptor], resolver);
		const material = cache.get(0, 'front');
		let disposed = 0;
		material.addEventListener('dispose', () => { disposed += 1; });
		expect(material.map).toBeNull();
		available = true;
		settled?.({ path, ok: true });
		expect(material.map).toBe(texture);
		expect(material.color.getHexString()).toBe('ffffff');
		expect(material.opacity).toBe(0.2);
		expect(material.transparent).toBe(true);
		cache.dispose();
		expect(unsubscribed).toBe(true);
		expect(disposed).toBe(1);
	} finally {
		console.warn = originalWarn;
		texture.dispose();
	}
});
