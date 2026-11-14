/**
 * SIB-MCP-MODELING-001 v2.0 WP1 / E-L1 evidence (characterisation tests).
 *
 * Checks whether the v2.0 A4/A7/C9 managed-module encoding (group instance id
 * `${documentId}:arch:<module>:instance`, label `sibambo-arch-v2:<json>`,
 * `${documentId}:material:sib-*` materials, faces with surfaceCode/roleCode and
 * `sib:` labels) survives the BOMC writer/reader and the Editor authoring
 * admission, and records the stored-graph coordinate convention.
 * These tests assert the behaviour observed on Editor 9965b3a; they are
 * evidence for the next PLAN, not product behaviour.
 *
 * Since v2.1 (WP1A) they document why v2.1 exists: the v2.0 encoding must STILL be
 * rejected after the `arch` admission extension, while the v2.1 encoding is proved
 * admissible in admission-e-l2.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { readWebBomc } from '@sibambo/bomc-document/reader';
import { BomcWriter } from '@sibambo/bomc-document/writer';
import type { BomcGraph } from '@sibambo/bomc-document';
import { validateAuthoringDocument } from '../../src/lib/authoring/model.js';
import { buildRectangleEdit } from '../../src/lib/authoring/geometry.js';
import { AuthoringWorkerDispatcher } from '../../src/lib/authoring/bomc-authoring.worker.js';
import { AUTHORING_PROTOCOL_VERSION, type AuthoringWorkerMessage } from '../../src/lib/authoring/protocol.js';

const DOC = '5b0c8f2e-3d41-4a7b-9c2e-1f0a6d4e8b71';
const SESSION = '0f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b';
const receipt: Record<string, unknown> = {};

/** Source Z-up metres -> Editor runtime/graph Y-up: (x, y, z) -> (x, z, -y); column-major for Instance.matrix. */
const CONVENTION_COLUMN_MAJOR = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

function managedGraph(labelBytes: number): BomcGraph {
	const base = BomcDocument.create({ documentId: DOC, name: 'E-L1' });
	const graph = structuredClone(base.snapshot().graph) as BomcGraph & Record<string, any>;
	base.dispose();
	const material = `${DOC}:material:sib-default`;
	const definition = `${DOC}:arch:house/ground:definition`;
	const mesh = `${DOC}:arch:house/ground:mesh`;
	const json = JSON.stringify({ module: { schemaVersion: '2.0.0', moduleId: 'house/ground', revision: 1, elements: [] }, bakedMeshSha256: '0'.repeat(64) });
	const label = 'sibambo-arch-v2:' + json + ' '.repeat(Math.max(0, labelBytes - json.length - 16));
	(graph as any).materials = [{ id: material, name: 'sib-default', displayName: null, rgba: [199, 204, 212, 255], opacityU16: 65535 }];
	(graph as any).definitions = [...graph.definitions, { id: definition, name: 'house/ground', kind: 'group', meshId: mesh }];
	(graph as any).meshes = [{
		id: mesh, definitionId: definition,
		positions: [0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0],
		faces: [{ id: `${mesh}:f:w-1:f0`, outer: [0, 1, 2, 3], holes: [], triangles: [0, 1, 2, 0, 2, 3], normal: [0, 0, 1],
			frontMaterialId: material, backMaterialId: null, hidden: false, surfaceCode: 2, roleCode: 2, label: 'sib:slab-1:top' }]
	}];
	(graph as any).instances = [...graph.instances, {
		id: `${DOC}:arch:house/ground:instance`, name: 'house/ground', kind: 'group', ownerDefinitionId: graph.rootDefinitionId,
		definitionId: definition, matrix: CONVENTION_COLUMN_MAJOR, materialId: null, visible: true, roleCode: 0, label
	}];
	return graph;
}

async function openThroughDispatcher(bytes: Uint8Array): Promise<AuthoringWorkerMessage> {
	const messages: AuthoringWorkerMessage[] = [];
	const dispatcher = new AuthoringWorkerDispatcher((message) => messages.push(message), () => '7c6b5a49-3827-4615-9a4b-3c2d1e0f9a8b');
	const buffer = bytes.slice().buffer;
	dispatcher.receive({ protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: SESSION, requestId: 1, type: 'OPEN', data: { ownedBuffer: buffer } });
	for (let i = 0; i < 200 && !messages.some((m) => m.event === 'RESULT' || m.event === 'ERROR'); i++) await new Promise((r) => setTimeout(r, 10));
	return messages.find((m) => m.event === 'RESULT' || m.event === 'ERROR')!;
}

describe('E-L1 managed-module encoding vs BOMC format and authoring admission', () => {
	test('(i-a) a 64 KiB group-instance label round-trips through BomcWriter -> readWebBomc', async () => {
		const graph = managedGraph(64 * 1024);
		const document = BomcDocument.fromGraph(graph);
		const writer = new BomcWriter(document, { compressionMode: 'store-only' });
		const bytes = new Uint8Array((await writer.write()).bytes);
		const restored = await readWebBomc(bytes);
		const before = graph.instances.find((i) => i.kind === 'group')!.label!;
		const after = restored.snapshot().graph.instances.find((i) => i.kind === 'group')?.label ?? null;
		receipt.formatRoundTrip = { labelBytes: new TextEncoder().encode(before).length, identical: after === before, fileBytes: bytes.length };
		expect(after).toBe(before);
		document.dispose(); restored.dispose();
	});

	test('(i-b) Editor authoring admission rejects the v2.0 managed-module encoding', () => {
		const result = validateAuthoringDocument(managedGraph(1024));
		receipt.admissionPlanDesign = result.editable ? { editable: true } : { editable: false, reason: result.reason };
		expect(result.editable).toBe(false);
	});

	test('(i-c) OPEN through the real worker dispatcher yields viewer-only for that encoding', async () => {
		const document = BomcDocument.fromGraph(managedGraph(64 * 1024));
		const bytes = new Uint8Array((await new BomcWriter(document, { compressionMode: 'store-only' }).write()).bytes);
		document.dispose();
		const message = await openThroughDispatcher(bytes);
		const result = message.event === 'RESULT' ? (message.result as any) : null;
		receipt.dispatcherOpen = message.event === 'RESULT'
			? { kind: result.kind, reason: result.reason ?? null }
			: { error: (message as any).error };
		expect(message.event).toBe('RESULT');
		expect(result.kind).toBe('viewer');
	});

	test('(i-e) every layer of the v2.0 encoding is rejected independently (material, container, face)', () => {
		const layers: Record<string, string> = {};
		const graph = managedGraph(1024) as any;
		const authored = `${DOC}:material:op:1`;
		graph.materials[0].id = authored;
		graph.meshes[0].faces[0].frontMaterialId = authored;
		let result = validateAuthoringDocument(graph);
		layers.afterAuthoredMaterial = result.editable ? 'editable' : result.reason;
		graph.instances[1].id = `${DOC}:instance:op:2`;
		graph.instances[1].label = JSON.stringify(['sibambo-editor-container-v1', 2]);
		result = validateAuthoringDocument(graph);
		layers.afterContainerIdAndLabel = result.editable ? 'editable' : result.reason;
		const face = graph.meshes[0].faces[0];
		face.surfaceCode = 0; face.roleCode = 0;
		result = validateAuthoringDocument(graph);
		layers.afterZeroFaceCodes = result.editable ? 'editable' : result.reason;
		face.label = JSON.stringify(['sibambo-editor-shape-v2', 'line', face.id]);
		result = validateAuthoringDocument(graph);
		layers.afterV2FaceLabel = result.editable ? 'editable' : result.reason;
		receipt.admissionLayers = layers;
		expect(layers.afterAuthoredMaterial).not.toBe('editable');
		expect(layers.afterContainerIdAndLabel).not.toBe('editable');
		expect(layers.afterZeroFaceCodes).not.toBe('editable');
	});

	test('(i-d) root metadata rejects an arch key without the v2.1 C9a schema shape', () => {
		const base = BomcDocument.create({ documentId: DOC, name: 'meta' });
		const graph = structuredClone(base.snapshot().graph) as any;
		base.dispose();
		graph.instances[0].label = JSON.stringify({ schema: 'sibambo-editor-model-v1', guides: [], looseEdges: [], arch: { modules: [] } });
		const result = validateAuthoringDocument(graph);
		receipt.rootMetadataArchKey = result.editable ? { editable: true } : { editable: false, reason: result.reason };
		expect(result.editable).toBe(false);
	});

	test('(iii) authored geometry is stored in the Y-up runtime frame (ground plane y = 0)', () => {
		const document = BomcDocument.create({ documentId: DOC, name: 'convention' });
		const edit = buildRectangleEdit(document.snapshot().graph, `${DOC}:rectangle:1`, [0, 0, 0], [4, 0, 3]);
		const mesh = edit.forward.find((e) => e.type === 'put-mesh')!;
		const positions = (mesh as any).value.positions as number[];
		const ys = positions.filter((_, i) => i % 3 === 1);
		receipt.convention = {
			rectangleYs: [...new Set(ys)],
			storedFrame: 'Y-up runtime (three.js); source Z-up maps (x, y, z) -> (x, z, -y)',
			conventionColumnMajor: CONVENTION_COLUMN_MAJOR,
			instanceMatrixOrder: 'column-major (Matrix4.fromArray in model.ts::modelOccurrences), composed parent * child',
			branch: 'B1 (child positions stay module-local Z-up; Instance.matrix = CONVENTION * transform)'
		};
		expect(new Set(ys)).toEqual(new Set([0]));
		document.dispose();
		const out = process.env.SIBAMBO_EL1_RECEIPT;
		if (out) writeFileSync(out, JSON.stringify(receipt, null, 2));
	});
});
