/**
 * SIB-MCP-MODELING-001 v2.3 C6 — `arch/kernel.ts`, the ONLY importer of `manifold-3d` (A3).
 *
 * Responsibilities:
 * - load the WASM once per worker (`init`);
 * - build prisms from rings (orientation- and start-vertex-canonical, so equal geometry gives
 *   byte-equal solids no matter how the caller wrote the ring);
 * - Boolean union/difference with part-tag attribution through Manifold original ids;
 * - export Float64 vertices (via `warpBatch`, asserted equal to the Float32 mesh order), triangles and
 *   per-triangle tags;
 * - 2D helpers (slice, union, regions outside a footprint);
 * - lifetime accounting: every Manifold/CrossSection created here is counted and must be released.
 *
 * `#simplify` is deliberately not used in Phase 1: topology (WP5) removes the collinear/interior vertices that
 * coplanar unions leave behind.
 */
import Module from 'manifold-3d';
import { ArchError } from './errors.js';

export type Vec2 = readonly [number, number];
export type Ring = readonly Vec2[];
// manifold-3d's classes are opaque to the rest of the code base.
export type Solid = any;
type Section = any;
type Wasm = Awaited<ReturnType<typeof Module>>;

export type MeshExport = {
	/** x,y,z per vertex, rounded to 1e-6 m. */
	positions: Float64Array;
	/** Three vertex indices per triangle. */
	triangles: Uint32Array;
	/** Part tag per triangle (the tag passed to prism/boxLocal); -1 when unattributed. */
	triTag: Int32Array;
};

export type Region = {
	ring: Vec2[];
	holes: Vec2[][];
	/** outer area − holes, m². */
	area: number;
	bbox: { minX: number; minY: number; maxX: number; maxY: number };
	/** True when the region reaches the clipping box (i.e. it is the outside). */
	touchesBounds: boolean;
};

export type SolidStats = { numVert: number; numTri: number; volume: number; genus: number; status: string; components: number };

/** A kernel failure; surfaces as INVALID_GEOMETRY. */
export class KernelError extends ArchError {
	constructor(reason: string, message?: string) {
		super('INVALID_GEOMETRY', { reason }, message ?? `Kernel failure: ${reason}`);
		this.name = 'KernelError';
	}
}

/** Components smaller than this (m³) are numerical slivers, not geometry. */
const SLIVER_VOLUME = 1e-9;
const MESH_DECIMALS = 1e6;
const RING_DECIMALS = 1e9;
const roundMesh = (value: number) => Math.round(value * MESH_DECIMALS) / MESH_DECIMALS + 0;
const roundRing = (value: number) => Math.round(value * RING_DECIMALS) / RING_DECIMALS + 0;

export function signedArea(ring: Ring): number {
	let sum = 0;
	for (let i = 0; i < ring.length; i++) {
		const [x0, y0] = ring[i]!;
		const [x1, y1] = ring[(i + 1) % ring.length]!;
		sum += x0 * y1 - x1 * y0;
	}
	return sum / 2;
}

/** Enclosed volume of an exported closed mesh from its Float64 vertices (signed tetrahedra), rounded to 1e-9 m³. */
export function meshVolume(mesh: Pick<MeshExport, 'positions' | 'triangles'>): number {
	const p = mesh.positions, t = mesh.triangles;
	let sum = 0;
	for (let i = 0; i < t.length; i += 3) {
		const a = t[i]! * 3, b = t[i + 1]! * 3, c = t[i + 2]! * 3;
		sum +=
			p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
			p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
			p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
	}
	return Math.round((sum / 6) * 1e9) / 1e9 + 0;
}

/**
 * Canonical form of a polygon: coordinates rounded to 1e-9, consecutive duplicates removed, orientation
 * counter-clockwise (`ccw=true`) or clockwise, starting at the lexicographically smallest vertex.
 * Manifold's output ordering depends on input ordering, so every ring enters through this function.
 */
export function canonicalRing(ring: Ring, ccw = true): Vec2[] {
	const points: Vec2[] = [];
	for (const p of ring) {
		const q: Vec2 = [roundRing(p[0]), roundRing(p[1])];
		const last = points[points.length - 1];
		if (!last || last[0] !== q[0] || last[1] !== q[1]) points.push(q);
	}
	while (points.length > 1 && points[0]![0] === points[points.length - 1]![0] && points[0]![1] === points[points.length - 1]![1]) points.pop();
	if (points.length < 3) throw new KernelError('RING_TOO_SMALL', 'A ring needs at least three distinct vertices.');
	if (points.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) throw new KernelError('NON_FINITE_VERTEX');
	const area = signedArea(points);
	if (area === 0) throw new KernelError('RING_DEGENERATE', 'A ring has zero area.');
	if ((area > 0) !== ccw) points.reverse();
	let start = 0;
	for (let i = 1; i < points.length; i++) {
		const p = points[i]!, s = points[start]!;
		if (p[0] < s[0] || (p[0] === s[0] && p[1] < s[1])) start = i;
	}
	return [...points.slice(start), ...points.slice(0, start)];
}

/** Rounded (1e-6) canonical output ring. */
function outputRing(polygon: readonly (readonly number[])[], ccw: boolean): Vec2[] {
	const rounded: Vec2[] = polygon.map((p) => [roundMesh(p[0]!), roundMesh(p[1]!)] as Vec2);
	return canonicalRing(rounded, ccw);
}

export type KernelOptions = {
	/** Loads and returns a fresh manifold-3d module. Default: the real WASM. Tests inject faults through it. */
	load?: () => Promise<Wasm>;
	/** Components below this volume (m³) are dropped from boolean results. Default 1e-9; 0 disables the cleanup. */
	sliverVolume?: number;
};

export class Kernel {
	private wasm: Wasm | null = null;
	private starting: Promise<void> | null = null;
	private live = 0;
	private readonly owned = new WeakSet<object>();
	private readonly tagByOriginal = new Map<number, number>();
	private readonly sliverVolume: number;

	constructor(private readonly options: KernelOptions = {}) {
		this.sliverVolume = options.sliverVolume ?? SLIVER_VOLUME;
	}

	/**
	 * Loads the WASM once. Safe to call concurrently: every caller shares ONE load (one WASM instance) and one outcome.
	 * A failed load (module or `setup()`) leaves the kernel uninitialised and a later `init()` retries from scratch; a
	 * half-initialised kernel is never observable.
	 */
	init(): Promise<void> {
		if (this.wasm) return Promise.resolve();
		this.starting ??= this.start().catch((error: unknown) => {
			this.starting = null; // a failed attempt is not cached: the next init() retries
			throw error;
		});
		return this.starting;
	}

	private async start(): Promise<void> {
		try {
			const wasm = await (this.options.load ?? Module)();
			wasm.setup();
			this.wasm = wasm; // published only after setup() succeeded
		} catch (error) {
			throw error instanceof KernelError
				? error
				: new KernelError('KERNEL_INIT_FAILED', `The geometry kernel failed to start: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private get w(): Wasm {
		if (!this.wasm) throw new KernelError('KERNEL_NOT_INITIALISED', 'kernel.init() has not completed.');
		return this.wasm;
	}

	/** Number of Manifold/CrossSection objects created here and not yet released (T-K1). */
	liveCount(): number {
		return this.live;
	}

	private own<T extends object>(value: T): T {
		this.owned.add(value);
		this.live++;
		return value;
	}

	release(...objects: unknown[]): void {
		for (const object of objects) {
			if (!object || typeof object !== 'object' || !this.owned.has(object)) continue;
			this.owned.delete(object);
			this.live--;
			(object as { delete(): void }).delete();
		}
	}

	/** Forget tag attribution of every original id. Call after all meshes of an evaluation were exported. */
	resetTags(): void {
		this.tagByOriginal.clear();
	}

	private checked(solid: Solid, what: string): Solid {
		this.own(solid);
		let status: string;
		try {
			status = solid.status();
		} catch (error) {
			this.release(solid);
			throw error;
		}
		if (status !== 'NoError') {
			this.release(solid);
			throw new KernelError(`KERNEL_${status.toUpperCase()}`, `${what} produced an invalid solid (${status}).`);
		}
		return solid;
	}

	private section(rings: readonly Ring[]): Section {
		return this.own(this.w.CrossSection.ofPolygons(rings.map((r) => r.map((p) => [p[0], p[1]] as [number, number])), 'Positive'));
	}

	private extrude(section: Section, z0: number, z1: number, tag: number): Solid {
		if (!(z1 > z0)) throw new KernelError('PRISM_HEIGHT', 'A prism needs z1 > z0.');
		const raw = this.own(this.w.Manifold.extrude(section, z1 - z0));
		let moved: Solid | undefined;
		try {
			moved = this.own(raw.translate([0, 0, z0]));
			const original = this.checked(moved.asOriginal(), 'prism');
			try {
				this.tagByOriginal.set(original.originalID(), tag);
			} catch (error) {
				this.release(original);
				throw error;
			}
			return original;
		} finally {
			this.release(raw, moved);
		}
	}

	prism(ring: Ring, z0: number, z1: number, tag: number): Solid {
		const section = this.section([canonicalRing(ring, true)]);
		try {
			return this.extrude(section, z0, z1, tag);
		} finally {
			this.release(section);
		}
	}

	prismWithHoles(outer: Ring, holes: readonly Ring[], z0: number, z1: number, tag: number): Solid {
		const section = this.section([canonicalRing(outer, true), ...holes.map((h) => canonicalRing(h, false))]);
		try {
			return this.extrude(section, z0, z1, tag);
		} finally {
			this.release(section);
		}
	}

	/** Prism of the local rectangle `[x0,x1]×[y0,y1]` in the frame `(origin, ux, uy)`, extruded over `[z0,z1]`. */
	boxLocal(
		origin: Vec2, ux: Vec2, uy: Vec2,
		x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, tag: number
	): Solid {
		const at = (x: number, y: number): Vec2 => [origin[0] + x * ux[0] + y * uy[0], origin[1] + x * ux[1] + y * uy[1]];
		return this.prism([at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)], z0, z1, tag);
	}

	/**
	 * Boolean results can carry zero-volume shells (4-triangle flat tetrahedra) when two inputs have edges that differ by
	 * ~1e-9 (symbolic perturbation artefact). They are not geometry: drop every connected component whose volume is
	 * below the sliver volume (1e-9 m³ unless overridden). The input is released when something was dropped; otherwise it is returned as is.
	 */
	private dropSlivers(solid: Solid): Solid {
		if (!(this.sliverVolume > 0)) return solid;
		let components: Solid[] = [];
		let result: Solid = solid;
		try {
			components = solid.decompose();
			components.forEach((c) => this.own(c));
			if (components.length > 1) {
				const keep = components.filter((c) => Math.abs(c.volume()) >= this.sliverVolume);
				if (keep.length > 0 && keep.length < components.length) result = this.checked(this.w.Manifold.compose([...keep]), 'sliver cleanup');
			}
		} catch (error) {
			this.release(solid);
			throw error;
		} finally {
			this.release(...components);
		}
		if (result !== solid) this.release(solid);
		return result;
	}

	union(solids: readonly Solid[]): Solid {
		if (solids.length === 0) throw new KernelError('EMPTY_UNION', 'Nothing to union.');
		return this.dropSlivers(this.checked(this.w.Manifold.union([...solids]), 'union'));
	}

	difference(base: Solid, cutters: readonly Solid[]): Solid {
		if (cutters.length === 0) return this.checked(this.w.Manifold.union([base]), 'difference');
		return this.dropSlivers(this.checked(this.w.Manifold.difference([base, ...cutters]), 'difference'));
	}

	exportMesh(solid: Solid): MeshExport {
		const mesh = solid.getMesh();
		const f32: Float32Array = mesh.vertProperties;
		const numProp: number = mesh.numProp;
		let doubles: Float64Array | null = null;
		let copy: Solid | undefined;
		try {
			copy = this.own(
				solid.warpBatch((verts: Float64Array, count: number) => {
					doubles = new Float64Array(verts.subarray(0, count * 3));
				})
			);
		} finally {
			this.release(copy);
		}
		const d = doubles as Float64Array | null;
		const vertexCount = f32.length / numProp;
		if (!d || d.length !== vertexCount * 3) throw new KernelError('VERTEX_ORDER', 'warpBatch vertex count differs from getMesh.');
		const positions = new Float64Array(d.length);
		for (let v = 0; v < vertexCount; v++)
			for (let k = 0; k < 3; k++) {
				const value = d[v * 3 + k]!;
				if (Math.fround(value) !== f32[v * numProp + k]) throw new KernelError('VERTEX_ORDER', 'warpBatch order differs from getMesh order.');
				positions[v * 3 + k] = roundMesh(value);
			}
		const triangles = Uint32Array.from(mesh.triVerts as Uint32Array);
		const triTag = new Int32Array(triangles.length / 3).fill(-1);
		const runIndex: Uint32Array | undefined = mesh.runIndex;
		const runIds: Uint32Array | undefined = mesh.runOriginalID;
		if (runIndex && runIds) {
			for (let r = 0; r < runIds.length; r++) {
				const tag = this.tagByOriginal.get(runIds[r]!) ?? -1;
				for (let t = runIndex[r]! / 3; t < runIndex[r + 1]! / 3; t++) triTag[t] = tag;
			}
		}
		return { positions, triangles, triTag };
	}

	stats(solid: Solid): SolidStats {
		const parts: Solid[] = solid.decompose();
		let components = 0;
		try {
			parts.forEach((p) => this.own(p));
			components = parts.length;
		} finally {
			this.release(...parts);
		}
		return {
			numVert: solid.numVert(),
			numTri: solid.numTri(),
			// Manifold's own volume() accumulates in single precision (≈2e-7 error on a 5.67 m³ room).
			volume: meshVolume(this.exportMesh(solid)),
			genus: solid.genus(),
			status: solid.status(),
			components
		};
	}

	/** Horizontal slice at height z → rings (outer CCW, holes CW, rounded 1e-6). */
	sliceAt(solid: Solid, z: number): Vec2[][] {
		const cut = this.own(solid.slice(z));
		try {
			return (cut.toPolygons() as number[][][]).map((polygon) => {
				const rounded = polygon.map((p) => [roundMesh(p[0]!), roundMesh(p[1]!)] as Vec2);
				const area = signedArea(rounded);
				return canonicalRing(rounded, area >= 0);
			});
		} finally {
			this.release(cut);
		}
	}

	/** Union of positive (CCW-normalised) rings. Result: outer rings CCW and holes CW, rounded 1e-6, sorted. */
	union2d(rings: readonly Ring[]): Vec2[][] {
		if (rings.length === 0) return [];
		const section = this.section(rings.map((r) => canonicalRing(r, true)));
		try {
			return this.polygonsOf(section);
		} finally {
			this.release(section);
		}
	}

	/** Area of the union of positive rings (m²). */
	unionArea2d(rings: readonly Ring[]): number {
		if (rings.length === 0) return 0;
		const section = this.section(rings.map((r) => canonicalRing(r, true)));
		try {
			return section.area();
		} finally {
			this.release(section);
		}
	}

	/** Area of an outline with holes after a Positive-fill union (self-intersection check). */
	areaWithHoles2d(outer: Ring, holes: readonly Ring[]): number {
		const section = this.section([canonicalRing(outer, true), ...holes.map((h) => canonicalRing(h, false))]);
		try {
			return section.area();
		} finally {
			this.release(section);
		}
	}

	/**
	 * Rings of `subject ∖ clip`. Both are footprint rings with orientation meaning (outer CCW, holes CW), as `union2d`
	 * returns them. Used to MEASURE geometry (holes, protrusions); nothing in the evaluator depends on it.
	 */
	differenceRings2d(subject: readonly Ring[], clip: readonly Ring[]): Vec2[][] {
		const oriented = (rings: readonly Ring[]) => rings.map((r) => canonicalRing(r, signedArea(r) >= 0));
		const held: unknown[] = [];
		try {
			if (subject.length === 0) return [];
			const a = this.section(oriented(subject));
			held.push(a);
			if (clip.length === 0) return this.polygonsOf(a);
			const b = this.section(oriented(clip));
			held.push(b);
			const d = this.own(a.subtract(b));
			held.push(d);
			return this.polygonsOf(d);
		} finally {
			this.release(...held);
		}
	}

	/** Area (m²) of `subject ∖ clip` (see `differenceRings2d`). */
	differenceArea2d(subject: readonly Ring[], clip: readonly Ring[]): number {
		return this.differenceRings2d(subject, clip).reduce((sum, ring) => sum + signedArea(ring), 0);
	}

	private polygonsOf(section: Section): Vec2[][] {
		const polygons = section.toPolygons() as number[][][];
		const out: Vec2[][] = [];
		for (const polygon of polygons) {
			const rounded = polygon.map((p) => [roundMesh(p[0]!), roundMesh(p[1]!)] as Vec2);
			try {
				out.push(canonicalRing(rounded, signedArea(rounded) >= 0));
			} catch (error) {
				// a sliver thinner than the 1e-6 output lattice collapses to fewer than three vertices or zero area: not geometry
				if (!(error instanceof KernelError) || (error.detail.reason !== 'RING_TOO_SMALL' && error.detail.reason !== 'RING_DEGENERATE')) throw error;
			}
		}
		out.sort((a, b) => a[0]![0] - b[0]![0] || a[0]![1] - b[0]![1] || a.length - b.length);
		return out;
	}

	/**
	 * Connected regions of `bbox ∖ footprint`, where `rings` keep their orientation (outer CCW, holes CW; the output
	 * of `union2d`). A region that reaches the box is the outside
	 * (`touchesBounds`); the others are enclosed.
	 */
	regionsOutside(rings: readonly Ring[], bbox: { minX: number; minY: number; maxX: number; maxY: number }): Region[] {
		const box: Ring = [[bbox.minX, bbox.minY], [bbox.maxX, bbox.minY], [bbox.maxX, bbox.maxY], [bbox.minX, bbox.maxY]];
		const held: unknown[] = [];
		const hold = <T>(value: T): T => {
			held.push(value);
			return value;
		};
		try {
			// `rings` are footprint rings as `union2d` returns them: outer CCW, holes CW. Orientation carries meaning here.
			const footprint = rings.length ? hold(this.section(rings.map((r) => canonicalRing(r, signedArea(r) >= 0)))) : null;
			const boxSection = hold(this.section([canonicalRing(box, true)]));
			const outside = footprint ? hold(this.own(boxSection.subtract(footprint))) : null;
			const base = outside ?? boxSection;
			const components: Section[] = base.decompose();
			components.forEach((c) => hold(this.own(c)));
			const eps = 1e-6;
			const regions = components.map((component): Region => {
				const polygons = this.polygonsOf(component);
				const outers = polygons.filter((p) => signedArea(p) > 0).sort((a, b) => signedArea(b) - signedArea(a));
				const outer = outers[0]!;
				const holes = polygons.filter((p) => signedArea(p) < 0);
				const xs = outer.map((p) => p[0]), ys = outer.map((p) => p[1]);
				const rect = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
				return {
					ring: outer,
					holes,
					area: Math.round((signedArea(outer) + holes.reduce((sum, h) => sum + signedArea(h), 0)) * 1e9) / 1e9,
					bbox: rect,
					touchesBounds:
						rect.minX <= bbox.minX + eps || rect.minY <= bbox.minY + eps || rect.maxX >= bbox.maxX - eps || rect.maxY >= bbox.maxY - eps
				};
			});
			regions.sort((a, b) => a.bbox.minX - b.bbox.minX || a.bbox.minY - b.bbox.minY || a.area - b.area);
			return regions;
		} finally {
			this.release(...held);
		}
	}
}

/** A fresh, independent kernel (its own WASM instance on first `init`). */
export function createKernel(): Kernel {
	return new Kernel();
}

const shared = new Kernel();
export const init = () => shared.init();
export const prism = shared.prism.bind(shared);
export const prismWithHoles = shared.prismWithHoles.bind(shared);
export const boxLocal = shared.boxLocal.bind(shared);
export const union = shared.union.bind(shared);
export const difference = shared.difference.bind(shared);
export const exportMesh = shared.exportMesh.bind(shared);
export const sliceAt = shared.sliceAt.bind(shared);
export const union2d = shared.union2d.bind(shared);
export const regionsOutside = shared.regionsOutside.bind(shared);
export const release = shared.release.bind(shared);
export const sharedKernel = shared;
