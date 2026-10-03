import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BomcContainer, crc32 } from '../../packages/e4-import/src/container.ts';
import { BomcBinaryReader } from '../../packages/e4-import/src/binary-reader.ts';
import { BOMC_SECTION } from '../../packages/e4-import/src/types.ts';
import { validateProvenance } from '../../packages/provenance/src/index.ts';
import { E4_PROVENANCE_POLICY_V1 } from '../../packages/provenance/src/policies/e4-v1.ts';

type ExpectedFixture = {
	id: string;
	locator: string;
	bytes: number;
	sha256: string;
	expected: {
		materialVersion: number;
		textureTableVersion: number;
		sourceTextureCount: number;
		activeSemanticCount: number;
	};
	provenanceSidecarLocator?: string | null;
};

type FixtureManifest = { schemaVersion: 'bomc-loader-fixture-manifest-v1'; plan: string; fixtures: ExpectedFixture[] };

const FILE = fileURLToPath(import.meta.url);
const TOOL_DIR = path.dirname(FILE);
const REPO_ROOT = path.resolve(TOOL_DIR, '../..');
const SECTION_NAMES = new Map(Object.entries(BOMC_SECTION).map(([name, type]) => [type, name]));
const VERSIONED_SECTIONS = new Set<number>([
	BOMC_SECTION.MODEL, BOMC_SECTION.STRINGS, BOMC_SECTION.MATERIALS, BOMC_SECTION.TAGS, BOMC_SECTION.MESHES,
	BOMC_SECTION.FACES, BOMC_SECTION.DEFINITIONS, BOMC_SECTION.INSTANCES, BOMC_SECTION.TRANSFORMS,
	BOMC_SECTION.VISUAL_EDGES, BOMC_SECTION.TEXTURE_TABLE, BOMC_SECTION.FALLBACK, BOMC_SECTION.SCENES,
	BOMC_SECTION.ENCODING_CONTRACT, BOMC_SECTION.CLIP_PLANES
]);
const MEDIA_NAMES = ['invalid', 'png', 'jpeg', 'webp', 'avif', 'ktx2', 'bomjcm'] as const;

function requireArgument(args: string[], name: string) {
	const index = args.indexOf(name);
	if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing required argument ${name}.`);
	return args[index + 1];
}

function safeWorkspacePath(workspaceRoot: string, locator: string) {
	if (!locator || path.isAbsolute(locator)) throw new Error(`Fixture locator must be workspace-relative: ${locator}`);
	const target = path.resolve(workspaceRoot, locator);
	const relative = path.relative(workspaceRoot, target);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Fixture locator escapes workspace root: ${locator}`);
	return target;
}

export function verifyFixturePayload(fixture: Pick<ExpectedFixture, 'id' | 'bytes' | 'sha256'>, input: Uint8Array) {
	if (input.byteLength !== fixture.bytes) throw new Error(`${fixture.id}: byte length ${input.byteLength} does not match pinned ${fixture.bytes}.`);
	const sha256 = createHash('sha256').update(input).digest('hex');
	if (sha256 !== fixture.sha256) throw new Error(`${fixture.id}: SHA-256 ${sha256} does not match pinned ${fixture.sha256}.`);
	return sha256;
}

function fixtureArrayBuffer(bytes: Uint8Array) {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function rawSection(container: BomcContainer, type: number) {
	const descriptor = container.descriptor(type);
	if (!descriptor) return undefined;
	if (descriptor.codec === 0) {
		const bytes = container.bytes.subarray(descriptor.offset, descriptor.offset + descriptor.storedLength);
		if (crc32(bytes) !== descriptor.crc32) throw new Error(`BOMC invalid: section ${descriptor.index} checksum mismatch.`);
		return bytes;
	}
	if (descriptor.codec !== 1) throw new Error(`BOMC invalid: section ${descriptor.index} uses unsupported codec ${descriptor.codec}.`);
	try {
		return await container.load(type) as Uint8Array;
	} finally {
		container.release(type);
	}
}

function parseModel(bytes: Uint8Array) {
	const reader = new BomcBinaryReader(bytes);
	const version = reader.readUint8();
	if (version !== 1) throw new Error(`BOMC invalid: model section version ${version}.`);
	const profileCode = reader.readUint8();
	const stringWidth = reader.readUint8();
	reader.readUint8();
	const rootNode = reader.readUint32();
	const bounds = Array.from({ length: 6 }, () => reader.readFloat64());
	const values = Array.from({ length: 9 }, () => reader.readUint32());
	reader.readIndices(stringWidth, 2);
	reader.finish('model section');
	return {
		version,
		profileCode,
		rootNode,
		bounds,
		counts: Object.fromEntries(['materials', 'tags', 'meshes', 'faces', 'definitions', 'instances', 'transforms', 'textures', 'edges'].map((key, index) => [key, values[index]])),
		sourceCounts: values
	};
}

function parseMaterials(bytes: Uint8Array) {
	const reader = new BomcBinaryReader(bytes);
	const version = reader.readUint8();
	if (version !== 1 && version !== 2) throw new Error(`BOMC invalid: material section version ${version}.`);
	const stringWidth = reader.readUint8();
	const textureWidth = reader.readUint8();
	if (reader.readUint8() !== 0) throw new Error('BOMC invalid: material section reserved field.');
	const count = reader.readCount('material');
	if (![1, 2, 4].includes(stringWidth) || ![1, 2, 4].includes(textureWidth)) throw new Error('BOMC invalid: adaptive-width code.');
	reader.assertRemainingCount(count, stringWidth * 2 + 4 + 2 + textureWidth + 8 + (version === 2 ? 58 : 0), 'material');
	reader.readIndices(stringWidth, count);
	reader.readIndices(stringWidth, count);
	reader.readBytes(count * 4);
	for (let index = 0; index < count; index += 1) reader.readUint16();
	reader.readIndices(textureWidth, count);
	for (let index = 0; index < count * 2; index += 1) reader.readFloat32();
	const active: Array<{ materialIndex: number; materialType: number; colorizeMode: number; hls: [number, number, number]; outputRgbaSha256: string }> = [];
	const modes: Record<string, number> = {};
	if (version === 2) {
		const materialTypes = reader.readBytes(count);
		const colorizeModes = reader.readBytes(count);
		for (let index = 0; index < count; index += 1) {
			const hls: [number, number, number] = [reader.readFloat64(), reader.readFloat64(), reader.readFloat64()];
			modes[String(colorizeModes[index])] = (modes[String(colorizeModes[index])] ?? 0) + 1;
			const outputRgbaSha256 = Buffer.from(reader.readBytes(32)).toString('hex');
			if (colorizeModes[index] === 1 || colorizeModes[index] === 2) {
				active.push({ materialIndex: index, materialType: materialTypes[index], colorizeMode: colorizeModes[index], hls, outputRgbaSha256 });
			}
		}
	}
	reader.finish('material section');
	return { version, count, activeSemanticCount: active.length, semanticModeCounts: modes, activeSemanticMaterials: active };
}

function parseTextureTable(bytes: Uint8Array, blobRawLength: number | undefined) {
	const reader = new BomcBinaryReader(bytes);
	const version = reader.readUint8();
	if ((version !== 1 && version !== 2) || reader.readUint8() !== 0 || reader.readUint8() !== 0 || reader.readUint8() !== 0) {
		throw new Error('BOMC invalid: texture table header.');
	}
	const count = reader.readCount('texture');
	reader.assertRemainingCount(count, 57, 'texture');
	const media = reader.readBytes(count);
	const widths = Array.from({ length: count }, () => reader.readUint32());
	const heights = Array.from({ length: count }, () => reader.readUint32());
	const hashes = Array.from({ length: count }, () => Buffer.from(reader.readBytes(32)).toString('hex'));
	const offsets = Array.from({ length: count }, () => reader.readUint64('texture blob offset'));
	const lengths = Array.from({ length: count }, () => reader.readUint64('texture blob length'));
	reader.finish('texture table');
	if (count > 0 && blobRawLength === undefined) throw new Error('BOMC invalid: texture table has no texture blob section.');
	const mediaCounts: Record<string, number> = {};
	const textures = Array.from({ length: count }, (_, index) => {
		const end = offsets[index] + lengths[index];
		if (media[index] < 1 || media[index] > 6) throw new Error(`BOMC invalid: texture ${index} media type.`);
		if (widths[index] <= 0 || heights[index] <= 0 || !Number.isSafeInteger(widths[index] * heights[index] * 4)) throw new Error(`BOMC invalid: texture ${index} dimensions.`);
		if (!Number.isSafeInteger(end) || offsets[index] < 0 || lengths[index] < 0 || end > (blobRawLength ?? 0)) throw new Error(`BOMC invalid: texture ${index} outside blob section.`);
		if (media[index] === 6 && version !== 2) throw new Error(`BOMC invalid: texture ${index} requires table version 2.`);
		const mediaName = MEDIA_NAMES[media[index]];
		mediaCounts[mediaName] = (mediaCounts[mediaName] ?? 0) + 1;
		return { index, media: mediaName, width: widths[index], height: heights[index], encodedPayloadSha256: hashes[index], offset: offsets[index], length: lengths[index] };
	});
	return { version, count, mediaCounts, textures };
}

function parseEncodingContract(bytes: Uint8Array) {
	if (bytes.byteLength !== 76) throw new Error(`BOMC invalid: encoding contract size ${bytes.byteLength} != 76.`);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const schemaVersion = view.getUint16(0, true);
	const profile = ({ 1: 'exact', 2: 'research', 3: 'visual' } as Record<number, string>)[view.getUint8(2)];
	if (schemaVersion !== 1 || !profile) throw new Error(`BOMC invalid: encoding contract schema/profile ${schemaVersion}/${view.getUint8(2)}.`);
	return { schemaVersion, profile, sourceSizeRequired: view.getUint8(3) === 1, texturePolicyCode: view.getUint8(68), semanticExact: view.getUint8(69) === 1, sceneExact: view.getUint8(70) === 1, protectedTopologyExact: view.getUint8(71) === 1, encoderRevision: view.getUint32(72, true) };
}

function parseScenes(bytes: Uint8Array, directoryCount: number) {
	const reader = new BomcBinaryReader(bytes);
	const version = reader.readUint8();
	if (version < 1 || version > 5) throw new Error(`BOMC invalid: scenes section version ${version} unsupported.`);
	const tagCount = reader.readUint8();
	const count = reader.readCount('scene');
	if (count !== directoryCount) throw new Error(`BOMC invalid: scene directory count ${directoryCount} does not match section count ${count}.`);
	return { version, count, tagCount };
}

function parseClipPlanes(bytes: Uint8Array, directoryCount: number) {
	const reader = new BomcBinaryReader(bytes);
	const version = reader.readUint8();
	reader.readBytes(3);
	const count = reader.readCount('clip plane');
	if (version !== 1 || count !== directoryCount) throw new Error(`BOMC invalid: clip plane version/count ${version}/${count}.`);
	return { version, count };
}

function parseFaces(bytes: Uint8Array) {
	const reader = new BomcBinaryReader(bytes);
	const version = reader.readUint8();
	const materialWidth = reader.readUint8();
	const tagWidth = reader.readUint8();
	const stringWidth = reader.readUint8();
	const count = reader.readCount('face');
	const loopCount = reader.readCount('face loop');
	const loopCountBytes = reader.readUint32();
	const triangleCountBytes = reader.readUint32();
	const loopLengthBytes = reader.readUint32();
	if (version !== 1 || ![materialWidth, tagWidth, stringWidth].every((width) => [1, 2, 4].includes(width))) throw new Error('BOMC invalid: face section header.');
	reader.readBytes(count * 3);
	reader.readIndices(materialWidth, count);
	reader.readIndices(materialWidth, count);
	reader.readIndices(tagWidth, count);
	reader.readIndices(stringWidth, count);
	reader.readBytes(loopCountBytes);
	const triangleBytes = reader.readBytes(triangleCountBytes);
	reader.readBytes(loopLengthBytes);
	reader.finish('face section');
	const triangleReader = new BomcBinaryReader(triangleBytes);
	let triangleCount = 0;
	for (let index = 0; index < count; index += 1) triangleCount += triangleReader.readVaruintCount('face triangle');
	triangleReader.finish('face triangle counts');
	return { version, polygonCount: count, polygonLoopCount: loopCount, declaredTriangleCount: triangleCount };
}

function parseMeshes(bytes: Uint8Array) {
	const reader = new BomcBinaryReader(bytes);
	const version = reader.readUint8();
	const width = reader.readUint8();
	if (reader.readUint16() !== 0) throw new Error('BOMC invalid: mesh section reserved fields.');
	const count = reader.readCount('mesh');
	if (version !== 1 || ![1, 2, 4].includes(width)) throw new Error('BOMC invalid: mesh section header.');
	reader.readIndices(width, count, true);
	const columns = Array.from({ length: 11 }, () => Array.from({ length: count }, () => reader.readUint32()));
	reader.finish('mesh section');
	return {
		count,
		rows: Array.from({ length: count }, (_, index) => ({
			vertexCount: columns[0][index], positionOffset: columns[5][index], positionLength: columns[6][index], uvOffset: columns[9][index], uvLength: columns[10][index]
		}))
	};
}

function codecHeader(bytes: Uint8Array, label: string, versioned = false) {
	const reader = new BomcBinaryReader(bytes);
	const version = reader.readUint8();
	const codec = reader.readUint8();
	if (reader.readUint16() !== 0) throw new Error(`BOMC invalid: ${label} reserved fields.`);
	const count = reader.readCount(label);
	const payloadLength = reader.readUint32();
	if (reader.remaining !== payloadLength || (versioned && version !== 1)) throw new Error(`BOMC invalid: ${label} section header.`);
	return { version, codec, count, payloadLength };
}

function parsePositionBlocks(section: Uint8Array, meshRows: ReturnType<typeof parseMeshes>['rows']) {
	const codecs: Record<string, { blocks: number; vertices: number }> = {};
	let float64SourceValues = 0;
	for (const [index, mesh] of meshRows.entries()) {
		if (mesh.positionLength === 0) continue;
		const end = mesh.positionOffset + mesh.positionLength;
		if (!Number.isSafeInteger(end) || end > section.byteLength) throw new Error(`BOMC invalid: mesh ${index} position range.`);
		const reader = new BomcBinaryReader(section.subarray(mesh.positionOffset, end));
		const version = reader.readUint8();
		const codec = reader.readUint8();
		if (reader.readUint16() !== 0) throw new Error(`BOMC invalid: position block ${index} reserved fields.`);
		const count = reader.readCount('position');
		const payloadLength = reader.readUint32();
		reader.readBytes(48);
		if (version !== 1 || ![1, 2, 3, 4, 5].includes(codec) || count !== mesh.vertexCount || reader.remaining !== payloadLength) throw new Error(`BOMC invalid: position block ${index} header.`);
		const item = codecs[String(codec)] ?? { blocks: 0, vertices: 0 };
		item.blocks += 1;
		item.vertices += count;
		codecs[String(codec)] = item;
		if (codec === 1) float64SourceValues += count * 3;
	}
	return { codecs, float64SourceValues, runtimeTypedArray: 'Float32Array' };
}

function parseUvBlocks(section: Uint8Array, meshRows: ReturnType<typeof parseMeshes>['rows']) {
	const codecs: Record<string, { blocks: number; values: number }> = {};
	let float64SourceValues = 0;
	for (const [index, mesh] of meshRows.entries()) {
		if (mesh.uvLength === 0) continue;
		const end = mesh.uvOffset + mesh.uvLength;
		if (!Number.isSafeInteger(end) || end > section.byteLength) throw new Error(`BOMC invalid: mesh ${index} UV range.`);
		const reader = new BomcBinaryReader(section.subarray(mesh.uvOffset, end));
		const version = reader.readUint8();
		const codec = reader.readUint8();
		if (reader.readUint16() !== 0) throw new Error(`BOMC invalid: UV block ${index} reserved fields.`);
		const count = reader.readCount('UV');
		const payloadLength = reader.readUint32();
		reader.readBytes(32);
		if (version !== 1 || ![1, 2, 3, 4, 5].includes(codec) || reader.remaining !== payloadLength) throw new Error(`BOMC invalid: UV block ${index} header.`);
		const item = codecs[String(codec)] ?? { blocks: 0, values: 0 };
		item.blocks += 1;
		item.values += count * 2;
		codecs[String(codec)] = item;
		if (codec === 5) float64SourceValues += count * 2;
	}
	return { codecs, float64SourceValues, runtimeTypedArray: 'Float32Array' };
}

async function sidecarStatus(workspaceRoot: string, fixture: ExpectedFixture, artifactSha256: string, encodingProfile: string | null) {
	const locator = fixture.provenanceSidecarLocator ?? null;
	if (!locator) return { locator: null, present: false, policyStatus: 'not-supplied', attestationMethod: null, cryptographicSignature: false };
	const target = safeWorkspacePath(workspaceRoot, locator);
	if (!existsSync(target)) return { locator, present: false, policyStatus: 'declared-but-missing', attestationMethod: null, cryptographicSignature: false };
	try {
		const parsed = JSON.parse(readFileSync(target, 'utf8')) as unknown;
		const provenance = validateProvenance(parsed, E4_PROVENANCE_POLICY_V1);
		const file = parsed as { artifact?: { bytes?: number; profile?: string } };
		const bytesMatch = file.artifact?.bytes === fixture.bytes;
		const hashMatch = provenance.artifact.sha256 === artifactSha256;
		const profileMatch = encodingProfile !== null && provenance.artifact.profile === encodingProfile;
		return {
			locator, present: true,
			policyStatus: bytesMatch && hashMatch && profileMatch ? 'policy-valid-and-matched' : 'policy-valid-but-artifact-or-profile-mismatch',
			artifactBytesMatch: bytesMatch, artifactSha256Match: hashMatch, encodingProfileMatch: profileMatch,
			attestationMethod: provenance.capture.method, cryptographicSignature: false
		};
	} catch (cause) {
		return { locator, present: true, policyStatus: 'present-but-invalid', error: cause instanceof Error ? cause.message : String(cause), attestationMethod: null, cryptographicSignature: false };
	}
}

async function inventoryFixture(workspaceRoot: string, fixture: ExpectedFixture) {
	const filePath = safeWorkspacePath(workspaceRoot, fixture.locator);
	if (!existsSync(filePath)) throw new Error(`${fixture.id}: fixture file is missing at ${fixture.locator}.`);
	const file = readFileSync(filePath);
	const sha256 = verifyFixturePayload(fixture, file);
	const container = new BomcContainer(fixtureArrayBuffer(file));
	const descriptors = [...container.sections.values()].sort((a, b) => a.index - b.index);
	if (container.header.major !== 1 || container.header.minor !== 2) throw new Error(`${fixture.id}: expected BOMC 1.2, found ${container.header.major}.${container.header.minor}.`);
	const blobDescriptor = container.descriptor(BOMC_SECTION.TEXTURE_BLOBS);
	const sectionRows: Array<Record<string, unknown>> = [];
	let model: ReturnType<typeof parseModel> | null = null;
	let material: ReturnType<typeof parseMaterials> | null = null;
	let textureTable: ReturnType<typeof parseTextureTable> | null = null;
	let encoding: ReturnType<typeof parseEncodingContract> | null = null;
	let scenes: ReturnType<typeof parseScenes> | null = null;
	let clipPlanes: ReturnType<typeof parseClipPlanes> | null = null;
	let faces: ReturnType<typeof parseFaces> | null = null;
	let meshes: ReturnType<typeof parseMeshes> | null = null;
	let positions: ReturnType<typeof parsePositionBlocks> | null = null;
	let uvs: ReturnType<typeof parseUvBlocks> | null = null;
	let normals: (ReturnType<typeof codecHeader> & { float64SourceValues: number; runtimeTypedArray: string }) | null = null;
	let positionSection: Uint8Array | null = null;
	let uvSection: Uint8Array | null = null;
	let stringCount: number | null = null;

	for (const descriptor of descriptors) {
		const bytes = await rawSection(container, descriptor.type);
		if (!bytes) throw new Error(`${fixture.id}: section ${descriptor.type} could not be read.`);
		const version = VERSIONED_SECTIONS.has(descriptor.type) && bytes.length > 0 ? bytes[0] : null;
		const row: Record<string, unknown> = {
			type: descriptor.type, name: SECTION_NAMES.get(descriptor.type) ?? `SECTION_${descriptor.type}`,
			version, directoryCount: descriptor.count, directoryCodec: descriptor.codec,
			storedBytes: descriptor.storedLength, rawBytes: descriptor.rawLength, crc32Validated: true
		};
		switch (descriptor.type) {
			case BOMC_SECTION.MODEL: model = parseModel(bytes); break;
			case BOMC_SECTION.STRINGS: {
				const reader = new BomcBinaryReader(bytes);
				if (reader.readUint8() !== 1 || reader.readUint8() !== 0 || reader.readUint8() !== 0 || reader.readUint8() !== 0) throw new Error('BOMC invalid: string section header.');
				stringCount = reader.readCount('string');
				break;
			}
			case BOMC_SECTION.MATERIALS: material = parseMaterials(bytes); row.sectionCount = material.count; break;
			case BOMC_SECTION.TEXTURE_TABLE: textureTable = parseTextureTable(bytes, blobDescriptor?.rawLength); row.sectionCount = textureTable.count; break;
			case BOMC_SECTION.ENCODING_CONTRACT: encoding = parseEncodingContract(bytes); break;
			case BOMC_SECTION.SCENES: scenes = parseScenes(bytes, descriptor.count); row.sectionCount = scenes.count; break;
			case BOMC_SECTION.CLIP_PLANES: clipPlanes = parseClipPlanes(bytes, descriptor.count); row.sectionCount = clipPlanes.count; break;
			case BOMC_SECTION.FACES: faces = parseFaces(bytes); row.sectionCount = faces.polygonCount; break;
			case BOMC_SECTION.MESHES: meshes = parseMeshes(bytes); row.sectionCount = meshes.count; break;
			case BOMC_SECTION.POSITIONS: positionSection = bytes; row.innerCodecs = 'per-mesh position block headers'; break;
			case BOMC_SECTION.UVS: uvSection = bytes; row.innerCodecs = 'per-mesh UV block headers'; break;
			case BOMC_SECTION.NORMALS: {
				const header = codecHeader(bytes, 'normal', true);
				normals = { ...header, float64SourceValues: header.codec === 3 ? header.count * 3 : 0, runtimeTypedArray: 'Float32Array' };
				row.innerCodec = normals.codec;
				row.sectionCount = normals.count;
				break;
			}
			case BOMC_SECTION.TRANSFORMS: row.innerCodec = codecHeader(bytes, 'transform', true).codec; break;
		}
		sectionRows.push(row);
	}

	if (!model || !material) throw new Error(`${fixture.id}: required MODEL or MATERIALS section is missing.`);
	if (material.count !== model.counts.materials) throw new Error(`${fixture.id}: MATERIALS section count differs from MODEL.`);
	if ((textureTable?.count ?? 0) !== model.counts.textures) throw new Error(`${fixture.id}: texture-table count differs from MODEL.`);
	if ((faces?.polygonCount ?? 0) !== model.counts.faces) throw new Error(`${fixture.id}: FACES section count differs from MODEL.`);
	if ((meshes?.count ?? 0) !== model.counts.meshes) throw new Error(`${fixture.id}: MESHES section count differs from MODEL.`);
	if (meshes && positionSection) positions = parsePositionBlocks(positionSection, meshes.rows);
	if (meshes && uvSection) uvs = parseUvBlocks(uvSection, meshes.rows);
	if (material.version !== fixture.expected.materialVersion) throw new Error(`${fixture.id}: MATERIALS version ${material.version} does not match manifest ${fixture.expected.materialVersion}.`);
	if ((textureTable?.version ?? 0) !== fixture.expected.textureTableVersion) throw new Error(`${fixture.id}: texture-table version ${textureTable?.version ?? 'missing'} does not match manifest ${fixture.expected.textureTableVersion}.`);
	if ((textureTable?.count ?? 0) !== fixture.expected.sourceTextureCount) throw new Error(`${fixture.id}: texture count ${textureTable?.count ?? 0} does not match manifest ${fixture.expected.sourceTextureCount}.`);
	if (material.activeSemanticCount !== fixture.expected.activeSemanticCount) throw new Error(`${fixture.id}: active semantic count ${material.activeSemanticCount} does not match manifest ${fixture.expected.activeSemanticCount}.`);
	const sidecar = await sidecarStatus(workspaceRoot, fixture, sha256, encoding?.profile ?? null);
	return {
		id: fixture.id, locator: fixture.locator, bytes: file.byteLength, sha256,
		container: { major: container.header.major, minor: container.header.minor, flags: container.header.flags, directoryEntryBytes: container.header.directoryEntryBytes },
		sections: sectionRows,
		sourceCounts: model.counts,
		strings: { count: stringCount },
		materials: material,
		textures: textureTable,
		encodingContract: encoding,
		scenes: scenes ?? { present: false, count: 0 },
		clipPlanes: clipPlanes ?? { present: false, count: 0 },
		geometry: {
			faceTopology: faces,
			meshCount: meshes?.count ?? null,
			positionBlocks: positions,
			normalSection: normals,
			uvBlocks: uvs,
			adaptedAnalyticalCounts: null,
			adaptedAnalyticalCountsEvidence: 'Captured separately from the supported B0 runtime path; unavailable to a wire-only inventory for expected MATERIALS-v2 rejections.'
		},
		authoringFieldAudit: {
			definitionInstanceMaterialSceneClipIdentifiers: 'Source counts and wire sections recorded; render DTO does not constitute a canonical authoring document.',
			positionsNormalsUvs: 'The existing reader decodes BOMC Float64 position codec 1, normal codec 3, and UV codec 5 into Float32Array render data; per-file encoded Float64 value counts are recorded above.',
			polygonLoopsAndTriangles: 'Source face, loop, and declared triangle counts are recorded above; triangulated runtime output is a render product.',
			writerCanonicalDocument: false
		},
		provenanceSidecar: sidecar,
		attestationLimit: 'A policy-matched provenance sidecar is operator/exporter evidence, not a cryptographic producer signature or certification.'
	};
}

export async function buildInventory(workspaceRootInput: string, manifestPath = path.join(TOOL_DIR, 'fixtures.json')) {
	const workspaceRoot = path.resolve(workspaceRootInput);
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FixtureManifest;
	if (manifest.schemaVersion !== 'bomc-loader-fixture-manifest-v1' || manifest.plan !== 'BOMC-LOADER-001/v1.0' || manifest.fixtures.length !== 8) {
		throw new Error('Fixture manifest schema/plan/count does not match the frozen eight-input corpus.');
	}
	const fixtures = [];
	for (const fixture of manifest.fixtures) fixtures.push(await inventoryFixture(workspaceRoot, fixture));
	return {
		schemaVersion: 'bomc-loader-inventory-v1', plan: manifest.plan,
		workspaceRoot, recordedAt: new Date().toISOString(), fixtureCount: fixtures.length,
		fixtures
	};
}

async function main() {
	const args = process.argv.slice(2);
	const workspaceRoot = requireArgument(args, '--workspace-root');
	const output = args.includes('--output') ? requireArgument(args, '--output') : null;
	const result = await buildInventory(workspaceRoot);
	const serialized = `${JSON.stringify(result, null, 2)}\n`;
	if (output) {
		const outputPath = path.resolve(output);
		writeFileSync(outputPath, serialized, 'utf8');
		process.stdout.write(`${outputPath}\n`);
	} else {
		process.stdout.write(serialized);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === FILE) {
	main().catch((cause) => {
		process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
		process.exitCode = 1;
	});
}
