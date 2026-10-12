import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Vector3 } from 'three';
import type { BomcGraph } from '@sibambo/bomc-document';
import type { PreparedSceneViewport } from '@sibambo/viewport';
import type { AuthoringCheckpoint, AuthoringPoint, ModelAction, ModelSelection } from './protocol.js';
import {
	contextGraph,
	contextTransform,
	definitionGraph,
	meshEdges,
	modelMetadata,
	modelOccurrences,
	transformPoint,
} from './model.js';
import { nearestAuthoringFaceHit, resolveAuthoringInference } from './inference.js';
import { closestAxisParameterToRay } from './axis-drag.js';

export type ModelingMode = 'select' | 'erase' | 'move' | 'offset' | 'guide' | 'guidepoint';
export type ModelingState = {
	mode: ModelingMode;
	path: string[];
	selection: ModelSelection[];
	axis: 'x' | 'y' | 'z' | null;
	anchor: AuthoringPoint | null;
	delta: AuthoringPoint;
	message: string;
};
type Options = {
	checkpoint: () => AuthoringCheckpoint | null;
	viewport: () => PreparedSceneViewport | null;
	enabled: () => boolean;
	submit: (path: readonly string[], action: ModelAction) => Promise<void>;
	change: (state: ModelingState) => void;
	contextChanged: () => void;
	error: (message: string) => void;
};
const OVERLAY = 'authoring-model-selection',
	PREVIEW = 'authoring-model-move';
const key = (s: ModelSelection) => JSON.stringify(s);
const xyz = (mesh: { positions: readonly number[] }, i: number): AuthoringPoint => [
	mesh.positions[i * 3]!,
	mesh.positions[i * 3 + 1]!,
	mesh.positions[i * 3 + 2]!,
];
const tuple = (v: Vector3): AuthoringPoint => [v.x, v.y, v.z];
export class ModelingController {
	state: ModelingState = {
		mode: 'select',
		path: [],
		selection: [],
		axis: null,
		anchor: null,
		delta: [0, 0, 0],
		message: '',
	};
	private documentId = '';
	private pointer: { x: number; y: number; shift: boolean; ctrl: boolean; checkpoint: AuthoringCheckpoint } | null =
		null;
	private lastClick = { time: 0, id: '' };
	private disposed = false;
	constructor(private options: Options) {}
	private publish() {
		this.options.change({ ...this.state, path: [...this.state.path], selection: [...this.state.selection] });
	}
	refresh() {
		const checkpoint = this.options.checkpoint();
		if (!checkpoint) return;
		const graph = checkpoint.snapshot.graph;
		if (graph.documentId !== this.documentId) {
			this.documentId = graph.documentId;
			this.state.path = [];
			this.state.selection = [];
			this.cancel();
		}
		try {
			contextTransform(graph, this.state.path);
		} catch {
			this.state.path = [];
			this.state.selection = [];
			this.options.contextChanged();
		}
		const owner = contextTransform(graph, this.state.path).definitionId;
		this.state.selection = this.state.selection.filter((s) =>
			s.type === 'instance'
				? graph.instances.some((i) => i.id === s.id && i.ownerDefinitionId === owner)
				: s.type === 'face'
					? graph.meshes.some((m) => m.definitionId === owner && m.faces.some((f) => f.id === s.id))
					: true,
		);
		this.draw();
		this.publish();
	}
	setMode(mode: ModelingMode) {
		this.cancel();
		this.state.mode = mode;
		this.state.message =
			mode === 'move'
				? 'Select entities, then click a move origin and destination.'
				: mode === 'guide' || mode === 'guidepoint'
					? 'Click two inferred points to place a persistent guide.'
					: '';
		this.publish();
	}
	setAxis(axis: 'x' | 'y' | 'z' | null) {
		this.state.axis = this.state.axis === axis ? null : axis;
		this.publish();
	}
	cancel() {
		this.pointer = null;
		this.state.anchor = null;
		this.state.delta = [0, 0, 0];
		this.options.viewport()?.setDomainOverlay(PREVIEW, null);
		this.publish();
	}
	selectAll() {
		const graph = this.options.checkpoint()?.snapshot.graph;
		if (!graph) return;
		const owner = contextTransform(graph, this.state.path).definitionId,
			mesh = graph.meshes.find((m) => m.definitionId === owner);
		this.state.selection = [
			...(mesh?.faces.map((f) => ({ type: 'face' as const, id: f.id })) ?? []),
			...graph.instances
				.filter((i) => i.ownerDefinitionId === owner)
				.map((i) => ({ type: 'instance' as const, id: i.id })),
			...modelMetadata(graph)
				.looseEdges.filter((e) => e.ownerDefinitionId === owner)
				.map((e) => ({
					type: 'edge' as const,
					start: transformPoint(e.start, contextTransform(graph, this.state.path).matrix),
					end: transformPoint(e.end, contextTransform(graph, this.state.path).matrix),
				})),
		];
		this.draw();
		this.publish();
	}
	enter() {
		const selected = this.state.selection.find((s) => s.type === 'instance');
		if (!selected) return;
		this.state.path = [...this.state.path, selected.id];
		this.state.selection = [];
		this.cancel();
		this.options.contextChanged();
		this.refresh();
	}
	exit() {
		if (!this.state.path.length) return;
		this.state.path = this.state.path.slice(0, -1);
		this.state.selection = [];
		this.cancel();
		this.options.contextChanged();
		this.refresh();
	}
	async apply(action: ModelAction) {
		if (!this.options.enabled()) return;
		try {
			await this.options.submit([...this.state.path], action);
			this.state.selection = [];
			this.cancel();
			this.refresh();
		} catch (error) {
			this.options.error(error instanceof Error ? error.message : 'Model edit failed.');
		}
	}
	erase() {
		if (this.state.selection.length) void this.apply({ type: 'erase', selection: this.state.selection });
	}
	selectConnected() {
		const graph = this.options.checkpoint()?.snapshot.graph;
		if (!graph) return;
		const mesh = contextGraph(graph, this.state.path, true).meshes[0];
		if (!mesh) return;
		const ids = new Set(this.state.selection.filter((s) => s.type === 'face').map((s) => s.id)),
			vertices = new Set<number>();
		let changed = true;
		while (changed) {
			changed = false;
			for (const face of mesh.faces) {
				const ring = [face.outer, ...face.holes].flat();
				if (ids.has(face.id) || ring.some((v) => vertices.has(v))) {
					if (!ids.has(face.id)) {
						ids.add(face.id);
						changed = true;
					}
					for (const v of ring)
						if (!vertices.has(v)) {
							vertices.add(v);
							changed = true;
						}
				}
			}
		}
		this.state.selection = [
			...this.state.selection.filter((s) => s.type !== 'face'),
			...[...ids].map((id) => ({ type: 'face' as const, id })),
		];
		this.draw();
		this.publish();
	}
	guideDistance(distance: number) {
		if (!Number.isFinite(distance) || Math.abs(distance) < 1e-6 || !this.state.anchor)
			throw new Error('Click a guide origin first, then enter a nonzero distance.');
		const direction = this.state.axis
			? new Vector3(this.state.axis === 'x' ? 1 : 0, this.state.axis === 'y' ? 1 : 0, this.state.axis === 'z' ? 1 : 0)
			: new Vector3(...this.state.delta).normalize();
		if (direction.length() < 0.5) throw new Error('Move the cursor to choose a direction or lock an axis.');
		void this.apply({
			type: 'guide',
			start: this.state.anchor,
			end: tuple(new Vector3(...this.state.anchor).addScaledVector(direction, distance)),
			guideKind: this.state.mode === 'guidepoint' ? 'point' : 'line',
		});
	}
	private inference(x: number, y: number) {
		const graph = this.options.checkpoint()?.snapshot.graph,
			viewport = this.options.viewport();
		if (!graph || !viewport) return null;
		const anchor = this.state.anchor;
		if (anchor && this.state.axis) {
			const axis: AuthoringPoint =
					this.state.axis === 'x' ? [1, 0, 0] : this.state.axis === 'y' ? [0, 1, 0] : [0, 0, 1],
				ray = viewport.rayFromScreen(x, y);
			if (!ray) return null;
			const amount = closestAxisParameterToRay(ray, anchor, axis);
			return amount === null ? null : tuple(new Vector3(...anchor).addScaledVector(new Vector3(...axis), amount));
		}
		return (
			resolveAuthoringInference({
				graph: contextGraph(graph, this.state.path, true),
				viewport,
				clientX: x,
				clientY: y,
				anchor,
				activePlane: { origin: anchor ?? [0, 0, 0], normal: [0, 1, 0] },
			})?.point ?? null
		);
	}
	private targets(graph: BomcGraph) {
		const context = contextTransform(graph, this.state.path),
			targets: {
				selection: ModelSelection;
				points: AuthoringPoint[];
				edges: { start: AuthoringPoint; end: AuthoringPoint }[];
			}[] = [];
		const flat = contextGraph(graph, this.state.path, true),
			mesh = flat.meshes[0];
		if (mesh)
			for (const face of mesh.faces) {
				const points = [face.outer, ...face.holes].flat().map((v) => xyz(mesh, v));
				targets.push({
					selection: { type: 'face', id: face.id },
					points,
					edges: meshEdges({ ...mesh, faces: [face] }),
				});
			}
		const descendants = new Map<string, ReturnType<typeof modelOccurrences>>();
		for (const occurrence of modelOccurrences(graph)) {
			if (
				occurrence.path.length <= this.state.path.length ||
				!this.state.path.every((id, i) => occurrence.path[i] === id)
			)
				continue;
			const childId = occurrence.path[this.state.path.length]!,
				bucket = descendants.get(childId) ?? [];
			bucket.push(occurrence);
			descendants.set(childId, bucket);
		}
		for (const child of graph.instances.filter((i) => i.ownerDefinitionId === context.definitionId)) {
			const occurrences = descendants.get(child.id) ?? [];
			const points: AuthoringPoint[] = [],
				edges: { start: AuthoringPoint; end: AuthoringPoint }[] = [];
			for (const occurrence of occurrences) {
				const mesh = definitionGraph(graph, occurrence.definitionId, occurrence.matrix).meshes[0];
				if (mesh) {
					for (let i = 0; i < mesh.positions.length / 3; i++) points.push(xyz(mesh, i));
					edges.push(...meshEdges(mesh));
				}
			}
			targets.push({ selection: { type: 'instance', id: child.id }, points, edges });
		}
		for (const edge of modelMetadata(graph).looseEdges.filter((e) => e.ownerDefinitionId === context.definitionId)) {
			const start = transformPoint(edge.start, context.matrix),
				end = transformPoint(edge.end, context.matrix);
			targets.push({ selection: { type: 'edge', start, end }, points: [start, end], edges: [{ start, end }] });
		}
		return targets;
	}
	private pick(x: number, y: number): ModelSelection | null {
		const graph = this.options.checkpoint()?.snapshot.graph,
			viewport = this.options.viewport();
		if (!graph || !viewport) return null;
		const ray = viewport.rayFromScreen(x, y);
		if (!ray) return null;
		let best: { selection: ModelSelection; distance: number } | null = null;
		for (const occurrence of modelOccurrences(graph)) {
			if (!this.state.path.every((id, i) => occurrence.path[i] === id)) continue;
			const hit = nearestAuthoringFaceHit(definitionGraph(graph, occurrence.definitionId, occurrence.matrix), ray);
			if (!hit) continue;
			const selection: ModelSelection =
				occurrence.path.length > this.state.path.length
					? { type: 'instance', id: occurrence.path[this.state.path.length]! }
					: { type: 'face', id: hit.face.id };
			if (!best || hit.distance < best.distance) best = { selection, distance: hit.distance };
		}
		for (const target of this.targets(graph))
			for (const edge of target.edges) {
				if (target.selection.type === 'instance') continue;
				const a = viewport.projectWorldToScreen(edge.start),
					b = viewport.projectWorldToScreen(edge.end);
				if (!a?.inFront || !b?.inFront) continue;
				const dx = b.x - a.x,
					dy = b.y - a.y,
					t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
				if (Math.hypot(x - a.x - dx * t, y - a.y - dy * t) > 6) continue;
				const p = new Vector3(...edge.start).lerp(new Vector3(...edge.end), t),
					distance = p.clone().sub(ray.origin).dot(ray.direction);
				if (distance < 0 || (best && distance > best.distance + 1e-4)) continue;
				return { type: 'edge', start: edge.start, end: edge.end };
			}
		return best?.selection ?? null;
	}
	down(event: PointerEvent) {
		if (!this.options.enabled() || event.button !== 0) return;
		const checkpoint = this.options.checkpoint();
		if (checkpoint)
			this.pointer = {
				x: event.clientX,
				y: event.clientY,
				shift: event.shiftKey,
				ctrl: event.ctrlKey || event.metaKey,
				checkpoint,
			};
	}
	move(event: PointerEvent) {
		if (!['move', 'guide', 'guidepoint'].includes(this.state.mode) || !this.state.anchor || !this.options.enabled())
			return;
		const point = this.inference(event.clientX, event.clientY);
		if (!point) return;
		this.state.delta = tuple(new Vector3(...point).sub(new Vector3(...this.state.anchor)));
		if (this.state.mode === 'move') this.draw(this.state.delta, PREVIEW);
		else {
			const group = new Group(),
				geometry = new BufferGeometry();
			geometry.setAttribute('position', new Float32BufferAttribute([...this.state.anchor, ...point], 3));
			group.add(new LineSegments(geometry, new LineBasicMaterial({ color: 0xb87d00, depthTest: false })));
			this.options.viewport()?.setDomainOverlay(PREVIEW, group);
		}
		this.publish();
	}
	up(event: PointerEvent) {
		const pointer = this.pointer;
		this.pointer = null;
		if (!pointer || !this.options.enabled() || pointer.checkpoint !== this.options.checkpoint()) return;
		if (
			this.state.mode === 'guide' ||
			this.state.mode === 'guidepoint' ||
			(this.state.mode === 'move' && this.state.selection.length)
		) {
			const point = this.inference(event.clientX, event.clientY);
			if (!point) return;
			if (!this.state.anchor) {
				this.state.anchor = point;
				this.publish();
				return;
			}
			if (this.state.mode === 'move') {
				const delta = tuple(new Vector3(...point).sub(new Vector3(...this.state.anchor)));
				void this.apply({
					type: 'transform',
					selection: this.state.selection,
					delta,
					copy: event.ctrlKey || event.metaKey,
					count: 1,
					spacing: 'multiply',
					radial: null,
				});
			} else
				void this.apply({
					type: 'guide',
					start: this.state.anchor,
					end: point,
					guideKind: this.state.mode === 'guidepoint' ? 'point' : 'line',
				});
			return;
		}
		let picked: ModelSelection[] = [];
		if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) {
			const graph = this.options.checkpoint()!.snapshot.graph,
				viewport = this.options.viewport()!,
				crossing = event.clientX < pointer.x;
			const x0 = Math.min(pointer.x, event.clientX),
				x1 = Math.max(pointer.x, event.clientX),
				y0 = Math.min(pointer.y, event.clientY),
				y1 = Math.max(pointer.y, event.clientY);
			const inside = (p: { x: number; y: number; inFront: boolean }) =>
				p.inFront && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
			const intersects = (a: { x: number; y: number }, b: { x: number; y: number }) => {
				let lo = 0,
					hi = 1;
				const dx = b.x - a.x,
					dy = b.y - a.y;
				for (const [p, q] of [
					[-dx, a.x - x0],
					[dx, x1 - a.x],
					[-dy, a.y - y0],
					[dy, y1 - a.y],
				]) {
					if (Math.abs(p!) < 1e-12) {
						if (q! < 0) return false;
					} else {
						const t = q! / p!;
						if (p! < 0) lo = Math.max(lo, t);
						else hi = Math.min(hi, t);
						if (lo > hi) return false;
					}
				}
				return true;
			};
			for (const target of this.targets(graph)) {
				const points = target.points
					.map((p) => viewport.projectWorldToScreen(p))
					.filter((p): p is NonNullable<typeof p> => p !== null);
				if (
					points.length &&
					(crossing
						? points.some(inside) ||
							target.edges.some((e) => {
								const a = viewport.projectWorldToScreen(e.start),
									b = viewport.projectWorldToScreen(e.end);
								return !!a?.inFront && !!b?.inFront && intersects(a, b);
							})
						: points.every(inside))
				)
					picked.push(target.selection);
			}
			if (crossing) {
				for (const [x, y] of [
					[x0, y0],
					[x1, y0],
					[x0, y1],
					[x1, y1],
				]) {
					const face = this.pick(x!, y!);
					if (face && !picked.some((s) => key(s) === key(face))) picked.push(face);
				}
			}
		} else {
			const selection = this.pick(event.clientX, event.clientY);
			if (selection) picked = [selection];
			const now = performance.now(),
				id = selection ? key(selection) : '';
			if (selection?.type === 'instance' && this.lastClick.id === id && now - this.lastClick.time < 350) {
				this.state.selection = [selection];
				this.enter();
				this.lastClick = { time: 0, id: '' };
				return;
			}
			this.lastClick = { time: now, id };
		}
		if (pointer.shift || pointer.ctrl) {
			const next = [...this.state.selection];
			for (const selected of picked) {
				const index = next.findIndex((s) => key(s) === key(selected));
				if (index >= 0) next.splice(index, 1);
				else next.push(selected);
			}
			this.state.selection = next;
		} else this.state.selection = picked;
		if (this.state.mode === 'erase') this.erase();
		this.draw();
		this.publish();
	}
	private draw(delta: AuthoringPoint = [0, 0, 0], overlay = OVERLAY) {
		const graph = this.options.checkpoint()?.snapshot.graph,
			viewport = this.options.viewport();
		if (!graph || !viewport) return;
		const positions: number[] = [];
		for (const target of this.targets(graph)) {
			if (!this.state.selection.some((s) => key(s) === key(target.selection))) continue;
			for (const edge of target.edges)
				positions.push(...edge.start.map((v, i) => v + delta[i]!), ...edge.end.map((v, i) => v + delta[i]!));
		}
		for (const selected of this.state.selection)
			if (selected.type === 'edge')
				positions.push(...selected.start.map((v, i) => v + delta[i]!), ...selected.end.map((v, i) => v + delta[i]!));
		const group = new Group();
		if (positions.length) {
			const geometry = new BufferGeometry();
			geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
			const lines = new LineSegments(
				geometry,
				new LineBasicMaterial({ color: overlay === PREVIEW ? 0x22aa77 : 0x1765e5, depthTest: false }),
			);
			lines.renderOrder = 10;
			group.add(lines);
		}
		viewport.setDomainOverlay(overlay, group);
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.options.viewport()?.setDomainOverlay(OVERLAY, null);
		this.options.viewport()?.setDomainOverlay(PREVIEW, null);
	}
}
