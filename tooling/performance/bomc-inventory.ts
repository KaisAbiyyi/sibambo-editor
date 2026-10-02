import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BomcContainer } from '../../packages/e4-import/src/container.ts';
import { BomcBinaryReader } from '../../packages/e4-import/src/binary-reader.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface FixtureManifestEntry {
	id: string;
	locator: string;
	bytes: number;
	sha256: string;
	expectedMaterialsVersion: number;
	expectedTextureTableVersion: number;
	activeSemanticCount: number;
	profile: string;
	capability: string;
}

export interface FixtureManifest {
	schemaVersion: string;
	fixtures: FixtureManifestEntry[];
}

export interface InventoryResult {
	id: string;
	locator: string;
	bytes: number;
	sha256: string;
	hashMatch: boolean;
	bytesMatch: boolean;
	sidecarPresent: boolean;
	attestationStatus: string;
	header: {
		major: number;
		minor: number;
		flags: number;
		sectionCount: number;
		directoryOffset: number;
		directoryEntryBytes: number;
	};
	sections: Array<{
		type: number;
		typeName: string;
		codec: number;
		flags: number;
		offset: number;
		storedLength: number;
		rawLength: number;
		count: number;
		crc32: number;
	}>;
	model?: {
		version: number;
		profile: string;
		axisFlags: number;
		rootNode: number;
		bounds: { min: number[]; max: number[] };
		counts: {
			materials: number;
			tags: number;
			meshes: number;
			faces: number;
			definitions: number;
			instances: number;
			transforms: number;
			textures: number;
			edges: number;
		};
		source: { fileName?: string; modelName?: string };
	};
	materials?: {
		version: number;
		count: number;
		stringWidth: number;
		textureWidth: number;
		activeSemanticCount: number;
		modes: number[];
		activeMaterials: Array<{
			index: number;
			name?: string;
			displayName?: string;
			materialType: number;
			mode: number;
			modeName: string;
			deltas: [number, number, number];
			outputHash: string;
		}>;
	};
	textureTable?: {
		version: number;
		count: number;
		mediaCounts: Record<string, number>;
		textures: Array<{
			index: number;
			media: number;
			mediaName: string;
			width: number;
			height: number;
			hash: string;
			offset: number;
			length: number;
		}>;
	};
	encodingContract?: {
		schemaVersion: number;
		profile: string;
		sourceSkpBytes: number;
		texturePolicy: string;
		semanticExact: boolean;
		sceneExact: boolean;
		protectedTopologyExact: boolean;
		encoderRevision: number;
	};
	scenes?: {
		version: number;
		tagCount: number;
		scenesCount: number;
	};
	clipPlanes?: {
		version: number;
		count: number;
	};
	authoringFidelity: {
		retainedFields: string[];
		lostOrAdaptedFields: string[];
		canonicalDocumentNote: string;
	};
}

const SECTION_TYPE_NAMES: Record<number, string> = {
	1: 'MODEL',
	2: 'STRINGS',
	3: 'MATERIALS',
	4: 'TAGS',
	5: 'MESHES',
	6: 'FACES',
	7: 'POSITIONS',
	8: 'TOPOLOGY',
	9: 'NORMALS',
	10: 'UVS',
	11: 'DEFINITIONS',
	12: 'INSTANCES',
	13: 'TRANSFORMS',
	14: 'VISUAL_EDGES',
	15: 'TEXTURE_TABLE',
	16: 'TEXTURE_BLOBS',
	17: 'COVERAGE',
	18: 'FALLBACK',
	19: 'SCENES',
	20: 'ENCODING_CONTRACT',
	21: 'CLIP_PLANES',
	240: 'DEBUG'
};

const MEDIA_NAMES: Record<number, string> = {
	1: 'PNG',
	2: 'JPEG',
	3: 'WebP',
	4: 'AVIF',
	5: 'KTX2',
	6: 'BOMJCM'
};

export function readStringsSection(bytes: Uint8Array): string[] {
	if (bytes.byteLength < 12) throw new Error('BOMC invalid: truncated string section.');
	const reader = new BomcBinaryReader(bytes);
	const version = reader.readUint8();
	const rA = reader.readUint8();
	const rB = reader.readUint8();
	const rC = reader.readUint8();
	if (version !== 1 || rA !== 0 || rB !== 0 || rC !== 0) throw new Error('BOMC invalid: string header.');
	const count = reader.readUint32();
	const dataSize = reader.readUint32();
	const offsetsSize = (count + 1) * 4;
	const expected = 12 + offsetsSize + dataSize;
	if (bytes.byteLength !== expected) throw new Error('BOMC invalid: string section byte count.');
	const offsets: number[] = [];
	for (let i = 0; i <= count; i++) {
		offsets.push(reader.readUint32());
	}
	const data = bytes.subarray(12 + offsetsSize, 12 + offsetsSize + dataSize);
	const decoder = new TextDecoder('utf-8', { fatal: true });
	const strings: string[] = [];
	for (let i = 0; i < count; i++) {
		const strBytes = data.subarray(offsets[i], offsets[i + 1]);
		strings.push(decoder.decode(strBytes));
	}
	return strings;
}

export async function inventorySingleFixture(
	fixture: FixtureManifestEntry,
	workspaceRoot: string
): Promise<InventoryResult> {
	const filePath = resolve(workspaceRoot, fixture.locator);
	if (!existsSync(filePath)) {
		throw new Error(`Fixture file not found at: ${filePath}`);
	}

	const rawBuffer = readFileSync(filePath);
	const actualBytes = rawBuffer.byteLength;
	const actualSha256 = createHash('sha256').update(rawBuffer).digest('hex').toLowerCase();

	if (actualBytes !== fixture.bytes) {
		throw new Error(`Length mismatch for ${fixture.id}: expected ${fixture.bytes}, got ${actualBytes}`);
	}
	if (actualSha256 !== fixture.sha256.toLowerCase()) {
		throw new Error(`Hash mismatch for ${fixture.id}: expected ${fixture.sha256}, got ${actualSha256}`);
	}

	const sidecarPath = `${filePath}.sidecar.json`;
	const sidecarPresent = existsSync(sidecarPath);
	const attestationStatus = sidecarPresent ? 'sidecar_present_unverified' : 'unattested_file_only';

	const arrayBuffer = rawBuffer.buffer.slice(
		rawBuffer.byteOffset,
		rawBuffer.byteOffset + rawBuffer.byteLength
	);
	const container = new BomcContainer(arrayBuffer);

	const sections: InventoryResult['sections'] = [];
	for (const desc of container.sections.values()) {
		sections.push({
			type: desc.type,
			typeName: SECTION_TYPE_NAMES[desc.type] || `UNKNOWN_${desc.type}`,
			codec: desc.codec,
			flags: desc.flags,
			offset: desc.offset,
			storedLength: desc.storedLength,
			rawLength: desc.rawLength,
			count: desc.count,
			crc32: desc.crc32
		});
	}

	let strings: string[] = [];
	if (container.has(2)) {
		const strBytes = await container.load(2);
		if (strBytes) strings = readStringsSection(strBytes);
	}

	let modelInfo: InventoryResult['model'];
	if (container.has(1)) {
		const mb = await container.load(1);
		if (mb) {
			const reader = new BomcBinaryReader(mb);
			const version = reader.readUint8();
			const profileCode = reader.readUint8();
			const stringWidth = reader.readUint8();
			const axisFlags = reader.readUint8();
			const rootNode = reader.readUint32();
			const bounds = [
				reader.readFloat64(), reader.readFloat64(), reader.readFloat64(),
				reader.readFloat64(), reader.readFloat64(), reader.readFloat64()
			];
			const counts = {
				materials: reader.readUint32(),
				tags: reader.readUint32(),
				meshes: reader.readUint32(),
				faces: reader.readUint32(),
				definitions: reader.readUint32(),
				instances: reader.readUint32(),
				transforms: reader.readUint32(),
				textures: reader.readUint32(),
				edges: reader.readUint32()
			};
			const sourceIndices = reader.readIndices(stringWidth, 2).values;
			const fileName = sourceIndices[0] !== undefined && sourceIndices[0] < strings.length ? strings[sourceIndices[0]] : undefined;
			const modelName = sourceIndices[1] !== undefined && sourceIndices[1] < strings.length ? strings[sourceIndices[1]] : undefined;

			modelInfo = {
				version,
				profile: profileCode === 2 ? 'debug' : 'production',
				axisFlags,
				rootNode,
				bounds: { min: bounds.slice(0, 3), max: bounds.slice(3, 6) },
				counts,
				source: { fileName, modelName }
			};
		}
	}

	let materialsInfo: InventoryResult['materials'];
	if (container.has(3)) {
		const matBytes = await container.load(3);
		if (matBytes) {
			const reader = new BomcBinaryReader(matBytes);
			const version = reader.readUint8();
			const stringWidth = reader.readUint8();
			const textureWidth = reader.readUint8();
			reader.readUint8(); // reserved
			const count = reader.readCount('material');
			const names = reader.readIndices(stringWidth, count).values;
			const displayNames = reader.readIndices(stringWidth, count).values;
			reader.readBytes(count * 4); // colors
			reader.readBytes(count * 2); // opacities
			reader.readIndices(textureWidth, count); // textures
			reader.readBytes(count * 4); // widths
			reader.readBytes(count * 4); // heights

			let activeSemanticCount = 0;
			const modes: number[] = [];
			const activeMaterials: InventoryResult['materials']['activeMaterials'] = [];

			if (version >= 2) {
				const materialTypes = Array.from(reader.readBytes(count));
				const colorizeModes = Array.from(reader.readBytes(count));
				modes.push(...colorizeModes);

				const deltas: Array<[number, number, number]> = [];
				for (let i = 0; i < count; i++) {
					deltas.push([reader.readFloat64(), reader.readFloat64(), reader.readFloat64()]);
				}

				const outputHashes: string[] = [];
				for (let i = 0; i < count; i++) {
					const hashBytes = reader.readBytes(32);
					outputHashes.push(
						Array.from(hashBytes).map((b) => b.toString(16).padStart(2, '0')).join('')
					);
				}

				for (let i = 0; i < count; i++) {
					const mode = colorizeModes[i];
					if (mode !== 0) {
						activeSemanticCount++;
						activeMaterials.push({
							index: i,
							name: names[i] !== undefined && names[i] < strings.length ? strings[names[i]] : undefined,
							displayName: displayNames[i] !== undefined && displayNames[i] < strings.length ? strings[displayNames[i]] : undefined,
							materialType: materialTypes[i],
							mode,
							modeName: mode === 1 ? 'shift' : mode === 2 ? 'tint' : 'unknown',
							deltas: deltas[i],
							outputHash: outputHashes[i]
						});
					}
				}
			}

			materialsInfo = {
				version,
				count,
				stringWidth,
				textureWidth,
				activeSemanticCount,
				modes,
				activeMaterials
			};
		}
	}

	let textureTableInfo: InventoryResult['textureTable'];
	if (container.has(15)) {
		const ttBytes = await container.load(15);
		if (ttBytes) {
			const reader = new BomcBinaryReader(ttBytes);
			const version = reader.readUint8();
			reader.readUint8();
			reader.readUint8();
			reader.readUint8();
			const count = reader.readCount('texture');
			const media = Array.from(reader.readBytes(count));
			const widths = Array.from({ length: count }, () => reader.readUint32());
			const heights = Array.from({ length: count }, () => reader.readUint32());
			const hashes = Array.from({ length: count }, () => {
				const hb = reader.readBytes(32);
				return Array.from(hb).map((b) => b.toString(16).padStart(2, '0')).join('');
			});
			const offsets = Array.from({ length: count }, () => reader.readUint64('offset'));
			const lengths = Array.from({ length: count }, () => reader.readUint64('length'));

			const mediaCounts: Record<string, number> = {};
			const textures: InventoryResult['textureTable']['textures'] = [];

			for (let i = 0; i < count; i++) {
				const mName = MEDIA_NAMES[media[i]] || `TYPE_${media[i]}`;
				mediaCounts[mName] = (mediaCounts[mName] || 0) + 1;
				textures.push({
					index: i,
					media: media[i],
					mediaName: mName,
					width: widths[i],
					height: heights[i],
					hash: hashes[i],
					offset: offsets[i],
					length: lengths[i]
				});
			}

			textureTableInfo = {
				version,
				count,
				mediaCounts,
				textures
			};
		}
	}

	let encodingContractInfo: InventoryResult['encodingContract'];
	if (container.has(20)) {
		const ecBytes = await container.load(20);
		if (ecBytes && ecBytes.byteLength === 76) {
			const view = new DataView(ecBytes.buffer, ecBytes.byteOffset, ecBytes.byteLength);
			const schemaVersion = view.getUint16(0, true);
			const profileEnum = view.getUint8(2);
			const profileMap: Record<number, string> = { 1: 'exact', 2: 'research', 3: 'visual' };
			const profile = profileMap[profileEnum] || 'unknown';
			const sourceSkpBytes = Number(view.getBigUint64(4, true));
			const texturePolicyEnum = view.getUint8(40);
			const texturePolicies = ['pixel_lossless', 'perceptual_bounded', 'web_aggressive_bounded'];
			const texturePolicy = texturePolicies[texturePolicyEnum] || 'unknown';
			const semanticExact = view.getUint8(41) === 1;
			const sceneExact = view.getUint8(42) === 1;
			const protectedTopologyExact = view.getUint8(43) === 1;
			const encoderRevision = view.getUint16(44, true);

			encodingContractInfo = {
				schemaVersion,
				profile,
				sourceSkpBytes,
				texturePolicy,
				semanticExact,
				sceneExact,
				protectedTopologyExact,
				encoderRevision
			};
		}
	}

	let scenesInfo: InventoryResult['scenes'];
	if (container.has(19)) {
		const scBytes = await container.load(19);
		if (scBytes && scBytes.byteLength >= 6) {
			const reader = new BomcBinaryReader(scBytes);
			const version = reader.readUint8();
			const tagCount = reader.readUint8();
			const scenesCount = reader.readCount('scene');
			scenesInfo = { version, tagCount, scenesCount };
		}
	}

	let clipPlanesInfo: InventoryResult['clipPlanes'];
	if (container.has(21)) {
		const cpBytes = await container.load(21);
		if (cpBytes && cpBytes.byteLength >= 8) {
			const reader = new BomcBinaryReader(cpBytes);
			const version = reader.readUint8();
			reader.readUint8();
			reader.readUint8();
			reader.readUint8();
			const count = reader.readCount('clip plane');
			clipPlanesInfo = { version, count };
		}
	}

	const authoringFidelity: InventoryResult['authoringFidelity'] = {
		retainedFields: [
			'definitions count and hierarchy structure',
			'instances count and transform matrices (Float64)',
			'material metadata (names, RGBA, opacity, physical dimensions)',
			'materials v2 semantic colorize deltas and output hashes',
			'tag names and initial visibility',
			'scenes definitions, cameras, tag visibility, page names',
			'clip planes definitions, normals, origins, stability IDs',
			'mesh definitions and edge counts'
		],
		lostOrAdaptedFields: [
			'source SketchUp polygon loops with inner holes adapted to triangulated render faces',
			'Float64 positions converted to Float32 runtime buffer arrays during application preparation',
			'Float64 normals converted to Float32 runtime buffer arrays',
			'Float64 UV coordinates converted to Float32 runtime buffer arrays',
			'original coplanar face boundaries merged into runtime surface batches'
		],
		canonicalDocumentNote:
			'PreparedRuntimeGeometryScene is a downstream render product, NOT the future BOMC writer canonical authoring document.'
	};

	return {
		id: fixture.id,
		locator: fixture.locator,
		bytes: actualBytes,
		sha256: actualSha256,
		hashMatch: true,
		bytesMatch: true,
		sidecarPresent,
		attestationStatus,
		header: container.header,
		sections,
		model: modelInfo,
		materials: materialsInfo,
		textureTable: textureTableInfo,
		encodingContract: encodingContractInfo,
		scenes: scenesInfo,
		clipPlanes: clipPlanesInfo,
		authoringFidelity
	};
}

export async function runFullInventory(workspaceRoot: string): Promise<InventoryResult[]> {
	const manifestPath = join(__dirname, 'fixtures.json');
	const manifest: FixtureManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
	const results: InventoryResult[] = [];

	for (const fixture of manifest.fixtures) {
		const result = await inventorySingleFixture(fixture, workspaceRoot);
		results.push(result);
	}
	return results;
}

// CLI entry point
if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('bomc-inventory')) {
	(async () => {
		let workspaceRoot = resolve(__dirname, '../../..');
		let outputPath: string | undefined;

		for (let i = 2; i < process.argv.length; i++) {
			if (process.argv[i] === '--workspace-root' && process.argv[i + 1]) {
				workspaceRoot = resolve(process.argv[++i]);
			} else if (process.argv[i] === '--output' && process.argv[i + 1]) {
				outputPath = resolve(process.argv[++i]);
			}
		}

		console.log(`Running BOMC inventory across fixtures... Workspace root: ${workspaceRoot}`);
		const results = await runFullInventory(workspaceRoot);
		console.log(`Successfully inventoried ${results.length} fixtures without errors.`);

		for (const r of results) {
			console.log(
				`[${r.id}] bytes=${r.bytes} sha=${r.sha256.substring(0, 12)}... sections=${r.sections.length} mat_v=${r.materials?.version ?? 'none'} active_semantic=${r.materials?.activeSemanticCount ?? 0} textures=${r.textureTable?.count ?? 0}`
			);
		}

		if (outputPath) {
			writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
			console.log(`Saved inventory JSON to ${outputPath}`);
		}
	})().catch((err) => {
		console.error('BOMC inventory failed:', err);
		process.exit(1);
	});
}
