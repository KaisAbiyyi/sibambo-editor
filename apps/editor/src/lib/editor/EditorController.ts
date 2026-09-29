import { Vector3 } from 'three';
import { CommandHistory, CreateShapeCommand, MoveCommand, PushPullCommand } from './commands/EditorCommand';
import { EditableGeometryStore, occurrenceTransformId, type OccurrenceTransform, type OccurrenceTranslation } from './EditableGeometryStore';
import type { EditablePlanarFace, EditorPlane, EditorPoint, EditorPreview, EditorSelectionHit, EditorTool } from './EditorState';
import { createCircle, createPlane, createRectangle, dimensions, extrudeFace, translateEntity } from './geometry/editable-geometry';

export class EditorController {
	readonly history = new CommandHistory();
	tool: EditorTool = 'select';
	preview: EditorPreview = { entity: null, label: '', hover: null };
	private firstPoint: EditorPoint | null = null;
	private drawingPlane: EditorPlane | null = null;
	pushFace: EditablePlanarFace | null = null;
	pushAnchorPoint: Vector3 | null = null;
	moveEntityId: string | null = null;
	private moveStartPoint: EditorPoint | null = null;
	private pushStartY = 0;
	private sequence = 0;
	private occurrenceMove: {
		id: string;
		artifactSha256: string;
		occurrenceHandle: string;
		before: OccurrenceTranslation;
		after: OccurrenceTranslation;
		delta: EditorPoint;
		axis: 'x' | 'y' | 'z' | null;
		distance: number | null;
	} | null = null;

	constructor(readonly store: EditableGeometryStore, private distanceScale = 0.02) {}

	setTool(tool: EditorTool) { this.cancel(); this.tool = tool; }
	setDistanceScale(scale: number) { this.distanceScale = Math.max(scale, 0.001); }

	get occurrenceMovePreview() {
		if (!this.occurrenceMove) return null;
		return { occurrenceHandle: this.occurrenceMove.occurrenceHandle, translation: this.occurrenceMove.after };
	}

	beginOccurrenceMove(input: { artifactSha256: string; occurrenceHandle: string; anchor: EditorPoint }) {
		this.cancel();
		if (!/^[a-f0-9]{64}$/i.test(input.artifactSha256) || !input.occurrenceHandle.trim() || !input.anchor.every(Number.isFinite)) return false;
		const id = occurrenceTransformId(input.artifactSha256, input.occurrenceHandle);
		const existing = this.store.getOccurrenceTransform(id);
		const before: OccurrenceTranslation = existing?.translation ?? [0, 0, 0];
		this.occurrenceMove = {
			id, artifactSha256: input.artifactSha256.toLowerCase(), occurrenceHandle: input.occurrenceHandle,
			before, after: before, delta: [0, 0, 0], axis: null, distance: null
		};
		this.preview = { entity: null, label: 'Move selected occurrence · drag to preview; click to commit; Escape to cancel.', hover: null };
		return true;
	}

	updateOccurrenceMove(delta: EditorPoint) {
		if (!this.occurrenceMove || !delta.every(Number.isFinite)) return null;
		this.occurrenceMove.delta = delta;
		this.refreshOccurrenceMovePreview();
		return this.occurrenceMovePreview;
	}

	setOccurrenceMoveAxis(axis: 'x' | 'y' | 'z' | null) {
		if (!this.occurrenceMove) return null;
		this.occurrenceMove.axis = axis;
		this.refreshOccurrenceMovePreview();
		return this.occurrenceMovePreview;
	}

	setOccurrenceMoveDistance(distance: number | null) {
		if (!this.occurrenceMove || (distance !== null && !Number.isFinite(distance))) return null;
		this.occurrenceMove.distance = distance;
		this.refreshOccurrenceMovePreview();
		return this.occurrenceMovePreview;
	}

	commitOccurrenceMove() {
		const move = this.occurrenceMove;
		if (!move) return false;
		this.occurrenceMove = null;
		const changed = move.after.some((value, index) => Math.abs(value - move.before[index]) > 1e-9);
		this.preview = { entity: null, label: '', hover: null };
		if (!changed) return false;
		const after: OccurrenceTransform = {
			id: move.id, artifactSha256: move.artifactSha256, occurrenceHandle: move.occurrenceHandle, translation: move.after
		};
		const before = this.store.getOccurrenceTransform(move.id);
		this.history.execute({
			execute: () => this.store.setOccurrenceTransform(after),
			undo: () => before ? this.store.setOccurrenceTransform(before) : this.store.deleteOccurrenceTransform(move.id)
		});
		return true;
	}

	move(hit: EditorSelectionHit | null, clientY: number, snapPoint?: Vector3 | null, pushPullDistance?: number, pushPullLabel?: string) {
		if (this.tool === 'rectangle' || this.tool === 'circle') {
			if (!this.firstPoint || !this.drawingPlane || (!hit && !snapPoint)) {
				this.preview = { entity: null, label: '', hover: hit?.face || null };
				return this.preview;
			}
			const pointToUse: EditorPoint = snapPoint
				? [snapPoint.x, snapPoint.y, snapPoint.z]
				: hit ? projectToPlane(hit.point, this.drawingPlane) : this.firstPoint;
			const projected = projectToPlane(pointToUse, this.drawingPlane);
			const face = this.tool === 'rectangle'
				? createRectangle(this.previewId(), this.drawingPlane, this.firstPoint, projected)
				: createCircle(this.previewId(), { ...this.drawingPlane, origin: this.firstPoint }, this.firstPoint, projected);
			const size = dimensions(face);
			this.preview = {
				entity: face,
				label: face.shape === 'circle' ? `R ${size.radius?.toFixed(3)} m` : `${size.width?.toFixed(3)} × ${size.height?.toFixed(3)} m`,
				hover: null
			};
			return this.preview;
		}
		if (this.tool === 'pushpull') {
			if (!this.pushFace) {
				this.preview = { entity: null, label: '', hover: hit?.face || null };
				return this.preview;
			}
			const distance = pushPullDistance ?? (this.pushStartY - clientY) * this.distanceScale;
			const entity = extrudeFace(this.pushFace, distance);
			const label = pushPullLabel ?? `${distance >= 0 ? '+' : ''}${distance.toFixed(3)} m`;
			this.preview = { entity, label, hover: this.pushFace };
			return this.preview;
		}
		if (this.tool === 'move') {
			if (!this.moveEntityId || !this.moveStartPoint || (!hit && !snapPoint)) {
				this.preview = { entity: null, label: '', hover: hit?.face || null };
				return this.preview;
			}
			const pt: EditorPoint = snapPoint ? [snapPoint.x, snapPoint.y, snapPoint.z] : hit!.point;
			const delta: EditorPoint = [pt[0] - this.moveStartPoint[0], pt[1] - this.moveStartPoint[1], pt[2] - this.moveStartPoint[2]];
			const original = this.store.get(this.moveEntityId);
			if (!original) {
				this.preview = { entity: null, label: '', hover: null };
				return this.preview;
			}
			const moved = translateEntity(original, delta);
			const dist = Math.hypot(delta[0], delta[1], delta[2]);
			this.preview = {
				entity: moved,
				label: `Move ${dist.toFixed(3)} m (dx: ${delta[0].toFixed(2)}, dy: ${delta[1].toFixed(2)}, dz: ${delta[2].toFixed(2)})`,
				hover: null
			};
			return this.preview;
		}
		this.preview = { entity: null, label: '', hover: hit?.face || null };
		return this.preview;
	}

	click(hit: EditorSelectionHit | null, clientY: number, snapPoint?: Vector3 | null) {
		if (this.tool === 'rectangle' || this.tool === 'circle') {
			if (!this.firstPoint) {
				if (!hit && !snapPoint) return false;
				const pt: EditorPoint = snapPoint ? [snapPoint.x, snapPoint.y, snapPoint.z] : hit!.point;
				const normal = hit ? hit.plane.normal : ([0, 0, 1] as EditorPoint);
				const u = hit ? hit.plane.u : ([1, 0, 0] as EditorPoint);
				this.firstPoint = pt;
				this.drawingPlane = createPlane(pt, normal, u);
				return false;
			}
			if (this.preview.entity?.kind !== 'face') return false;
			const face = { ...this.preview.entity, id: this.nextId('editable-face') };
			this.history.execute(new CreateShapeCommand(this.store, face));
			this.resetOperation();
			return true;
		}
		if (this.tool === 'pushpull') {
			if (!this.pushFace) {
				if (!hit || hit.face.outer.length < 3 || hit.face.holes.length) return false;
				this.pushFace = hit.face;
				this.pushAnchorPoint = new Vector3(...hit.point);
				this.pushStartY = clientY;
				return false;
			}
			if (this.preview.entity?.kind !== 'extrusion') return false;
			const extrusion = this.preview.entity.sourceSurfaceId
				? { ...this.preview.entity, id: this.nextId('editable-extrusion') }
				: this.preview.entity;
			this.history.execute(new PushPullCommand(this.store, extrusion));
			this.resetOperation();
			return true;
		}
		if (this.tool === 'move') {
			if (!this.moveEntityId) {
				if (!hit) return false;
				if (hit.imported) {
					this.preview = { entity: null, label: 'Imported BOMC geometry is read-only in Editor; select editable geometry to move.', hover: hit.face };
					return false;
				}
				const entity = this.store.get(hit.face.id);
				if (!entity) return false;
				this.moveEntityId = entity.id;
				this.moveStartPoint = snapPoint ? [snapPoint.x, snapPoint.y, snapPoint.z] : hit.point;
				return false;
			}
			if (!this.preview.entity || this.preview.entity.id !== this.moveEntityId) return false;
			this.history.execute(new MoveCommand(this.store, this.moveEntityId, this.preview.entity));
			this.resetOperation();
			return true;
		}
		return false;
	}

	cancel() { this.resetOperation(); this.occurrenceMove = null; }
	undo() { this.cancel(); return this.history.undo(); }
	redo() { this.cancel(); return this.history.redo(); }

	private resetOperation() {
		this.firstPoint = null; this.drawingPlane = null; this.pushFace = null; this.pushAnchorPoint = null;
		this.moveEntityId = null; this.moveStartPoint = null;
		this.preview = { entity: null, label: '', hover: null };
	}
	private refreshOccurrenceMovePreview() {
		const move = this.occurrenceMove;
		if (!move) return;
		let delta = [...move.delta] as EditorPoint;
		if (move.axis) {
			const axisIndex = move.axis === 'x' ? 0 : move.axis === 'y' ? 1 : 2;
			let value = delta[axisIndex];
			if (move.distance !== null) value = Math.sign(value || 1) * move.distance;
			delta = [0, 0, 0];
			delta[axisIndex] = value;
		} else if (move.distance !== null) {
			const length = Math.hypot(...delta);
			if (length > 1e-9) delta = delta.map((value) => value / length * move.distance!) as EditorPoint;
			else delta = [move.distance, 0, 0];
		}
		move.after = [move.before[0] + delta[0], move.before[1] + delta[1], move.before[2] + delta[2]];
		this.preview = {
			entity: null,
			label: `Move ${Math.hypot(...delta).toFixed(3)} m${move.axis ? ` along ${move.axis.toUpperCase()}` : ''}`,
			hover: null
		};
	}
	private previewId() { return `editable-preview-${this.sequence + 1}`; }
	private nextId(prefix: string) { this.sequence += 1; return `${prefix}-${this.sequence}`; }
}

function projectToPlane(point: EditorPoint, plane: EditorPlane): EditorPoint {
	const delta = point.map((value, index) => value - plane.origin[index]) as EditorPoint;
	const distance = delta[0] * plane.normal[0] + delta[1] * plane.normal[1] + delta[2] * plane.normal[2];
	return point.map((value, index) => value - plane.normal[index] * distance) as EditorPoint;
}
