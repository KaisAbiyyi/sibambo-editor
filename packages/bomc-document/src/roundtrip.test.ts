import { describe, expect, test } from 'bun:test';
import { BomcDocument, BomcDocumentError } from './document.js';
import { crc32, parseDirectory } from './binary.js';
import { readWebBomc } from './reader.js';
import { BomcWriter } from './writer.js';
import type { BomcGraph } from './types.js';
import {
	createColorGraph, createConcaveGraph, createEmptyGraph, createExtrusionNegativeGraph, createExtrusionPositiveGraph,
	createHoleGraph, createNestedGraph, createOriginGraph, createPrecisionGraph, createSharedGraph, createWidthGraph
} from './test-fixtures/documents.js';

const fixtures = [
	['empty', createEmptyGraph], ['precision', createPrecisionGraph], ['origin', createOriginGraph], ['hole', createHoleGraph],
	['concave', createConcaveGraph], ['extrusion-positive', createExtrusionPositiveGraph], ['extrusion-negative', createExtrusionNegativeGraph],
	['shared', createSharedGraph], ['nested', createNestedGraph], ['color', createColorGraph], ['width', createWidthGraph]
] as const;

function float64Hex(value: number) {
	const bytes = new ArrayBuffer(8);
	new DataView(bytes).setFloat64(0, value, true);
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function geometryFloat64Rows(graph: BomcGraph) {
	return [
		...graph.meshes.flatMap((mesh) => [
			...mesh.positions,
			...mesh.faces.flatMap((face) => face.normal)
		]),
		...graph.instances.flatMap((instance) => instance.matrix)
	].map(float64Hex);
}

function pointInRing(x: number, y: number, ring: readonly number[], positions: readonly number[]) {
	let inside = false;
	for (let index = 0, prior = ring.length - 1; index < ring.length; prior = index, index += 1) {
		const left = ring[index]! * 3;
		const right = ring[prior]! * 3;
		const xi = positions[left]!; const yi = positions[left + 1]!;
		const xj = positions[right]!; const yj = positions[right + 1]!;
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

function triangleAreaAndCentroid(triangle: readonly [number, number, number], positions: readonly number[]) {
	const a = triangle[0] * 3; const b = triangle[1] * 3; const c = triangle[2] * 3;
	const ax = positions[a]!; const ay = positions[a + 1]!;
	const bx = positions[b]!; const by = positions[b + 1]!;
	const cx = positions[c]!; const cy = positions[c + 1]!;
	return {
		area: Math.abs((ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)) / 2),
		x: (ax + bx + cx) / 3,
		y: (ay + by + cy) / 3
	};
}

function mutateSection(bytes: Uint8Array, type: number, mutate: (section: Uint8Array, entry: ReturnType<typeof parseDirectory>['sections'][number]) => void) {
	const directory = parseDirectory(bytes, 'web-core');
	const index = directory.sections.findIndex((entry) => entry.type === type);
	if (index < 0) throw new Error(`Fixture has no section ${type}.`);
	const entry = directory.sections[index]!;
	mutate(bytes.subarray(entry.offset, entry.offset + entry.storedLength), entry);
	const checksum = crc32(bytes.subarray(entry.offset, entry.offset + entry.storedLength));
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(32 + index * 24 + 20, checksum, true);
	return bytes;
}

async function storedColorFixture() {
	const document = BomcDocument.fromGraph(createColorGraph());
	const writer = new BomcWriter(document, { compressionMode: 'store-only' });
	try { return new Uint8Array((await writer.write()).bytes); }
	finally { writer.dispose(); document.dispose(); }
}

async function expectUnsupportedSource(bytes: Uint8Array) {
	let thrown: unknown;
	try { await readWebBomc(bytes); }
	catch (error) { thrown = error; }
	expect(thrown).toBeInstanceOf(BomcDocumentError);
	expect((thrown as BomcDocumentError).code).toBe('UNSUPPORTED_FEATURE');
}

describe('web-core BOMC persistence round-trip', () => {
	for (const [name, create] of fixtures) for (const compressionMode of ['store-only', 'auto'] as const) {
		test(`round-trips ${name} graph and exact Float64 bytes in ${compressionMode} mode`, async () => {
			const document = BomcDocument.fromGraph(create(), 7);
			const before = document.snapshot();
			const writer = new BomcWriter(document, { compressionMode });
			let restored: BomcDocument | undefined;
			try {
				const output = await writer.write();
				const parsed = parseDirectory(output.bytes, 'web-core');
				restored = await readWebBomc(output.bytes);
				const after = restored.snapshot();
				expect(after.revision).toBe(7);
				expect(after.graph).toEqual(before.graph);
				expect(geometryFloat64Rows(after.graph)).toEqual(geometryFloat64Rows(before.graph));
				expect(parsed.sections.map((section) => section.type)).toEqual(expect.arrayContaining([1, 2, 11, 12, 13, 17, 20, 241]));
			} finally {
				restored?.dispose();
				writer.dispose();
				document.dispose();
			}
		});
	}

	test('preserves loop order, holes, face/material IDs, colors, and both material sides', async () => {
		const graph = createColorGraph();
		const document = BomcDocument.fromGraph(graph);
		const writer = new BomcWriter(document);
		let restored: BomcDocument | undefined;
		try {
			restored = await readWebBomc((await writer.write()).bytes);
			const restoredGraph = restored.snapshot().graph;
			const face = restoredGraph.meshes[0]!.faces[0]!;
			expect(face.id).toBe(graph.meshes[0]!.faces[0]!.id);
			expect(face.outer).toEqual([0, 1, 2, 3]);
			expect(face.holes).toEqual([[4, 5, 6, 7]]);
			expect(face.triangles).toEqual(graph.meshes[0]!.faces[0]!.triangles);
			expect(face.frontMaterialId).toBe(graph.meshes[0]!.faces[0]!.frontMaterialId);
			expect(face.backMaterialId).toBe(graph.meshes[0]!.faces[0]!.backMaterialId);
			expect(face.frontMaterialId).not.toBe(face.backMaterialId);
			expect(restoredGraph.materials.map((material) => [material.id, material.rgba, material.opacityU16])).toEqual([
				['fixture:color:material:0', [155, 28, 49, 255], 65535],
				['fixture:color:material:1', [0, 128, 255, 128], 32768]
			]);
		} finally { restored?.dispose(); writer.dispose(); document.dispose(); }
	});

	test('independently measures the decoded hole and concave triangulations', async () => {
		for (const [name, create, expectedArea] of [['hole', createHoleGraph, 12], ['concave', createConcaveGraph, 5]] as const) {
			const document = BomcDocument.fromGraph(create());
			const writer = new BomcWriter(document);
			let restored: BomcDocument | undefined;
			try {
				restored = await readWebBomc((await writer.write()).bytes);
				const mesh = restored.snapshot().graph.meshes[0]!;
				const face = mesh.faces[0]!;
				let totalArea = 0;
				for (let offset = 0; offset < face.triangles.length; offset += 3) {
					const measure = triangleAreaAndCentroid(
						[face.triangles[offset]!, face.triangles[offset + 1]!, face.triangles[offset + 2]!], mesh.positions
					);
					totalArea += measure.area;
					expect(pointInRing(measure.x, measure.y, face.outer, mesh.positions), `${name} triangle centroid must stay inside the outer loop`).toBe(true);
					for (const hole of face.holes) expect(pointInRing(measure.x, measure.y, hole, mesh.positions), `${name} triangle centroid must stay outside holes`).toBe(false);
				}
				expect(totalArea).toBe(expectedArea);
			} finally { restored?.dispose(); writer.dispose(); document.dispose(); }
		}
	});

	test('retains shared definition rows without multiplying meshes or rewriting occurrence IDs', async () => {
		const graph = createSharedGraph();
		const document = BomcDocument.fromGraph(graph);
		const writer = new BomcWriter(document);
		let restored: BomcDocument | undefined;
		try {
			restored = await readWebBomc((await writer.write()).bytes);
			const after = restored.snapshot().graph;
			expect(after.meshes).toHaveLength(1);
			expect(after.definitions.filter((row) => row.kind === 'component')).toHaveLength(1);
			expect(after.instances.filter((row) => row.kind === 'component').map((row) => row.id)).toEqual(
				graph.instances.filter((row) => row.kind === 'component').map((row) => row.id)
			);
			expect(after.instances.filter((row) => row.kind === 'component').map((row) => row.definitionId)).toEqual([
				graph.instances.find((row) => row.kind === 'component')!.definitionId,
				graph.instances.find((row) => row.kind === 'component')!.definitionId
			]);
		} finally { restored?.dispose(); writer.dispose(); document.dispose(); }
	});

	test('retains positive and negative extrusion orientation and expected visual-edge counts', async () => {
		for (const [create, direction] of [[createExtrusionPositiveGraph, 1], [createExtrusionNegativeGraph, -1]] as const) {
			const document = BomcDocument.fromGraph(create());
			const writer = new BomcWriter(document);
			let restored: BomcDocument | undefined;
			try {
				const bytes = (await writer.write()).bytes;
				const parsed = parseDirectory(bytes, 'web-core');
				const edgeSection = parsed.sections.find((section) => section.type === 14)!;
				expect(edgeSection.count).toBe(12);
				restored = await readWebBomc(bytes);
				const mesh = restored.snapshot().graph.meshes[0]!;
				const zs = mesh.positions.filter((_value, index) => index % 3 === 2);
				expect(Math.min(...zs)).toBe(direction < 0 ? -0.5 : 0);
				expect(Math.max(...zs)).toBe(direction > 0 ? 0.5 : 0);
				for (const face of mesh.faces) for (let offset = 0; offset < face.triangles.length; offset += 3) {
					const a = face.triangles[offset]! * 3; const b = face.triangles[offset + 1]! * 3; const c = face.triangles[offset + 2]! * 3;
					const ab = [mesh.positions[b]! - mesh.positions[a]!, mesh.positions[b + 1]! - mesh.positions[a + 1]!, mesh.positions[b + 2]! - mesh.positions[a + 2]!];
					const ac = [mesh.positions[c]! - mesh.positions[a]!, mesh.positions[c + 1]! - mesh.positions[a + 1]!, mesh.positions[c + 2]! - mesh.positions[a + 2]!];
					const cross = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
					expect(cross[0]! * face.normal[0]! + cross[1]! * face.normal[1]! + cross[2]! * face.normal[2]!).toBeGreaterThan(0);
				}
			} finally { restored?.dispose(); writer.dispose(); document.dispose(); }
		}
	});

	test('copies source bytes before the first asynchronous section load', async () => {
		const document = BomcDocument.fromGraph(createPrecisionGraph(), 19);
		const writer = new BomcWriter(document, { compressionMode: 'auto' });
		let restored: BomcDocument | undefined;
		try {
			const input = (await writer.write()).bytes;
			const original = new Uint8Array(input);
			const pending = readWebBomc(input);
			input.fill(0);
			restored = await pending;
			expect(restored.snapshot().revision).toBe(19);
			expect(restored.snapshot().graph).toEqual(document.snapshot().graph);
			expect(original.some((value) => value !== 0)).toBe(true);
			expect(input.every((value) => value === 0)).toBe(true);
		} finally { restored?.dispose(); writer.dispose(); document.dispose(); }
	});

	test('rejects unsupported authoring schema and capability metadata', async () => {
		const original = await storedColorFixture();
		for (const [relativeOffset, writeValue] of [
			[4, (view: DataView, offset: number) => view.setUint16(offset, 2, true)],
			[8, (view: DataView, offset: number) => view.setUint32(offset, 2, true)]
		] as const) {
			const corrupted = new Uint8Array(original);
			mutateSection(corrupted, 241, (section) => writeValue(new DataView(section.buffer, section.byteOffset, section.byteLength), relativeOffset));
			await expectUnsupportedSource(corrupted);
		}
	});

	test('rejects unsupported material schema, texture references, and semantic fields', async () => {
		const original = await storedColorFixture();
		const schema = new Uint8Array(original);
		mutateSection(schema, 3, (section) => { section[0] = 1; });
		await expectUnsupportedSource(schema);

		const texture = new Uint8Array(original);
		mutateSection(texture, 3, (section) => {
			const count = new DataView(section.buffer, section.byteOffset, section.byteLength).getUint32(4, true);
			const stringWidth = section[1]!;
			const textureReferences = 8 + count * stringWidth * 2 + count * 4 + count * 2;
			section[textureReferences] = 0;
		});
		await expectUnsupportedSource(texture);

		const semantic = new Uint8Array(original);
		mutateSection(semantic, 3, (section) => {
			const count = new DataView(section.buffer, section.byteOffset, section.byteLength).getUint32(4, true);
			const stringWidth = section[1]!;
			const semanticFields = 8 + count * stringWidth * 2 + count * 4 + count * 2 + count + count * 2 * 4;
			section[semanticFields] = 1;
		});
		await expectUnsupportedSource(semantic);
	});

	test('rejects UV streams instead of admitting them as editable geometry', async () => {
		const original = await storedColorFixture();
		const corrupted = new Uint8Array(original);
		mutateSection(corrupted, 5, (section) => {
			const definitionWidth = section[1]!;
			const uvOffsetColumn = 8 + definitionWidth + 9 * 4;
			new DataView(section.buffer, section.byteOffset, section.byteLength).setUint32(uvOffsetColumn, 1, true);
		});
		await expectUnsupportedSource(corrupted);
	});
});
