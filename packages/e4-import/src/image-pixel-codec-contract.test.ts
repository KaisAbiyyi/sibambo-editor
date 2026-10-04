import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { hydrateSemanticMaterials } from './bomc-loader';
import type { ImagePixelCodec } from './image-pixel-codec';

type Material = Parameters<typeof hydrateSemanticMaterials>[0][number];
type Texture = Parameters<typeof hydrateSemanticMaterials>[1][number];
const SOURCE_RGBA = Uint8Array.from([115, 137, 98, 255]);
const OUTPUT_RGBA = Uint8Array.from([147, 156, 158, 255]);
const OUTPUT_HASH = createHash('sha256').update(OUTPUT_RGBA).digest('hex');
const REGRESSION_DELTAS: [number, number, number] = [92.58741048890613, 0.13725490868091583, -0.11229892646129502];

function semanticMaterial(texture: number, outputHash = OUTPUT_HASH, mode: 1 | 2 = 1): Material {
	return {
		name: `material-${texture}`, displayName: `material-${texture}`, rgba: [180, 160, 140, 255], opacity: 1,
		texture, textureWidthM: 1, textureHeightM: 1,
		semantic: { materialType: 2, colorizeMode: mode, deltas: REGRESSION_DELTAS, outputRgbaSha256: outputHash }
	};
}

function sourceTexture(index: number, patch: Partial<Texture> = {}): Texture {
	return {
		media: 1, sourceMedia: 1, encodedHashVerified: true, width: 1, height: 1,
		hash: `source-${index}`, bytes: Uint8Array.of(index, 41, 42), assetPath: `bomc/textures/source-${index}.png`, payloadByteLength: 3,
		...patch
	};
}

function makeCodec(options: { failEncode?: boolean; onDecode?: () => void; onEncode?: () => void } = {}) {
	const decodeCalls: number[] = [];
	const encodedFrames: Uint8Array[] = [];
	const codec: ImagePixelCodec = {
		async decode(source) {
			decodeCalls.push(source.bytes[0]);
			options.onDecode?.();
			return { width: source.width, height: source.height, data: new Uint8ClampedArray(SOURCE_RGBA) };
		},
		async encodePng(frame) {
			encodedFrames.push(new Uint8Array(frame.data));
			options.onEncode?.();
			if (options.failEncode) throw new Error('mock encode failure');
			return Uint8Array.of(0x89, 0x50, 0x4e, 0x47, encodedFrames.length);
		}
	};
	return { codec, decodeCalls, encodedFrames };
}

describe('semantic image codec and loader contract', () => {
	test('decodes source textures and materials in stable order; hashes before asset deduplication', async () => {
		const { codec, decodeCalls, encodedFrames } = makeCodec();
		const textures = [sourceTexture(0), sourceTexture(1)];
		const sourceCopies = textures.map((texture) => texture.bytes.slice());
		const materials = [semanticMaterial(1), semanticMaterial(0), semanticMaterial(1)];
		const verified: number[] = [];
		const result = await hydrateSemanticMaterials(materials, textures, {
			codec,
			onMaterialVerified: (proof) => verified.push(proof.materialIndex)
		});

		expect(decodeCalls).toEqual([0, 1]);
		expect(verified).toEqual([1, 0, 2]);
		expect(result.diagnostics.materialProofs.map((proof) => proof.materialIndex)).toEqual([1, 0, 2]);
		expect(result.diagnostics.materialProofs.map((proof) => proof.reusedAsset)).toEqual([false, true, true]);
		expect(encodedFrames).toHaveLength(1);
		expect(result.assets).toHaveLength(1);
		expect(result.diagnostics).toMatchObject({ activeCount: 3, verifiedCount: 3, generatedAssetCount: 1, baseDecodeCount: 2, maxLiveBaseFrames: 1, maxLiveOutputFrames: 1, maxMemoEntries: 1 });
		expect(materials.map((material) => material.renderTextureAsset)).toEqual(Array(3).fill(result.assets[0].path));
		expect(textures.map((texture) => texture.bytes)).toEqual(sourceCopies);
		expect(result.assets[0].path).toBe(`bomc/textures/semantic-${OUTPUT_HASH}-1x1.png`);
	});

	test('does not commit any render overrides when a later material hash fails', async () => {
		const { codec, encodedFrames } = makeCodec();
		const materials = [semanticMaterial(0), semanticMaterial(0, 'f'.repeat(64))];
		const verified: number[] = [];
		await expect(hydrateSemanticMaterials(materials, [sourceTexture(0)], {
			codec,
			onMaterialVerified: (proof) => verified.push(proof.materialIndex)
		})).rejects.toThrow(`material 1 texture 0: RGBA hash mismatch; expected ${'f'.repeat(64)}, actual ${OUTPUT_HASH}`);
		expect(encodedFrames).toHaveLength(1);
		expect(verified).toEqual([0]);
		expect(materials.every((material) => material.renderTextureAsset === undefined)).toBe(true);
	});

	test('does not encode a row whose independently checked hash mismatches', async () => {
		const { codec, encodedFrames } = makeCodec();
		await expect(hydrateSemanticMaterials([semanticMaterial(0, 'e'.repeat(64))], [sourceTexture(0)], { codec })).rejects.toThrow('RGBA hash mismatch');
		expect(encodedFrames).toHaveLength(0);
	});

	test.each([4, 5, 6])('rejects active source media %i before starting a codec job', async (sourceMedia) => {
		const { codec, decodeCalls } = makeCodec();
		await expect(hydrateSemanticMaterials([semanticMaterial(0)], [sourceTexture(0, { sourceMedia })], { codec })).rejects.toThrow(`source media ${sourceMedia} is unsupported`);
		expect(decodeCalls).toEqual([]);
	});

	test('rejects invalid references, unverified source bytes, unsafe dimensions and unavailable crypto before decoding', async () => {
		const { codec, decodeCalls } = makeCodec();
		await expect(hydrateSemanticMaterials([semanticMaterial(2)], [sourceTexture(0)], { codec })).rejects.toThrow('outside the source texture table');
		await expect(hydrateSemanticMaterials([semanticMaterial(0)], [sourceTexture(0, { encodedHashVerified: false })], { codec })).rejects.toThrow('encoded source hash was not verified');
		await expect(hydrateSemanticMaterials([semanticMaterial(0)], [sourceTexture(0, { width: 0 })], { codec })).rejects.toThrow('dimensions or RGBA byte length are invalid');
		expect(decodeCalls).toEqual([]);

		const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
		try {
			Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
			await expect(hydrateSemanticMaterials([semanticMaterial(0)], [sourceTexture(0)], { codec })).rejects.toThrow('SHA-256 is unavailable');
		} finally {
			if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
			else Reflect.deleteProperty(globalThis, 'crypto');
		}
	});

	test('checks cancellation after decode and encode awaits before observer or override commit', async () => {
		let cancelled = false;
		const decodeStub = makeCodec({ onDecode: () => { cancelled = true; } });
		const decodedMaterial = semanticMaterial(0);
		await expect(hydrateSemanticMaterials([decodedMaterial], [sourceTexture(0)], { codec: decodeStub.codec, isCancelled: () => cancelled })).rejects.toThrow('BOMC load cancelled');
		expect(decodeStub.encodedFrames).toHaveLength(0);
		expect(decodedMaterial.renderTextureAsset).toBeUndefined();

		const encodeStub = makeCodec();
		let checks = 0;
		const encodedMaterial = semanticMaterial(0);
		await expect(hydrateSemanticMaterials([encodedMaterial], [sourceTexture(0)], { codec: encodeStub.codec, isCancelled: () => ++checks === 8 })).rejects.toThrow('BOMC load cancelled');
		expect(encodeStub.encodedFrames).toHaveLength(1);
		expect(encodedMaterial.renderTextureAsset).toBeUndefined();
	});

	test('reports observer failures separately from pixel mismatches and leaves overrides uncommitted', async () => {
		const material = semanticMaterial(0);
		await expect(hydrateSemanticMaterials([material], [sourceTexture(0)], {
			codec: makeCodec().codec,
			onMaterialVerified: () => { throw new Error('observer storage failed'); }
		})).rejects.toThrow('proof observer failed');
		expect(material.renderTextureAsset).toBeUndefined();
	});

	test('returns inert diagnostics and never calls codecs for v1 or inactive-only rows', async () => {
		const { codec, decodeCalls, encodedFrames } = makeCodec();
		const legacy: Material = { ...semanticMaterial(0), semantic: undefined };
		const inactive: Material = { ...semanticMaterial(0, '0'.repeat(64), 1), semantic: { materialType: 2, colorizeMode: 0, deltas: [Number.NaN, 9, 8], outputRgbaSha256: '0'.repeat(64) } };
		const result = await hydrateSemanticMaterials([legacy, inactive], [sourceTexture(0)], { codec });
		expect(decodeCalls).toEqual([]);
		expect(encodedFrames).toEqual([]);
		expect(result.diagnostics).toMatchObject({ sectionVersion: 2, activeCount: 0, verifiedCount: 0, generatedAssetCount: 0, generatedPngBytes: 0, baseDecodeCount: 0, maxLiveBaseFrames: 0, maxLiveOutputFrames: 0, maxMemoEntries: 0, baseDecodes: [], materialProofs: [] });
	});
});
