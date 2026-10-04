import { deflateSync } from 'node:zlib';
import { BOMC_SECTION } from '../../packages/e4-import/src/index';
import { crc32 } from '../../packages/e4-import/src/container';

type SectionInput = { type: number; bytes: Uint8Array; count: number; compress?: boolean };

export function makeTinyBomc12(options: { faceSurfaceCode?: number; faceRoleCode?: number; modelName?: string; sourceFileName?: string } = {}): Uint8Array {
	const strings = stringSection([options.modelName ?? 'model', options.sourceFileName ?? 'tiny-browser-test.bomc']);
	const positions = positionBlock(2, packF32([0, 0, 0, 2, 0, 0, 0, 2, 0]), [0, 0, 0], [0, 0, 0], 3);
	const topology = topologyBlock([0, 1, 2], [0, 1, 2]);
	const model = concat(Uint8Array.of(1, 1, 1, 5), packU32([0]), packF64([0, 0, 0, 2, 2, 0]), packU32([0, 0, 1, 1, 1, 1, 1, 0, 0]), Uint8Array.of(1, 0));
	const meshes = concat(Uint8Array.of(1, 1, 0, 0), packU32([1]), Uint8Array.of(0), ...[
		[3], [0], [1], [0], [0], [0], [positions.length], [0], [topology.length], [0], [0]
	].map(packU32));
	const faces = concat(
		Uint8Array.of(1, 1, 1, 1), packU32([1, 1, 1, 1, 1]),
		Uint8Array.of(options.faceSurfaceCode ?? 2), Uint8Array.of(0), Uint8Array.of(options.faceRoleCode ?? 2),
		Uint8Array.of(0xff), Uint8Array.of(0xff), Uint8Array.of(0xff), Uint8Array.of(0xff),
		Uint8Array.of(1), Uint8Array.of(3), Uint8Array.of(3)
	);
	const definitions = concat(Uint8Array.of(1, 1, 1, 0), packU32([1]), Uint8Array.of(0), Uint8Array.of(1), Uint8Array.of(0));
	const instances = concat(
		Uint8Array.of(1, 1, 1, 1, 1, 1, 0, 0), packU32([1]),
		Uint8Array.of(0), Uint8Array.of(1), Uint8Array.of(0xff), Uint8Array.of(0), Uint8Array.of(0),
		Uint8Array.of(0xff), Uint8Array.of(0xff), Uint8Array.of(1), Uint8Array.of(0), Uint8Array.of(0xff)
	);
	const encoding = new Uint8Array(76);
	const encodingView = new DataView(encoding.buffer);
	encodingView.setUint16(0, 1, true);
	encodingView.setUint8(2, 1); // Exact profile.
	encodingView.setBigUint64(4, 0n, true);
	encodingView.setFloat64(12, 0, true);
	encodingView.setFloat64(20, 0, true);
	encodingView.setBigUint64(28, 0n, true);
	encodingView.setFloat64(36, 0, true);
	encodingView.setFloat64(44, 0, true);
	encodingView.setFloat64(52, 0, true);
	encodingView.setFloat64(60, 0.00001, true);
	encodingView.setUint8(68, 1);
	encodingView.setUint8(69, 1);
	encodingView.setUint8(70, 1);
	encodingView.setUint8(71, 1);
	encodingView.setUint32(72, 1, true);

	return buildContainer([
		{ type: BOMC_SECTION.MODEL, bytes: model, count: 1, compress: true },
		{ type: BOMC_SECTION.STRINGS, bytes: strings, count: 2, compress: true },
		{ type: BOMC_SECTION.MESHES, bytes: meshes, count: 1, compress: true },
		{ type: BOMC_SECTION.FACES, bytes: faces, count: 1, compress: true },
		{ type: BOMC_SECTION.POSITIONS, bytes: positions, count: 1, compress: true },
		{ type: BOMC_SECTION.TOPOLOGY, bytes: topology, count: 1, compress: true },
		{ type: BOMC_SECTION.NORMALS, bytes: genericCodec(1, 1, packF32([0, 0, 1])), count: 1, compress: true },
		{ type: BOMC_SECTION.DEFINITIONS, bytes: definitions, count: 1, compress: true },
		{ type: BOMC_SECTION.INSTANCES, bytes: instances, count: 1, compress: true },
		{ type: BOMC_SECTION.TRANSFORMS, bytes: genericCodec(5, 1, Uint8Array.of(0)), count: 1, compress: true },
		{ type: BOMC_SECTION.COVERAGE, bytes: packU32([1, 1, 0, 0, 0, 0]), count: 1, compress: true },
		{ type: BOMC_SECTION.ENCODING_CONTRACT, bytes: encoding, count: 1, compress: true }
	]);
}

/** A small closed room model for Rooms review and analysis browser coverage. */
export function makeTinyRoomBomc12(): Uint8Array {
	const outputPoint = (x: number, y: number, z: number) => ({ x, y, z });
	const sourcePoint = ({ x, y, z }: { x: number; y: number; z: number }) => ({ x, y: -z, z: y });
	const roomFaces = [
		{ surface: 2, role: 2, normal: [0, 0, 1], points: [outputPoint(0, 0, 0), outputPoint(4, 0, 0), outputPoint(4, 0, 3), outputPoint(0, 0, 3)] },
		{ surface: 3, role: 3, normal: [0, 0, -1], points: [outputPoint(0, 3, 0), outputPoint(4, 3, 0), outputPoint(4, 3, 3), outputPoint(0, 3, 3)] },
		{ surface: 1, role: 1, normal: [0, 0, 1], points: [outputPoint(0, 0, 0), outputPoint(4, 0, 0), outputPoint(4, 3, 0), outputPoint(0, 3, 0)] },
		{ surface: 1, role: 1, normal: [1, 0, 0], points: [outputPoint(4, 0, 0), outputPoint(4, 0, 3), outputPoint(4, 3, 3), outputPoint(4, 3, 0)] },
		{ surface: 1, role: 1, normal: [0, 0, -1], points: [outputPoint(4, 0, 3), outputPoint(0, 0, 3), outputPoint(0, 3, 3), outputPoint(4, 3, 3)] },
		{ surface: 1, role: 1, normal: [-1, 0, 0], points: [outputPoint(0, 0, 3), outputPoint(0, 0, 0), outputPoint(0, 3, 0), outputPoint(0, 3, 3)] }
	];
	const sourcePoints = roomFaces.flatMap((face) => face.points.map(sourcePoint));
	const positions = positionBlock(2, packF32(sourcePoints.flatMap(({ x, y, z }) => [x, y, z])), [0, 0, 0], [0, 0, 0], sourcePoints.length);
	const loopIndices: number[] = [];
	const triangleIndices: number[] = [];
	roomFaces.forEach((_, faceIndex) => {
		const start = faceIndex * 4;
		loopIndices.push(start, start + 1, start + 2, start + 3);
		triangleIndices.push(start, start + 1, start + 2, start, start + 2, start + 3);
	});
	const topology = topologyBlock(loopIndices, triangleIndices);
	const faceCount = roomFaces.length;
	const faceColumns = concat(
		Uint8Array.of(1, 1, 1, 1), packU32([faceCount, faceCount, faceCount, faceCount, faceCount]),
		Uint8Array.from(roomFaces.map((face) => face.surface)), new Uint8Array(faceCount),
		Uint8Array.from(roomFaces.map((face) => face.role)),
		new Uint8Array(faceCount).fill(0xff), new Uint8Array(faceCount).fill(0xff), new Uint8Array(faceCount).fill(0xff), new Uint8Array(faceCount).fill(0xff),
		...roomFaces.map(() => varuint(1)), ...roomFaces.map(() => varuint(6)), ...roomFaces.map(() => varuint(4))
	);
	const meshes = concat(Uint8Array.of(1, 1, 0, 0), packU32([1]), Uint8Array.of(0), ...[
		[sourcePoints.length], [0], [faceCount], [0], [0], [0], [positions.length], [0], [topology.length], [0], [0]
	].map(packU32));
	const normals = genericCodec(1, faceCount, packF32(roomFaces.flatMap((face) => face.normal)));
	const strings = stringSection(['model', 'tiny-rooms-analysis-test.bomc']);
	const model = concat(Uint8Array.of(1, 1, 1, 5), packU32([0]), packF64([0, -3, 0, 4, 0, 3]), packU32([0, 0, 1, faceCount, 1, 1, 1, 0, 0]), Uint8Array.of(1, 0));
	const definitions = concat(Uint8Array.of(1, 1, 1, 0), packU32([1]), Uint8Array.of(0), Uint8Array.of(1), Uint8Array.of(0));
	const instances = concat(
		Uint8Array.of(1, 1, 1, 1, 1, 1, 0, 0), packU32([1]),
		Uint8Array.of(0), Uint8Array.of(1), Uint8Array.of(0xff), Uint8Array.of(0), Uint8Array.of(0),
		Uint8Array.of(0xff), Uint8Array.of(0xff), Uint8Array.of(1), Uint8Array.of(0), Uint8Array.of(0xff)
	);
	const encoding = new Uint8Array(76);
	const encodingView = new DataView(encoding.buffer);
	encodingView.setUint16(0, 1, true);
	encodingView.setUint8(2, 1);
	encodingView.setBigUint64(4, 0n, true);
	encodingView.setFloat64(12, 0, true);
	encodingView.setFloat64(20, 0, true);
	encodingView.setBigUint64(28, 0n, true);
	encodingView.setFloat64(36, 0.00001, true);
	encodingView.setFloat64(44, 0.00001, true);
	encodingView.setFloat64(52, 0.00001, true);
	encodingView.setFloat64(60, 0.00001, true);
	encodingView.setUint8(68, 1);
	encodingView.setUint8(69, 1);
	encodingView.setUint8(70, 1);
	encodingView.setUint8(71, 1);
	encodingView.setUint32(72, 1, true);

	return buildContainer([
		{ type: BOMC_SECTION.MODEL, bytes: model, count: 1, compress: true },
		{ type: BOMC_SECTION.STRINGS, bytes: strings, count: 2, compress: true },
		{ type: BOMC_SECTION.MESHES, bytes: meshes, count: 1, compress: true },
		{ type: BOMC_SECTION.FACES, bytes: faceColumns, count: faceCount, compress: true },
		{ type: BOMC_SECTION.POSITIONS, bytes: positions, count: 1, compress: true },
		{ type: BOMC_SECTION.TOPOLOGY, bytes: topology, count: 1, compress: true },
		{ type: BOMC_SECTION.NORMALS, bytes: normals, count: faceCount, compress: true },
		{ type: BOMC_SECTION.DEFINITIONS, bytes: definitions, count: 1, compress: true },
		{ type: BOMC_SECTION.INSTANCES, bytes: instances, count: 1, compress: true },
		{ type: BOMC_SECTION.TRANSFORMS, bytes: genericCodec(5, 1, Uint8Array.of(0)), count: 1, compress: true },
		{ type: BOMC_SECTION.COVERAGE, bytes: packU32([1, 1, 0, 0, 0, 0]), count: 1, compress: true },
		{ type: BOMC_SECTION.ENCODING_CONTRACT, bytes: encoding, count: 1, compress: true }
	]);
}

function buildContainer(inputs: SectionInput[]) {
	const sections = [...inputs].sort((a, b) => a.type - b.type).map((section) => {
		const compressed = section.compress ? new Uint8Array(deflateSync(section.bytes)) : section.bytes;
		const stored = section.compress && compressed.length < section.bytes.length ? compressed : section.bytes;
		return { ...section, stored, codec: stored === section.bytes ? 0 : 1, offset: 0 };
	});
	const entryBytes = 24;
	let cursor = align8(32 + sections.length * entryBytes);
	for (const section of sections) { section.offset = cursor; cursor = align8(cursor + section.stored.length); }
	const output = new Uint8Array(cursor);
	output.set(Uint8Array.of(0x42, 0x4f, 0x4d, 0x43, 0x0d, 0x0a, 0x1a, 0x0a));
	const view = new DataView(output.buffer);
	view.setUint16(8, 1, true); view.setUint16(10, 2, true); view.setUint32(12, 0x01020304, true);
	view.setUint32(16, 1 | 0x10, true); view.setUint32(20, sections.length, true); view.setBigUint64(24, 32n, true);
	sections.forEach((section, index) => {
		let at = 32 + index * entryBytes;
		view.setUint16(at, section.type, true); at += 2; view.setUint8(at++, section.codec); view.setUint8(at++, 0);
		view.setUint32(at, section.offset, true); at += 4;
		view.setUint32(at, section.stored.length, true); at += 4;
		view.setUint32(at, section.bytes.length, true); at += 4;
		view.setUint32(at, section.count, true); at += 4;
		view.setUint32(at, crc32(section.stored), true);
		output.set(section.stored, section.offset);
	});
	return output;
}

function stringSection(values: string[]) {
	const encoded = values.map((value) => new TextEncoder().encode(value));
	const offsets = [0]; encoded.forEach((value) => offsets.push(offsets[offsets.length - 1] + value.length));
	return concat(Uint8Array.of(1, 0, 0, 0), packU32([values.length, offsets[offsets.length - 1]]), packU32(offsets), ...encoded);
}
function positionBlock(codec: number, payload: Uint8Array, origin: number[], scale: number[], count: number) { return concat(Uint8Array.of(1, codec, 0, 0), packU32([count, payload.length]), packF64(origin), packF64(scale), payload); }
function genericCodec(codec: number, count: number, payload: Uint8Array) { return concat(Uint8Array.of(1, codec, 0, 0), packU32([count, payload.length]), payload); }
function topologyBlock(loops: number[], triangles: number[]) {
	const loopBytes = deltaBytes(loops), triangleBytes = deltaBytes(triangles);
	return concat(Uint8Array.of(1, 0, 0, 0), packU32([loops.length, triangles.length, loopBytes.length, triangleBytes.length]), loopBytes, triangleBytes);
}
function deltaBytes(values: number[]) { let previous = 0; return concat(...values.map((value) => { const delta = value - previous; previous = value; return varuint(delta < 0 ? -delta * 2 - 1 : delta * 2); })); }
function varuint(value: number) { const bytes: number[] = []; do { let byte = value & 0x7f; value = Math.floor(value / 128); if (value) byte |= 0x80; bytes.push(byte); } while (value); return Uint8Array.from(bytes); }
function concat(...arrays: Uint8Array[]) { const result = new Uint8Array(arrays.reduce((sum, value) => sum + value.length, 0)); let cursor = 0; arrays.forEach((value) => { result.set(value, cursor); cursor += value.length; }); return result; }
function pack(values: number[], bytes: number, setter: (view: DataView, offset: number, value: number) => void) { const result = new Uint8Array(values.length * bytes); const view = new DataView(result.buffer); values.forEach((value, index) => setter(view, index * bytes, value)); return result; }
const packU32 = (values: number[]) => pack(values, 4, (view, offset, value) => view.setUint32(offset, value, true));
const packF32 = (values: number[]) => pack(values, 4, (view, offset, value) => view.setFloat32(offset, value, true));
const packF64 = (values: number[]) => pack(values, 8, (view, offset, value) => view.setFloat64(offset, value, true));
function align8(value: number) { return value + ((8 - value % 8) % 8); }
