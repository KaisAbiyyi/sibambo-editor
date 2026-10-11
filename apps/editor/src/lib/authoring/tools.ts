import {
	BufferGeometry,
	DoubleSide,
	Float32BufferAttribute,
	Group,
	LineBasicMaterial,
	LineSegments,
	Mesh,
	MeshStandardMaterial
} from 'three';
import type { BomcGraph, BomcSnapshot, Face, Mesh as BomcMesh } from '@sibambo/bomc-document';
import type { PreparedSceneViewport } from '@sibambo/viewport';
import { buildPushPullFaceEdit, hasEntityId, validateEditableSubset, type AuthoringEntity } from './geometry.js';
import { captureAxisDrag, solveAxisDrag, type AxisDragCapture } from './axis-drag.js';
import {
	constructionBasis,
	inferenceLabel,
	nearestAuthoringFaceHit,
	rectangleCorners,
	resolveAuthoringInference,
	type AuthoringInference,
	type AuthoringPlane
} from './inference.js';
import { AuthoringPolygonError, preparePolygon } from './polygon.js';
import type { AuthoringCheckpoint, AuthoringCommand, AuthoringPoint, AuthoringResult } from './protocol.js';

const PREVIEW_OVERLAY_KEY = 'editor-authoring-preview';
const SELECTION_OVERLAY_KEY = 'editor-authoring-selection';
const POINTER_DRAG_THRESHOLD_CSS_PX = 4;
const MIN_EXTRUSION_METRES = 1e-6;
const SHAPE_SCHEMA = 'sibambo-editor-shape-v1';
const GROUND_PLANE: AuthoringPlane = Object.freeze({ origin: [0, 0, 0], normal: [0, 1, 0] });

export type AuthoringTool = 'select' | 'rectangle' | 'line' | 'extrude';
export type AuthoringToolControllerOptions = {
	viewport: Pick<PreparedSceneViewport, 'rayFromScreen' | 'projectWorldToScreen' | 'worldUnitsPerPixelAt' | 'setDomainOverlay'>;
	getCheckpoint: () => AuthoringCheckpoint | null;
	submitCommand: (command: AuthoringCommand) => Promise<AuthoringResult>;
	onSelectionChange: (entityId: string | null) => void;
	onInferenceChange?: (label: string) => void;
	onError: (message: string) => void;
};

type PointerGesture = {
	pointerId: number;
	startX: number;
	startY: number;
	moved: boolean;
	cameraHandled: boolean;
	checkpoint: AuthoringCheckpoint | null;
	tool: AuthoringTool;
};

type EntityHit = { entityId: string; faceId: string; distance: number };
type ParsedDistance = { value: number } | { error: string };
type RectangleGesture = Readonly<{
	first: AuthoringPoint;
	plane: AuthoringPlane;
	basis: readonly [AuthoringPoint, AuthoringPoint];
}>;
type PushPullGesture = Readonly<{
	faceId: string;
	checkpoint: AuthoringCheckpoint;
	drag: AxisDragCapture;
	distance: number | null;
}>;

function codeUnitCompare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

function pointAt(mesh: BomcMesh, vertexIndex: number): [number, number, number] {
	return [mesh.positions[vertexIndex * 3]!, mesh.positions[vertexIndex * 3 + 1]!, mesh.positions[vertexIndex * 3 + 2]!];
}

function parseDistance(text: string): ParsedDistance {
	const valueText = text.trim();
	if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(valueText)) {
		return { error: 'Enter a complete finite Push/Pull distance in metres.' };
	}
	const value = Number(valueText);
	if (!Number.isFinite(value)) return { error: 'Push/Pull distance must be finite.' };
	if (Math.abs(value) < MIN_EXTRUSION_METRES) return { error: 'Push/Pull distance must be at least 0.000001 m from zero.' };
	return { value };
}

function entityForId(graph: BomcGraph, entityId: string | null): AuthoringEntity | null {
	if (!entityId) return null;
	const subset = validateEditableSubset(graph);
	if (!subset.editable) return null;
	return subset.entities.find((entity) => entity.entityId === entityId) ?? null;
}

function uniqueBoundaryPositions(mesh: BomcMesh, faces: readonly Face[]): number[] {
	const seen = new Set<string>();
	const positions: number[] = [];
	for (const face of faces) {
		for (const ring of [face.outer, ...face.holes]) for (let index = 0; index < ring.length; index += 1) {
			const first = ring[index]!;
			const second = ring[(index + 1) % ring.length]!;
			const key = first < second ? `${first}:${second}` : `${second}:${first}`;
			if (seen.has(key)) continue;
			seen.add(key);
			positions.push(...pointAt(mesh, first), ...pointAt(mesh, second));
		}
	}
	return positions;
}

function addFaceMesh(group: Group, mesh: BomcMesh, face: Face, entityId: string, opacity: number): void {
	const vertexIndices = [...new Set([face.outer, ...face.holes].flatMap((ring) => [...ring]))];
	const localIndex = new Map(vertexIndices.map((sourceIndex, index) => [sourceIndex, index]));
	const positions = vertexIndices.flatMap((sourceIndex) => pointAt(mesh, sourceIndex));
	const normals = vertexIndices.flatMap(() => [...face.normal]);
	const indices = face.triangles.map((sourceIndex) => {
		const index = localIndex.get(sourceIndex);
		if (index === undefined) throw new Error(`Face ${face.id} references a vertex outside its canonical ring.`);
		return index;
	});
	const geometry = new BufferGeometry();
	let material: MeshStandardMaterial | null = null;
	try {
		geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
		geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
		geometry.setIndex(indices);
		geometry.computeBoundingSphere();
		material = new MeshStandardMaterial({
			color: '#e2e2e2',
			side: DoubleSide,
			transparent: true,
			opacity,
			depthWrite: false
		});
		const projected = new Mesh(geometry, material);
		projected.name = `authoring-preview:${face.id}`;
		projected.userData = { authoringEntityId: entityId, authoringFaceId: face.id, transient: true };
		group.add(projected);
	} catch (error) {
		geometry.dispose();
		material?.dispose();
		throw error;
	}
}

function addBoundaryLines(group: Group, positions: readonly number[], color: string, opacity: number, selected: boolean): void {
	if (positions.length === 0) return;
	const geometry = new BufferGeometry();
	let material: LineBasicMaterial | null = null;
	try {
		geometry.setAttribute('position', new Float32BufferAttribute([...positions], 3));
		material = new LineBasicMaterial({
			color,
			transparent: opacity < 1,
			opacity,
			depthTest: !selected,
			depthWrite: false,
			toneMapped: false
		});
		const lines = new LineSegments(geometry, material);
		lines.name = selected ? 'editor-authoring-selection-outline' : 'editor-authoring-preview-edges';
		if (selected) lines.renderOrder = 12;
		group.add(lines);
	} catch (error) {
		geometry.dispose();
		material?.dispose();
		throw error;
	}
}

function disposeUntransferred(group: Group): void {
	const geometries = new Set<BufferGeometry>();
	const materials = new Set<MeshStandardMaterial | LineBasicMaterial>();
	group.traverse((object) => {
		const drawable = object as typeof object & {
			geometry?: BufferGeometry;
			material?: MeshStandardMaterial | LineBasicMaterial | Array<MeshStandardMaterial | LineBasicMaterial>;
		};
		if (drawable.geometry) geometries.add(drawable.geometry);
		if (Array.isArray(drawable.material)) for (const material of drawable.material) materials.add(material);
		else if (drawable.material) materials.add(drawable.material);
	});
	for (const geometry of geometries) geometry.dispose();
	for (const material of materials) material.dispose();
}

function makeSelectionGroup(snapshot: BomcSnapshot, entityId: string): Group | null {
	const subset = validateEditableSubset(snapshot.graph);
	if (!subset.editable) throw new Error(`Checkpoint is outside the authoring subset: ${subset.reason}`);
	const entity = subset.entities.find((candidate) => candidate.entityId === entityId);
	const mesh = snapshot.graph.meshes[0];
	if (!entity || !mesh) return null;
	const group = new Group();
	group.name = SELECTION_OVERLAY_KEY;
	try {
		addBoundaryLines(group, uniqueBoundaryPositions(mesh, entity.faces), '#125dff', 1, true);
		return group;
	} catch (error) {
		disposeUntransferred(group);
		throw error;
	}
}

function makeFaceGroup(mesh: BomcMesh, faces: readonly Face[], name: string, opacity = 0.34): Group {
	const group = new Group();
	group.name = name;
	try {
		for (const face of faces) addFaceMesh(group, mesh, face, face.id, opacity);
		addBoundaryLines(group, uniqueBoundaryPositions(mesh, faces), '#125dff', Math.min(1, opacity + 0.3), false);
		return group;
	} catch (error) {
		disposeUntransferred(group);
		throw error;
	}
}

function faceFromPoints(points: readonly AuthoringPoint[], normal: AuthoringPoint): { mesh: BomcMesh; face: Face } {
	const prepared = preparePolygon(points, normal, { canonicalizeStart: false });
	const positions = prepared.points.flatMap((point) => [...point]);
	const ring = prepared.points.map((_point, index) => index);
	return {
		mesh: { id: 'preview:mesh', definitionId: 'preview:root', positions, faces: [] },
		face: {
			id: 'preview:face', outer: ring, holes: [], triangles: prepared.triangles,
			normal: prepared.normal, frontMaterialId: null, backMaterialId: null,
			hidden: false, surfaceCode: 0, roleCode: 0, label: null
		}
	};
}

function addInferenceMarker(group: Group, viewport: AuthoringToolControllerOptions['viewport'], inference: AuthoringInference | null): void {
	if (!inference) return;
	const scale = viewport.worldUnitsPerPixelAt(inference.point);
	if (scale === null || !Number.isFinite(scale) || scale <= 0) return;
	const radius = scale * 6;
	const [x, y, z] = inference.point;
	addBoundaryLines(group, [
		x - radius, y, z, x + radius, y, z,
		x, y - radius, z, x, y + radius, z,
		x, y, z - radius, x, y, z + radius
	], '#125dff', 1, true);
}

function makeRectanglePreview(
	viewport: AuthoringToolControllerOptions['viewport'],
	points: readonly AuthoringPoint[],
	normal: AuthoringPoint,
	inference: AuthoringInference | null
): Group {
	const { mesh, face } = faceFromPoints(points, normal);
	const group = new Group();
	group.name = PREVIEW_OVERLAY_KEY;
	try {
		addFaceMesh(group, mesh, face, 'preview:rectangle', 0.30);
		addBoundaryLines(group, uniqueBoundaryPositions(mesh, [face]), '#125dff', 0.72, false);
		addInferenceMarker(group, viewport, inference);
		return group;
	} catch (error) {
		disposeUntransferred(group);
		throw error;
	}
}

function makeInferenceOnlyPreview(viewport: AuthoringToolControllerOptions['viewport'], inference: AuthoringInference | null): Group | null {
	if (!inference) return null;
	const group = new Group();
	group.name = PREVIEW_OVERLAY_KEY;
	try { addInferenceMarker(group, viewport, inference); return group; }
	catch (error) { disposeUntransferred(group); throw error; }
}

function makeLinePreview(
	viewport: AuthoringToolControllerOptions['viewport'],
	points: readonly AuthoringPoint[],
	inference: AuthoringInference | null
): Group | null {
	if (points.length === 0 && !inference) return null;
	const group = new Group();
	group.name = PREVIEW_OVERLAY_KEY;
	try {
		const segments: number[] = [];
		for (let index = 1; index < points.length; index += 1) segments.push(...points[index - 1]!, ...points[index]!);
		if (points.length > 0 && inference) segments.push(...points.at(-1)!, ...inference.point);
		addBoundaryLines(group, segments, '#125dff', 0.9, false);
		addInferenceMarker(group, viewport, inference);
		if (inference?.kind === 'closure' && points.length >= 3) {
			try {
				const prepared = preparePolygon(points, inference.plane.normal, { canonicalizeStart: false });
				const { mesh, face } = faceFromPoints(prepared.points, prepared.normal);
				addFaceMesh(group, mesh, face, 'preview:line-loop', 0.20);
			} catch (error) {
				if (!(error instanceof AuthoringPolygonError)) throw error;
			}
		}
		return group;
	} catch (error) {
		disposeUntransferred(group);
		throw error;
	}
}

function makePushPullPreview(checkpoint: AuthoringCheckpoint, faceId: string, distance: number): Group {
	const edit = buildPushPullFaceEdit(checkpoint.snapshot.graph, faceId, distance, checkpoint.sequence);
	const replacement = edit.forward.find((item) => item.type === 'put-mesh');
	if (!replacement || replacement.type !== 'put-mesh') throw new Error('Push/Pull preview did not produce a root mesh replacement.');
	const operationId = `${checkpoint.snapshot.graph.documentId}:op:${checkpoint.sequence}`;
	const faces = replacement.value.faces.filter((face) => face.id === faceId || face.label?.includes(operationId));
	if (faces.length === 0) throw new Error('Push/Pull preview contains no changed faces.');
	return makeFaceGroup(replacement.value, faces, PREVIEW_OVERLAY_KEY, 0.34);
}

function nearestEntityHit(graph: BomcGraph, clientX: number, clientY: number, viewport: AuthoringToolControllerOptions['viewport']): EntityHit | null {
	const ray = viewport.rayFromScreen(clientX, clientY);
	if (!ray) return null;
	const hit = nearestAuthoringFaceHit(graph, ray);
	if (!hit) return null;
	const entityId = parseEntityId(hit.face) ?? hit.face.id;
	return { entityId, faceId: hit.face.id, distance: hit.distance };
}

function parseEntityId(face: Face): string | null {
	if (face.label === null) return null;
	try {
		const label: unknown = JSON.parse(face.label);
		return Array.isArray(label) && label[0] === SHAPE_SCHEMA && typeof label[2] === 'string' ? label[2] : face.id;
	} catch { return null; }
}

/** Pointer, inference and transient overlay owner for canonical authoring tools. */
export class AuthoringToolController {
	private readonly options: AuthoringToolControllerOptions;
	private checkpoint: AuthoringCheckpoint | null;
	private activeTool: AuthoringTool = 'select';
	private pointer: PointerGesture | null = null;
	private rectangle: RectangleGesture | null = null;
	private linePoints: AuthoringPoint[] = [];
	private linePlane: AuthoringPlane | null = null;
	private pushPull: PushPullGesture | null = null;
	private extrusionText = '';
	private selectedEntity: string | null = null;
	private commandPending = false;
	private disposed = false;
	private inference = '';
	private previewFrame: number | null = null;
	private pendingPreview: { x: number; y: number } | null = null;

	constructor(options: AuthoringToolControllerOptions) {
		this.options = options;
		this.checkpoint = options.getCheckpoint();
	}

	get tool(): AuthoringTool { return this.activeTool; }
	get selectedEntityId(): string | null { return this.selectedEntity; }
	get inferenceLabel(): string { return this.inference; }

	setTool(tool: AuthoringTool): void {
		if (this.disposed || tool === this.activeTool) return;
		this.cancelPreview();
		this.pointer = null;
		this.activeTool = tool;
	}

	handlePointerDown(event: PointerEvent, cameraHandled: boolean): void {
		if (this.disposed || this.commandPending || event.button !== 0 || event.isPrimary === false || this.pointer) return;
		if (cameraHandled) {
			this.cancelForCameraMove();
			return;
		}
		this.pointer = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			moved: false,
			cameraHandled: false,
			checkpoint: this.options.getCheckpoint(),
			tool: this.activeTool
		};
	}

	handlePointerMove(event: PointerEvent, cameraHandled: boolean): void {
		if (this.disposed || this.commandPending) return;
		if (cameraHandled) {
			if (this.pointer && event.pointerId === this.pointer.pointerId) this.pointer.cameraHandled = true;
			this.cancelForCameraMove();
			return;
		}
		if (this.pointer && event.pointerId === this.pointer.pointerId) {
			this.pointer.moved ||= Math.hypot(event.clientX - this.pointer.startX, event.clientY - this.pointer.startY) > POINTER_DRAG_THRESHOLD_CSS_PX;
		}
		this.queuePreview(event.clientX, event.clientY);
	}

	handlePointerUp(event: PointerEvent, cameraHandled: boolean): void {
		const pointer = this.pointer;
		if (!pointer || pointer.pointerId !== event.pointerId) return;
		this.pointer = null;
		const current = this.options.getCheckpoint();
		if (this.disposed || this.commandPending || pointer.cameraHandled || cameraHandled || pointer.moved || pointer.checkpoint !== current) return;
		if (pointer.tool === 'select') this.selectAt(event.clientX, event.clientY, current);
		else if (pointer.tool === 'rectangle') this.rectangleClick(event.clientX, event.clientY, current);
		else if (pointer.tool === 'line') this.lineClick(event.clientX, event.clientY, current);
		else this.pushPullClick(event.clientX, event.clientY, current);
	}

	handlePointerCancel(): void {
		this.pointer = null;
		if (this.activeTool !== 'line') this.cancelPreview();
	}

	/** Notify transient tools after a camera change that did not travel through pointer camera handling. */
	handleCameraChange(): void {
		if (this.disposed) return;
		this.pointer = null;
		this.cancelQueuedPreview();
		this.cancelForCameraMove();
	}

	setCheckpoint(checkpoint: AuthoringCheckpoint | null): void {
		if (this.disposed || checkpoint === this.checkpoint) return;
		this.checkpoint = checkpoint;
		this.pointer = null;
		this.rectangle = null;
		this.linePoints = [];
		this.linePlane = null;
		this.pushPull = null;
		this.extrusionText = '';
		this.cancelQueuedPreview();
		this.clearPreviewOverlay();
		this.setInference(null);
		if (this.selectedEntity && (!checkpoint || !hasEntityId(checkpoint.snapshot.graph, this.selectedEntity))) {
			this.setSelection(null, checkpoint);
		} else if (this.selectedEntity && checkpoint) {
			this.refreshSelectionOverlay(checkpoint, this.selectedEntity);
		}
	}

	setExtrusionDistance(text: string): void {
		this.extrusionText = text;
		const parsed = parseDistance(text);
		if ('error' in parsed || !this.pushPull) {
			if (!this.pushPull) return;
			this.clearPreviewOverlay();
			return;
		}
		this.updatePushPullPreview(parsed.value);
	}

	commitExtrusionDistance(): Promise<AuthoringResult | null> {
		const parsed = parseDistance(this.extrusionText);
		if ('error' in parsed) {
			this.options.onError(parsed.error);
			return Promise.resolve(null);
		}
		const checkpoint = this.options.getCheckpoint();
		if (!checkpoint || !this.pushPull || checkpoint !== this.pushPull.checkpoint) {
			this.options.onError('Hover and click an authored face before entering a Push/Pull distance.');
			return Promise.resolve(null);
		}
		const faceId = this.pushPull.faceId;
		this.cancelPushPull();
		return this.submit({ kind: 'PUSH_PULL_FACE', faceId, distance: parsed.value }, checkpoint);
	}

	cancelPreview(): void {
		this.rectangle = null;
		this.linePoints = [];
		this.linePlane = null;
		this.pushPull = null;
		this.extrusionText = '';
		this.clearPreviewOverlay();
		this.setInference(null);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.pointer = null;
		this.rectangle = null;
		this.linePoints = [];
		this.linePlane = null;
		this.pushPull = null;
		this.extrusionText = '';
		this.cancelQueuedPreview();
		this.options.viewport.setDomainOverlay(PREVIEW_OVERLAY_KEY, null);
		this.options.viewport.setDomainOverlay(SELECTION_OVERLAY_KEY, null);
		this.selectedEntity = null;
		this.checkpoint = null;
		this.setInference(null);
	}

	private cancelForCameraMove(): void {
		if (this.pushPull) this.cancelPushPull();
		if (this.rectangle) {
			this.rectangle = null;
			this.clearPreviewOverlay();
			this.setInference(null);
		}
	}

	private selectAt(clientX: number, clientY: number, checkpoint: AuthoringCheckpoint | null): void {
		if (!checkpoint) return;
		const hit = nearestEntityHit(checkpoint.snapshot.graph, clientX, clientY, this.options.viewport);
		this.setSelection(hit?.entityId ?? null, checkpoint);
	}

	private rectangleInference(clientX: number, clientY: number, checkpoint: AuthoringCheckpoint): AuthoringInference | null {
		if (!this.rectangle) {
			return resolveAuthoringInference({
				graph: checkpoint.snapshot.graph,
				viewport: this.options.viewport,
				clientX,
				clientY,
				activePlane: GROUND_PLANE
			});
		}
		const preferred = resolveAuthoringInference({
			graph: checkpoint.snapshot.graph,
			viewport: this.options.viewport,
			clientX,
			clientY,
			anchor: this.rectangle.first,
			restrictToPlane: this.rectangle.plane
		});
		return preferred ?? resolveAuthoringInference({
			graph: checkpoint.snapshot.graph,
			viewport: this.options.viewport,
			clientX,
			clientY,
			activePlane: this.rectangle.plane,
			anchor: this.rectangle.first,
			restrictToPlane: this.rectangle.plane
		});
	}

	private previewRectangleAt(clientX: number, clientY: number): void {
		const checkpoint = this.options.getCheckpoint();
		if (!checkpoint) return;
		const inference = this.rectangleInference(clientX, clientY, checkpoint);
		this.setInference(inference);
		if (!this.rectangle) {
			try { this.publishPreview(makeInferenceOnlyPreview(this.options.viewport, inference)); }
			catch { this.clearPreviewOverlay(); }
			return;
		}
		if (!inference) { this.clearPreviewOverlay(); return; }
		try {
			const points = rectangleCorners(this.rectangle.first, inference.point, this.rectangle.basis);
			this.publishPreview(makeRectanglePreview(this.options.viewport, points, this.rectangle.plane.normal, inference));
		} catch { this.clearPreviewOverlay(); }
	}

	private rectangleClick(clientX: number, clientY: number, checkpoint: AuthoringCheckpoint | null): void {
		if (!checkpoint) return;
		const inference = this.rectangleInference(clientX, clientY, checkpoint);
		if (!inference) return;
		if (!this.rectangle) {
			this.rectangle = Object.freeze({
				first: inference.point,
				plane: inference.plane,
				basis: constructionBasis(inference.plane.normal, inference.point, this.options.viewport)
			});
			this.previewRectangleAt(clientX, clientY);
			return;
		}
		const rectangle = this.rectangle;
		const points = rectangleCorners(rectangle.first, inference.point, rectangle.basis);
		try { preparePolygon(points, rectangle.plane.normal); }
		catch (error) {
			this.options.onError(error instanceof Error ? error.message : 'Rectangle dimensions are invalid.');
			return;
		}
		this.rectangle = null;
		this.clearPreviewOverlay();
		this.setInference(null);
		void this.submit({ kind: 'CREATE_RECTANGLE', points, normal: rectangle.plane.normal }, checkpoint);
	}

	private lineInference(clientX: number, clientY: number, checkpoint: AuthoringCheckpoint): AuthoringInference | null {
		if (this.linePoints.length === 0) {
			return resolveAuthoringInference({
				graph: checkpoint.snapshot.graph,
				viewport: this.options.viewport,
				clientX,
				clientY,
				activePlane: GROUND_PLANE
			});
		}
		const anchor = this.linePoints.at(-1)!;
		const closurePoint = this.linePoints.length >= 3 ? this.linePoints[0]! : null;
		const preferred = resolveAuthoringInference({
			graph: checkpoint.snapshot.graph,
			viewport: this.options.viewport,
			clientX,
			clientY,
			anchor,
			closurePoint
		});
		return preferred ?? resolveAuthoringInference({
			graph: checkpoint.snapshot.graph,
			viewport: this.options.viewport,
			clientX,
			clientY,
			activePlane: this.linePlane,
			anchor,
			closurePoint
		});
	}

	private previewLineAt(clientX: number, clientY: number): void {
		const checkpoint = this.options.getCheckpoint();
		if (!checkpoint) return;
		const inference = this.lineInference(clientX, clientY, checkpoint);
		this.setInference(inference);
		try { this.publishPreview(makeLinePreview(this.options.viewport, this.linePoints, inference)); }
		catch { this.clearPreviewOverlay(); }
	}

	private lineClick(clientX: number, clientY: number, checkpoint: AuthoringCheckpoint | null): void {
		if (!checkpoint) return;
		const inference = this.lineInference(clientX, clientY, checkpoint);
		if (!inference) return;
		if (this.linePoints.length === 0) {
			this.linePoints = [inference.point];
			this.linePlane = inference.plane;
			this.previewLineAt(clientX, clientY);
			return;
		}
		if (inference.kind === 'closure' && this.linePoints.length >= 3 && this.linePlane) {
			let prepared;
			try { prepared = preparePolygon(this.linePoints); }
			catch (error) {
				this.options.onError(error instanceof Error ? error.message : 'Line loop is invalid.');
				return;
			}
			const points = [...prepared.points] as AuthoringPoint[];
			const normal = prepared.normal as AuthoringPoint;
			this.linePoints = [];
			this.linePlane = null;
			this.clearPreviewOverlay();
			this.setInference(null);
			void this.submit({ kind: 'CREATE_FACE_LOOP', points, normal }, checkpoint);
			return;
		}
		const previous = this.linePoints.at(-1)!;
		if (Math.hypot(inference.point[0] - previous[0], inference.point[1] - previous[1], inference.point[2] - previous[2]) < 1e-6) return;
		this.linePoints = [...this.linePoints, inference.point];
		this.linePlane = inference.plane;
		this.previewLineAt(clientX, clientY);
	}

	private previewPushPullAt(clientX: number, clientY: number): void {
		const checkpoint = this.options.getCheckpoint();
		if (!checkpoint) return;
		if (this.pushPull) {
			if (checkpoint !== this.pushPull.checkpoint) { this.cancelPushPull(); return; }
			const distance = solveAxisDrag(this.options.viewport, this.pushPull.drag, clientX, clientY);
			this.pushPull = Object.freeze({ ...this.pushPull, distance });
			if (distance === null || Math.abs(distance) < MIN_EXTRUSION_METRES) { this.clearPreviewOverlay(); return; }
			this.updatePushPullPreview(distance);
			return;
		}
		const ray = this.options.viewport.rayFromScreen(clientX, clientY);
		const hit = ray ? nearestAuthoringFaceHit(checkpoint.snapshot.graph, ray) : null;
		this.setInference(hit ? Object.freeze({ point: hit.point, kind: 'face', faceId: hit.face.id, plane: { origin: pointAt(checkpoint.snapshot.graph.meshes[0]!, hit.face.outer[0]!), normal: hit.face.normal }, screenDistancePx: 0 }) : null);
		if (!hit) { this.clearPreviewOverlay(); return; }
		try { this.publishPreview(makeFaceGroup(checkpoint.snapshot.graph.meshes[0]!, [hit.face], PREVIEW_OVERLAY_KEY, 0.22)); }
		catch { this.clearPreviewOverlay(); }
	}

	private pushPullClick(clientX: number, clientY: number, checkpoint: AuthoringCheckpoint | null): void {
		if (!checkpoint) return;
		if (!this.pushPull) {
			const ray = this.options.viewport.rayFromScreen(clientX, clientY);
			const hit = ray ? nearestAuthoringFaceHit(checkpoint.snapshot.graph, ray) : null;
			if (!hit) return;
			const drag = captureAxisDrag(this.options.viewport, hit.point, hit.face.normal, clientX, clientY);
			if (!drag) {
				this.options.onError('Push/Pull could not establish a stable face-normal drag from this camera view.');
				return;
			}
			this.pushPull = Object.freeze({ faceId: hit.face.id, checkpoint, drag, distance: null });
			this.extrusionText = '';
			this.previewPushPullAt(clientX, clientY);
			return;
		}
		if (checkpoint !== this.pushPull.checkpoint) { this.cancelPushPull(); return; }
		const distance = solveAxisDrag(this.options.viewport, this.pushPull.drag, clientX, clientY) ?? this.pushPull.distance;
		if (distance === null || !Number.isFinite(distance) || Math.abs(distance) < MIN_EXTRUSION_METRES) {
			this.options.onError('Move along the face normal by at least 0.000001 m before committing Push/Pull.');
			return;
		}
		const faceId = this.pushPull.faceId;
		this.cancelPushPull();
		void this.submit({ kind: 'PUSH_PULL_FACE', faceId, distance }, checkpoint);
	}

	private updatePushPullPreview(distance: number): void {
		const checkpoint = this.options.getCheckpoint();
		if (!checkpoint || !this.pushPull || checkpoint !== this.pushPull.checkpoint) return;
		try { this.publishPreview(makePushPullPreview(checkpoint, this.pushPull.faceId, distance)); }
		catch (error) {
			this.clearPreviewOverlay();
			this.options.onError(error instanceof Error ? error.message : 'Push/Pull preview is invalid.');
		}
	}

	private cancelPushPull(): void {
		this.pushPull = null;
		this.extrusionText = '';
		this.clearPreviewOverlay();
		this.setInference(null);
	}

	private queuePreview(clientX: number, clientY: number): void {
		this.pendingPreview = { x: clientX, y: clientY };
		const raf = globalThis.requestAnimationFrame;
		if (typeof raf !== 'function') { this.flushPreview(); return; }
		if (this.previewFrame !== null) return;
		this.previewFrame = raf(() => {
			this.previewFrame = null;
			this.flushPreview();
		});
	}

	private flushPreview(): void {
		const pending = this.pendingPreview;
		this.pendingPreview = null;
		if (!pending || this.disposed || this.commandPending) return;
		if (this.activeTool === 'rectangle') this.previewRectangleAt(pending.x, pending.y);
		else if (this.activeTool === 'line') this.previewLineAt(pending.x, pending.y);
		else if (this.activeTool === 'extrude') this.previewPushPullAt(pending.x, pending.y);
	}

	private cancelQueuedPreview(): void {
		this.pendingPreview = null;
		if (this.previewFrame === null) return;
		if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(this.previewFrame);
		this.previewFrame = null;
	}

	private publishPreview(group: Group | null): void {
		if (this.disposed) {
			if (group) disposeUntransferred(group);
			return;
		}
		this.options.viewport.setDomainOverlay(PREVIEW_OVERLAY_KEY, group);
	}

	private clearPreviewOverlay(): void {
		this.options.viewport.setDomainOverlay(PREVIEW_OVERLAY_KEY, null);
	}

	private setSelection(entityId: string | null, checkpoint: AuthoringCheckpoint | null): void {
		this.selectedEntity = entityId;
		this.options.onSelectionChange(entityId);
		if (entityId && checkpoint) this.refreshSelectionOverlay(checkpoint, entityId);
		else this.options.viewport.setDomainOverlay(SELECTION_OVERLAY_KEY, null);
	}

	private refreshSelectionOverlay(checkpoint: AuthoringCheckpoint, entityId: string): void {
		try {
			const group = makeSelectionGroup(checkpoint.snapshot, entityId);
			this.options.viewport.setDomainOverlay(SELECTION_OVERLAY_KEY, group);
		} catch (error) {
			this.options.viewport.setDomainOverlay(SELECTION_OVERLAY_KEY, null);
			this.options.onError(error instanceof Error ? error.message : 'Unable to create the selection outline.');
		}
	}

	private setInference(inference: AuthoringInference | null): void {
		const next = inferenceLabel(inference);
		if (next === this.inference) return;
		this.inference = next;
		this.options.onInferenceChange?.(next);
	}

	private async submit(command: AuthoringCommand, checkpoint: AuthoringCheckpoint): Promise<AuthoringResult | null> {
		if (this.disposed || this.commandPending) return null;
		this.commandPending = true;
		const documentId = checkpoint.snapshot.graph.documentId;
		try {
			const result = await this.options.submitCommand(command);
			const current = this.options.getCheckpoint();
			if (this.disposed || current?.snapshot.graph.documentId !== documentId) return null;
			const entityId = result.commandResult?.entityId ?? null;
			if (entityId && hasEntityId(result.checkpoint.snapshot.graph, entityId)) this.setSelection(entityId, result.checkpoint);
			return result;
		} catch (error) {
			if (!this.disposed && this.options.getCheckpoint()?.snapshot.graph.documentId === documentId) {
				this.clearPreviewOverlay();
				this.options.onError(error instanceof Error ? error.message : 'Authoring command failed.');
			}
			return null;
		} finally {
			this.commandPending = false;
		}
	}
}
