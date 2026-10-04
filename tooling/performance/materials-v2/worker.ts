/// <reference lib="webworker" />

import { decodeMaterials, decodeModel, decodeStrings, decodeTextures, hydrateSemanticMaterials } from '../../../packages/e4-import/src/bomc-loader';
import { BomcContainer } from '../../../packages/e4-import/src/container';
import { defaultImagePixelCodec, type ImagePixelCodec, type PixelFrame } from '../../../packages/e4-import/src/image-pixel-codec';
import { digestSha256 } from '../../../packages/e4-import/src/jpeg-color-map';
import { BOMC_SECTION } from '../../../packages/e4-import/src/types';
import type { BomcSemanticMaterialDiagnostics } from '../../../packages/e4-import/src/types';

type ExpectedMaterial = {
	materialIndex: number; name: string | null; displayName: string | null; rgba: number[]; opacity: number;
	textureIndex: number | null; textureWidthM: number; textureHeightM: number; activeSemantic: boolean;
	semantic?: { materialType: number; colorizeMode: number; deltas: number[]; outputRgbaSha256: string };
};
type PngCase = {
	width: number; height: number; sourceRgba: number[][]; mode: 1 | 2; deltas: number[];
	expectedRgba: number[][]; expectedRgbaSha256: string;
};
type ProofRequest = { fixtureId: string; sha256: string; expectedMaterials: ExpectedMaterial[]; pngCase?: PngCase };
type WorkerRequest = { id: number; request: ProofRequest };

const workerScope = self as DedicatedWorkerGlobalScope;
const ALLOWED_FIXTURES = new Set(['S1-new', 'S2-new', 'I-new', 'Y-new']);
const ALLOWED_SECTIONS = new Set<number>([BOMC_SECTION.MODEL, BOMC_SECTION.STRINGS, BOMC_SECTION.MATERIALS, BOMC_SECTION.TEXTURE_TABLE, BOMC_SECTION.TEXTURE_BLOBS]);

let activeRequestId: number | null = null;
workerScope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
	const { id, request } = event.data;
	if (activeRequestId !== null) {
		workerScope.postMessage({ id, type: 'error', error: 'Texture proof worker already has an active request.' });
		return;
	}
	activeRequestId = id;
	void runRequest(id, request).then(
		(report) => workerScope.postMessage({ id, type: 'complete', report }),
		(error) => workerScope.postMessage({ id, type: 'error', error: error instanceof Error ? error.message : String(error) })
	).finally(() => { activeRequestId = null; });
});

async function runRequest(id: number, request: ProofRequest) {
	if (request.fixtureId === 'generated-png') return runGeneratedPngCase(id, request.pngCase);
	if (!ALLOWED_FIXTURES.has(request.fixtureId) || request.sha256 !== fixtureSha256(request.fixtureId) || !Array.isArray(request.expectedMaterials)) {
		throw new Error('Texture proof request does not match an allowed fixture identity.');
	}
	const stageStarted = performance.now();
	let phase = 'fetch';
	let container: BomcContainer | undefined;
	const loadedSections: number[] = [];
	let materialRows: ReturnType<typeof decodeMaterials> = [];
	let textures: Awaited<ReturnType<typeof decodeTextures>> = [];
	let semanticAssets: Array<{ path: string; bytes: Uint8Array }> = [];
	let scalarProofs: BomcSemanticMaterialDiagnostics['materialProofs'] = [];
	try {
		const response = await fetch(`/__fixture__/${request.fixtureId}`);
		if (!response.ok) throw new Error(`Fixture route returned HTTP ${response.status}.`);
		const buffer = await response.arrayBuffer();
		const sourceFileSha256 = await sha256Buffer(buffer);
		if (sourceFileSha256 !== request.sha256) throw new Error(`Fixture ${request.fixtureId} complete-file SHA-256 mismatch.`);
		phase = 'counted-sections';
		container = new BomcContainer(buffer);
		const load = async (section: number) => {
			if (!ALLOWED_SECTIONS.has(section)) throw new Error(`Texture-only proof attempted disallowed section ${section}.`);
			const bytes = await container!.load(section);
			loadedSections.push(section);
			return bytes as Uint8Array;
		};
		const stringBytes = await load(BOMC_SECTION.STRINGS);
		const strings = decodeStrings(stringBytes);
		container.release(BOMC_SECTION.STRINGS);
		const modelBytes = await load(BOMC_SECTION.MODEL);
		const model = decodeModel(modelBytes, strings);
		container.release(BOMC_SECTION.MODEL);
		const materialBytes = await load(BOMC_SECTION.MATERIALS);
		const materialVersion = materialBytes[0];
		if (materialVersion !== 2) throw new Error(`Fixture ${request.fixtureId} does not contain MATERIALS v2.`);
		materialRows = decodeMaterials(materialBytes, strings, model.counts.materials);
		container.release(BOMC_SECTION.MATERIALS);
		compareMaterialMetadata(materialRows, request.expectedMaterials);
		const tableBytes = await load(BOMC_SECTION.TEXTURE_TABLE);
		const blobBytes = await load(BOMC_SECTION.TEXTURE_BLOBS);
		textures = await decodeTextures(tableBytes, blobBytes, { expectedCount: model.counts.textures });
		container.release(BOMC_SECTION.TEXTURE_TABLE);
		container.release(BOMC_SECTION.TEXTURE_BLOBS);
		const sourceHashesBefore = await hashSourcePayloads(textures);
		const activeTextureIndices = [...new Set(materialRows.flatMap((material) => isActive(material) ? [material.texture] : []))].sort((a, b) => a - b);
		const sourceMediaCounts = countActiveMedia(materialRows, textures);
		phase = 'semantic-reconstruction';
		const baseObservations: Array<{ textureIndex: number; sourceMedia: number; width: number; height: number; baseRgbaSha256: string; alphaZeroPixels: number; nonOpaquePixels: number }> = [];
		const testCodec: ImagePixelCodec = {
			async decode(source, isCancelled) {
				const frame = await defaultImagePixelCodec.decode(source, isCancelled);
				const textureIndex = textures.findIndex((texture) => texture.bytes === source.bytes);
				if (textureIndex < 0) throw new Error('Codec source bytes do not belong to a decoded source texture.');
				let alphaZeroPixels = 0;
				let nonOpaquePixels = 0;
				for (let offset = 3; offset < frame.data.byteLength; offset += 4) {
					if (frame.data[offset] === 0) alphaZeroPixels += 1;
					if (frame.data[offset] !== 255) nonOpaquePixels += 1;
				}
				baseObservations.push({
					textureIndex, sourceMedia: source.media, width: frame.width, height: frame.height,
					baseRgbaSha256: await sha256Frame(frame.data), alphaZeroPixels, nonOpaquePixels
				});
				return frame;
			},
			encodePng: (frame, isCancelled) => defaultImagePixelCodec.encodePng(frame, isCancelled)
		};
		const semantic = await hydrateSemanticMaterials(materialRows, textures, {
			codec: testCodec,
			onMaterialVerified(proof) {
				scalarProofs.push({ ...proof });
				workerScope.postMessage({ id, type: 'row', proof: { ...proof } });
			}
		});
		semanticAssets = semantic.assets;
		const sourceHashesAfter = await hashSourcePayloads(textures);
		const sourcePayloadsUnchanged = JSON.stringify(sourceHashesBefore) === JSON.stringify(sourceHashesAfter);
		const generatedAliasesSourceBlob = semanticAssets.some((asset) => textures.some((texture) => asset.bytes.buffer === texture.bytes.buffer));
		phase = 'generated-png-round-trip';
		const roundTrips = await roundTripGeneratedPngs(semanticAssets, semantic.diagnostics.materialProofs);
		const loaded = container.metrics.filter((metric) => metric.loaded).map((metric) => metric.type).sort((a, b) => a - b);
		const geometryLoadedSections = container.metrics.filter((metric) => !ALLOWED_SECTIONS.has(metric.type) && metric.loaded).map((metric) => metric.type);
		if (geometryLoadedSections.length) throw new Error(`Texture-only proof inflated geometry sections: ${geometryLoadedSections.join(',')}.`);
		if (loaded.some((section) => !ALLOWED_SECTIONS.has(section))) throw new Error('Texture-only proof loaded a section outside its allowlist.');
		if (!sourcePayloadsUnchanged || generatedAliasesSourceBlob) throw new Error('Semantic reconstruction changed or aliased source texture payload storage.');
		if (scalarProofs.length !== semantic.diagnostics.activeCount) throw new Error('Completed scalar row receipts do not equal active material count.');
		if (roundTrips.some((row) => !row.passed)) throw new Error('A generated PNG did not round-trip to its verified RGBA pixels.');
		const activeMediaCounts = countActiveMedia(materialRows, textures);
		const sourceTexturePayloadBytes = textures.reduce((sum, texture) => sum + texture.payloadByteLength, 0);
		return {
			fixtureId: request.fixtureId, sourceFileBytes: buffer.byteLength, sourceFileSha256, materialVersion,
			materialCount: materialRows.length, sourceTextureCount: textures.length, activeCount: semantic.diagnostics.activeCount,
			activeTextureIndices, activeMediaCounts, sourceTexturePayloadBytes,
			loadedSections: loaded, geometryLoadedSections,
			sourcePayloadHashesBefore: sourceHashesBefore, sourcePayloadHashesAfter: sourceHashesAfter, sourcePayloadsUnchanged,
			generatedAliasesSourceBlob, diagnostics: semantic.diagnostics, baseObservations, generatedPngRoundTrips: roundTrips,
			stageTotalMs: Math.max(0, performance.now() - stageStarted), workerErrors: 0
		};
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		failure.message = `phase=${phase}; ${failure.message}`;
		throw failure;
	} finally {
		for (const section of loadedSections) container?.release(section);
		semanticAssets = [];
		textures = [];
		materialRows = [];
		container = undefined;
		scalarProofs = [];
	}
}

async function runGeneratedPngCase(id: number, pngCase: PngCase | undefined) {
	if (!pngCase || pngCase.width !== 2 || pngCase.height !== 2 || pngCase.sourceRgba.length !== 4 || pngCase.expectedRgba.length !== 4) {
		throw new Error('Generated PNG proof request is malformed.');
	}
	const sourceData = Uint8ClampedArray.from(pngCase.sourceRgba.flat());
	const sourceHash = await sha256Frame(sourceData);
	let sourcePng: Uint8Array | undefined;
	let sourceFrame: PixelFrame | undefined;
	let generatedFrame: PixelFrame | undefined;
	let assets: Array<{ path: string; bytes: Uint8Array }> = [];
	let materialRows: Parameters<typeof hydrateSemanticMaterials>[0] = [];
	let textures: Awaited<ReturnType<typeof decodeTextures>> = [];
	try {
		sourcePng = await defaultImagePixelCodec.encodePng({ width: 2, height: 2, data: sourceData });
		sourceFrame = await defaultImagePixelCodec.decode({ media: 1, bytes: sourcePng, width: 2, height: 2 });
		const sourceRoundTripHash = await sha256Frame(sourceFrame.data);
		if (!equalBytes(sourceFrame.data, sourceData) || sourceRoundTripHash !== sourceHash) throw new Error('Pinned PNG codec did not preserve the generated source RGBA channels.');
		const encodedHash = await sha256(sourcePng);
		const material = {
			name: 'generated PNG material', displayName: 'generated PNG material', rgba: [255, 255, 255, 255] as [number, number, number, number],
			opacity: 1, texture: 0, textureWidthM: 1, textureHeightM: 1,
			semantic: { materialType: 2 as const, colorizeMode: pngCase.mode, deltas: pngCase.deltas as [number, number, number], outputRgbaSha256: pngCase.expectedRgbaSha256 }
		};
		materialRows = [material];
		textures = [{
			media: 1, sourceMedia: 1, encodedHashVerified: true, width: 2, height: 2, hash: encodedHash,
			bytes: sourcePng, assetPath: `bomc/textures/${encodedHash}.png`, payloadByteLength: sourcePng.byteLength
		}];
		const semantic = await hydrateSemanticMaterials(materialRows, textures);
		assets = semantic.assets;
		if (semantic.diagnostics.verifiedCount !== 1 || assets.length !== 1) throw new Error('Generated PNG semantic material was not verified exactly once.');
		const asset = assets[0];
		const dimensions = /-(\d+)x(\d+)\.png$/.exec(asset.path);
		if (!dimensions) throw new Error('Generated semantic PNG asset path does not carry dimensions.');
		generatedFrame = await defaultImagePixelCodec.decode({ media: 1, bytes: asset.bytes, width: Number(dimensions[1]), height: Number(dimensions[2]) });
		const roundTripHash = await sha256Frame(generatedFrame.data);
		if (roundTripHash !== pngCase.expectedRgbaSha256 || !equalBytes(generatedFrame.data, Uint8ClampedArray.from(pngCase.expectedRgba.flat()))) {
			throw new Error('Generated semantic PNG did not round-trip to the independent Ruby oracle pixels.');
		}
		return {
			fixtureId: 'generated-png', sourceRgbaSha256: sourceHash, sourcePngSha256: encodedHash,
			sourcePngRoundTripExact: true, expectedRgbaSha256: pngCase.expectedRgbaSha256, actualRgbaSha256: roundTripHash,
			generatedAssetPath: asset.path, generatedPngRoundTripExact: true, sourceRgba: pngCase.sourceRgba,
			expectedRgba: pngCase.expectedRgba, diagnostics: semantic.diagnostics, workerErrors: 0
		};
	} finally {
		sourceFrame = undefined;
		generatedFrame = undefined;
		sourcePng = undefined;
		assets = [];
		textures = [];
		materialRows = [];
	}
}

function compareMaterialMetadata(materials: Awaited<ReturnType<typeof decodeMaterials>>, expected: ExpectedMaterial[]) {
	if (materials.length !== expected.length) throw new Error(`Ruby metadata material count ${expected.length} differs from parser count ${materials.length}.`);
	for (let index = 0; index < materials.length; index += 1) {
		const actual = materials[index];
		const reference = expected[index];
		if (reference.materialIndex !== index || (actual.name ?? null) !== reference.name || (actual.displayName ?? null) !== reference.displayName ||
			JSON.stringify(actual.rgba) !== JSON.stringify(reference.rgba) || actual.opacity !== reference.opacity ||
			(actual.texture === 0xffffffff ? null : actual.texture) !== reference.textureIndex ||
			actual.textureWidthM !== reference.textureWidthM || actual.textureHeightM !== reference.textureHeightM) {
			throw new Error(`Ruby metadata common-field mismatch at material ${index}.`);
		}
		if (isActive(actual) !== reference.activeSemantic) throw new Error(`Ruby metadata active-state mismatch at material ${index}.`);
		if (reference.activeSemantic) {
			const semantic = actual.semantic;
			if (!semantic || !reference.semantic || semantic.materialType !== reference.semantic.materialType ||
				semantic.colorizeMode !== reference.semantic.colorizeMode || JSON.stringify(semantic.deltas) !== JSON.stringify(reference.semantic.deltas) ||
				semantic.outputRgbaSha256 !== reference.semantic.outputRgbaSha256) {
				throw new Error(`Ruby metadata semantic-field mismatch at material ${index}.`);
			}
		}
	}
}

async function roundTripGeneratedPngs(assets: Array<{ path: string; bytes: Uint8Array }>, proofs: BomcSemanticMaterialDiagnostics['materialProofs']) {
	const expectedByPath = new Map(proofs.map((proof) => [proof.assetPath, proof.actualRgbaSha256]));
	const receipts: Array<{ path: string; width: number; height: number; expectedRgbaSha256: string; actualRgbaSha256: string; passed: boolean }> = [];
	for (const asset of assets) {
		const match = /-(\d+)x(\d+)\.png$/.exec(asset.path);
		if (!match) throw new Error(`Generated asset path is missing dimensions: ${asset.path}`);
		let frame: PixelFrame | undefined;
		try {
			frame = await defaultImagePixelCodec.decode({ media: 1, bytes: asset.bytes, width: Number(match[1]), height: Number(match[2]) });
			const actual = await sha256Frame(frame.data);
			const expected = expectedByPath.get(asset.path) || '';
			receipts.push({ path: asset.path, width: frame.width, height: frame.height, expectedRgbaSha256: expected, actualRgbaSha256: actual, passed: expected === actual });
		} finally {
			frame = undefined;
		}
	}
	return receipts;
}

function countActiveMedia(materials: Awaited<ReturnType<typeof decodeMaterials>>, textures: Awaited<ReturnType<typeof decodeTextures>>) {
	const counts: Record<string, number> = { PNG: 0, JPEG: 0, WebP: 0 };
	for (const material of materials) {
		if (!isActive(material)) continue;
		const media = textures[material.texture]?.sourceMedia;
		const key = media === 1 ? 'PNG' : media === 2 ? 'JPEG' : media === 3 ? 'WebP' : `media-${media}`;
		counts[key] = (counts[key] || 0) + 1;
	}
	return counts;
}

async function hashSourcePayloads(textures: Awaited<ReturnType<typeof decodeTextures>>) {
	const rows: Array<{ textureIndex: number; sourceMedia: number; bytes: number; sha256: string }> = [];
	for (let index = 0; index < textures.length; index += 1) {
		rows.push({ textureIndex: index, sourceMedia: textures[index].sourceMedia, bytes: textures[index].bytes.byteLength, sha256: await sha256(textures[index].bytes) });
	}
	return rows;
}

function isActive(material: { semantic?: { materialType: number; colorizeMode: number } }) {
	return material.semantic?.materialType === 2 && (material.semantic.colorizeMode === 1 || material.semantic.colorizeMode === 2);
}

function fixtureSha256(fixtureId: string) {
	return ({
		'S1-new': 'd306fb89c0a59edf5ecdbcaf26d27e795e521cceb1c689e59958e1038932918c',
		'S2-new': 'df19a9f07df845661d065b98b221dbcfc53e9ec2c3efe7a11f434b7fcb0ac452',
		'I-new': '01bf898df9a8b377f4d48ea4825c51427f2e18dbded865144363d5642a235825',
		'Y-new': '5bca4efdf0ac4f502b810179d51e49defbbc63406e98bb1f7641db1fb1d14c6f'
	} as Record<string, string>)[fixtureId];
}

async function sha256Buffer(buffer: ArrayBuffer) {
	return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)));
}
async function sha256(bytes: Uint8Array) { return bytesToHex(await digestSha256(bytes)); }
async function sha256Frame(data: Uint8ClampedArray) {
	return bytesToHex(await digestSha256(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
}
function bytesToHex(bytes: Uint8Array) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''); }
function equalBytes(first: Uint8Array | Uint8ClampedArray, second: Uint8Array | Uint8ClampedArray) {
	return first.byteLength === second.byteLength && first.every((value, index) => value === second[index]);
}
