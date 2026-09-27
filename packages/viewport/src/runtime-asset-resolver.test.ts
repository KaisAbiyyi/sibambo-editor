import { describe, expect, test } from 'bun:test';
import { RuntimeAssetResolver } from './runtime-asset-resolver';

describe('runtime asset ownership', () => {
	test('replacing an asset updates the unique byte total instead of double counting', () => {
		const resolver = new RuntimeAssetResolver();
		resolver.registerAsset('materials/wood.png', new Uint8Array([1, 2, 3]));
		resolver.registerAsset('materials/wood.png', new Uint8Array([4, 5, 6, 7, 8]));

		expect(resolver.getStats()).toMatchObject({ uniqueAssetCount: 1, assetBytes: 5 });
		resolver.dispose();
	});

	test('caches each texture path once and clears owned state on disposal', () => {
		const resolver = new RuntimeAssetResolver(new Map([['wall.png', new Uint8Array([1, 2, 3])]]));
		const first = resolver.getTexture('wall.png');
		const second = resolver.getTexture('wall.png');

		expect(first).not.toBeNull();
		expect(second).toBe(first);
		expect(resolver.getStats()).toMatchObject({ referencesCount: 2, cacheHits: 1, uniqueAssetCount: 1 });
		resolver.dispose();
		expect(resolver.getStats()).toMatchObject({ referencesCount: 0, uniqueAssetCount: 0, decodedTexturesCount: 0, cacheHits: 0, assetBytes: 0 });
	});
});
