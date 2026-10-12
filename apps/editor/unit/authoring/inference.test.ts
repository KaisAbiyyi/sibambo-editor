import { describe, expect, test } from 'bun:test';
import { OrthographicCamera, PerspectiveCamera, Raycaster, Vector2, Vector3, type Camera } from 'three';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { buildPlanarRectangleEdit, buildPushPullFaceEdit } from '../../src/lib/authoring/geometry.js';
import { resolveAuthoringInference, resolvePushPullLevelSnap } from '../../src/lib/authoring/inference.js';
import { buildModelEdit,contextGraph } from '../../src/lib/authoring/model.js';

const DOCUMENT_ID = '3ed35ead-9640-4e34-b10c-0983190ec99d';
const WIDTH = 1000;
const HEIGHT = 1000;

test('Push/Pull softly snaps below the parent edge and releases beyond its CSS pixel radius', () => {
	const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Side edge snap' });
	try {
		document.transact(buildPlanarRectangleEdit(document.snapshot().graph, `${DOCUMENT_ID}:rectangle:1`, [[0,0,0],[4,0,0],[4,0,3],[0,0,3]], [0,1,0]).forward);
		document.transact(buildPlanarRectangleEdit(document.snapshot().graph, `${DOCUMENT_ID}:rectangle:2`, [[1,0,1],[2,0,1],[2,0,2],[1,0,2]], [0,1,0]).forward);
		document.transact(buildPushPullFaceEdit(document.snapshot().graph, `${DOCUMENT_ID}:rectangle:1`, 1, 3).forward);
		document.transact(buildPushPullFaceEdit(document.snapshot().graph, `${DOCUMENT_ID}:rectangle:2`, -.8, 4).forward);
		const graph = document.snapshot().graph, mesh = graph.meshes[0]!;
		const side = mesh.faces.find(face => Math.abs(face.normal[0]) > .9 && face.outer.every(vertex => mesh.positions[vertex*3] === 2 && mesh.positions[vertex*3+1]! <= 0))!;
		const camera = new OrthographicCamera(-5,5,5,-5,.1,100); camera.position.set(0,0,10); camera.lookAt(0,0,0); camera.updateProjectionMatrix();
		const viewport = cameraViewport(camera), anchor = [2,-.4,1.5] as const;
		const projected = viewport.projectWorldToScreen([3.99,-.4,1.5]);
		const options = {graph,viewport,faceId:side.id,clientX:projected.x,clientY:projected.y,dragAnchor:anchor,dragDistance:1.99/side.normal[0]!};
		const snap = resolvePushPullLevelSnap(options);
		expect(snap?.distance).toBe(2/side.normal[0]!);
		expect(snap?.inference.kind).toBe('edge');
		expect(snap?.inference.point).toEqual([4,0,1.5]);
		expect(resolvePushPullLevelSnap({...options,dragDistance:2.3/side.normal[0]!})).toBeNull();
		const zoomed = new OrthographicCamera(-10,10,10,-10,.1,100); zoomed.position.copy(camera.position); zoomed.lookAt(0,0,0); zoomed.updateProjectionMatrix();
		expect(resolvePushPullLevelSnap({...options,viewport:cameraViewport(zoomed),dragDistance:2.15/side.normal[0]!})?.distance).toBe(2/side.normal[0]!);
		expect(resolvePushPullLevelSnap({...options,dragDistance:2.15/side.normal[0]!})).toBeNull();
	} finally { document.dispose(); }
});

function cameraViewport(camera: Camera) {
	const raycaster = new Raycaster();
	camera.updateMatrixWorld(true);
	return {
		rayFromScreen(clientX: number, clientY: number) {
			const ndc = new Vector2(clientX / WIDTH * 2 - 1, -(clientY / HEIGHT) * 2 + 1);
			raycaster.setFromCamera(ndc, camera);
			return raycaster.ray.clone();
		},
		projectWorldToScreen(point: readonly [number, number, number]) {
			const cameraSpace = new Vector3(...point).applyMatrix4(camera.matrixWorldInverse);
			const projected = new Vector3(...point).project(camera);
			const x = (projected.x + 1) * 0.5 * WIDTH;
			const y = (1 - projected.y) * 0.5 * HEIGHT;
			return {
				x,
				y,
				inFront: cameraSpace.z < 0,
				visible: cameraSpace.z < 0 && projected.z >= -1 && projected.z <= 1 && x >= 0 && x <= WIDTH && y >= 0 && y <= HEIGHT
			};
		}
	};
}

function topViewport(halfHeight: number) {
	const camera = new OrthographicCamera(-halfHeight, halfHeight, halfHeight, -halfHeight, 0.1, 100);
	camera.position.set(0, 10, 0);
	camera.up.set(0, 0, -1);
	camera.lookAt(0, 0, 0);
	camera.updateProjectionMatrix();
	return cameraViewport(camera);
}

function perspectiveViewport(position: [number, number, number], up: [number, number, number] = [0, 1, 0]) {
	const camera = new PerspectiveCamera(50, 1, 0.1, 100);
	camera.position.set(...position);
	camera.up.set(...up);
	camera.lookAt(0, 0, 0);
	camera.updateProjectionMatrix();
	return cameraViewport(camera);
}

function authoredRectangle() {
	const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Inference' });
	const id = `${DOCUMENT_ID}:rectangle:1`;
	document.transact(buildPlanarRectangleEdit(
		document.snapshot().graph,
		id,
		[[-2, 0, -2], [2, 0, -2], [2, 0, 2], [-2, 0, 2]],
		[0, 1, 0]
	).forward);
	return { document, id };
}

function authoredBox() {
	const { document, id } = authoredRectangle();
	document.transact(buildPushPullFaceEdit(document.snapshot().graph, id, 2.7, 2).forward);
	return { document, id };
}

function offsetPerpendicular(
	viewport: ReturnType<typeof topViewport>,
	start: readonly [number, number, number],
	end: readonly [number, number, number],
	pixels: number
) {
	const a = viewport.projectWorldToScreen(start);
	const b = viewport.projectWorldToScreen(end);
	const mx = (a.x + b.x) / 2;
	const my = (a.y + b.y) / 2;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = Math.hypot(dx, dy);
	return { x: mx - dy / length * pixels, y: my + dx / length * pixels, midpoint: [0, 0, -2] as const };
}

describe('authoring inference', () => {
	test('persistent guides snap beyond their defining segment and point guides snap to the placed endpoint',()=>{
		const document=BomcDocument.create({documentId:DOCUMENT_ID,name:'Guides'});
		try{
			document.transact(buildModelEdit(document.snapshot().graph,[],{type:'guide',guideKind:'line',start:[1,0,1],end:[2,0,1]},1).forward);
			document.transact(buildModelEdit(document.snapshot().graph,[],{type:'guide',guideKind:'point',start:[0,0,0],end:[4,0,3]},2).forward);
			const graph=contextGraph(document.snapshot().graph,[],true),viewport=topViewport(10),screen=viewport.projectWorldToScreen([5,0,1]);
			const snapped=resolveAuthoringInference({graph,viewport,clientX:screen.x,clientY:screen.y+1,activePlane:{origin:[0,0,0],normal:[0,1,0]}});
			expect(snapped?.kind).toBe('guide');expect(snapped?.point[0]).toBeCloseTo(5,12);expect(snapped?.point[2]).toBe(1);
			const point=viewport.projectWorldToScreen([4,0,3]);
			expect(resolveAuthoringInference({graph,viewport,clientX:point.x+1,clientY:point.y})?.point).toEqual([4,0,3]);
		}finally{document.dispose();}
	});
	test('endpoint wins over the same edge and edge snap returns the exact segment point', () => {
		const { document } = authoredRectangle();
		try {
			const viewport = topViewport(10);
			const endpoint = viewport.projectWorldToScreen([-2, 0, -2]);
			const endpointHit = resolveAuthoringInference({
				graph: document.snapshot().graph,
				viewport,
				clientX: endpoint.x + 3,
				clientY: endpoint.y
			});
			expect(endpointHit).toMatchObject({ kind: 'endpoint', point: [-2, 0, -2] });

			const edge = offsetPerpendicular(viewport, [-2, 0, -2], [2, 0, -2], 5);
			const edgeHit = resolveAuthoringInference({
				graph: document.snapshot().graph,
				viewport,
				clientX: edge.x,
				clientY: edge.y
			});
			expect(edgeHit).toMatchObject({ kind: 'edge', point: edge.midpoint });
		} finally { document.dispose(); }
	});

	test('keeps the 10 CSS px edge tolerance stable across zoom while world tolerance changes', () => {
		const { document } = authoredRectangle();
		try {
			for (const halfHeight of [10, 2]) {
				const viewport = topViewport(halfHeight);
				const inside = offsetPerpendicular(viewport, [-2, 0, -2], [2, 0, -2], 9);
				const outside = offsetPerpendicular(viewport, [-2, 0, -2], [2, 0, -2], 11);
				expect(resolveAuthoringInference({ graph: document.snapshot().graph, viewport, clientX: inside.x, clientY: inside.y })?.kind).toBe('edge');
				expect(resolveAuthoringInference({ graph: document.snapshot().graph, viewport, clientX: outside.x, clientY: outside.y })?.kind).not.toBe('edge');
			}
		} finally { document.dispose(); }
	});

	test('returns the exact canonical face and plane for an interior hit without mutating the graph', () => {
		const { document, id } = authoredRectangle();
		try {
			const viewport = topViewport(10);
			const before = JSON.stringify(document.snapshot().graph);
			const center = viewport.projectWorldToScreen([0, 0, 0]);
			const hit = resolveAuthoringInference({ graph: document.snapshot().graph, viewport, clientX: center.x, clientY: center.y });
			expect(hit).toMatchObject({ kind: 'face', faceId: id, plane: { normal: [0, 1, 0] } });
			expect(hit?.point[0]).toBeCloseTo(0, 12);
			expect(hit?.point[1]).toBeCloseTo(0, 12);
			expect(hit?.point[2]).toBeCloseTo(0, 12);
			expect(JSON.stringify(document.snapshot().graph)).toBe(before);
		} finally { document.dispose(); }
	});

	test('top and side cameras choose visible world axes and ignore a projection-degenerate axis', () => {
		const document = BomcDocument.create({ documentId: DOCUMENT_ID, name: 'Axes' });
		try {
			const anchor = [0, 0, 0] as const;
			const top = perspectiveViewport([0, 10, 0], [0, 0, -1]);
			const topAnchor = top.projectWorldToScreen(anchor);
			const topX = top.projectWorldToScreen([1, 0, 0]);
			const topDx = topX.x - topAnchor.x;
			const topDy = topX.y - topAnchor.y;
			const topLength = Math.hypot(topDx, topDy);
			const xHit = resolveAuthoringInference({
				graph: document.snapshot().graph,
				viewport: top,
				anchor,
				clientX: topAnchor.x + topDx / topLength * 80,
				clientY: topAnchor.y + topDy / topLength * 80
			});
			expect(xHit).toMatchObject({ kind: 'axis', axis: 'x' });

			const side = perspectiveViewport([0, 0, 10]);
			const sideAnchor = side.projectWorldToScreen(anchor);
			const sideY = side.projectWorldToScreen([0, 1, 0]);
			const sideDx = sideY.x - sideAnchor.x;
			const sideDy = sideY.y - sideAnchor.y;
			const sideLength = Math.hypot(sideDx, sideDy);
			const yHit = resolveAuthoringInference({
				graph: document.snapshot().graph,
				viewport: side,
				anchor,
				clientX: sideAnchor.x + sideDx / sideLength * 80,
				clientY: sideAnchor.y + sideDy / sideLength * 80
			});
			expect(yHit).toMatchObject({ kind: 'axis', axis: 'y' });
		} finally { document.dispose(); }
	});

	test('uses deterministic face tie breaks even when incident face array order changes', () => {
		const { document } = authoredRectangle();
		try {
			const graph = document.snapshot().graph;
			const mesh = graph.meshes[0]!;
			const original = mesh.faces[0]!;
			const duplicate = { ...original, id: `${DOCUMENT_ID}:face:2`, label: JSON.stringify(['sibambo-editor-shape-v2', 'line', `${DOCUMENT_ID}:face:2`]) };
			const viewport = topViewport(10);
			const target = viewport.projectWorldToScreen([-2, 0, -2]);
			const forward = { ...graph, meshes: [{ ...mesh, faces: [original, duplicate] }] };
			const reversed = { ...graph, meshes: [{ ...mesh, faces: [duplicate, original] }] };
			const first = resolveAuthoringInference({ graph: forward, viewport, clientX: target.x, clientY: target.y });
			const second = resolveAuthoringInference({ graph: reversed, viewport, clientX: target.x, clientY: target.y });
			expect(first?.kind).toBe('endpoint');
			expect(second?.kind).toBe('endpoint');
			expect(first?.faceId).toBe(second?.faceId);
		} finally { document.dispose(); }
	});

	test('box edge snapping uses the actually hovered incident face plane instead of the first face ID', () => {
		const { document } = authoredBox();
		try {
			const graph = document.snapshot().graph;
			const mesh = graph.meshes[0]!;
			const front = mesh.faces.find((face) => Math.abs(face.normal[2] - 1) < 1e-9)!;
			const viewport = perspectiveViewport([0, 1.35, 10]);
			const frontPoints = front.outer.map((vertex) => [
				mesh.positions[vertex * 3]!, mesh.positions[vertex * 3 + 1]!, mesh.positions[vertex * 3 + 2]!
			] as const);
			const topY = Math.max(...frontPoints.map((point) => point[1]));
			const z = frontPoints[0]![2];
			const nearTopEdge = viewport.projectWorldToScreen([0, topY - 0.03, z]);
			const hit = resolveAuthoringInference({
				graph,
				viewport,
				clientX: nearTopEdge.x,
				clientY: nearTopEdge.y,
				activePlane: { origin: [0, 0, 0], normal: [0, 1, 0] }
			});
			expect(hit?.kind).toBe('edge');
			expect(hit?.faceId).toBe(front.id);
			expect(hit?.plane.normal).toEqual(front.normal);
		} finally { document.dispose(); }
	});
});
