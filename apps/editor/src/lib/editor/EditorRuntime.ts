import {
	Box3,
	BoxGeometry,
	BufferAttribute,
	BufferGeometry,
	DoubleSide,
	EdgesGeometry,
	Group,
	LineBasicMaterial,
	LineSegments,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	Ray,
	Raycaster,
	Vector3
} from 'three';
import type { EditorMutation } from './EditableGeometryStore';
import { EditableGeometryStore } from './EditableGeometryStore';
import type { EditableEntity, EditablePlanarFace, EditorSelectionHit } from './EditorState';
import { createPlane, extrusionCapFace, triangulateEditableFace, triangulateExtrusion } from './geometry/editable-geometry';
import type { SnapResult } from './snapping/SnapManager';

export type EditorRuntimeStats = {
	entityCount: number;
	objectCount: number;
	geometryCount: number;
	triangleCount: number;
	previewUpdates: number;
};

/** Imperative GPU layer for compact edits. It never owns or mutates imported scene objects. */
export class EditorRuntime {
	readonly root = new Group();
	readonly overlay = new Group();
	private readonly objects = new Map<string, Group>();
	private readonly raycaster = new Raycaster();
	private readonly previewGeometry = new BufferGeometry();
	private readonly hoverGeometry = new BufferGeometry();
	private readonly snapAxisGeometry = new BufferGeometry();
	private readonly pushPullPosGeometry = new BufferGeometry();
	private readonly pushPullNegGeometry = new BufferGeometry();
	private readonly previewMesh: Mesh;
	private readonly hoverMesh: Mesh;
	private readonly snapMarkerMesh: Mesh;
	private readonly snapAxisLine: LineSegments;
	private readonly pushPullCueGroup = new Group();
	private readonly pushPullPosLine: LineSegments;
	private readonly pushPullNegLine: LineSegments;
	private readonly pushPullAnchorMesh: Mesh;
	private readonly unsubscribe: () => void;
	private previewUpdates = 0;

	constructor(private readonly store: EditableGeometryStore, private readonly invalidate: () => void) {
		this.root.name = 'EditableGeometryLayer';
		this.overlay.name = 'EditorInteractionOverlay';
		this.previewMesh = new Mesh(this.previewGeometry, new MeshStandardMaterial({
			color: '#9b1c31', emissive: '#5f0e1d', emissiveIntensity: 0.2, transparent: true,
			opacity: 0.7, roughness: 0.7, metalness: 0, side: DoubleSide, depthWrite: false
		}));
		this.hoverMesh = new Mesh(this.hoverGeometry, new MeshBasicMaterial({
			color: '#facc15', transparent: true, opacity: 0.18, side: DoubleSide, depthWrite: false,
			polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
		}));
		this.snapMarkerMesh = new Mesh(
			new BoxGeometry(0.06, 0.06, 0.06),
			new MeshBasicMaterial({ color: '#22c55e', depthTest: false, depthWrite: false })
		);
		this.snapAxisLine = new LineSegments(
			this.snapAxisGeometry,
			new LineBasicMaterial({ color: '#3b82f6', transparent: true, opacity: 0.85, depthTest: false, depthWrite: false })
		);
		this.pushPullPosLine = new LineSegments(
			this.pushPullPosGeometry,
			new LineBasicMaterial({ color: '#22c55e', transparent: true, opacity: 0.9, depthTest: false, depthWrite: false })
		);
		this.pushPullNegLine = new LineSegments(
			this.pushPullNegGeometry,
			new LineBasicMaterial({ color: '#ef4444', transparent: true, opacity: 0.6, depthTest: false, depthWrite: false })
		);
		this.pushPullAnchorMesh = new Mesh(
			new BoxGeometry(0.05, 0.05, 0.05),
			new MeshBasicMaterial({ color: '#22c55e', depthTest: false, depthWrite: false })
		);

		this.pushPullCueGroup.add(this.pushPullPosLine, this.pushPullNegLine, this.pushPullAnchorMesh);

		this.previewMesh.visible = false;
		this.hoverMesh.visible = false;
		this.snapMarkerMesh.visible = false;
		this.snapAxisLine.visible = false;
		this.pushPullCueGroup.visible = false;

		this.previewMesh.renderOrder = 80;
		this.hoverMesh.renderOrder = 79;
		this.snapMarkerMesh.renderOrder = 90;
		this.snapAxisLine.renderOrder = 89;
		this.pushPullCueGroup.renderOrder = 91;

		this.overlay.add(this.hoverMesh, this.previewMesh, this.snapMarkerMesh, this.snapAxisLine, this.pushPullCueGroup);
		this.unsubscribe = store.subscribe((mutation) => this.sync(mutation));
	}

	setPushPullCue(cue: { start: Vector3; end: Vector3; anchor: Vector3; normal: Vector3 } | null) {
		if (!cue) {
			this.pushPullCueGroup.visible = false;
			this.invalidate();
			return;
		}
		const { start, end, anchor } = cue;

		const posPositions = new Float32Array([
			anchor.x, anchor.y, anchor.z,
			end.x, end.y, end.z
		]);
		this.pushPullPosGeometry.setAttribute('position', new BufferAttribute(posPositions, 3));

		const negPositions = new Float32Array([
			start.x, start.y, start.z,
			anchor.x, anchor.y, anchor.z
		]);
		this.pushPullNegGeometry.setAttribute('position', new BufferAttribute(negPositions, 3));

		this.pushPullAnchorMesh.position.copy(anchor);
		this.pushPullCueGroup.visible = true;
		this.invalidate();
	}

	setSnapCue(snap: SnapResult | null) {
		if (!snap || snap.kind === 'face') {
			this.snapMarkerMesh.visible = false;
			this.snapAxisLine.visible = false;
			this.invalidate();
			return;
		}
		this.snapMarkerMesh.position.copy(snap.point);
		this.snapMarkerMesh.visible = true;

		const mat = this.snapMarkerMesh.material as MeshBasicMaterial;
		if (snap.kind === 'endpoint') mat.color.set('#22c55e');
		else if (snap.kind === 'midpoint') mat.color.set('#06b6d4');
		else if (snap.kind === 'edge') mat.color.set('#ef4444');
		else if (snap.kind === 'axis') mat.color.set('#3b82f6');
		else mat.color.set('#f59e0b');

		if (snap.kind === 'axis' && snap.snapPointA) {
			const positions = new Float32Array([
				snap.snapPointA.x, snap.snapPointA.y, snap.snapPointA.z,
				snap.point.x, snap.point.y, snap.point.z
			]);
			this.snapAxisGeometry.setAttribute('position', new BufferAttribute(positions, 3));
			this.snapAxisLine.visible = true;
		} else {
			this.snapAxisLine.visible = false;
		}
		this.invalidate();
	}

	setPreview(entity: EditableEntity | null, hover: EditablePlanarFace | null) {
		this.previewUpdates += 1;
		this.previewMesh.visible = Boolean(entity);
		this.hoverMesh.visible = Boolean(hover?.outer.length);
		if (entity) updateGeometry(this.previewGeometry, geometryData(entity));
		if (hover?.outer.length) updateGeometry(this.hoverGeometry, triangulateEditableFace(hover));
		this.invalidate();
	}

	pick(ray: Ray): EditorSelectionHit | null {
		this.raycaster.ray.copy(ray);
		const intersection = this.raycaster.intersectObjects([...this.objects.values()], true)[0];
		if (!intersection) return null;
		const id = findEditorId(intersection.object);
		const entity = id ? this.store.get(id) : undefined;
		if (!entity) return null;
		const face = entity.kind === 'face' ? entity : extrusionCapFace(entity);
		return {
			point: [intersection.point.x, intersection.point.y, intersection.point.z],
			plane: face.plane,
			face,
			distance: intersection.distance,
			imported: false
		};
	}

	stats(): EditorRuntimeStats {
		let objectCount = 0;
		let geometryCount = 0;
		let triangleCount = 0;
		this.root.traverse((object) => {
			objectCount += 1;
			if (object instanceof Mesh) {
				geometryCount += 1;
				triangleCount += object.geometry.index ? object.geometry.index.count / 3 : object.geometry.getAttribute('position').count / 3;
			}
		});
		return { entityCount: this.store.size, objectCount, geometryCount, triangleCount, previewUpdates: this.previewUpdates };
	}

	dispose() {
		this.unsubscribe();
		for (const id of [...this.objects.keys()]) this.remove(id);
		this.previewGeometry.dispose();
		this.hoverGeometry.dispose();
		(this.previewMesh.material as MeshStandardMaterial).dispose();
		(this.hoverMesh.material as MeshBasicMaterial).dispose();
		this.root.removeFromParent();
		this.overlay.removeFromParent();
	}

	private sync(mutation: EditorMutation) {
		for (const id of new Set([...mutation.removed, ...mutation.updated])) this.remove(id);
		for (const id of [...mutation.added, ...mutation.updated]) {
			const entity = this.store.get(id);
			if (entity) this.add(entity);
		}
		this.invalidate();
	}

	private add(entity: EditableEntity) {
		const data = geometryData(entity);
		const geometry = new BufferGeometry();
		updateGeometry(geometry, data);
		geometry.computeVertexNormals();
		geometry.computeBoundingBox();
		geometry.computeBoundingSphere();
		const material = new MeshStandardMaterial({ color: entity.color, roughness: 0.72, metalness: 0, side: DoubleSide });
		const mesh = new Mesh(geometry, material);
		mesh.userData.editorId = entity.id;
		mesh.name = entity.id;
		const edges = new LineSegments(new EdgesGeometry(geometry, 22), new LineBasicMaterial({ color: '#4a0714', transparent: true, opacity: 0.82 }));
		edges.userData.editorId = entity.id;
		const group = new Group();
		group.userData.editorId = entity.id;
		group.add(mesh, edges);
		this.objects.set(entity.id, group);
		this.root.add(group);
	}

	private remove(id: string) {
		const group = this.objects.get(id);
		if (!group) return;
		group.removeFromParent();
		group.traverse((object) => {
			if (object instanceof Mesh || object instanceof LineSegments) {
				object.geometry.dispose();
				const materials = Array.isArray(object.material) ? object.material : [object.material];
				for (const material of materials) material.dispose();
			}
		});
		this.objects.delete(id);
	}
}

function geometryData(entity: EditableEntity) {
	return entity.kind === 'face' ? triangulateEditableFace(entity) : triangulateExtrusion(entity);
}

function updateGeometry(geometry: BufferGeometry, data: ReturnType<typeof geometryData>) {
	geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
	geometry.setIndex(new BufferAttribute(data.indices, 1));
	geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
}

function findEditorId(object: { userData: Record<string, unknown>; parent: typeof object | null }): string | null {
	let current: typeof object | null = object;
	while (current) {
		if (typeof current.userData.editorId === 'string') return current.userData.editorId;
		current = current.parent;
	}
	return null;
}
