/**
 * SIB-MCP-MODELING-001 v2.3 C9 (WP5) — `arch/topology.ts`: maximal coplanar face extraction,
 * boundary loop reconstruction, global collinear-vertex removal, hard/soft edge classification,
 * and semantic face role/ID assignment. Pure over exported meshes (no kernel import).
 */
import { preparePolygon, type Point3 } from '../authoring/polygon.js';
import { windingNumber } from './elements.js';
import type { MeshExport, Region, Vec2 } from './kernel.js';
import type { SpaceResult } from './elements.js';

const DEGENERATE_AREA = 1e-12;
const SLIVER_AREA = 1e-6;
const NORMAL_DOT_MIN = 1 - 1e-9;
const PLANE_TOL = 1e-6;
const COLLINEAR_TOL = 1e-7;
const COLLINEAR_QUANT_TOL = 1e-6;
const HARD_DIHEDRAL_DEG = 20;
const PROBE_OFFSET = 0.05;

export type PartKind = 'walls' | 'slab' | 'frame' | 'glazing' | 'leaf';
export type TagInfo = { elementId: string; role: string; materialId: string };

export type RoleProbeContext = {
	regions: readonly Region[];
	spaces: readonly SpaceResult[];
};

export type TopologyFace = {
	id: string;
	elementId: string;
	role: string;
	materialId: string;
	normal: [number, number, number];
	w: number;
	centroid: [number, number, number];
	area: number;
	outer: number[];
	holes: number[][];
};

export type TopologyEdge = {
	a: number;
	b: number;
	faces: string[];
	dihedral: number;
	flag: 'hard' | 'soft';
};

export type PartTopology = {
	partId: string;
	kind: PartKind;
	positions: Float64Array;
	faces: TopologyFace[];
	edges: TopologyEdge[];
	degenerateTriangles: number;
};

type TriRecord = {
	idx: number;
	verts: [number, number, number];
	n: [number, number, number];
	w: number;
	area: number;
	centroid: [number, number, number];
	tag: number;
	materialId: string;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cleanZero = (v: number): number => (v === 0 ? 0 : v);
const roundDp = (v: number, scale: number): number => cleanZero(Math.round(v * scale) / scale);

function pointAt(positions: readonly number[], index: number): [number, number, number] {
	return [positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!];
}

function comparePoint(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function rotateLoopToMinCoord(loop: number[], positions: readonly number[]): number[] {
	if (loop.length <= 1) return [...loop];
	let best = 0;
	let bestPt = pointAt(positions, loop[0]!);
	for (let i = 1; i < loop.length; i++) {
		const pt = pointAt(positions, loop[i]!);
		if (comparePoint(pt, bestPt) < 0) {
			best = i;
			bestPt = pt;
		}
	}
	return best === 0 ? [...loop] : [...loop.slice(best), ...loop.slice(0, best)];
}

function signedLoopArea3d(loop: readonly number[], positions: readonly number[], normal: readonly [number, number, number]): number {
	let sx = 0;
	let sy = 0;
	let sz = 0;
	for (let i = 0; i < loop.length; i++) {
		const a = loop[i]!;
		const b = loop[(i + 1) % loop.length]!;
		const ax = positions[a * 3]!;
		const ay = positions[a * 3 + 1]!;
		const az = positions[a * 3 + 2]!;
		const bx = positions[b * 3]!;
		const by = positions[b * 3 + 1]!;
		const bz = positions[b * 3 + 2]!;
		sx += ay * bz - az * by;
		sy += az * bx - ax * bz;
		sz += ax * by - ay * bx;
	}
	return 0.5 * (normal[0] * sx + normal[1] * sy + normal[2] * sz);
}

function weldPositions(raw: Float64Array): { positions: number[]; remap: number[] } {
	const coordMap = new Map<string, number>();
	const remap: number[] = new Array(raw.length / 3);
	const positions: number[] = [];
	for (let i = 0; i < remap.length; i++) {
		const x = cleanZero(raw[i * 3]!);
		const y = cleanZero(raw[i * 3 + 1]!);
		const z = cleanZero(raw[i * 3 + 2]!);
		const key = `${x},${y},${z}`;
		let idx = coordMap.get(key);
		if (idx === undefined) {
			idx = positions.length / 3;
			coordMap.set(key, idx);
			positions.push(x, y, z);
		}
		remap[i] = idx;
	}
	return { positions, remap };
}

function extractBoundaryLoops(
	group: readonly TriRecord[],
	positions: readonly number[],
	normal: readonly [number, number, number]
): number[][] {
	const edgeCounts = new Map<string, number>();
	for (const tri of group) {
		for (let j = 0; j < 3; j++) {
			const u = tri.verts[j]!;
			const v = tri.verts[(j + 1) % 3]!;
			const rev = `${v}->${u}`;
			const revCount = edgeCounts.get(rev) ?? 0;
			if (revCount > 0) edgeCounts.set(rev, revCount - 1);
			else {
				const fwd = `${u}->${v}`;
				edgeCounts.set(fwd, (edgeCounts.get(fwd) ?? 0) + 1);
			}
		}
	}

	const outEdges = new Map<number, number[]>();
	for (const [key, count] of edgeCounts) {
		if (count <= 0) continue;
		const sep = key.indexOf('->');
		const u = Number(key.slice(0, sep));
		const v = Number(key.slice(sep + 2));
		for (let c = 0; c < count; c++) {
			const list = outEdges.get(u) ?? [];
			list.push(v);
			outEdges.set(u, list);
		}
	}
	for (const list of outEdges.values()) list.sort((a, b) => a - b);

	const loops: number[][] = [];
	for (const startU of [...outEdges.keys()].sort((a, b) => a - b)) {
		while ((outEdges.get(startU)?.length ?? 0) > 0) {
			const loop: number[] = [startU];
			let prev = startU;
			let curr = outEdges.get(startU)!.shift()!;
			while (curr !== startU) {
				loop.push(curr);
				const nexts = outEdges.get(curr);
				if (!nexts || nexts.length === 0) break;
				let pick = 0;
				if (nexts.length > 1) {
					const ax = positions[curr * 3]! - positions[prev * 3]!;
					const ay = positions[curr * 3 + 1]! - positions[prev * 3 + 1]!;
					const az = positions[curr * 3 + 2]! - positions[prev * 3 + 2]!;
					const al = Math.hypot(ax, ay, az);
					const inx = ax / al;
					const iny = ay / al;
					const inz = az / al;
					let bestScore = -Infinity;
					for (let j = 0; j < nexts.length; j++) {
						const w = nexts[j]!;
						const bx = positions[w * 3]! - positions[curr * 3]!;
						const by = positions[w * 3 + 1]! - positions[curr * 3 + 1]!;
						const bz = positions[w * 3 + 2]! - positions[curr * 3 + 2]!;
						const bl = Math.hypot(bx, by, bz);
						const ox = bx / bl;
						const oy = by / bl;
						const oz = bz / bl;
						const dot = inx * ox + iny * oy + inz * oz;
						const cx = iny * oz - inz * oy;
						const cy = inz * ox - inx * oz;
						const cz = inx * oy - iny * ox;
						const angle = Math.atan2(normal[0] * cx + normal[1] * cy + normal[2] * cz, dot);
						if (angle > bestScore) {
							bestScore = angle;
							pick = j;
						}
					}
				}
				prev = curr;
				curr = nexts.splice(pick, 1)[0]!;
			}
			if (loop.length >= 3) loops.push(loop);
		}
	}
	return loops;
}

type PendingFace = {
	normal: [number, number, number];
	w: number;
	centroid: [number, number, number];
	area: number;
	materialId: string;
	tris: TriRecord[];
	loops: number[][];
};

function needsPlanarSnapCleanup(face: PendingFace, positions: readonly number[]): boolean {
	return face.loops.some((loop) => {
		if (loop.length < 4) return false;
		try {
			preparePolygon(
				loop.map((v) => pointAt(positions, v) as Point3),
				face.normal as Point3,
				{ canonicalizeStart: false }
			);
			return false;
		} catch (error) {
			return error instanceof Error && error.message.includes('coplanar');
		}
	});
}

function removeCollinearVertices(faces: PendingFace[], positions: readonly number[], tolerance: number, onlyNonPlanarFaces: boolean): void {
	let changed = true;
	while (changed) {
		changed = false;
		const neighbors = new Map<number, Set<number>>();
		const facesOfVertex = new Map<number, Set<PendingFace>>();
		for (const face of faces) {
			for (const loop of face.loops) {
				for (let i = 0; i < loop.length; i++) {
					const a = loop[i]!;
					const b = loop[(i + 1) % loop.length]!;
					let na = neighbors.get(a);
					if (!na) {
						na = new Set();
						neighbors.set(a, na);
					}
					na.add(b);
					let nb = neighbors.get(b);
					if (!nb) {
						nb = new Set();
						neighbors.set(b, nb);
					}
					nb.add(a);
					let fa = facesOfVertex.get(a);
					if (!fa) {
						fa = new Set();
						facesOfVertex.set(a, fa);
					}
					fa.add(face);
				}
			}
		}

		const nonPlanar = onlyNonPlanarFaces ? new Set(faces.filter((f) => needsPlanarSnapCleanup(f, positions))) : null;
		if (nonPlanar && nonPlanar.size === 0) break;

		const removeSet = new Set<number>();
		for (const [v, nbrs] of [...neighbors.entries()].sort((p, q) => p[0] - q[0])) {
			if (nbrs.size !== 2) continue;
			if (nonPlanar) {
				const touching = facesOfVertex.get(v);
				if (!touching || ![...touching].some((f) => nonPlanar.has(f))) continue;
			}
			const [u, w] = [...nbrs];
			const ux = positions[u! * 3]!;
			const uy = positions[u! * 3 + 1]!;
			const uz = positions[u! * 3 + 2]!;
			const vx = positions[v * 3]!;
			const vy = positions[v * 3 + 1]!;
			const vz = positions[v * 3 + 2]!;
			const wx = positions[w! * 3]!;
			const wy = positions[w! * 3 + 1]!;
			const wz = positions[w! * 3 + 2]!;
			const dx = wx - ux;
			const dy = wy - uy;
			const dz = wz - uz;
			const len = Math.hypot(dx, dy, dz);
			if (len < 1e-12) continue;
			const rx = vx - ux;
			const ry = vy - uy;
			const rz = vz - uz;
			const cx = ry * dz - rz * dy;
			const cy = rz * dx - rx * dz;
			const cz = rx * dy - ry * dx;
			const perp = Math.hypot(cx, cy, cz) / len;
			const proj = (rx * dx + ry * dy + rz * dz) / (len * len);
			if (perp <= tolerance && proj > 0 && proj < 1) removeSet.add(v);
		}
		if (removeSet.size > 0) {
			changed = true;
			for (const face of faces) {
				face.loops = face.loops.map((loop) => loop.filter((v) => !removeSet.has(v))).filter((loop) => loop.length >= 3);
			}
		}
	}
}

function pointInRegion(pt: Vec2, region: Pick<Region, 'ring' | 'holes'>): boolean {
	if (region.ring.length < 3 || windingNumber(pt, region.ring) === 0) return false;
	return region.holes.every((hole) => windingNumber(pt, hole) === 0);
}

function classifyWallFaceRole(
	face: PendingFace,
	majorityTag: TagInfo | undefined,
	roleContext?: RoleProbeContext
): string {
	if (majorityTag?.role.startsWith('reveal:')) return majorityTag.role;
	const nz = face.normal[2];
	if (Math.abs(nz) > 0.99) return nz > 0 ? 'top' : 'bottom';
	if (!roleContext) return 'side';
	const probe: Vec2 = [
		face.centroid[0] + PROBE_OFFSET * face.normal[0],
		face.centroid[1] + PROBE_OFFSET * face.normal[1]
	];
	for (const space of roleContext.spaces) {
		if (space.enclosed && pointInRegion(probe, space)) return `interior:${space.elementId}`;
	}
	for (const region of roleContext.regions) {
		if (!region.touchesBounds && pointInRegion(probe, region)) return 'interior';
	}
	for (const region of roleContext.regions) {
		if (region.touchesBounds && pointInRegion(probe, region)) return 'exterior';
	}
	// Probes beyond the +1 m region clipping box are also outside any wall footprint.
	if (roleContext.regions.length === 0) return 'exterior';
	const xs = roleContext.regions.flatMap((r) => [r.bbox.minX, r.bbox.maxX]);
	const ys = roleContext.regions.flatMap((r) => [r.bbox.minY, r.bbox.maxY]);
	if (
		xs.length > 0 &&
		(probe[0] < Math.min(...xs) || probe[0] > Math.max(...xs) || probe[1] < Math.min(...ys) || probe[1] > Math.max(...ys))
	) {
		return 'exterior';
	}
	return 'side';
}

function majorityTagForFace(tris: readonly TriRecord[], tags: readonly TagInfo[]): TagInfo | undefined {
	const byTag = new Map<number, { area: number; count: number; info: TagInfo }>();
	for (const tri of tris) {
		const info = tags[tri.tag];
		if (!info) continue;
		const existing = byTag.get(tri.tag) ?? { area: 0, count: 0, info };
		existing.area += tri.area;
		existing.count += 1;
		byTag.set(tri.tag, existing);
	}
	const entries = [...byTag.values()];
	if (entries.length === 0) return undefined;
	entries.sort((a, b) => {
		if (Math.abs(b.area - a.area) > 1e-9) return b.area - a.area;
		if (b.count !== a.count) return b.count - a.count;
		return cmp(a.info.elementId, b.info.elementId) || cmp(a.info.role, b.info.role);
	});
	return entries[0]!.info;
}

/** Extract maximal coplanar faces, clean loops, hard/soft edges, and semantic roles for one part. */
export function extractPartTopology(
	part: { partId: string; kind: PartKind; elementId: string | null; mesh: MeshExport },
	tags: readonly TagInfo[],
	roleContext?: RoleProbeContext
): PartTopology {
	const { positions, remap } = weldPositions(part.mesh.positions);
	const rawTris = part.mesh.triangles;
	const rawTags = part.mesh.triTag;
	const tris: TriRecord[] = [];
	let degenerateTriangles = 0;

	for (let i = 0; i < rawTris.length; i += 3) {
		const a = remap[rawTris[i]!]!;
		const b = remap[rawTris[i + 1]!]!;
		const c = remap[rawTris[i + 2]!]!;
		if (a === b || b === c || c === a) {
			degenerateTriangles += 1;
			continue;
		}
		const ax = positions[a * 3]!;
		const ay = positions[a * 3 + 1]!;
		const az = positions[a * 3 + 2]!;
		const bx = positions[b * 3]!;
		const by = positions[b * 3 + 1]!;
		const bz = positions[b * 3 + 2]!;
		const cx = positions[c * 3]!;
		const cy = positions[c * 3 + 1]!;
		const cz = positions[c * 3 + 2]!;
		const ux = bx - ax;
		const uy = by - ay;
		const uz = bz - az;
		const vx = cx - ax;
		const vy = cy - ay;
		const vz = cz - az;
		const nx = uy * vz - uz * vy;
		const ny = uz * vx - ux * vz;
		const nz = ux * vy - uy * vx;
		const len = Math.hypot(nx, ny, nz);
		const area = 0.5 * len;
		if (!Number.isFinite(area) || area < DEGENERATE_AREA) {
			degenerateTriangles += 1;
			continue;
		}
		const normal: [number, number, number] = [cleanZero(nx / len), cleanZero(ny / len), cleanZero(nz / len)];
		const w = cleanZero(normal[0] * ax + normal[1] * ay + normal[2] * az);
		const tag = rawTags[i / 3] ?? -1;
		const materialId = tags[tag]?.materialId ?? 'sib-default';
		tris.push({
			idx: tris.length,
			verts: [a, b, c],
			n: normal,
			w,
			area,
			centroid: [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3],
			tag,
			materialId
		});
	}

	const halfEdges = new Map<string, number[]>();
	for (const tri of tris) {
		for (let j = 0; j < 3; j++) {
			const key = `${tri.verts[j]}->${tri.verts[(j + 1) % 3]}`;
			const arr = halfEdges.get(key) ?? [];
			arr.push(tri.idx);
			halfEdges.set(key, arr);
		}
	}

	const parent = tris.map((_, i) => i);
	const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
	const unite = (x: number, y: number) => {
		const rx = find(x);
		const ry = find(y);
		if (rx !== ry) parent[ry] = rx;
	};

	for (const tri of tris) {
		for (let j = 0; j < 3; j++) {
			const u = tri.verts[j]!;
			const v = tri.verts[(j + 1) % 3]!;
			const opp = halfEdges.get(`${v}->${u}`);
			if (!opp) continue;
			for (const oIdx of opp) {
				if (oIdx <= tri.idx) continue;
				const other = tris[oIdx]!;
				if (tri.materialId !== other.materialId) continue;
				const dot = tri.n[0] * other.n[0] + tri.n[1] * other.n[1] + tri.n[2] * other.n[2];
				if (dot >= NORMAL_DOT_MIN && Math.abs(tri.w - other.w) <= PLANE_TOL) {
					unite(tri.idx, other.idx);
				}
			}
		}
	}

	// Absorb sub-1e-6 m² rounding-flipped slivers into coplanar neighbor groups whose plane contains all sliver vertices.
	let absorbed = true;
	while (absorbed) {
		absorbed = false;
		const groups = new Map<number, TriRecord[]>();
		for (const tri of tris) {
			const r = find(tri.idx);
			const arr = groups.get(r) ?? [];
			arr.push(tri);
			groups.set(r, arr);
		}
		for (const [root, grp] of groups) {
			const area = grp.reduce((s, t) => s + t.area, 0);
			if (area >= SLIVER_AREA) continue;
			const adj = new Set<number>();
			for (const tri of grp) {
				for (let j = 0; j < 3; j++) {
					const u = tri.verts[j]!;
					const v = tri.verts[(j + 1) % 3]!;
					for (const oIdx of halfEdges.get(`${v}->${u}`) ?? []) {
						const or = find(oIdx);
						if (or !== root) adj.add(or);
					}
				}
			}
			const matchingHosts: { hostRoot: number; hn: [number, number, number]; hw: number; mat: string }[] = [];
			for (const hostRoot of adj) {
				const host = groups.get(hostRoot)!;
				if (host[0]!.materialId !== grp[0]!.materialId) continue;
				const ha = host.reduce((s, t) => s + t.area, 0);
				if (ha < SLIVER_AREA) continue;
				let hx = 0;
				let hy = 0;
				let hz = 0;
				for (const ht of host) {
					hx += ht.n[0] * ht.area;
					hy += ht.n[1] * ht.area;
					hz += ht.n[2] * ht.area;
				}
				const hl = Math.hypot(hx, hy, hz);
				if (hl < 1e-12) continue;
				const hn: [number, number, number] = [hx / hl, hy / hl, hz / hl];
				const hw =
					host.reduce(
						(s, ht) =>
							s +
							(hn[0] * positions[ht.verts[0]! * 3]! +
								hn[1] * positions[ht.verts[0]! * 3 + 1]! +
								hn[2] * positions[ht.verts[0]! * 3 + 2]!) *
								ht.area,
						0
					) / ha;
				const allOnPlane = grp.every((gt) =>
					gt.verts.every(
						(v) =>
							Math.abs(
								hn[0] * positions[v * 3]! + hn[1] * positions[v * 3 + 1]! + hn[2] * positions[v * 3 + 2]! - hw
							) <= PLANE_TOL
					)
				);
				if (allOnPlane) matchingHosts.push({ hostRoot, hn, hw, mat: host[0]!.materialId });
			}
			if (matchingHosts.length > 0) {
				const base = matchingHosts[0]!;
				unite(root, base.hostRoot);
				for (let m = 1; m < matchingHosts.length; m++) {
					const alt = matchingHosts[m]!;
					const dot = base.hn[0] * alt.hn[0] + base.hn[1] * alt.hn[1] + base.hn[2] * alt.hn[2];
					if (alt.mat === base.mat && dot >= NORMAL_DOT_MIN && Math.abs(base.hw - alt.hw) <= PLANE_TOL) {
						unite(root, alt.hostRoot);
					}
				}
				absorbed = true;
				break;
			}
		}
	}

	const grouped = new Map<number, TriRecord[]>();
	for (const tri of tris) {
		const r = find(tri.idx);
		const arr = grouped.get(r) ?? [];
		arr.push(tri);
		grouped.set(r, arr);
	}

	const pending: PendingFace[] = [];
	for (const grp of grouped.values()) {
		const totalArea = grp.reduce((s, t) => s + t.area, 0);
		if (totalArea < SLIVER_AREA) continue;
		let hx = 0;
		let hy = 0;
		let hz = 0;
		let cx = 0;
		let cy = 0;
		let cz = 0;
		for (const tri of grp) {
			hx += tri.n[0] * tri.area;
			hy += tri.n[1] * tri.area;
			hz += tri.n[2] * tri.area;
			cx += tri.centroid[0] * tri.area;
			cy += tri.centroid[1] * tri.area;
			cz += tri.centroid[2] * tri.area;
		}
		const hl = Math.hypot(hx, hy, hz);
		if (hl < 1e-12) continue;
		const normal: [number, number, number] = [cleanZero(hx / hl), cleanZero(hy / hl), cleanZero(hz / hl)];
		const centroid: [number, number, number] = [cleanZero(cx / totalArea), cleanZero(cy / totalArea), cleanZero(cz / totalArea)];
		const w = cleanZero(normal[0] * centroid[0] + normal[1] * centroid[1] + normal[2] * centroid[2]);
		const loops = extractBoundaryLoops(grp, positions, normal);
		if (loops.length === 0) continue;
		pending.push({
			normal,
			w,
			centroid,
			area: totalArea,
			materialId: grp[0]!.materialId,
			tris: grp,
			loops
		});
	}

	// Step 4: global collinear-vertex removal (1e-7 m primary, then 1e-6 m quantization fallback for non-planar oblique loops).
	removeCollinearVertices(pending, positions, COLLINEAR_TOL, false);
	removeCollinearVertices(pending, positions, COLLINEAR_QUANT_TOL, true);

	const labeled = pending.map((face) => {
		const majority = majorityTagForFace(face.tris, tags);
		const elementId = part.kind === 'walls' ? (majority?.elementId ?? part.partId) : (part.elementId ?? part.partId);
		const nz = face.normal[2];
		const baseRole = nz > 0.99 ? 'top' : nz < -0.99 ? 'bottom' : 'side';
		const role =
			part.kind === 'slab'
				? baseRole
				: part.kind === 'walls'
					? classifyWallFaceRole(face, majority, roleContext)
					: `${part.kind}/${baseRole}`;

		const withArea = face.loops.map((loop) => ({
			loop: rotateLoopToMinCoord(loop, positions),
			signedArea: signedLoopArea3d(loop, positions, face.normal)
		}));
		withArea.sort((a, b) => Math.abs(b.signedArea) - Math.abs(a.signedArea));
		const outer = withArea[0]!.loop;
		const holes = withArea
			.slice(1)
			.map((h) => h.loop)
			.sort((a, b) => comparePoint(pointAt(positions, a[0]!), pointAt(positions, b[0]!)));
		return { face, elementId, role, outer, holes };
	});

	labeled.sort((p, q) => {
		const roleCmp = cmp(p.role, q.role);
		if (roleCmp !== 0) return roleCmp;
		for (let i = 0; i < 3; i++) {
			const d = roundDp(p.face.normal[i]!, 1e3) - roundDp(q.face.normal[i]!, 1e3);
			if (d !== 0) return d;
		}
		const dw = roundDp(p.face.w, 1e4) - roundDp(q.face.w, 1e4);
		if (dw !== 0) return dw;
		for (let i = 0; i < 3; i++) {
			const dc = roundDp(p.face.centroid[i]!, 1e4) - roundDp(q.face.centroid[i]!, 1e4);
			if (dc !== 0) return dc;
		}
		return cmp(p.elementId, q.elementId) || comparePoint(pointAt(positions, p.outer[0]!), pointAt(positions, q.outer[0]!));
	});

	// Compact positions to loop-referenced vertices in sorted-face first-use order.
	const compactPos: number[] = [];
	const compactRemap = new Map<number, number>();
	const mapVertex = (v: number): number => {
		let idx = compactRemap.get(v);
		if (idx === undefined) {
			idx = compactPos.length / 3;
			compactRemap.set(v, idx);
			compactPos.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
		}
		return idx;
	};

	const perElementCounter = new Map<string, number>();
	const faces: TopologyFace[] = labeled.map((item) => {
		const k = perElementCounter.get(item.elementId) ?? 0;
		perElementCounter.set(item.elementId, k + 1);
		return {
			id: `${item.elementId}:f${k}`,
			elementId: item.elementId,
			role: item.role,
			materialId: item.face.materialId,
			normal: item.face.normal,
			w: item.face.w,
			centroid: item.face.centroid,
			area: item.face.area,
			outer: item.outer.map(mapVertex),
			holes: item.holes.map((hole) => hole.map(mapVertex))
		};
	});

	const faceById = new Map(faces.map((f) => [f.id, f]));
	const edgeMap = new Map<string, { a: number; b: number; faceIds: Set<string> }>();
	for (const face of faces) {
		for (const ring of [face.outer, ...face.holes]) {
			for (let i = 0; i < ring.length; i++) {
				const u = ring[i]!;
				const v = ring[(i + 1) % ring.length]!;
				const a = Math.min(u, v);
				const b = Math.max(u, v);
				const key = `${a}:${b}`;
				let entry = edgeMap.get(key);
				if (!entry) {
					entry = { a, b, faceIds: new Set() };
					edgeMap.set(key, entry);
				}
				entry.faceIds.add(face.id);
			}
		}
	}

	const edges: TopologyEdge[] = [...edgeMap.values()]
		.map((entry) => {
			const faceIds = [...entry.faceIds].sort(cmp);
			let dihedral = 180;
			let flag: 'hard' | 'soft' = 'hard';
			if (faceIds.length === 2) {
				const f1 = faceById.get(faceIds[0]!)!;
				const f2 = faceById.get(faceIds[1]!)!;
				const dot = Math.max(-1, Math.min(1, f1.normal[0] * f2.normal[0] + f1.normal[1] * f2.normal[1] + f1.normal[2] * f2.normal[2]));
				dihedral = (Math.acos(dot) * 180) / Math.PI;
				if (f1.materialId === f2.materialId && dihedral < HARD_DIHEDRAL_DEG) flag = 'soft';
			}
			return { a: entry.a, b: entry.b, faces: faceIds, dihedral, flag };
		})
		.sort((p, q) => p.a - q.a || p.b - q.b);

	return {
		partId: part.partId,
		kind: part.kind,
		positions: new Float64Array(compactPos),
		faces,
		edges,
		degenerateTriangles
	};
}
