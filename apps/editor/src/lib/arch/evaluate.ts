/**
 * SIB-MCP-MODELING-001 v2.3 C9 (WP5) — `arch/evaluate.ts`.
 *
 * `evaluateModule(module)` turns one validated ArchModule into parts (with maximal coplanar topology:
 * faces, loops, hard/soft edges, semantic roles), spaces and junction data. It is pure apart from
 * the kernel's lifetime accounting.
 *
 * Parts are sorted by partId: `walls`, `<slabId>`, `<openingId>/frame|glazing|leaf` (code-unit order).
 * Results are cached (LRU 32 per kernel) by the SHA-256 of the canonical module JSON and must be treated as
 * immutable by callers.
 */
import { buildSlab, buildSpaces, openingCutter, openingInserts, placeOpenings, type OpeningElement, type SlabElement, type SpaceElement, type SpaceResult } from './elements.js';
import { centerlineEnclosure } from './connectivity.js';
import { ArchError } from './errors.js';
import { meshVolume, sharedKernel, type Kernel, type MeshExport, type Region, type Solid, type SolidStats, type Vec2 } from './kernel.js';
import { canonicalJson, validateArchModule, type ArchModule } from './schema.js';
import { sha256Hex } from './sha256.js';
import { extractPartTopology, type PartKind, type PartTopology, type TagInfo } from './topology.js';
import { buildWallNetwork, type Junction, type StaggeredContinuation, type WallElement, type WallNetworkOptions, type WallSegment } from './walls.js';

export const DEFAULT_MATERIAL = 'sib-default';
const CACHE_SIZE = 32;

export type { PartKind, PartTopology, TagInfo };

export type EvaluatedPart = {
	partId: string;
	kind: PartKind;
	/** Owning element for slabs and inserts (the opening); `null` for the joined wall part. */
	elementId: string | null;
	/** Raw exported triangles. `triTag` indexes `EvaluatedModule.tags`. */
	mesh: MeshExport;
	/** Extracted maximal coplanar faces, loops, hard/soft edges, and semantic roles (WP5 C9). */
	topology: PartTopology;
	stats: SolidStats;
};

export type EvaluatedOpening = {
	elementId: string;
	hostElementId: string;
	openingType: string;
	segmentTag: number;
	x0: number;
	x1: number;
	zBottom: number;
	zTop: number;
	authoredStart: number;
	authoredEnd: number;
};

export type EvaluationDiagnostic = { code: 'WALL_STAGGERED_CONTINUATION'; at: Vec2; elements: [string, string]; overlap: number };

/** Owner disposition D3: an agent WRITE rejects staggered continuations, a READ/evaluation only reports them. */
export type EvaluationPurpose = 'read' | 'write';

/**
 * `purpose` selects the staggered-continuation policy (`write` → reject, `read` → report; default `read`, because reads
 * must describe documents that already exist). An explicit `staggered` overrides it. Nothing is ever auto-joined.
 */
export type EvaluateOptions = { cache?: boolean; purpose?: EvaluationPurpose } & WallNetworkOptions;

/**
 * A room as the evaluator reports it. `enclosed` is SOLID closure (the 3D wall bodies, owner disposition D1-B: its meaning
 * is unchanged); `authoredEnclosed` is CENTRELINE connectivity (wall paths joined with JOIN_TOL), `null` only for a seed that
 * lies on a centreline. They differ exactly where walls overlap without being joined (G9) or are joined without closing
 * the solid. Neither value alters a mesh.
 */
export type EvaluatedSpace = SpaceResult & { authoredEnclosed: boolean | null };

export type EvaluatedModule = {
	moduleId: string;
	/** SHA-256 of the canonical module JSON. */
	hash: string;
	parts: EvaluatedPart[];
	tags: TagInfo[];
	segments: WallSegment[];
	nodes: { id: string; point: Vec2; degree: number }[];
	footprintRings: Vec2[][];
	junctions: Record<string, Junction[]>;
	openings: EvaluatedOpening[];
	spaces: EvaluatedSpace[];
	/** Explicit, non-blocking observations about the authored geometry (never silent behaviour). */
	diagnostics: EvaluationDiagnostic[];
	bounds: { min: [number, number, number]; max: [number, number, number] } | null;
	stats: { elements: number; segments: number; nodes: number; parts: number; triangles: number; wallVolume: number };
};

const caches = new WeakMap<Kernel, Map<string, EvaluatedModule>>();

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function elementsOf<T>(module: ArchModule, kind: string): T[] {
	return module.elements.filter((e) => e.kind === kind) as unknown as T[];
}

export function evaluateModule(module: ArchModule, kernel: Kernel = sharedKernel, options: EvaluateOptions = {}): EvaluatedModule {
	validateArchModule(module);
	const hash = sha256Hex(canonicalJson(module));
	const policy = options.staggered ?? (options.purpose === 'write' ? 'reject' : 'report');
	const cacheKey = `${hash}:${policy}`; // the policy changes the outcome, so it is part of the key
	const useCache = options.cache !== false;
	const cache = caches.get(kernel) ?? new Map<string, EvaluatedModule>();
	caches.set(kernel, cache);
	const hit = useCache ? cache.get(cacheKey) : undefined;
	if (hit) {
		cache.delete(cacheKey);
		cache.set(cacheKey, hit);
		return hit;
	}
	let result: EvaluatedModule;
	try {
		result = evaluate(module, hash, kernel, { ...options, staggered: policy });
	} catch (error) {
		if (error instanceof ArchError) throw error.withModule(module.moduleId);
		throw error;
	}
	if (useCache) {
		cache.set(cacheKey, result);
		while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
	}
	return result;
}

function evaluate(module: ArchModule, hash: string, kernel: Kernel, options: EvaluateOptions): EvaluatedModule {
	const walls = elementsOf<WallElement>(module, 'wall');
	const slabs = elementsOf<SlabElement>(module, 'slab');
	const openings = elementsOf<OpeningElement>(module, 'opening');
	const spaces = elementsOf<SpaceElement>(module, 'space');
	const wallById = new Map(walls.map((w) => [w.elementId, w]));
	const materialOf = (element: { materialId?: string } | undefined, fallback = DEFAULT_MATERIAL) => element?.materialId ?? fallback;

	const owned: unknown[] = [];
	const keep = <T>(value: T): T => {
		owned.push(value);
		return value;
	};
	try {
		const network = buildWallNetwork(kernel, walls, { staggered: options.staggered });
		keep(network.solid);
		const tags: TagInfo[] = network.segments.map((s) => ({ elementId: s.elementId, role: 'wall', materialId: materialOf(wallById.get(s.elementId)) }));
		const newTag = (info: TagInfo) => tags.push(info) - 1;

		const placements = placeOpenings(network, wallById, openings);
		const rawParts: { partId: string; kind: PartKind; elementId: string | null; mesh: MeshExport; stats: SolidStats }[] = [];
		const pushPart = (partId: string, kind: PartKind, elementId: string | null, solid: Solid) => {
			const mesh = kernel.exportMesh(solid);
			rawParts.push({ partId, kind, elementId, mesh, stats: kernel.stats(solid) });
		};

		// Walls: cutters are subtracted in ONE difference; cutter-tagged triangles become reveals of the host.
		if (network.solid) {
			const cutters = placements
				.map((p) =>
					keep(
						openingCutter(
							kernel,
							p,
							newTag({ elementId: p.opening.hostElementId, role: `reveal:${p.opening.elementId}`, materialId: materialOf(wallById.get(p.opening.hostElementId)) })
						)
					)
				);
			const cut = cutters.length ? keep(kernel.difference(network.solid, cutters)) : network.solid;
			pushPart('walls', 'walls', null, cut);
		}

		for (const slab of [...slabs].sort((p, q) => cmp(p.elementId, q.elementId))) {
			const tag = newTag({ elementId: slab.elementId, role: 'slab', materialId: materialOf(slab) });
			const solid = keep(buildSlab(kernel, slab, tag));
			pushPart(slab.elementId, 'slab', slab.elementId, solid);
		}

		for (const placement of placements) {
			const insertTags = new Map<string, number>();
			const materials = { frame: materialOf(placement.opening, 'sib-frame'), glazing: 'sib-glass', leaf: 'sib-door' };
			const tagFor = (kind: 'frame' | 'glazing' | 'leaf') => {
				if (!insertTags.has(kind)) insertTags.set(kind, newTag({ elementId: placement.opening.elementId, role: kind, materialId: materials[kind] }));
				return insertTags.get(kind)!;
			};
			const inserts = openingInserts(kernel, placement, tagFor);
			inserts.forEach((insert) => keep(insert.solid)); // hold ALL before exporting any: a later failure must not strand the rest
			for (const insert of inserts) {
				pushPart(`${placement.opening.elementId}/${insert.kind}`, insert.kind, placement.opening.elementId, insert.solid);
			}
		}
		rawParts.sort((p, q) => cmp(p.partId, q.partId));

		const solidSpaces = buildSpaces(kernel, network.footprintRings, spaces);
		const authored = new Map(centerlineEnclosure(kernel, network.segments, spaces).map((r) => [r.elementId, r.centerlineEnclosed]));
		const spaceResults: EvaluatedSpace[] = solidSpaces.map((space) => ({ ...space, authoredEnclosed: authored.get(space.elementId) ?? null }));

		let footprintRegions: Region[] = [];
		if (network.footprintRings.length > 0) {
			const xs = network.footprintRings.flatMap((r) => r.map((p) => p[0]));
			const ys = network.footprintRings.flatMap((r) => r.map((p) => p[1]));
			const regionBounds = {
				minX: Math.min(...xs) - 1,
				minY: Math.min(...ys) - 1,
				maxX: Math.max(...xs) + 1,
				maxY: Math.max(...ys) + 1
			};
			footprintRegions = kernel.regionsOutside(network.footprintRings, regionBounds);
		}
		const roleContext = { regions: footprintRegions, spaces: solidSpaces };
		const parts: EvaluatedPart[] = rawParts.map((raw) => ({
			...raw,
			topology: extractPartTopology(raw, tags, raw.kind === 'walls' ? roleContext : undefined)
		}));

		let min: [number, number, number] | null = null;
		let max: [number, number, number] | null = null;
		for (const part of parts) {
			const p = part.mesh.positions;
			for (let i = 0; i < p.length; i += 3)
				for (let k = 0; k < 3; k++) {
					const v = p[i + k]!;
					min = min ?? [Infinity, Infinity, Infinity];
					max = max ?? [-Infinity, -Infinity, -Infinity];
					if (v < min[k]!) min[k] = v;
					if (v > max[k]!) max[k] = v;
				}
		}
		const wallPart = parts.find((p) => p.kind === 'walls');
		return {
			moduleId: module.moduleId,
			hash,
			parts,
			tags,
			segments: network.segments,
			nodes: network.nodes.map((n) => ({ id: n.id, point: n.point, degree: n.degree })),
			footprintRings: network.footprintRings,
			junctions: Object.fromEntries([...network.junctions].sort((p, q) => cmp(p[0], q[0]))),
			openings: placements.map((p) => ({
				elementId: p.opening.elementId, hostElementId: p.opening.hostElementId, openingType: p.opening.openingType, segmentTag: p.segment.tag,
				x0: p.x0, x1: p.x1, zBottom: p.zBottom, zTop: p.zTop, authoredStart: p.authoredStart, authoredEnd: p.authoredEnd
			})),
			spaces: spaceResults,
			diagnostics: network.staggered.map((s: StaggeredContinuation) => ({ code: 'WALL_STAGGERED_CONTINUATION' as const, at: s.at, elements: s.elements, overlap: s.overlap })),
			bounds: min && max ? { min, max } : null,
			stats: {
				elements: module.elements.length,
				segments: network.segments.length,
				nodes: network.nodes.length,
				parts: parts.length,
				triangles: parts.reduce((sum, p) => sum + p.mesh.triangles.length / 3, 0),
				wallVolume: wallPart ? meshVolume(wallPart.mesh) : 0
			}
		};
	} finally {
		kernel.release(...owned);
		kernel.resetTags();
	}
}
