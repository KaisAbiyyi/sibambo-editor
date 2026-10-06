import { BomcDocument, BomcDocumentError } from './document.js';
import { BinaryReader, loadSection, parseDirectory, WEB_SECTION_TYPES } from './binary.js';
import { decodeWebGraph, requiredOutputSectionTypes } from './section-codec.js';
import type { BomcGraph } from './types.js';

function visualEdgeCount(graph: BomcGraph) {
	let total = 0;
	for (const mesh of graph.meshes) {
		const edges = new Set<string>();
		for (const face of mesh.faces) for (const ring of [face.outer, ...face.holes]) for (let index = 0; index < ring.length; index += 1) {
			const left = ring[index]!; const right = ring[(index + 1) % ring.length]!;
			edges.add(left < right ? `${left}:${right}` : `${right}:${left}`);
		}
		total += edges.size;
	}
	return total;
}

/** Restore only the closed web-core-v1 authoring profile. */
export async function readWebBomc(input: Uint8Array): Promise<BomcDocument> {
	if (!(input instanceof Uint8Array)) throw new BomcDocumentError('INVALID_SOURCE', 'BOMC input must be a Uint8Array.');
	let bytes: Uint8Array;
	try { bytes = new Uint8Array(input); }
	catch (error) { throw new BomcDocumentError('RESOURCE_LIMIT', 'Unable to copy BOMC input.', error); }
	if (bytes.byteLength === 0) throw new BomcDocumentError('INVALID_SOURCE', 'BOMC input is empty.');
	const directory = parseDirectory(bytes, 'web-core');
	const known = new Set<number>(WEB_SECTION_TYPES);
	for (const entry of directory.sections) if (!known.has(entry.type)) throw new BomcDocumentError('UNSUPPORTED_FEATURE', `Web-core section ${entry.type} is unsupported.`);
	const sectionMap = new Map(directory.sections.map((entry) => [entry.type, entry]));
	for (const type of [1, 2, 11, 12, 13, 17, 20, 241]) if (!sectionMap.has(type)) throw new BomcDocumentError('INVALID_SOURCE', `Required web-core section ${type} is missing.`);
	const payloads = new Map<number, Uint8Array>();
	for (const entry of directory.sections) payloads.set(entry.type, await loadSection(bytes, entry));
	const authoring = payloads.get(241)!;
	if (authoring.byteLength < 20 || authoring[0] !== 0x42 || authoring[1] !== 0x57 || authoring[2] !== 0x45 || authoring[3] !== 0x42) {
		throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'BOMC does not contain the recognized BWEB authoring section.');
	}
	// AUTHORING's revision is fixed at byte offset 12 in this schema.
	const revisionView = new DataView(authoring.buffer, authoring.byteOffset, authoring.byteLength);
	const revisionBig = revisionView.getBigUint64(12, true);
	if (revisionBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new BomcDocumentError('RESOURCE_LIMIT', 'Stored document revision exceeds the safe integer range.');
	const revision = Number(revisionBig);
	let graph: BomcGraph;
	try { graph = decodeWebGraph(payloads, revision); }
	catch (error) {
		if (error instanceof BomcDocumentError && error.code === 'INVALID_DOCUMENT') throw new BomcDocumentError('INVALID_SOURCE', `Decoded graph is invalid: ${error.message}`, error);
		throw error;
	}
	const required = new Set(requiredOutputSectionTypes(graph));
	for (const entry of directory.sections) if (!required.has(entry.type)) throw new BomcDocumentError('UNSUPPORTED_FEATURE', `Section ${entry.type} is outside the declared graph subset.`);
	for (const type of required) if (!payloads.has(type)) throw new BomcDocumentError('INVALID_SOURCE', `Graph-required section ${type} is missing.`);
	const stringReader = new BinaryReader(payloads.get(2)!);
	stringReader.skip(4);
	const expectedCounts = new Map<number, number>([
		[1, 1], [2, stringReader.readU32()],
		[3, graph.materials.length], [5, graph.meshes.length], [6, graph.meshes.reduce((sum, mesh) => sum + mesh.faces.length, 0)],
		[7, graph.meshes.length], [8, graph.meshes.length], [9, graph.meshes.reduce((sum, mesh) => sum + mesh.faces.length, 0)],
		[11, graph.definitions.length], [12, graph.instances.length], [13, graph.instances.length],
		[14, visualEdgeCount(graph)], [17, 1], [20, 1], [241, 1]
	]);
	for (const entry of directory.sections) {
		const expected = expectedCounts.get(entry.type);
		if (expected === undefined || entry.count !== expected) throw new BomcDocumentError('INVALID_SOURCE', `Section ${entry.type} row count is inconsistent.`);
	}
	try { return BomcDocument.fromGraph(graph, revision); }
	catch (error) {
		if (error instanceof BomcDocumentError && error.code === 'INVALID_DOCUMENT') {
			throw new BomcDocumentError('INVALID_SOURCE', `Decoded graph is invalid: ${error.message}`, error);
		}
		throw error;
	}
}
