import {
	BufferGeometry,
	DoubleSide,
	Float32BufferAttribute,
	Group,
	LineBasicMaterial,
	LineSegments,
	Mesh,
	MeshStandardMaterial,
	Ray,
	Vector3
} from 'three';
import type { BomcGraph, BomcSnapshot, Face, Mesh as BomcMesh } from '@sibambo/bomc-document';
import type { PreparedSceneViewport } from '@sibambo/viewport';
import { buildExtrusionEdit, hasEntityId, validateEditableSubset, validateRectangleInput, type AuthoringEntity } from './geometry.js';
import type { AuthoringCheckpoint, AuthoringCommand, AuthoringResult } from './protocol.js';

const PREVIEW_OVERLAY_KEY = 'editor-authoring-preview';
const SELECTION_OVERLAY_KEY = 'editor-authoring-selection';
const POINTER_DRAG_THRESHOLD_CSS_PX = 4;
const POINTER_EXTRUSION_METRES_PER_CSS_PX = 0.02;
const MIN_EXTRUSION_METRES = 1e-6;
const SHAPE_SCHEMA = 'sibambo-editor-shape-v1';

export type AuthoringTool = 'select' | 'rectangle' | 'extrude';
export type AuthoringToolControllerOptions = {
	viewport: Pick<PreparedSceneViewport, 'rayFromScreen' | 'setDomainOverlay'>;
	getCheckpoint: () => AuthoringCheckpoint | null;
	submitCommand: (command: AuthoringCommand) => Promise<AuthoringResult>;
	onSelectionChange: (entityId: string | null) => void;
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

function codeUnitCompare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

function pointAt(mesh: BomcMesh, vertexIndex: number): [number, number, number] {
	return [mesh.positions[vertexIndex * 3]!, mesh.positions[vertexIndex * 3 + 1]!, mesh.positions[vertexIndex * 3 + 2]!];
}

function parseDistance(text: string): ParsedDistance {
	const valueText = text.trim();
	if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(valueText)) {
		return { error: 'Enter a complete finite extrusion distance in metres.' };
	}
	const value = Number(valueText);
	if (!Number.isFinite(value)) return { error: 'Extrusion distance must be finite.' };
	if (Math.abs(value) < MIN_EXTRUSION_METRES) return { error: 'Extrusion distance must be at least 0.000001 m from zero.' };
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
		for (let index = 0; index < face.outer.length; index += 1) {
			const first = face.outer[index]!;
			const second = face.outer[(index + 1) % face.outer.length]!;
			const key = first < second ? `${first}:${second}` : `${second}:${first}`;
			if (seen.has(key)) continue;
			seen.add(key);
			positions.push(...pointAt(mesh, first), ...pointAt(mesh, second));
		}
	}
	return positions;
}

function addFaceMesh(group: Group, mesh: BomcMesh, face: Face, entityId: string, opacity: number): void {
	const vertexIndices = [...new Set(face.outer)];
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
			color: '#9b1c31',
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

function addBoundaryLines(group: Group, positions: readonly number[], color: '#125dff' | '#9b1c31', opacity: number, selected: boolean): void {
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

function makeRectanglePreview(first: readonly [number, number, number], opposite: readonly [number, number, number]): Group {
	const xmin = Math.min(first[0], opposite[0]);
	const xmax = Math.max(first[0], opposite[0]);
	const zmin = Math.min(first[2], opposite[2]);
	const zmax = Math.max(first[2], opposite[2]);
	const group = new Group();
	group.name = PREVIEW_OVERLAY_KEY;
	const mesh: BomcMesh = {
		id: 'preview:rectangle', definitionId: 'preview:root',
		positions: [xmin, 0, zmin, xmin, 0, zmax, xmax, 0, zmax, xmax, 0, zmin],
		faces: []
	};
	const face: Face = {
		id: 'preview:rectangle:face', outer: [0, 1, 2, 3], holes: [], triangles: [0, 1, 2, 0, 2, 3],
		normal: [0, 1, 0], frontMaterialId: null, backMaterialId: null,
		hidden: false, surfaceCode: 0, roleCode: 0, label: null
	};
	try {
		addFaceMesh(group, mesh, face, 'preview:rectangle', 0.35);
		addBoundaryLines(group, uniqueBoundaryPositions(mesh, [face]), '#9b1c31', 0.35, false);
		return group;
	} catch (error) {
		disposeUntransferred(group);
		throw error;
	}
}

function makeExtrusionPreview(graph: BomcGraph, entityId: string, distance: number): Group {
	const edit = buildExtrusionEdit(graph, entityId, distance);
	const replacement = edit.forward.find((item) => item.type === 'put-mesh');
	if (!replacement || replacement.type !== 'put-mesh') throw new Error('Extrusion preview did not produce a root mesh replacement.');
	const previewMesh = replacement.value;
	const previewFaces = previewMesh.faces.filter((face) => face.id === entityId || face.id.startsWith(`${entityId}:`));
	if (previewFaces.length !== 6) throw new Error('Extrusion preview did not produce the six canonical prism faces.');
	const group = new Group();
	group.name = PREVIEW_OVERLAY_KEY;
	try {
		for (const face of previewFaces) addFaceMesh(group, previewMesh, face, entityId, 0.35);
		addBoundaryLines(group, uniqueBoundaryPositions(previewMesh, previewFaces), '#9b1c31', 0.35, false);
		return group;
	} catch (error) {
		disposeUntransferred(group);
		throw error;
	}
}

function groundIntersection(ray: Ray): [number, number, number] | null {
	if (ray.direction.y === 0) return null;
	const distance = -ray.origin.y / ray.direction.y;
	if (!Number.isFinite(distance) || distance < 0) return null;
	const point = ray.at(distance, new Vector3());
	if (!point.toArray().every(Number.isFinite)) return null;
	return [point.x, 0, point.z];
}

function nearestEntityHit(graph: BomcGraph, ray: Ray): EntityHit | null {
	const subset = validateEditableSubset(graph);
	if (!subset.editable) return null;
	const mesh = graph.meshes[0];
	if (!mesh) return null;
	const validEntityIds = new Set(subset.entities.map((entity) => entity.entityId));
	let best: EntityHit | null = null;
	for (const face of mesh.faces) {
		const entityId = parseEntityId(face);
		if (!entityId || !validEntityIds.has(entityId)) continue;
		for (let index = 0; index < face.triangles.length; index += 3) {
			const a = new Vector3(...pointAt(mesh, face.triangles[index]!));
			const b = new Vector3(...pointAt(mesh, face.triangles[index + 1]!));
			const c = new Vector3(...pointAt(mesh, face.triangles[index + 2]!));
			const hit = ray.intersectTriangle(a, b, c, false, new Vector3());
			if (!hit) continue;
			const distance = hit.distanceTo(ray.origin);
			const alongRay = hit.clone().sub(ray.origin).dot(ray.direction);
			if (!Number.isFinite(distance) || alongRay < 0) continue;
			if (!best || distance < best.distance - 1e-9
				|| (Math.abs(distance - best.distance) <= 1e-9 && codeUnitCompare(face.id, best.faceId) < 0)) {
				best = { entityId, faceId: face.id, distance };
			}
		}
	}
	return best;
}

function parseEntityId(face: Face): string | null {
	if (face.label === null) return null;
	try {
		const label: unknown = JSON.parse(face.label);
		return Array.isArray(label) && label[0] === SHAPE_SCHEMA && typeof label[2] === 'string' ? label[2] : null;
	} catch { return null; }
}

/** Pointer and transient overlay owner for the supported canonical authoring tools. */
export class AuthoringToolController {
	private readonly options: AuthoringToolControllerOptions;
	private checkpoint: AuthoringCheckpoint | null;
	private activeTool: AuthoringTool = 'select';
	private pointer: PointerGesture | null = null;
	private rectangleFirst: [number, number, number] | null = null;
	private extrusionStartY: number | null = null;
	private extrusionText = '';
	private selectedEntity: string | null = null;
	private commandPending = false;
	private disposed = false;

	constructor(options: AuthoringToolControllerOptions) {
		this.options = options;
		this.checkpoint = options.getCheckpoint();
	}

	get tool(): AuthoringTool { return this.activeTool; }
	get selectedEntityId(): string | null { return this.selectedEntity; }

	setTool(tool: AuthoringTool): void {
		if (this.disposed || tool === this.activeTool) return;
		this.cancelPreview();
		this.pointer = null;
		this.activeTool = tool;
	}

	handlePointerDown(event: PointerEvent, cameraHandled: boolean): void {
		if (this.disposed || this.commandPending || cameraHandled || event.button !== 0 || event.isPrimary === false || this.pointer) return;
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
		if (this.pointer && event.pointerId === this.pointer.pointerId) {
			this.pointer.moved ||= Math.hypot(event.clientX - this.pointer.startX, event.clientY - this.pointer.startY) > POINTER_DRAG_THRESHOLD_CSS_PX;
			this.pointer.cameraHandled ||= cameraHandled;
			if (this.activeTool === 'extrude' && this.extrusionStartY !== null && !cameraHandled) {
				this.updateExtrusionPreview((this.extrusionStartY - event.clientY) * POINTER_EXTRUSION_METRES_PER_CSS_PX);
			}
			return;
		}
		if (cameraHandled) return;
		if (this.activeTool === 'rectangle' && this.rectangleFirst) {
			const point = this.groundPoint(event.clientX, event.clientY);
			if (point) this.updateRectanglePreview(this.rectangleFirst, point);
		}
		if (this.activeTool === 'extrude' && this.extrusionStartY !== null) {
			this.updateExtrusionPreview((this.extrusionStartY - event.clientY) * POINTER_EXTRUSION_METRES_PER_CSS_PX);
		}
	}

	handlePointerUp(event: PointerEvent, cameraHandled: boolean): void {
		const pointer = this.pointer;
		if (!pointer || pointer.pointerId !== event.pointerId) return;
		this.pointer = null;
		const current = this.options.getCheckpoint();
		if (this.disposed || this.commandPending || pointer.cameraHandled || cameraHandled || pointer.moved || pointer.checkpoint !== current) return;
		if (pointer.tool === 'select') {
			this.selectAt(event.clientX, event.clientY, current);
			return;
		}
		if (pointer.tool === 'rectangle') {
			this.rectangleClick(event.clientX, event.clientY, current);
			return;
		}
		if (pointer.tool === 'extrude') {
			this.extrusionClick(event.clientY, current);
		}
	}

	handlePointerCancel(): void {
		this.pointer = null;
		this.cancelPreview();
	}

	setCheckpoint(checkpoint: AuthoringCheckpoint | null): void {
		if (this.disposed || checkpoint === this.checkpoint) return;
		this.checkpoint = checkpoint;
		this.pointer = null;
		this.cancelPreview();
		if (this.selectedEntity && (!checkpoint || !hasEntityId(checkpoint.snapshot.graph, this.selectedEntity))) {
			this.setSelection(null, checkpoint);
		} else if (this.selectedEntity && checkpoint) {
			this.refreshSelectionOverlay(checkpoint, this.selectedEntity);
		}
	}

	setExtrusionDistance(text: string): void {
		this.extrusionText = text;
		const parsed = parseDistance(text);
		if ('error' in parsed) {
			this.clearPreviewOverlay();
			return;
		}
		const checkpoint = this.options.getCheckpoint();
		if (!checkpoint || !this.isSelectedFlatRectangle(checkpoint)) {
			this.clearPreviewOverlay();
			return;
		}
		this.updateExtrusionPreview(parsed.value);
	}

	commitExtrusionDistance(): Promise<AuthoringResult | null> {
		const parsed = parseDistance(this.extrusionText);
		if ('error' in parsed) {
			this.options.onError(parsed.error);
			return Promise.resolve(null);
		}
		const checkpoint = this.options.getCheckpoint();
		if (!checkpoint || !this.selectedEntity || !this.isSelectedFlatRectangle(checkpoint)) {
			this.options.onError('Select an unextruded authored rectangle before using Push/Pull.');
			return Promise.resolve(null);
		}
		const entityId = this.selectedEntity;
		this.cancelPreview();
		return this.submit({ kind: 'EXTRUDE_RECTANGLE', entityId, distance: parsed.value }, checkpoint);
	}

	cancelPreview(): void {
		this.rectangleFirst = null;
		this.extrusionStartY = null;
		this.extrusionText = '';
		this.clearPreviewOverlay();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.pointer = null;
		this.rectangleFirst = null;
		this.extrusionStartY = null;
		this.extrusionText = '';
		this.options.viewport.setDomainOverlay(PREVIEW_OVERLAY_KEY, null);
		this.options.viewport.setDomainOverlay(SELECTION_OVERLAY_KEY, null);
		this.selectedEntity = null;
		this.checkpoint = null;
	}

	private selectAt(clientX: number, clientY: number, checkpoint: AuthoringCheckpoint | null): void {
		if (!checkpoint) return;
		const ray = this.screenRay(clientX, clientY);
		const hit = ray ? nearestEntityHit(checkpoint.snapshot.graph, ray) : null;
		this.setSelection(hit?.entityId ?? null, checkpoint);
	}

	private rectangleClick(clientX: number, clientY: number, checkpoint: AuthoringCheckpoint | null): void {
		if (!checkpoint) return;
		const point = this.groundPoint(clientX, clientY);
		if (!point) return;
		if (!this.rectangleFirst) {
			this.rectangleFirst = point;
			return;
		}
		const first = this.rectangleFirst;
		try { validateRectangleInput(first, point); }
		catch (error) {
			this.cancelPreview();
			this.options.onError(error instanceof Error ? error.message : 'Rectangle dimensions are invalid.');
			return;
		}
		this.cancelPreview();
		void this.submit({ kind: 'CREATE_RECTANGLE', first, opposite: point }, checkpoint);
	}

	private extrusionClick(clientY: number, checkpoint: AuthoringCheckpoint | null): void {
		if (!checkpoint || !this.isSelectedFlatRectangle(checkpoint) || !this.selectedEntity) {
			this.options.onError('Select an unextruded authored rectangle before using Push/Pull.');
			return;
		}
		if (this.extrusionStartY === null) {
			this.extrusionStartY = clientY;
			return;
		}
		const distance = (this.extrusionStartY - clientY) * POINTER_EXTRUSION_METRES_PER_CSS_PX;
		if (!Number.isFinite(distance) || Math.abs(distance) < MIN_EXTRUSION_METRES) {
			this.cancelPreview();
			this.options.onError('Extrusion distance must be at least 0.000001 m from zero.');
			return;
		}
		const entityId = this.selectedEntity;
		this.cancelPreview();
		void this.submit({ kind: 'EXTRUDE_RECTANGLE', entityId, distance }, checkpoint);
	}

	private screenRay(clientX: number, clientY: number): Ray | null {
		return this.options.viewport.rayFromScreen(clientX, clientY);
	}

	private groundPoint(clientX: number, clientY: number): [number, number, number] | null {
		const ray = this.screenRay(clientX, clientY);
		return ray ? groundIntersection(ray) : null;
	}

	private updateRectanglePreview(first: readonly [number, number, number], opposite: readonly [number, number, number]): void {
		try { this.publishPreview(makeRectanglePreview(first, opposite)); }
		catch { this.clearPreviewOverlay(); }
	}

	private updateExtrusionPreview(distance: number): void {
		if (!Number.isFinite(distance) || Math.abs(distance) < MIN_EXTRUSION_METRES) {
			this.clearPreviewOverlay();
			return;
		}
		const checkpoint = this.options.getCheckpoint();
		if (!checkpoint || !this.selectedEntity || !this.isSelectedFlatRectangle(checkpoint)) {
			this.clearPreviewOverlay();
			return;
		}
		try { this.publishPreview(makeExtrusionPreview(checkpoint.snapshot.graph, this.selectedEntity, distance)); }
		catch { this.clearPreviewOverlay(); }
	}

	private publishPreview(group: Group): void {
		if (this.disposed) {
			disposeUntransferred(group);
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

	private isSelectedFlatRectangle(checkpoint: AuthoringCheckpoint): boolean {
		return entityForId(checkpoint.snapshot.graph, this.selectedEntity)?.kind === 'rectangle';
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
