import type { BomcGraph, BomcSnapshot, Definition, Face, GraphBounds, Instance, Mesh, SolidMaterial } from './types.js';
import { deriveGraphBounds } from './document.js';
import { BinaryReader, BinaryWriter, indexWidth, readVaruint, readZigzag, writeVaruint, writeZigzag } from './binary.js';
import { BomcDocumentError } from './document.js';

export type AdaptiveWidth = 1 | 2 | 4;
export type WriterLayout = Readonly<{
	strings: readonly string[];
	stringRows: ReadonlyMap<string, number>;
	materialIds: readonly string[];
	materialRows: ReadonlyMap<string, number>;
	definitionIds: readonly string[];
	definitionRows: ReadonlyMap<string, number>;
	meshIds: readonly string[];
	meshRows: ReadonlyMap<string, number>;
	faceIds: readonly string[];
	faceRows: ReadonlyMap<string, number>;
	instanceIds: readonly string[];
	instanceRows: ReadonlyMap<string, number>;
	stringWidth: AdaptiveWidth;
	materialWidth: AdaptiveWidth;
	definitionWidth: AdaptiveWidth;
	meshWidth: AdaptiveWidth;
	transformWidth: AdaptiveWidth;
}>;
export type EncodedSection = { raw: Uint8Array; count: number };

function compare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

function orderedDefinitions(graph: BomcGraph): Definition[] {
	return [...graph.definitions].sort((a, b) => a.id === graph.rootDefinitionId ? -1 : b.id === graph.rootDefinitionId ? 1 : compare(a.id, b.id));
}
function orderedInstances(graph: BomcGraph): Instance[] {
	return [...graph.instances].sort((a, b) => a.id === graph.rootInstanceId ? -1 : b.id === graph.rootInstanceId ? 1 : compare(a.id, b.id));
}
function orderedMaterials(graph: BomcGraph): SolidMaterial[] { return [...graph.materials].sort((a, b) => compare(a.id, b.id)); }
function orderedMeshes(graph: BomcGraph): Mesh[] {
	return [...graph.meshes].sort((a, b) => compare(a.id, b.id)).map((mesh) => ({ ...mesh, faces: [...mesh.faces].sort((a, b) => compare(a.id, b.id)) }));
}
function orderedFaces(meshes: readonly Mesh[]): Face[] { return meshes.flatMap((mesh) => [...mesh.faces]); }

function graphStrings(graph: BomcGraph): string[] {
	const values = new Set<string>([graph.documentId, graph.name]);
	for (const material of graph.materials) {
		values.add(material.id); values.add(material.name);
		if (material.displayName !== null) values.add(material.displayName);
	}
	for (const definition of graph.definitions) { values.add(definition.id); values.add(definition.name); }
	for (const mesh of graph.meshes) {
		values.add(mesh.id);
		for (const face of mesh.faces) {
			values.add(face.id);
			if (face.label !== null) values.add(face.label);
		}
	}
	for (const instance of graph.instances) {
		values.add(instance.id); values.add(instance.name);
		if (instance.label !== null) values.add(instance.label);
	}
	return [...values].sort(compare);
}

function mapRows(values: readonly string[]) { return new Map(values.map((value, index) => [value, index])); }

/** Layout retains only ordered IDs, dictionaries, and row maps, never graph records. */
export function deriveLayout(snapshot: BomcSnapshot): WriterLayout {
	const graph = snapshot.graph;
	const strings = graphStrings(graph);
	const materials = orderedMaterials(graph);
	const definitions = orderedDefinitions(graph);
	const meshes = orderedMeshes(graph);
	const faces = orderedFaces(meshes);
	const instances = orderedInstances(graph);
	return Object.freeze({
		strings: Object.freeze(strings),
		stringRows: mapRows(strings),
		materialIds: Object.freeze(materials.map((row) => row.id)), materialRows: mapRows(materials.map((row) => row.id)),
		definitionIds: Object.freeze(definitions.map((row) => row.id)), definitionRows: mapRows(definitions.map((row) => row.id)),
		meshIds: Object.freeze(meshes.map((row) => row.id)), meshRows: mapRows(meshes.map((row) => row.id)),
		faceIds: Object.freeze(faces.map((row) => row.id)), faceRows: mapRows(faces.map((row) => row.id)),
		instanceIds: Object.freeze(instances.map((row) => row.id)), instanceRows: mapRows(instances.map((row) => row.id)),
		stringWidth: indexWidth(strings.length), materialWidth: indexWidth(materials.length),
		definitionWidth: indexWidth(definitions.length), meshWidth: indexWidth(meshes.length), transformWidth: indexWidth(instances.length)
	});
}

export function requiredOutputSectionTypes(graph: BomcGraph): number[] {
	const types = [1, 2, 11, 12, 13, 17, 20, 241];
	if (graph.materials.length > 0) types.push(3);
	if (graph.meshes.length > 0) types.push(5, 6, 7, 8, 9, 14);
	return types.sort((a, b) => a - b);
}

function encode(writer: BinaryWriter, callback: (writer: BinaryWriter) => void): Uint8Array {
	callback(writer);
	return writer.finish();
}

function writeAdaptive(writer: BinaryWriter, value: number | null, width: AdaptiveWidth) {
	const sentinel = width === 1 ? 0xff : width === 2 ? 0xffff : 0xffffffff;
	const number = value === null ? sentinel : value;
	if (value !== null && (!Number.isSafeInteger(value) || value < 0 || number >= sentinel)) {
		throw new BomcDocumentError('RESOURCE_LIMIT', 'Adaptive row reference collides with its null sentinel.');
	}
	if (width === 1) writer.writeU8(number);
	else if (width === 2) writer.writeU16(number);
	else writer.writeU32(number);
}

function row(map: ReadonlyMap<string, number>, id: string | null, kind: string) {
	if (id === null) return null;
	const value = map.get(id);
	if (value === undefined) throw new BomcDocumentError('INTERNAL_ERROR', `${kind} reference ${id} is absent from the writer layout.`);
	return value;
}

function utf8(value: string) { return new TextEncoder().encode(value); }

function encodeStrings(layout: WriterLayout): EncodedSection {
	const values = layout.strings.map(utf8);
	const dataBytes = values.reduce((sum, value) => sum + value.byteLength, 0);
	const table = new BinaryWriter();
	table.writeU8(1); table.writeU8(0); table.writeU8(0); table.writeU8(0);
	table.writeU32(values.length); table.writeU32(dataBytes);
	let offset = 0;
	table.writeU32(0);
	for (const value of values) { offset += value.byteLength; table.writeU32(offset); }
	for (const value of values) table.writeBytes(value);
	return { raw: table.finish(), count: values.length };
}

function encodeMaterials(graph: BomcGraph, layout: WriterLayout): EncodedSection {
	const materials = orderedMaterials(graph);
	const writer = new BinaryWriter();
	writer.writeU8(2); writer.writeU8(layout.stringWidth); writer.writeU8(1); writer.writeU8(0);
	writer.writeU32(materials.length);
	for (const material of materials) writeAdaptive(writer, row(layout.stringRows, material.name, 'material name'), layout.stringWidth);
	for (const material of materials) writeAdaptive(writer, material.displayName === null ? null : row(layout.stringRows, material.displayName, 'material display name'), layout.stringWidth);
	for (const material of materials) for (const channel of material.rgba) writer.writeU8(channel);
	for (const material of materials) writer.writeU16(material.opacityU16);
	for (const _material of materials) writeAdaptive(writer, null, 1);
	for (const _material of materials) writer.writeF32(0);
	for (const _material of materials) writer.writeF32(0);
	for (const _material of materials) writer.writeU8(0);
	for (const _material of materials) writer.writeU8(0);
	for (const _material of materials) for (let axis = 0; axis < 3; axis += 1) writer.writeF64(0);
	for (const _material of materials) writer.writeZeros(32);
	return { raw: writer.finish(), count: materials.length };
}

function meshEdges(mesh: Mesh): Array<[number, number]> {
	const edges = new Map<string, [number, number]>();
	for (const face of [...mesh.faces].sort((a, b) => compare(a.id, b.id))) {
		for (const ring of [face.outer, ...face.holes]) {
			for (let index = 0; index < ring.length; index += 1) {
				const a = ring[index]!;
				const b = ring[(index + 1) % ring.length]!;
				const pair: [number, number] = a < b ? [a, b] : [b, a];
				edges.set(`${pair[0]}:${pair[1]}`, pair);
			}
		}
	}
	return [...edges.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function blockStream(blocks: readonly Uint8Array[]) {
	const writer = new BinaryWriter();
	const locations: Array<{ offset: number; length: number }> = [];
	for (const block of blocks) {
		writer.writeZeros((8 - writer.length % 8) % 8);
		const offset = writer.length;
		writer.writeBytes(block);
		locations.push({ offset, length: block.byteLength });
	}
	return { bytes: writer.finish(), locations };
}

function encodePositionBlock(mesh: Mesh) {
	const vertexCount = mesh.positions.length / 3;
	const payloadBytes = mesh.positions.length * 8;
	const writer = new BinaryWriter(52 + payloadBytes);
	writer.writeU8(1); writer.writeU8(1); writer.writeU8(0); writer.writeU8(0);
	writer.writeU32(vertexCount); writer.writeU32(payloadBytes);
	for (let value = 0; value < 6; value += 1) writer.writeF64(0);
	for (const coordinate of mesh.positions) writer.writeF64(coordinate);
	return writer.finish();
}

function varuintBytes(values: readonly number[], delta: boolean) {
	const writer = new BinaryWriter();
	let previous = 0;
	for (const value of values) {
		if (!delta) writeVaruint(writer, value);
		else { writeZigzag(writer, value - previous); previous = value; }
	}
	return writer.finish();
}

function encodeTopologyBlock(mesh: Mesh) {
	const rings = mesh.faces.flatMap((face) => [face.outer, ...face.holes]).flatMap((ring) => [...ring]);
	const triangles = mesh.faces.flatMap((face) => [...face.triangles]);
	const ringPayload = varuintBytes(rings, true);
	const trianglePayload = varuintBytes(triangles, true);
	const writer = new BinaryWriter(20 + ringPayload.byteLength + trianglePayload.byteLength);
	writer.writeU8(1); writer.writeU8(0); writer.writeU8(0); writer.writeU8(0);
	writer.writeU32(rings.length); writer.writeU32(triangles.length);
	writer.writeU32(ringPayload.byteLength); writer.writeU32(trianglePayload.byteLength);
	writer.writeBytes(ringPayload); writer.writeBytes(trianglePayload);
	return writer.finish();
}

function encodeMeshes(graph: BomcGraph, layout: WriterLayout, positions: ReturnType<typeof blockStream>, topology: ReturnType<typeof blockStream>, edgesByMesh: readonly (readonly [number, number][])[]): EncodedSection {
	const meshes = orderedMeshes(graph);
	const faces = orderedFaces(meshes);
	let faceStart = 0;
	let edgeStart = 0;
	const values: number[][] = [[], [], [], [], [], [], [], [], [], [], []];
	for (let index = 0; index < meshes.length; index += 1) {
		const mesh = meshes[index]!;
		const edgeCount = edgesByMesh[index]!.length;
		const positionBlock = positions.locations[index]!;
		const topologyBlock = topology.locations[index]!;
		const meshValues = [
			mesh.positions.length / 3, faceStart, mesh.faces.length, edgeStart, edgeCount,
			positionBlock.offset, positionBlock.length, topologyBlock.offset, topologyBlock.length, 0, 0
		];
		meshValues.forEach((value, column) => values[column]!.push(value));
		faceStart += mesh.faces.length;
		edgeStart += edgeCount;
	}
	const writer = new BinaryWriter();
	writer.writeU8(1); writer.writeU8(layout.definitionWidth); writer.writeU8(0); writer.writeU8(0);
	writer.writeU32(meshes.length);
	for (const mesh of meshes) writeAdaptive(writer, row(layout.definitionRows, mesh.definitionId, 'mesh definition'), layout.definitionWidth);
	for (const column of values) for (const value of column) writer.writeU32(value);
	return { raw: writer.finish(), count: meshes.length };
}

function encodeFaces(graph: BomcGraph, layout: WriterLayout): EncodedSection {
	const meshes = orderedMeshes(graph);
	const faces = orderedFaces(meshes);
	const totalRingCount = faces.reduce((sum, face) => sum + 1 + face.holes.length, 0);
	const ringCountWriter = new BinaryWriter();
	const triangleCountWriter = new BinaryWriter();
	const ringLengthWriter = new BinaryWriter();
	for (const face of faces) writeVaruint(ringCountWriter, 1 + face.holes.length);
	for (const face of faces) writeVaruint(triangleCountWriter, face.triangles.length);
	for (const face of faces) for (const ring of [face.outer, ...face.holes]) writeVaruint(ringLengthWriter, ring.length);
	const writer = new BinaryWriter();
	writer.writeU8(1); writer.writeU8(layout.materialWidth); writer.writeU8(1); writer.writeU8(layout.stringWidth);
	writer.writeU32(faces.length); writer.writeU32(totalRingCount);
	writer.writeU32(ringCountWriter.length); writer.writeU32(triangleCountWriter.length); writer.writeU32(ringLengthWriter.length);
	for (const face of faces) writer.writeU8(face.surfaceCode);
	for (const face of faces) writer.writeU8((face.hidden ? 1 : 0) | (face.holes.length ? 2 : 0));
	for (const face of faces) writer.writeU8(face.roleCode);
	for (const face of faces) writeAdaptive(writer, row(layout.materialRows, face.frontMaterialId, 'front material'), layout.materialWidth);
	for (const face of faces) writeAdaptive(writer, row(layout.materialRows, face.backMaterialId, 'back material'), layout.materialWidth);
	for (const _face of faces) writeAdaptive(writer, null, 1);
	for (const face of faces) writeAdaptive(writer, face.label === null ? null : row(layout.stringRows, face.label, 'face label'), layout.stringWidth);
	writer.writeBytes(ringCountWriter.finish()); writer.writeBytes(triangleCountWriter.finish()); writer.writeBytes(ringLengthWriter.finish());
	return { raw: writer.finish(), count: faces.length };
}

function encodePositions(meshes: readonly Mesh[], blocks: ReturnType<typeof blockStream>): EncodedSection {
	const writer = new BinaryWriter();
	for (let index = 0; index < meshes.length; index += 1) {
		writer.writeZeros((8 - writer.length % 8) % 8);
		writer.writeBytes(encodePositionBlock(meshes[index]!));
	}
	const raw = writer.finish();
	if (raw.byteLength !== blocks.bytes.byteLength) throw new BomcDocumentError('INTERNAL_ERROR', 'Position block layout changed while encoding.');
	return { raw, count: meshes.length };
}

function encodeTopology(meshes: readonly Mesh[], blocks: ReturnType<typeof blockStream>): EncodedSection {
	const writer = new BinaryWriter();
	for (let index = 0; index < meshes.length; index += 1) {
		writer.writeZeros((8 - writer.length % 8) % 8);
		writer.writeBytes(encodeTopologyBlock(meshes[index]!));
	}
	const raw = writer.finish();
	if (raw.byteLength !== blocks.bytes.byteLength) throw new BomcDocumentError('INTERNAL_ERROR', 'Topology block layout changed while encoding.');
	return { raw, count: meshes.length };
}

function encodeNormals(meshes: readonly Mesh[]): EncodedSection {
	const faces = orderedFaces(meshes);
	const writer = new BinaryWriter(8 + faces.length * 24);
	writer.writeU8(1); writer.writeU8(3); writer.writeU8(0); writer.writeU8(0);
	writer.writeU32(faces.length); writer.writeU32(faces.length * 24);
	for (const face of faces) for (const value of face.normal) writer.writeF64(value);
	return { raw: writer.finish(), count: faces.length };
}

function encodeDefinitions(graph: BomcGraph, layout: WriterLayout): EncodedSection {
	const definitions = orderedDefinitions(graph);
	const writer = new BinaryWriter();
	writer.writeU8(1); writer.writeU8(layout.stringWidth); writer.writeU8(layout.meshWidth); writer.writeU8(0);
	writer.writeU32(definitions.length);
	for (const definition of definitions) writeAdaptive(writer, row(layout.stringRows, definition.name, 'definition name'), layout.stringWidth);
	for (const definition of definitions) writer.writeU8(definition.kind === 'model' ? 1 : definition.kind === 'component' ? 2 : 3);
	for (const definition of definitions) writeAdaptive(writer, row(layout.meshRows, definition.meshId, 'definition mesh'), layout.meshWidth);
	return { raw: writer.finish(), count: definitions.length };
}

function encodeInstances(graph: BomcGraph, layout: WriterLayout): EncodedSection {
	const instances = orderedInstances(graph);
	const writer = new BinaryWriter();
	writer.writeU8(1); writer.writeU8(layout.stringWidth); writer.writeU8(layout.definitionWidth); writer.writeU8(layout.transformWidth);
	writer.writeU8(layout.materialWidth); writer.writeU8(1); writer.writeU8(0); writer.writeU8(0);
	writer.writeU32(instances.length);
	for (const instance of instances) writeAdaptive(writer, row(layout.stringRows, instance.name, 'instance name'), layout.stringWidth);
	for (const instance of instances) writer.writeU8(instance.kind === 'root' ? 1 : instance.kind === 'component' ? 2 : 3);
	for (const instance of instances) writeAdaptive(writer, row(layout.definitionRows, instance.ownerDefinitionId, 'instance owner'), layout.definitionWidth);
	for (const instance of instances) writeAdaptive(writer, row(layout.definitionRows, instance.definitionId, 'instance definition'), layout.definitionWidth);
	for (let index = 0; index < instances.length; index += 1) writeAdaptive(writer, index, layout.transformWidth);
	for (const instance of instances) writeAdaptive(writer, row(layout.materialRows, instance.materialId, 'instance material'), layout.materialWidth);
	for (const _instance of instances) writeAdaptive(writer, null, 1);
	for (const instance of instances) writer.writeU8(instance.visible ? 1 : 0);
	for (const instance of instances) writer.writeU8(instance.roleCode);
	for (const instance of instances) writeAdaptive(writer, instance.label === null ? null : row(layout.stringRows, instance.label, 'instance label'), layout.stringWidth);
	return { raw: writer.finish(), count: instances.length };
}

function encodeTransforms(graph: BomcGraph): EncodedSection {
	const instances = orderedInstances(graph);
	const writer = new BinaryWriter(8 + instances.length * 96);
	writer.writeU8(1); writer.writeU8(1); writer.writeU8(0); writer.writeU8(0);
	writer.writeU32(instances.length); writer.writeU32(instances.length * 96);
	for (const instance of instances) for (const index of [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14]) writer.writeF64(instance.matrix[index]!);
	return { raw: writer.finish(), count: instances.length };
}

function encodeEdges(edgesByMesh: readonly (readonly [number, number][])[]): EncodedSection {
	const totalEdges = edgesByMesh.reduce((sum, edges) => sum + edges.length, 0);
	const endpoints: number[] = [];
	for (const edges of edgesByMesh) for (const [start, end] of edges) endpoints.push(start, end);
	const payload = varuintBytes(endpoints, false);
	const writer = new BinaryWriter();
	writer.writeU8(1); writer.writeU8(1); writer.writeU8(0); writer.writeU8(0);
	writer.writeU32(totalEdges); writer.writeU32(payload.byteLength);
	for (let index = 0; index < totalEdges; index += 1) writeAdaptive(writer, null, 1);
	for (let index = 0; index < totalEdges; index += 1) writer.writeU8(0);
	writer.writeBytes(payload);
	return { raw: writer.finish(), count: totalEdges };
}

function encodeCoverage(faceCount: number): EncodedSection {
	const writer = new BinaryWriter(24);
	writer.writeU32(faceCount); writer.writeU32(faceCount);
	for (let index = 0; index < 4; index += 1) writer.writeU32(0);
	return { raw: writer.finish(), count: 1 };
}

function encodeEncodingContract(): EncodedSection {
	const writer = new BinaryWriter(76);
	writer.writeU16(1); writer.writeU8(1); writer.writeU8(0); writer.writeU64(0);
	writer.writeF64(0); writer.writeF64(0); writer.writeU64(0);
	for (let index = 0; index < 4; index += 1) writer.writeF64(0);
	writer.writeU8(1); writer.writeU8(1); writer.writeU8(1); writer.writeU8(1); writer.writeU32(1);
	return { raw: writer.finish(), count: 1 };
}

function encodeAuthoring(snapshot: BomcSnapshot, layout: WriterLayout): EncodedSection {
	const writer = new BinaryWriter();
	const graph = snapshot.graph;
	const meshes = orderedMeshes(graph);
	const faces = orderedFaces(meshes);
	const materials = orderedMaterials(graph);
	const definitions = orderedDefinitions(graph);
	const instances = orderedInstances(graph);
	writer.writeBytes(new TextEncoder().encode('BWEB'));
	writer.writeU16(1); writer.writeU8(layout.stringWidth); writer.writeU8(0);
	writer.writeU32(1); writer.writeU64(snapshot.revision);
	writeAdaptive(writer, row(layout.stringRows, graph.documentId, 'document ID'), layout.stringWidth);
	writer.writeU32(materials.length); writer.writeU32(definitions.length); writer.writeU32(meshes.length); writer.writeU32(faces.length); writer.writeU32(instances.length);
	for (const material of materials) writeAdaptive(writer, row(layout.stringRows, material.id, 'material ID'), layout.stringWidth);
	for (const definition of definitions) writeAdaptive(writer, row(layout.stringRows, definition.id, 'definition ID'), layout.stringWidth);
	for (const mesh of meshes) writeAdaptive(writer, row(layout.stringRows, mesh.id, 'mesh ID'), layout.stringWidth);
	for (const face of faces) writeAdaptive(writer, row(layout.stringRows, face.id, 'face ID'), layout.stringWidth);
	for (const instance of instances) writeAdaptive(writer, row(layout.stringRows, instance.id, 'instance ID'), layout.stringWidth);
	return { raw: writer.finish(), count: 1 };
}

function encodeModel(snapshot: BomcSnapshot, layout: WriterLayout, bounds: GraphBounds, edgesByMesh: readonly (readonly [number, number][])[]): EncodedSection {
	const graph = snapshot.graph;
	const meshes = orderedMeshes(graph);
	const totalFaces = meshes.reduce((sum, mesh) => sum + mesh.faces.length, 0);
	const totalEdges = edgesByMesh.reduce((sum, edges) => sum + edges.length, 0);
	const writer = new BinaryWriter();
	writer.writeU8(1); writer.writeU8(1); writer.writeU8(layout.stringWidth); writer.writeU8(5);
	writer.writeU32(0);
	for (const value of [...bounds.min, ...bounds.max]) writer.writeF64(value);
	for (const value of [graph.materials.length, 0, meshes.length, totalFaces, graph.definitions.length, graph.instances.length, graph.instances.length, 0, totalEdges]) writer.writeU32(value);
	writeAdaptive(writer, null, layout.stringWidth);
	writeAdaptive(writer, row(layout.stringRows, graph.name, 'document name'), layout.stringWidth);
	return { raw: writer.finish(), count: 1 };
}

export function encodeSection(type: number, snapshot: BomcSnapshot, layout: WriterLayout): EncodedSection {
	const graph = snapshot.graph;
	if (type === 2) return encodeStrings(layout);
	if (type === 3) return encodeMaterials(graph, layout);
	if (type === 11) return encodeDefinitions(graph, layout);
	if (type === 12) return encodeInstances(graph, layout);
	if (type === 13) return encodeTransforms(graph);
	if (type === 17) return encodeCoverage(graph.meshes.reduce((sum, mesh) => sum + mesh.faces.length, 0));
	if (type === 20) return encodeEncodingContract();
	if (type === 241) return encodeAuthoring(snapshot, layout);
	const meshes = orderedMeshes(graph);
	const edgesByMesh = meshes.map(meshEdges);
	if (type === 1) return encodeModel(snapshot, layout, deriveGraphBounds(graph), edgesByMesh);
	if (type === 5) {
		const positions = blockStream(meshes.map(encodePositionBlock));
		const topology = blockStream(meshes.map(encodeTopologyBlock));
		return encodeMeshes(graph, layout, positions, topology, edgesByMesh);
	}
	if (type === 6) return encodeFaces(graph, layout);
	if (type === 7) {
		const blocks = blockStream(meshes.map(encodePositionBlock));
		return encodePositions(meshes, blocks);
	}
	if (type === 8) {
		const blocks = blockStream(meshes.map(encodeTopologyBlock));
		return encodeTopology(meshes, blocks);
	}
	if (type === 9) return encodeNormals(meshes);
	if (type === 14) return encodeEdges(edgesByMesh);
	throw new BomcDocumentError('UNSUPPORTED_FEATURE', `BOMC section type ${type} cannot be encoded by web-core-v1.`);
}

export function encodeRawSection(type: number, snapshot: BomcSnapshot, layout: WriterLayout) {
	return encodeSection(type, snapshot, layout);
}

function readAdaptive(reader: BinaryReader, width: AdaptiveWidth): number | null {
	const value = width === 1 ? reader.readU8() : width === 2 ? reader.readU16() : reader.readU32();
	const sentinel = width === 1 ? 0xff : width === 2 ? 0xffff : 0xffffffff;
	return value === sentinel ? null : value;
}

function readStringRef(reader: BinaryReader, width: AdaptiveWidth, strings: readonly string[], nullable: boolean, path: string): string | null {
	const index = readAdaptive(reader, width);
	if (index === null) {
		if (!nullable) throw new BomcDocumentError('INVALID_SOURCE', `${path} is null.`);
		return null;
	}
	const value = strings[index];
	if (value === undefined) throw new BomcDocumentError('INVALID_SOURCE', `${path} references a missing string.`);
	return value;
}

function sumWireCounts(values: readonly number[], path: string) {
	let total = 0;
	for (const value of values) {
		total += value;
		if (!Number.isSafeInteger(total) || total > 0xffffffff) throw new BomcDocumentError('INVALID_SOURCE', `${path} count exceeds uint32 capacity.`);
	}
	return total;
}

function readVaruintStream(bytes: Uint8Array, count: number, delta: boolean, path: string) {
	if (!Number.isSafeInteger(count) || count < 0 || count > bytes.byteLength) throw new BomcDocumentError('INVALID_SOURCE', `${path} item count cannot fit its byte stream.`);
	const reader = new BinaryReader(bytes);
	const result = new Array<number>(count);
	let previous = 0;
	for (let index = 0; index < count; index += 1) {
		const value = delta ? previous + readZigzag(reader) : readVaruint(reader);
		if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new BomcDocumentError('INVALID_SOURCE', `${path} has an invalid decoded index.`);
		result[index] = value;
		if (delta) previous = value;
	}
	if (reader.remaining !== 0) throw new BomcDocumentError('INVALID_SOURCE', `${path} has unused bytes.`);
	return result;
}

function decodeStrings(bytes: Uint8Array): string[] {
	const reader = new BinaryReader(bytes);
	if (reader.readU8() !== 1 || reader.readU8() !== 0 || reader.readU8() !== 0 || reader.readU8() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'STRINGS section schema is unsupported.');
	const count = reader.readU32(); const dataBytes = reader.readU32();
	if (count > Math.floor(reader.remaining / 4) - 1 || dataBytes > reader.remaining - (count + 1) * 4) throw new BomcDocumentError('INVALID_SOURCE', 'STRINGS offsets or data exceed the section.');
	const offsets = new Array<number>(count + 1);
	for (let index = 0; index <= count; index += 1) offsets[index] = reader.readU32();
	if (offsets[0] !== 0 || offsets[count] !== dataBytes || offsets.some((value, index) => index > 0 && value < offsets[index - 1]!)) throw new BomcDocumentError('INVALID_SOURCE', 'STRINGS offsets are invalid.');
	const payload = reader.readBytes(dataBytes);
	if (reader.remaining !== 0) throw new BomcDocumentError('INVALID_SOURCE', 'STRINGS section has trailing bytes.');
	const decoder = new TextDecoder('utf-8', { fatal: true });
	try {
		const values = Array.from({ length: count }, (_, index) => decoder.decode(payload.subarray(offsets[index]!, offsets[index + 1]!)));
		for (let index = 1; index < values.length; index += 1) if (compare(values[index - 1]!, values[index]!) >= 0) throw new BomcDocumentError('INVALID_SOURCE', 'STRINGS rows are duplicated or unsorted.');
		return values;
	}
	catch (error) { throw new BomcDocumentError('INVALID_SOURCE', 'STRINGS contains invalid UTF-8.', error); }
}

function sectionReader(sections: ReadonlyMap<number, Uint8Array>, type: number): BinaryReader {
	const bytes = sections.get(type);
	if (!bytes) throw new BomcDocumentError('INVALID_SOURCE', `Required section ${type} is missing.`);
	return new BinaryReader(bytes);
}

/** Decode the declared authoring subset without using any rendering/Float32 importer. */
export function decodeWebGraph(sections: ReadonlyMap<number, Uint8Array>, revision: number): BomcGraph {
	const modelReader = sectionReader(sections, 1);
	if (modelReader.readU8() !== 1 || modelReader.readU8() !== 1) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'MODEL profile is unsupported.');
	const stringWidth = modelReader.readU8() as AdaptiveWidth;
	if (![1, 2, 4].includes(stringWidth) || modelReader.readU8() !== 5) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'MODEL coordinate contract is unsupported.');
	if (modelReader.readU32() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'Nonzero MODEL root-node rows are unsupported.');
	const modelBounds = Array.from({ length: 6 }, () => modelReader.readF64());
	if (modelBounds.some((value) => !Number.isFinite(value))) throw new BomcDocumentError('INVALID_SOURCE', 'MODEL bounds are non-finite.');
	const counts = Array.from({ length: 9 }, () => modelReader.readU32());
	const nullSourceName = readAdaptive(modelReader, stringWidth);
	const modelNameRow = readAdaptive(modelReader, stringWidth);
	if (nullSourceName !== null || modelNameRow === null || modelReader.remaining !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'MODEL source/name fields are outside web-core-v1.');

	const strings = decodeStrings(sections.get(2)!);
	const modelName = strings[modelNameRow];
	if (modelName === undefined) throw new BomcDocumentError('INVALID_SOURCE', 'MODEL name references a missing string.');
	const authorReader = sectionReader(sections, 241);
	if (new TextDecoder().decode(authorReader.readBytes(4)) !== 'BWEB' || authorReader.readU16() !== 1) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'AUTHORING schema is unsupported.');
	const authorStringWidth = authorReader.readU8() as AdaptiveWidth;
	if (![1, 2, 4].includes(authorStringWidth) || authorStringWidth !== stringWidth || authorReader.readU8() !== 0 || authorReader.readU32() !== 1) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'AUTHORING capability is unsupported.');
	const storedRevision = authorReader.readU64();
	if (storedRevision !== revision) throw new BomcDocumentError('INVALID_SOURCE', 'AUTHORING revision differs from the reader admission value.');
	const documentId = readStringRef(authorReader, stringWidth, strings, false, 'AUTHORING document ID')!;
	const authorCounts = Array.from({ length: 5 }, () => authorReader.readU32());
	const [materialCount, definitionCount, meshCount, faceCount, instanceCount] = authorCounts;
	const authorIdCount = authorCounts.reduce((sum, count) => sum + count, 0);
	if (!Number.isSafeInteger(authorIdCount) || authorIdCount > Math.floor(authorReader.remaining / stringWidth)) throw new BomcDocumentError('INVALID_SOURCE', 'AUTHORING ID tables exceed the section.');
	const readIds = (count: number, label: string) => Array.from({ length: count }, (_, index) => readStringRef(authorReader, stringWidth, strings, false, `${label}[${index}]`)!);
	const materialIds = readIds(materialCount!, 'material ID');
	const definitionIds = readIds(definitionCount!, 'definition ID');
	const meshIds = readIds(meshCount!, 'mesh ID');
	const faceIds = readIds(faceCount!, 'face ID');
	const instanceIds = readIds(instanceCount!, 'instance ID');
	if (authorReader.remaining !== 0) throw new BomcDocumentError('INVALID_SOURCE', 'AUTHORING section has unused bytes.');
	if (authorCounts.some((count, index) => count !== counts[[0, 4, 2, 3, 5][index]!])) throw new BomcDocumentError('INVALID_SOURCE', 'AUTHORING counts disagree with MODEL.');
	for (let index = 1; index < materialIds.length; index += 1) if (compare(materialIds[index - 1]!, materialIds[index]!) >= 0) throw new BomcDocumentError('INVALID_SOURCE', 'AUTHORING material IDs are not in canonical row order.');
	for (let index = 1; index < meshIds.length; index += 1) if (compare(meshIds[index - 1]!, meshIds[index]!) >= 0) throw new BomcDocumentError('INVALID_SOURCE', 'AUTHORING mesh IDs are not in canonical row order.');

	let materials: SolidMaterial[] = [];
	if (materialCount! > 0) {
		const reader = sectionReader(sections, 3);
		if (reader.readU8() !== 2) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'MATERIALS schema is unsupported.');
		const width = reader.readU8() as AdaptiveWidth;
		if (![1, 2, 4].includes(width) || width !== stringWidth || reader.readU8() !== 1 || reader.readU8() !== 0 || reader.readU32() !== materialCount) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'MATERIALS fields are outside web-core-v1.');
		if (materialCount! > Math.floor(reader.remaining / 75)) throw new BomcDocumentError('INVALID_SOURCE', 'MATERIALS rows exceed the section.');
		const names = Array.from({ length: materialCount! }, (_, index) => readStringRef(reader, width, strings, false, `MATERIALS name ${index}`)!);
		const displayNames = Array.from({ length: materialCount! }, (_, index) => readStringRef(reader, width, strings, true, `MATERIALS display name ${index}`));
		const colors = Array.from({ length: materialCount! }, () => [reader.readU8(), reader.readU8(), reader.readU8(), reader.readU8()] as [number, number, number, number]);
		const opacities = Array.from({ length: materialCount! }, () => reader.readU16());
		for (let index = 0; index < materialCount!; index += 1) {
			if (readAdaptive(reader, 1) !== null) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'Textured MATERIALS rows are not editable.');
		}
		for (let index = 0; index < materialCount! * 2; index += 1) if (reader.readF32() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'MATERIALS texture size is unsupported.');
		for (let index = 0; index < materialCount! * 2; index += 1) if (reader.readU8() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'MATERIALS semantic fields are unsupported.');
		for (let index = 0; index < materialCount! * 3; index += 1) if (reader.readF64() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'MATERIALS semantic deltas are unsupported.');
		for (let index = 0; index < materialCount! * 32; index += 1) if (reader.readU8() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'MATERIALS hash fields are unsupported.');
		if (reader.remaining !== 0) throw new BomcDocumentError('INVALID_SOURCE', 'MATERIALS has trailing bytes.');
		materials = materialIds.map((id, index) => ({ id, name: names[index]!, displayName: displayNames[index]!, rgba: colors[index]!, opacityU16: opacities[index]! }));
	} else if (sections.has(3)) throw new BomcDocumentError('INVALID_SOURCE', 'MATERIALS section is present with a zero MODEL count.');

	const definitionsReader = sectionReader(sections, 11);
	if (definitionsReader.readU8() !== 1) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'DEFINITIONS schema is unsupported.');
	const defStringWidth = definitionsReader.readU8() as AdaptiveWidth;
	const meshWidth = definitionsReader.readU8() as AdaptiveWidth;
	if (defStringWidth !== stringWidth || ![1, 2, 4].includes(meshWidth) || definitionsReader.readU8() !== 0 || definitionsReader.readU32() !== definitionCount) throw new BomcDocumentError('INVALID_SOURCE', 'DEFINITIONS header/count is invalid.');
	if (definitionCount! > Math.floor(definitionsReader.remaining / 3)) throw new BomcDocumentError('INVALID_SOURCE', 'DEFINITIONS rows exceed the section.');
	const definitionNames = Array.from({ length: definitionCount! }, (_, index) => readStringRef(definitionsReader, stringWidth, strings, false, `DEFINITIONS name ${index}`)!);
	const definitionKinds = Array.from({ length: definitionCount! }, () => definitionsReader.readU8());
	const definitionMeshes = Array.from({ length: definitionCount! }, (_, index) => readAdaptive(definitionsReader, meshWidth));
	if (definitionsReader.remaining !== 0) throw new BomcDocumentError('INVALID_SOURCE', 'DEFINITIONS has trailing bytes.');
	const rootDefinitionRow = definitionKinds.indexOf(1);
	if (rootDefinitionRow !== 0 || definitionKinds.filter((kind) => kind === 1).length !== 1) throw new BomcDocumentError('INVALID_SOURCE', 'DEFINITIONS root row is not canonical.');
	const definitionIdsByMesh = new Map<number, string>();
	for (let index = 0; index < definitionCount!; index += 1) {
		const meshRow = definitionMeshes[index]!;
		if (meshRow !== null) {
			if (meshRow < 0 || meshRow >= meshCount! || definitionIdsByMesh.has(meshRow)) throw new BomcDocumentError('INVALID_SOURCE', 'DEFINITIONS mesh reference is invalid or duplicated.');
			definitionIdsByMesh.set(meshRow, definitionIds[index]!);
		}
		if (index > 1 && compare(definitionIds[index - 1]!, definitionIds[index]!) >= 0) throw new BomcDocumentError('INVALID_SOURCE', 'DEFINITIONS non-root rows are not in canonical ID order.');
	}
	const definitions: Definition[] = definitionIds.map((id, index) => {
		const kind = definitionKinds[index] === 1 ? 'model' : definitionKinds[index] === 2 ? 'component' : definitionKinds[index] === 3 ? 'group' : null;
		if (!kind) throw new BomcDocumentError('UNSUPPORTED_FEATURE', `DEFINITIONS kind ${definitionKinds[index]} is unsupported.`);
		const meshRow = definitionMeshes[index]!;
		return { id, name: definitionNames[index]!, kind, meshId: meshRow === null ? null : meshIds[meshRow] ?? null };
	});

	const meshHeaders: Array<{ definitionRow: number; vertexCount: number; faceStart: number; faceCount: number; edgeStart: number; edgeCount: number; positionOffset: number; positionLength: number; topologyOffset: number; topologyLength: number; uvOffset: number; uvLength: number }> = [];
	if (meshCount! > 0) {
		const reader = sectionReader(sections, 5);
		if (reader.readU8() !== 1) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'MESHES schema is unsupported.');
		const defWidth = reader.readU8() as AdaptiveWidth;
		if (!([1, 2, 4] as number[]).includes(defWidth) || defWidth !== indexWidth(definitionCount!) || reader.readU8() !== 0 || reader.readU8() !== 0 || reader.readU32() !== meshCount) throw new BomcDocumentError('INVALID_SOURCE', 'MESHES header/count is invalid.');
		if (meshCount! > Math.floor(reader.remaining / 45)) throw new BomcDocumentError('INVALID_SOURCE', 'MESHES rows exceed the section.');
		const definitionRows = Array.from({ length: meshCount! }, () => readAdaptive(reader, defWidth));
		const columns = Array.from({ length: 11 }, () => Array.from({ length: meshCount! }, () => reader.readU32()));
		if (reader.remaining !== 0) throw new BomcDocumentError('INVALID_SOURCE', 'MESHES has trailing bytes.');
		for (let index = 0; index < meshCount!; index += 1) {
			meshHeaders.push({ definitionRow: definitionRows[index]!, vertexCount: columns[0]![index]!, faceStart: columns[1]![index]!, faceCount: columns[2]![index]!, edgeStart: columns[3]![index]!, edgeCount: columns[4]![index]!, positionOffset: columns[5]![index]!, positionLength: columns[6]![index]!, topologyOffset: columns[7]![index]!, topologyLength: columns[8]![index]!, uvOffset: columns[9]![index]!, uvLength: columns[10]![index]! });
		}
	}
	const positionsBytes = meshCount! > 0 ? sections.get(7)! : null;
	const topologyBytes = meshCount! > 0 ? sections.get(8)! : null;
	const facesReader = meshCount! > 0 ? sectionReader(sections, 6) : null;
	let faceSurface: number[] = []; let faceFlags: number[] = []; let faceRoles: number[] = [];
	let frontMaterials: Array<number | null> = []; let backMaterials: Array<number | null> = []; let faceLabels: Array<number | null> = [];
	let ringCounts: number[] = []; let triangleCounts: number[] = []; let ringLengths: number[] = [];
	let ringCountBytes = 0; let triangleCountBytes = 0; let ringLengthBytes = 0; let totalRingCount = 0; let totalRingItems = 0; let totalTriangleItems = 0;
	if (facesReader) {
		if (facesReader.readU8() !== 1) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'FACES schema is unsupported.');
		const materialWidth = facesReader.readU8() as AdaptiveWidth;
		if (materialWidth !== indexWidth(materialCount!) || facesReader.readU8() !== 1 || facesReader.readU8() !== stringWidth) throw new BomcDocumentError('INVALID_SOURCE', 'FACES widths are invalid.');
		const faceRows = facesReader.readU32(); totalRingCount = facesReader.readU32(); ringCountBytes = facesReader.readU32(); triangleCountBytes = facesReader.readU32(); ringLengthBytes = facesReader.readU32();
		if (faceRows !== faceCount) throw new BomcDocumentError('INVALID_SOURCE', 'FACES count differs from MODEL.');
		if (faceRows > Math.floor(facesReader.remaining / 8) || ringCountBytes > facesReader.remaining || triangleCountBytes > facesReader.remaining - ringCountBytes || ringLengthBytes > facesReader.remaining - ringCountBytes - triangleCountBytes) throw new BomcDocumentError('INVALID_SOURCE', 'FACES tables exceed the section.');
		if (totalRingCount > ringLengthBytes) throw new BomcDocumentError('INVALID_SOURCE', 'FACES ring count cannot fit its length stream.');
		faceSurface = Array.from({ length: faceRows }, () => facesReader.readU8()); faceFlags = Array.from({ length: faceRows }, () => facesReader.readU8()); faceRoles = Array.from({ length: faceRows }, () => facesReader.readU8());
		frontMaterials = Array.from({ length: faceRows }, () => readAdaptive(facesReader, materialWidth));
		backMaterials = Array.from({ length: faceRows }, () => readAdaptive(facesReader, materialWidth));
		for (let index = 0; index < faceRows; index += 1) if (readAdaptive(facesReader, 1) !== null) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'FACES tags are unsupported.');
		faceLabels = Array.from({ length: faceRows }, () => readAdaptive(facesReader, stringWidth));
		ringCounts = readVaruintStream(facesReader.readBytes(ringCountBytes), faceRows, false, 'FACES ring counts');
		triangleCounts = readVaruintStream(facesReader.readBytes(triangleCountBytes), faceRows, false, 'FACES triangle counts');
		const totalTriangleIndices = sumWireCounts(triangleCounts, 'FACES triangle indices');
		ringLengths = readVaruintStream(facesReader.readBytes(ringLengthBytes), totalRingCount, false, 'FACES ring lengths');
		if (facesReader.remaining !== 0) throw new BomcDocumentError('INVALID_SOURCE', 'FACES has trailing bytes.');
		totalRingItems = sumWireCounts(ringLengths, 'FACES ring indices');
		totalTriangleItems = totalTriangleIndices;
	}

	const normalsReader = meshCount! > 0 ? sectionReader(sections, 9) : null;
	let normals: Array<[number, number, number]> = [];
	if (normalsReader) {
		if (normalsReader.readU8() !== 1 || normalsReader.readU8() !== 3 || normalsReader.readU8() !== 0 || normalsReader.readU8() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'NORMALS codec is unsupported.');
		const normalCount = normalsReader.readU32(); const payloadBytes = normalsReader.readU32();
		if (normalCount !== faceCount || payloadBytes !== normalCount * 24 || normalsReader.remaining !== payloadBytes) throw new BomcDocumentError('INVALID_SOURCE', 'NORMALS count/length is invalid.');
		normals = Array.from({ length: normalCount }, () => [normalsReader.readF64(), normalsReader.readF64(), normalsReader.readF64()]);
	}

	const meshes: Mesh[] = [];
	let faceCursor = 0; let ringCursor = 0; let ringItemCursor = 0; let triangleItemCursor = 0;
	let positionEnd = 0; let topologyEnd = 0;
	for (let meshIndex = 0; meshIndex < meshHeaders.length; meshIndex += 1) {
		const header = meshHeaders[meshIndex]!;
		if (header.uvOffset !== 0 || header.uvLength !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'UV streams are not editable.');
		if (!positionsBytes || !topologyBytes || header.positionOffset !== Math.ceil(positionEnd / 8) * 8 || header.topologyOffset !== Math.ceil(topologyEnd / 8) * 8) throw new BomcDocumentError('INVALID_SOURCE', `MESHES row ${meshIndex} has a noncanonical block offset.`);
		for (const [payload, start, end] of [[positionsBytes, positionEnd, header.positionOffset], [topologyBytes, topologyEnd, header.topologyOffset]] as const) {
			for (let offset = start; offset < end; offset += 1) if (payload[offset] !== 0) throw new BomcDocumentError('INVALID_SOURCE', 'Geometry-block alignment padding must be zero.');
		}
		if (header.positionLength < 60 || header.topologyLength < 16) throw new BomcDocumentError('INVALID_SOURCE', `MESHES row ${meshIndex} has a truncated geometry block.`);
		const positionBlockReader = new BinaryReader(positionsBytes, header.positionOffset, header.positionLength);
		if (positionBlockReader.readU8() !== 1 || positionBlockReader.readU8() !== 1 || positionBlockReader.readU8() !== 0 || positionBlockReader.readU8() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'POSITIONS codec is unsupported.');
		const vertexCount = positionBlockReader.readU32(); const positionPayloadBytes = positionBlockReader.readU32();
		for (let field = 0; field < 6; field += 1) if (positionBlockReader.readF64() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'POSITIONS origin/scale is unsupported.');
		if (vertexCount > Math.floor(positionBlockReader.remaining / 24)) throw new BomcDocumentError('INVALID_SOURCE', `POSITIONS mesh ${meshIndex} vertex count exceeds its block.`);
		if (vertexCount !== header.vertexCount || positionPayloadBytes !== vertexCount * 24 || positionBlockReader.remaining !== positionPayloadBytes) throw new BomcDocumentError('INVALID_SOURCE', `POSITIONS mesh ${meshIndex} length is invalid.`);
		const positions = Array.from({ length: vertexCount * 3 }, () => positionBlockReader.readF64());
		positionEnd = header.positionOffset + header.positionLength;
		const topologyBlockReader = new BinaryReader(topologyBytes, header.topologyOffset, header.topologyLength);
		if (topologyBlockReader.readU8() !== 1 || topologyBlockReader.readU8() !== 0 || topologyBlockReader.readU8() !== 0 || topologyBlockReader.readU8() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'TOPOLOGY schema is unsupported.');
		const ringIndexCount = topologyBlockReader.readU32(); const triangleIndexCount = topologyBlockReader.readU32(); const ringPayloadBytes = topologyBlockReader.readU32(); const trianglePayloadBytes = topologyBlockReader.readU32();
		if (ringPayloadBytes > topologyBlockReader.remaining || trianglePayloadBytes > topologyBlockReader.remaining - ringPayloadBytes || ringIndexCount > ringPayloadBytes || triangleIndexCount > trianglePayloadBytes) throw new BomcDocumentError('INVALID_SOURCE', `TOPOLOGY mesh ${meshIndex} streams exceed their block.`);
		if (header.faceStart !== faceCursor || header.faceCount < 1) throw new BomcDocumentError('INVALID_SOURCE', 'MESHES face ranges are not contiguous.');
		const meshFaceRows = Array.from({ length: header.faceCount }, (_, index) => faceCursor + index);
		const meshRingCounts = ringCounts.slice(faceCursor, faceCursor + header.faceCount);
		const meshTriangleCounts = triangleCounts.slice(faceCursor, faceCursor + header.faceCount);
		const numberRings = meshRingCounts.reduce((sum, value) => sum + value, 0);
		const meshRingLengths = ringLengths.slice(ringCursor, ringCursor + numberRings);
		const ringValues = readVaruintStream(topologyBlockReader.readBytes(ringPayloadBytes), ringIndexCount, true, `TOPOLOGY rings ${meshIndex}`);
		const triangleValues = readVaruintStream(topologyBlockReader.readBytes(trianglePayloadBytes), triangleIndexCount, true, `TOPOLOGY triangles ${meshIndex}`);
		if (topologyBlockReader.remaining !== 0 || ringIndexCount !== meshRingLengths.reduce((sum, value) => sum + value, 0) || triangleIndexCount !== meshTriangleCounts.reduce((sum, value) => sum + value, 0)) throw new BomcDocumentError('INVALID_SOURCE', `TOPOLOGY mesh ${meshIndex} counts are inconsistent.`);
		const faces: Face[] = [];
		let currentRing = 0; let currentRingItem = 0; let currentTriangleItem = 0;
		for (const faceRow of meshFaceRows) {
			const faceRingCount = meshRingCounts[faceRow - faceCursor]!;
			const lengths = meshRingLengths.slice(currentRing, currentRing + faceRingCount);
			const rings: number[][] = [];
			for (const length of lengths) {
				rings.push(ringValues.slice(currentRingItem, currentRingItem + length));
				currentRingItem += length;
			}
			currentRing += faceRingCount;
			const triangleLength = meshTriangleCounts[faceRow - faceCursor]!;
			const triangleIndices = triangleValues.slice(currentTriangleItem, currentTriangleItem + triangleLength);
			currentTriangleItem += triangleLength;
			const front = frontMaterials[faceRow]!;
			const back = backMaterials[faceRow]!;
			const label = faceLabels[faceRow]!;
			if (front !== null && (front < 0 || front >= materialIds.length)) throw new BomcDocumentError('INVALID_SOURCE', `FACES row ${faceRow} has an invalid front material reference.`);
			if (back !== null && (back < 0 || back >= materialIds.length)) throw new BomcDocumentError('INVALID_SOURCE', `FACES row ${faceRow} has an invalid back material reference.`);
			if (label !== null && (label < 0 || label >= strings.length)) throw new BomcDocumentError('INVALID_SOURCE', `FACES row ${faceRow} has an invalid label reference.`);
			if (faceRingCount < 1 || faceRingCount > ringLengths.length || triangleLength < 3 || triangleLength % 3 !== 0) throw new BomcDocumentError('INVALID_SOURCE', `FACES row ${faceRow} has invalid topology lengths.`);
			faces.push({
				id: faceIds[faceRow]!, outer: rings[0] ?? [], holes: rings.slice(1), triangles: triangleIndices,
				normal: normals[faceRow]!, frontMaterialId: front === null ? null : materialIds[front] ?? null,
				backMaterialId: back === null ? null : materialIds[back] ?? null,
				hidden: (faceFlags[faceRow]! & 1) !== 0, surfaceCode: faceSurface[faceRow]!, roleCode: faceRoles[faceRow]!,
				label: label === null ? null : strings[label] ?? null
			});
			if (rings.length !== faceRingCount || !faceRingCount || triangleLength % 3 !== 0) throw new BomcDocumentError('INVALID_SOURCE', `FACES row ${faceRow} is incomplete.`);
			if ((faceFlags[faceRow]! & ~3) !== 0 || ((faceFlags[faceRow]! & 2) !== 0) !== (faceRingCount > 1)) throw new BomcDocumentError('UNSUPPORTED_FEATURE', `FACES row ${faceRow} flags are unsupported.`);
			if (faceRow > faceCursor && compare(faceIds[faceRow - 1]!, faceIds[faceRow]!) >= 0) throw new BomcDocumentError('INVALID_SOURCE', 'FACES IDs are not sorted within a mesh.');
		}
		const definitionId = header.definitionRow === null ? null : definitionIds[header.definitionRow] ?? null;
		if (!definitionId || header.definitionRow === null || header.definitionRow < 0 || header.definitionRow >= definitionIds.length || definitionIdsByMesh.get(meshIndex) !== definitionId) throw new BomcDocumentError('INVALID_SOURCE', `MESHES row ${meshIndex} definition mapping is invalid.`);
		meshes.push({ id: meshIds[meshIndex]!, definitionId, positions, faces });
		topologyEnd = header.topologyOffset + header.topologyLength;
		faceCursor += header.faceCount;
		ringCursor += numberRings;
		ringItemCursor += ringIndexCount;
		triangleItemCursor += triangleIndexCount;
	}
	if (faceCursor !== faceCount || ringCursor !== totalRingCount || ringItemCursor !== totalRingItems || triangleItemCursor !== totalTriangleItems) throw new BomcDocumentError('INVALID_SOURCE', 'FACES/MESHES topology totals are inconsistent.');
	if (positionsBytes && positionEnd !== positionsBytes.byteLength) throw new BomcDocumentError('INVALID_SOURCE', 'POSITIONS has trailing or unclaimed bytes.');
	if (topologyBytes && topologyEnd !== topologyBytes.byteLength) throw new BomcDocumentError('INVALID_SOURCE', 'TOPOLOGY has trailing or unclaimed bytes.');
	if (positionsBytes && meshHeaders.length === 0) throw new BomcDocumentError('INVALID_SOURCE', 'POSITIONS is present without meshes.');
	if (topologyBytes && meshHeaders.length === 0) throw new BomcDocumentError('INVALID_SOURCE', 'TOPOLOGY is present without meshes.');

	const instancesReader = sectionReader(sections, 12);
	if (instancesReader.readU8() !== 1) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'INSTANCES schema is unsupported.');
	const instanceStringWidth = instancesReader.readU8() as AdaptiveWidth;
	const instanceDefinitionWidth = instancesReader.readU8() as AdaptiveWidth;
	const transformWidth = instancesReader.readU8() as AdaptiveWidth;
	const instanceMaterialWidth = instancesReader.readU8() as AdaptiveWidth;
	if (instanceStringWidth !== stringWidth || instanceDefinitionWidth !== indexWidth(definitionCount!) || transformWidth !== indexWidth(instanceCount!) || instanceMaterialWidth !== indexWidth(materialCount!) || instancesReader.readU8() !== 1 || instancesReader.readU8() !== 0 || instancesReader.readU8() !== 0 || instancesReader.readU32() !== instanceCount) throw new BomcDocumentError('INVALID_SOURCE', 'INSTANCES header/count is invalid.');
	if (instanceCount! > Math.floor(instancesReader.remaining / 10)) throw new BomcDocumentError('INVALID_SOURCE', 'INSTANCES rows exceed the section.');
	const instanceNames = Array.from({ length: instanceCount! }, (_, index) => readStringRef(instancesReader, stringWidth, strings, false, `INSTANCES name ${index}`)!);
	const instanceKinds = Array.from({ length: instanceCount! }, () => instancesReader.readU8());
	const owners = Array.from({ length: instanceCount! }, () => readAdaptive(instancesReader, instanceDefinitionWidth));
	const targets = Array.from({ length: instanceCount! }, () => readAdaptive(instancesReader, instanceDefinitionWidth));
	const transforms = Array.from({ length: instanceCount! }, () => readAdaptive(instancesReader, transformWidth));
	const instanceMaterials = Array.from({ length: instanceCount! }, () => readAdaptive(instancesReader, instanceMaterialWidth));
	for (let index = 0; index < instanceCount!; index += 1) if (readAdaptive(instancesReader, 1) !== null) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'Instance tags are unsupported.');
	const visible = Array.from({ length: instanceCount! }, () => instancesReader.readU8());
	const roles = Array.from({ length: instanceCount! }, () => instancesReader.readU8());
	const labels = Array.from({ length: instanceCount! }, () => readAdaptive(instancesReader, stringWidth));
	if (instancesReader.remaining !== 0) throw new BomcDocumentError('INVALID_SOURCE', 'INSTANCES has trailing bytes.');
	const transformsReader = sectionReader(sections, 13);
	if (transformsReader.readU8() !== 1 || transformsReader.readU8() !== 1 || transformsReader.readU8() !== 0 || transformsReader.readU8() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'TRANSFORMS codec is unsupported.');
	const transformCount = transformsReader.readU32(); const transformPayloadBytes = transformsReader.readU32();
	if (transformCount !== instanceCount || transformPayloadBytes !== transformCount * 96 || transformsReader.remaining !== transformPayloadBytes) throw new BomcDocumentError('INVALID_SOURCE', 'TRANSFORMS count/length is invalid.');
	const matrixColumns = Array.from({ length: transformCount }, () => Array.from({ length: 12 }, () => transformsReader.readF64()));
	const matrixIndexSlots = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14];
	const matrices = matrixColumns.map((columns) => {
		const matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
		matrixIndexSlots.forEach((slot, index) => { matrix[slot] = columns[index]!; });
		return matrix;
	});
	const instances: Instance[] = instanceIds.map((id, index) => {
		const kind = instanceKinds[index] === 1 ? 'root' : instanceKinds[index] === 2 ? 'component' : instanceKinds[index] === 3 ? 'group' : null;
		if (!kind) throw new BomcDocumentError('UNSUPPORTED_FEATURE', `INSTANCES kind ${instanceKinds[index]} is unsupported.`);
		if (transforms[index] !== index) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'Deduplicated or permuted transforms are unsupported.');
		const owner = owners[index] === null ? null : definitionIds[owners[index]!] ?? null;
		const definitionId = targets[index] === null ? null : definitionIds[targets[index]!] ?? null;
		const materialId = instanceMaterials[index] === null ? null : materialIds[instanceMaterials[index]!] ?? null;
		const label = labels[index] === null ? null : strings[labels[index]!] ?? null;
		if (owners[index] !== null && owner === null) throw new BomcDocumentError('INVALID_SOURCE', `INSTANCES row ${index} has an invalid owner reference.`);
		if (targets[index] === null || definitionId === null) throw new BomcDocumentError('INVALID_SOURCE', `INSTANCES row ${index} has an invalid definition reference.`);
		if (instanceMaterials[index] !== null && materialId === null) throw new BomcDocumentError('INVALID_SOURCE', `INSTANCES row ${index} has an invalid material reference.`);
		if (labels[index] !== null && label === null) throw new BomcDocumentError('INVALID_SOURCE', `INSTANCES row ${index} has an invalid label reference.`);
		if (!definitionId || visible[index]! > 1) throw new BomcDocumentError('INVALID_SOURCE', `INSTANCES row ${index} has an invalid reference or visibility flag.`);
		return { id, name: instanceNames[index]!, kind, ownerDefinitionId: owner, definitionId, matrix: matrices[index]!, materialId, visible: visible[index] === 1, roleCode: roles[index]!, label };
	});

	const rootDefinitionId = definitionIds.find((id, index) => definitions[index]!.kind === 'model');
	const rootInstanceId = instanceIds.find((id, index) => instances[index]!.kind === 'root');
	if (!rootDefinitionId || !rootInstanceId) throw new BomcDocumentError('INVALID_SOURCE', 'Editable graph root rows are missing.');
	if (instances[0]?.kind !== 'root' || instances.filter((instance) => instance.kind === 'root').length !== 1) throw new BomcDocumentError('INVALID_SOURCE', 'INSTANCES root row is not canonical.');
	for (let index = 2; index < instanceIds.length; index += 1) if (compare(instanceIds[index - 1]!, instanceIds[index]!) >= 0) throw new BomcDocumentError('INVALID_SOURCE', 'INSTANCES non-root rows are not in canonical ID order.');
	const graph: BomcGraph = { documentId, name: modelName, rootDefinitionId, rootInstanceId, materials, definitions, meshes, instances };
	if (counts[1] !== 0 || counts[6] !== instanceCount || counts[7] !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'MODEL texture/scene/transform counts are outside web-core-v1.');
	const edgeExpected = new Map<number, Array<[number, number]>>();
	let totalEdges = 0;
	for (const mesh of meshes) {
		const edges = new Map<string, [number, number]>();
		for (const face of mesh.faces) for (const ring of [face.outer, ...face.holes]) for (let index = 0; index < ring.length; index += 1) {
			const a = ring[index]!; const b = ring[(index + 1) % ring.length]!; const pair: [number, number] = a < b ? [a, b] : [b, a]; edges.set(`${pair[0]}:${pair[1]}`, pair);
		}
		const sorted = [...edges.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		edgeExpected.set(meshes.indexOf(mesh), sorted); totalEdges += sorted.length;
	}
	if (counts[8] !== totalEdges) throw new BomcDocumentError('INVALID_SOURCE', 'MODEL visual-edge count disagrees with topology.');
	let expectedEdgeStart = 0;
	for (let meshIndex = 0; meshIndex < meshHeaders.length; meshIndex += 1) {
		const header = meshHeaders[meshIndex]!;
		const expectedCount = edgeExpected.get(meshIndex)!.length;
		if (header.edgeStart !== expectedEdgeStart || header.edgeCount !== expectedCount) throw new BomcDocumentError('INVALID_SOURCE', `MESHES row ${meshIndex} edge range is inconsistent.`);
		expectedEdgeStart += expectedCount;
	}
	if (meshCount! > 0) {
	const edgesReader = sectionReader(sections, 14);
		if (edgesReader.readU8() !== 1 || edgesReader.readU8() !== 1 || edgesReader.readU8() !== 0 || edgesReader.readU8() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'VISUAL_EDGES schema is unsupported.');
	const edgeCount = edgesReader.readU32(); const edgePayloadBytes = edgesReader.readU32();
	if (edgeCount !== totalEdges) throw new BomcDocumentError('INVALID_SOURCE', 'VISUAL_EDGES count disagrees with loops.');
	if (edgeCount > Math.floor(edgesReader.remaining / 4) || edgePayloadBytes > edgesReader.remaining - edgeCount * 2 || edgeCount * 2 > edgePayloadBytes) throw new BomcDocumentError('INVALID_SOURCE', 'VISUAL_EDGES tables exceed the section.');
		for (let index = 0; index < edgeCount; index += 1) if (readAdaptive(edgesReader, 1) !== null) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'Tagged visual edges are unsupported.');
		for (let index = 0; index < edgeCount; index += 1) if (edgesReader.readU8() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'Visual-edge flags are unsupported.');
		const endpointValues = readVaruintStream(edgesReader.readBytes(edgePayloadBytes), edgeCount * 2, false, 'VISUAL_EDGES endpoints');
		if (edgesReader.remaining !== 0) throw new BomcDocumentError('INVALID_SOURCE', 'VISUAL_EDGES has trailing bytes.');
		let endpoint = 0;
		for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) for (const pair of edgeExpected.get(meshIndex)!) {
			if (endpointValues[endpoint++] !== pair[0] || endpointValues[endpoint++] !== pair[1]) throw new BomcDocumentError('INVALID_SOURCE', `VISUAL_EDGES pair for mesh ${meshIndex} disagrees with face loops.`);
		}
	} else if (sections.has(14)) throw new BomcDocumentError('INVALID_SOURCE', 'VISUAL_EDGES exists without meshes.');
	const coverageReader = sectionReader(sections, 17);
	const coverage = Array.from({ length: 6 }, () => coverageReader.readU32());
	const graphFaceCount = meshes.reduce((sum, mesh) => sum + mesh.faces.length, 0);
	if (coverageReader.remaining !== 0 || coverage[0] !== graphFaceCount || coverage[1] !== graphFaceCount || coverage.slice(2).some((value) => value !== 0)) throw new BomcDocumentError('INVALID_SOURCE', 'COVERAGE does not match the authored face set.');
	const contractReader = sectionReader(sections, 20);
	if (contractReader.readU16() !== 1 || contractReader.readU8() !== 1 || contractReader.readU8() !== 0 || contractReader.readU64() !== 0 || contractReader.readF64() !== 0 || contractReader.readF64() !== 0 || contractReader.readU64() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'ENCODING_CONTRACT header is unsupported.');
	for (let index = 0; index < 4; index += 1) if (contractReader.readF64() !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'ENCODING_CONTRACT errors must be zero.');
	if (contractReader.readU8() !== 1 || contractReader.readU8() !== 1 || contractReader.readU8() !== 1 || contractReader.readU8() !== 1 || contractReader.readU32() !== 1 || contractReader.remaining !== 0) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'ENCODING_CONTRACT capabilities are unsupported.');
	const derivedBounds = deriveGraphBounds(graph);
	const expectedBounds = [...derivedBounds.min, ...derivedBounds.max];
	if (modelBounds.some((value, index) => !Object.is(value, expectedBounds[index]))) throw new BomcDocumentError('INVALID_SOURCE', 'MODEL bounds disagree with the authored graph.');
	return graph;
}
