import { Box3, Matrix4, Vector3 } from 'three';
import type { PartKey } from '@sibambo/contracts';
import {
	SOURCE_EDGE_HIDDEN,
	SOURCE_EDGE_SOFT,
	SOURCE_EDGE_SMOOTH,
	type PreparedRuntimeEdgeSet,
	type PreparedRuntimeGeometryGroup,
	type PreparedRuntimeGeometryMesh,
	type PreparedRuntimeGeometryScene
} from './prepared-types';

export type SolidCoplanarTriangle = {
	id: string;
	vertices: readonly [[number, number, number], [number, number, number], [number, number, number]];
	uvs?: readonly [[number, number], [number, number], [number, number]];
	materialKey: string;
	textureKey?: string;
	opacity: number;
	renderSide: 'front' | 'back' | 'double';
	definitionIndex: number;
	hierarchyDepth: number;
	sourceSurfaceArea?: number;
	partKey: PartKey;
	intentionalOverlay?: boolean;
};

export type SolidCoplanarResolutionResult = {
	suppressed: Array<{
		loser: string;
		winner: string;
		reason: 'exact-equivalent-opaque' | 'coplanar-contained-in-opaque-shell' | 'coplanar-shell-patch-union';
		confidence: number;
		overlapRatio: number;
		individualBestCoverage?: number;
		shellTriangleCount?: number;
	}>;
	ambiguous: string[];
};

const point = (value: readonly number[]) => new Vector3(value[0], value[1], value[2]);
const quantize = (value: number, quantum: number) => Math.round(value / quantum);

export type PlaneSeparationClass = 'exact' | 'very-near' | 'near' | 'separate';

export function classifyPlaneSeparation(separation: number, decodedPrecision = 0.00003): PlaneSeparationClass {
	const absolute = Math.abs(separation);
	if (absolute <= Math.max(decodedPrecision, Number.EPSILON * 64)) return 'exact';
	if (absolute < 0.001) return 'very-near';
	if (absolute < 0.005) return 'near';
	return 'separate';
}

/** Cyclic order is ignored, while reversed winding remains a different rendered side. */
export function canonicalWorldTriangleKey(triangle: SolidCoplanarTriangle, quantum = 0.00003) {
	const vertices = triangle.vertices.map((vertex, index) => [
		quantize(vertex[0], quantum), quantize(vertex[1], quantum), quantize(vertex[2], quantum),
		...(triangle.uvs ? [quantize(triangle.uvs[index][0], 1e-7), quantize(triangle.uvs[index][1], 1e-7)] : [])
	].join(','));
	const cycles = [0, 1, 2].map((offset) => [vertices[offset], vertices[(offset + 1) % 3], vertices[(offset + 2) % 3]].join('|'));
	return `${cycles.sort()[0]}#${triangle.renderSide}#${triangle.materialKey}#${triangle.textureKey || ''}#${triangle.opacity}`;
}

export function resolveSolidCoplanarTriangles(triangles: readonly SolidCoplanarTriangle[], decodedPrecision = 0.00003) {
	const suppressed: SolidCoplanarResolutionResult['suppressed'] = [];
	const suppressedIds = new Set<string>();
	const ambiguous = new Set<string>();
	const exact = new Map<string, SolidCoplanarTriangle>();

	for (const triangle of triangles) {
		if (triangle.opacity < 1) continue;
		const key = canonicalWorldTriangleKey(triangle, decodedPrecision);
		const winner = exact.get(key);
		if (winner) {
			suppressed.push({ loser: triangle.id, winner: winner.id, reason: 'exact-equivalent-opaque', confidence: 1, overlapRatio: 1 });
			suppressedIds.add(triangle.id);
		} else exact.set(key, triangle);
	}

	for (let leftIndex = 0; leftIndex < triangles.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < triangles.length; rightIndex += 1) {
			const left = triangles[leftIndex];
			const right = triangles[rightIndex];
			if (suppressedIds.has(left.id) || suppressedIds.has(right.id)) continue;
			const relation = coplanarRelation(left, right, decodedPrecision);
			if (!relation || relation.overlapRatio < 0.01) continue;
			if (relation.separationClass !== 'exact') {
				ambiguous.add(relation.smaller.id);
				continue;
			}
			if (left.materialKey === right.materialKey && !left.textureKey && !right.textureKey) {
				ambiguous.add(relation.smaller.id);
				continue;
			}
			if (relation.smaller.intentionalOverlay || ['doors', 'windows', 'openings'].includes(relation.smaller.partKey)) {
				ambiguous.add(relation.smaller.id);
				continue;
			}
			const { smaller: loser, larger: winner, overlapRatio } = relation;
			const triangleAreaRatio = relation.areaRatio;
			const sourceAreaRatio = Math.max(left.sourceSurfaceArea || 0, right.sourceSurfaceArea || 0) /
				Math.max(Math.min(left.sourceSurfaceArea || Infinity, right.sourceSurfaceArea || Infinity), 1e-12);
			const areaRatio = Math.max(triangleAreaRatio, Number.isFinite(sourceAreaRatio) ? sourceAreaRatio : 0);
			if (overlapRatio >= 0.98 && areaRatio >= 8 && winner.hierarchyDepth < loser.hierarchyDepth && winner.definitionIndex !== loser.definitionIndex) {
				suppressed.push({
					loser: loser.id,
					winner: winner.id,
					reason: 'coplanar-contained-in-opaque-shell',
					confidence: 0.95,
					overlapRatio,
					individualBestCoverage: overlapRatio,
					shellTriangleCount: 1
				});
				suppressedIds.add(loser.id);
			} else {
				ambiguous.add(loser.id);
			}
		}
	}

	// Check multi-triangle patch coverage for candidates that were not suppressed by single pairs
	for (const cand of triangles) {
		if (suppressedIds.has(cand.id) || cand.opacity < 1) continue;
		if (cand.intentionalOverlay || ['doors', 'windows', 'openings'].includes(cand.partKey)) continue;

		const norm = canonicalNormal(cand);
		const dom = dominantAxis(norm);
		const cand2D = cand.vertices.map((v) => project(v, dom));
		const candArea = polygonArea(cand2D);
		if (candArea < 1e-12) continue;

		const clippedPolys: Array<[number, number][]> = [];
		const matchingShells: SolidCoplanarTriangle[] = [];
		let bestSingleRatio = 0;

		for (const shell of triangles) {
			if (shell.id === cand.id || shell.opacity < 1) continue;
			if (shell.definitionIndex === cand.definitionIndex) continue;
			if (shell.hierarchyDepth > cand.hierarchyDepth) continue;
			if (shell.intentionalOverlay || ['doors', 'windows', 'openings'].includes(shell.partKey)) continue;

			const rel = coplanarRelation(shell, cand, decodedPrecision);
			if (!rel || rel.separationClass !== 'exact' || rel.overlapArea <= 0) continue;

			const shell2D = shell.vertices.map((v) => project(v, dom));
			const clipped = clipConvex(cand2D, shell2D);
			const clippedArea = polygonArea(clipped);
			if (clippedArea > 1e-10) {
				clippedPolys.push(clipped);
				matchingShells.push(shell);
				const ratio = clippedArea / candArea;
				if (ratio > bestSingleRatio) bestSingleRatio = ratio;
			}
		}

		if (clippedPolys.length >= 2) {
			const unionArea = computePolygonUnionArea(clippedPolys);
			const unionRatio = unionArea / candArea;
			if (unionRatio >= 0.95) {
				suppressed.push({
					loser: cand.id,
					winner: matchingShells[0].id,
					reason: 'coplanar-shell-patch-union',
					confidence: 0.92,
					overlapRatio: Math.min(unionRatio, 1),
					individualBestCoverage: bestSingleRatio,
					shellTriangleCount: matchingShells.length
				});
				suppressedIds.add(cand.id);
			}
		}
	}

	return { suppressed, ambiguous: [...ambiguous].filter((id) => !suppressedIds.has(id)) };
}

type ShellCandidate = {
	groupIndex: number;
	triangleIndex: number;
	occurrence: number;
	v0?: [number, number, number];
	v1?: [number, number, number];
	v2?: [number, number, number];
	normal?: Vector3;
	dist?: number;
	sourceSurfaceArea: number;
	hierarchyDepth: number;
	definitionIndex: number;
	partKey: PartKey;
	poly2D: [number, number][];
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	stamp?: number;
};

export function quantizeValue(value: number, step = 0.0001) {
	return Math.round(value / step) * step;
}

export interface SolidGeometryTolerancePolicy {
	/** Estimated source coordinate precision / uncertainty in meters */
	sourcePositionUncertaintyM: number;
	/** Spatial step for canonical plane integer distance bucketing */
	planeBucketStep: number;
	/** Maximum distance between candidate and shell to be considered coplanar */
	planeTolerance: number;
	/** Tolerance for querying neighboring plane buckets */
	neighboringPlaneTolerance: number;
	/** Radians tolerance for normal alignment (angular compatibility) */
	normalAngularToleranceRad: number;
	/** Minimum dot product between face normals to be considered parallel */
	normalDotTolerance: number;
	/** Multiplier for allowed residual sliver width relative to local feature scale */
	localSliverWidthToleranceRatio: number;
	/** Maximum ratio of uncovered area to candidate area for residual sliver suppression */
	relativeSliverAreaTolerance: number;
	/** Absolute minimum bound on allowed sliver width in meters */
	minAllowedSliverWidthM: number;
	/** Absolute maximum cap on allowed sliver width in meters */
	maxAllowedSliverWidthM: number;
	/** Absolute maximum cap on allowed sliver area in m^2 */
	maxAllowedSliverAreaM2: number;
	/** Minimum feature size that must always be preserved if not covered */
	minimumMeaningfulFeatureSizeM: number;
	/** Metadata regarding how this policy was derived */
	provenance: {
		modelSpanM: number;
		coordinateMagnitudeM: number;
		float32PrecisionM: number;
		decodedPrecisionM: number;
		safetyMultiplier: number;
	};
}

export function pointInConvexPolygon(p: readonly [number, number], poly: readonly [number, number][]): boolean {
	const n = poly.length;
	if (n < 3) return false;
	let sign = 0;
	for (let i = 0; i < n; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % n];
		const cp = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
		if (Math.abs(cp) < 1e-8) continue;
		const curSign = cp > 0 ? 1 : -1;
		if (sign === 0) sign = curSign;
		else if (curSign !== sign) return false;
	}
	return true;
}

export function deriveSolidGeometryTolerancePolicy(
	scene: PreparedRuntimeGeometryScene,
	decodedPrecision = 0.00003,
	overrides?: Partial<SolidGeometryTolerancePolicy>
): SolidGeometryTolerancePolicy {
	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

	for (const group of scene.groups) {
		if (group.worldBounds) {
			minX = Math.min(minX, group.worldBounds.min[0]);
			minY = Math.min(minY, group.worldBounds.min[1]);
			minZ = Math.min(minZ, group.worldBounds.min[2]);
			maxX = Math.max(maxX, group.worldBounds.max[0]);
			maxY = Math.max(maxY, group.worldBounds.max[1]);
			maxZ = Math.max(maxZ, group.worldBounds.max[2]);
		}
	}

	if (!Number.isFinite(minX)) {
		minX = -10; minY = -10; minZ = -10;
		maxX = 10; maxY = 10; maxZ = 10;
	}

	const coordinateMagnitudeM = Math.max(
		Math.abs(minX), Math.abs(maxX),
		Math.abs(minY), Math.abs(maxY),
		Math.abs(minZ), Math.abs(maxZ),
		1.0
	);
	const modelSpanM = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1.0);

	// IEEE-754 single precision eps = magnitude * 2^-23 (~1.192e-7)
	const float32PrecisionM = Math.max(coordinateMagnitudeM * 1.192092896e-7, 1e-7);

	// Estimated source position uncertainty (taking max of codec quantization and F32 representation)
	const sourcePositionUncertaintyM = Math.max(decodedPrecision, float32PrecisionM, 0.00001);

	// Safety multiplier for affine transform round-off and boundary quantization
	const safetyMultiplier = 4.0;

	// Numerical plane tolerance: at least 0.5 mm to bridge floating point and matrix transform jitter
	const planeTolerance = Math.max(sourcePositionUncertaintyM * safetyMultiplier, 0.0005);
	const planeBucketStep = Math.max(planeTolerance, 0.0005);
	const neighboringPlaneTolerance = planeTolerance;

	// Angular tolerance: 2 degrees (~0.035 rad) -> normal dot product ~0.9994
	const normalAngularToleranceRad = 0.035;
	const normalDotTolerance = Math.cos(normalAngularToleranceRad);

	const policy: SolidGeometryTolerancePolicy = {
		sourcePositionUncertaintyM,
		planeBucketStep,
		planeTolerance,
		neighboringPlaneTolerance,
		normalAngularToleranceRad,
		normalDotTolerance,
		localSliverWidthToleranceRatio: 0.02,
		relativeSliverAreaTolerance: 0.10,
		minAllowedSliverWidthM: Math.max(planeTolerance * 2.0, 0.001),
		maxAllowedSliverWidthM: 0.008,
		maxAllowedSliverAreaM2: 0.04,
		minimumMeaningfulFeatureSizeM: 0.005,
		provenance: {
			modelSpanM,
			coordinateMagnitudeM,
			float32PrecisionM,
			decodedPrecisionM: decodedPrecision,
			safetyMultiplier
		},
		...overrides
	};

	return policy;
}

export function canonicalPlane(
	norm: Vector3,
	pointOnPlane: Vector3,
	precisionOrPolicy: number | SolidGeometryTolerancePolicy = 0.001
) {
	const step = typeof precisionOrPolicy === 'object' ? precisionOrPolicy.planeBucketStep : precisionOrPolicy;
	let nx = norm.x;
	let ny = norm.y;
	let nz = norm.z;
	const first = Math.abs(nx) > 1e-5 ? nx : Math.abs(ny) > 1e-5 ? ny : nz;
	if (first < -1e-5) { nx = -nx; ny = -ny; nz = -nz; }
	const dist = nx * pointOnPlane.x + ny * pointOnPlane.y + nz * pointOnPlane.z;
	const rnx = Math.round(nx * 1000) / 1000;
	const rny = Math.round(ny * 1000) / 1000;
	const rnz = Math.round(nz * 1000) / 1000;
	const dInt = Math.round(dist / step);
	const normBase = `${rnx},${rny},${rnz}`;
	return {
		normal: norm,
		dist,
		dInt,
		normBase,
		key: `${normBase}#${dInt}`
	};
}

export function cellHash(gx: number, gy: number): number {
	return (((gx + 16384) & 0x7FFF) << 15) | ((gy + 16384) & 0x7FFF);
}

export type SolidShellPatch = {
	minHierarchyDepth: number;
	aggregateArea: number;
	isShell: boolean;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	shells: ShellCandidate[];
	memberIndices: number[];
	grid?: Map<number, number[]>;
};

export type GeometryPreparationProgress = {
	phase:
		| 'dedup'
		| 'plane-buckets'
		| 'shell-patches'
		| 'candidate-query'
		| 'coverage'
		| 'solid-indices'
		| 'solid-edges';
	completed: number;
	total: number;
	message?: string;
};

export type PlaneBucket = {
	axis: number;
	normal: Vector3;
	dist?: number;
	normBase?: string;
	dInt?: number;
	shells: ShellCandidate[];
	patches?: SolidShellPatch[];
	grid?: Map<number, number[]>;
	largeShells?: number[];
};

/**
 * Builds a Solid-only index mask in the loader/worker. The hot scan is linear in
 * occurrence triangles; plane bucketing and 2D polygon union analysis are performed
 * off-main-thread with zero per-frame runtime overhead.
 */
export function prepareSolidCoplanarScene(
	scene: PreparedRuntimeGeometryScene,
	decodedPrecision = 0.00003,
	customPolicy?: Partial<SolidGeometryTolerancePolicy>,
	onProgress?: (progress: GeometryPreparationProgress) => void
) {
	const started = performance.now();
	const policy = deriveSolidGeometryTolerancePolicy(scene, decodedPrecision, customPolicy);

	let lastProgressMs = performance.now();
	const reportProgress = (phase: GeometryPreparationProgress['phase'], completed: number, total: number, message?: string, force = false) => {
		if (!onProgress) return;
		const now = performance.now();
		if (force || now - lastProgressMs >= 40 || completed === total) {
			lastProgressMs = now;
			onProgress({ phase, completed, total, message });
		}
	};

	// Expose in DEV for diagnostic inspection
	if (typeof globalThis !== 'undefined') {
		(globalThis as any).__SIBAMBO_GEOMETRY_TOLERANCE__ = policy;
	}

	const meshes = new Map(scene.meshes.map((mesh) => [mesh.sourceMeshIndex, mesh]));
	const exactSuppressed = scene.groups.map(() => new Set<number>());
	const shellSuppressedByOccurrence = scene.groups.map(() => new Map<number, Set<number>>());
	let exactEquivalentBefore = 0;
	let trianglePairSuppressions = 0;
	let patchUnionSuppressions = 0;
	let ambiguousConflicts = 0;
	const suppressionDetails: NonNullable<PreparedRuntimeGeometryScene['solidCoplanarSuppressions']> = [];
	const fullTriangles = scene.groups.reduce((sum, group) => sum + (group.indices.length / 3) * Math.max(group.matrices.length / 16, 1), 0);

	console.time('dedup-identical');
	reportProgress('dedup', 0, scene.groups.length, 'Deduplikasi segitiga identik...', true);
	// 1. Deduplicate identical occurrences & duplicate co-located triangles
	for (const [groupIndex, group] of scene.groups.entries()) {
		reportProgress('dedup', groupIndex + 1, scene.groups.length, `Deduplikasi segitiga identik ${groupIndex + 1} / ${scene.groups.length}...`);
		if ((group.opacity ?? group.baseColorRgba?.[3] ?? 1) < 1) continue;
		const mesh = meshes.get(group.sourceMeshIndex);
		if (!mesh) continue;
		const seen = new Set<string>();
		for (let triangleIndex = 0; triangleIndex < group.indices.length / 3; triangleIndex += 1) {
			const i0 = group.indices[triangleIndex * 3];
			const i1 = group.indices[triangleIndex * 3 + 1];
			const i2 = group.indices[triangleIndex * 3 + 2];
			const min = Math.min(i0, i1, i2);
			const max = Math.max(i0, i1, i2);
			const mid = i0 + i1 + i2 - min - max;
			const key = `${min}:${mid}:${max}`;
			if (seen.has(key)) {
				exactSuppressed[groupIndex].add(triangleIndex);
				exactEquivalentBefore += Math.max(group.matrices.length / 16, 1);
			} else seen.add(key);
		}
	}
	console.timeEnd('dedup-identical');

	// 2. Build plane buckets & cluster into connected SolidShellPatch instances
	console.time('patch-build');
	const patchBuildStart = performance.now();
	const planeBuckets = new Map<string, PlaneBucket>();
	let totalPatchTriangles = 0;
	let smallTrianglesAcceptedViaPatchGrowth = 0;
	let isolatedSmallTrianglesRejected = 0;
	let shellPatchCount = 0;
	let internalPatchCount = 0;
	const patchMemberCounts: number[] = [];
	const patchAreas: number[] = [];
	const maxCandArea = 25.0;
	const scratchMat = new Matrix4();
	const scratchV0 = new Vector3();
	const scratchV1 = new Vector3();
	const scratchV2 = new Vector3();
	const scratchE1 = new Vector3();
	const scratchE2 = new Vector3();
	const scratchNorm = new Vector3();

	let minSceneHierarchyDepth = Infinity;
	for (const group of scene.groups) {
		if (group.occurrenceHierarchyDepths) {
			for (let i = 0; i < group.occurrenceHierarchyDepths.length; i += 1) {
				if (group.occurrenceHierarchyDepths[i] < minSceneHierarchyDepth) {
					minSceneHierarchyDepth = group.occurrenceHierarchyDepths[i];
				}
			}
		}
	}
	if (!Number.isFinite(minSceneHierarchyDepth)) minSceneHierarchyDepth = 0;

	// Precalculate definition mesh face normals
	const groupNormals = scene.groups.map((group) => {
		const mesh = meshes.get(group.sourceMeshIndex);
		if (!mesh) return null;
		const triCount = group.indices.length / 3;
		const norms = new Float32Array(triCount * 3);
		const v0 = new Vector3();
		const v1 = new Vector3();
		const v2 = new Vector3();
		const e1 = new Vector3();
		const e2 = new Vector3();
		const n = new Vector3();
		for (let t = 0; t < triCount; t += 1) {
			const i0 = group.indices[t * 3];
			const i1 = group.indices[t * 3 + 1];
			const i2 = group.indices[t * 3 + 2];
			v0.set(mesh.positions[i0 * 3], mesh.positions[i0 * 3 + 1], mesh.positions[i0 * 3 + 2]);
			v1.set(mesh.positions[i1 * 3], mesh.positions[i1 * 3 + 1], mesh.positions[i1 * 3 + 2]);
			v2.set(mesh.positions[i2 * 3], mesh.positions[i2 * 3 + 1], mesh.positions[i2 * 3 + 2]);
			e1.subVectors(v1, v0);
			e2.subVectors(v2, v0);
			n.crossVectors(e1, e2).normalize();
			norms[t * 3] = Number.isNaN(n.x) ? 0 : n.x;
			norms[t * 3 + 1] = Number.isNaN(n.y) ? 0 : n.y;
			norms[t * 3 + 2] = Number.isNaN(n.z) ? 0 : n.z;
		}
		return norms;
	});

	const localNorm = new Vector3();
	for (const [groupIndex, group] of scene.groups.entries()) {
		if (!eligibleOpaqueGroup(group)) continue;
		if (['doors', 'windows', 'openings', 'railings'].includes(group.key)) continue;
		const mesh = meshes.get(group.sourceMeshIndex);
		const norms = groupNormals[groupIndex];
		if (!mesh || !norms || !group.sourceFaceAreasByTriangle || !group.occurrenceHierarchyDepths) continue;
		const numOcc = Math.max(group.matrices.length / 16, 1);

		for (let occ = 0; occ < numOcc; occ += 1) {
			scratchMat.fromArray(group.matrices, occ * 16);
			const occDepth = group.occurrenceHierarchyDepths[occ];

			for (let triangleIndex = 0; triangleIndex < group.indices.length / 3; triangleIndex += 1) {
				if (exactSuppressed[groupIndex].has(triangleIndex)) continue;
				const area = group.sourceFaceAreasByTriangle[triangleIndex] || 0;
				const minTriangleArea = Math.min(0.0001, policy.maxAllowedSliverAreaM2 * 0.01);
				if (area < minTriangleArea) continue;

				localNorm.set(norms[triangleIndex * 3], norms[triangleIndex * 3 + 1], norms[triangleIndex * 3 + 2]);
				if (localNorm.x === 0 && localNorm.y === 0 && localNorm.z === 0) continue;
				scratchNorm.copy(localNorm).transformDirection(scratchMat).normalize();

				const i0 = group.indices[triangleIndex * 3];
				const i1 = group.indices[triangleIndex * 3 + 1];
				const i2 = group.indices[triangleIndex * 3 + 2];
				scratchV0.set(mesh.positions[i0 * 3], mesh.positions[i0 * 3 + 1], mesh.positions[i0 * 3 + 2]).applyMatrix4(scratchMat);
				scratchV1.set(mesh.positions[i1 * 3], mesh.positions[i1 * 3 + 1], mesh.positions[i1 * 3 + 2]).applyMatrix4(scratchMat);
				scratchV2.set(mesh.positions[i2 * 3], mesh.positions[i2 * 3 + 1], mesh.positions[i2 * 3 + 2]).applyMatrix4(scratchMat);

				const cp = canonicalPlane(scratchNorm, scratchV0, policy);

				let bucket = planeBuckets.get(cp.key);
				if (!bucket) {
					const axis = dominantAxis(scratchNorm);
					bucket = { axis, normal: scratchNorm.clone(), dist: cp.dist, normBase: cp.normBase, dInt: cp.dInt, shells: [] };
					planeBuckets.set(cp.key, bucket);
				}

				let p0x = 0, p0y = 0, p1x = 0, p1y = 0, p2x = 0, p2y = 0;
				if (bucket.axis === 2) {
					p0x = scratchV0.x; p0y = scratchV0.y;
					p1x = scratchV1.x; p1y = scratchV1.y;
					p2x = scratchV2.x; p2y = scratchV2.y;
				} else if (bucket.axis === 1) {
					p0x = scratchV0.x; p0y = scratchV0.z;
					p1x = scratchV1.x; p1y = scratchV1.z;
					p2x = scratchV2.x; p2y = scratchV2.z;
				} else {
					p0x = scratchV0.y; p0y = scratchV0.z;
					p1x = scratchV1.y; p1y = scratchV1.z;
					p2x = scratchV2.y; p2y = scratchV2.z;
				}
				const minX = Math.min(p0x, p1x, p2x);
				const maxX = Math.max(p0x, p1x, p2x);
				const minY = Math.min(p0y, p1y, p2y);
				const maxY = Math.max(p0y, p1y, p2y);

				bucket.shells.push({
					groupIndex,
					occurrence: occ,
					triangleIndex,
					definitionIndex: group.definitionIndex,
					hierarchyDepth: occDepth,
					partKey: group.key,
					sourceSurfaceArea: area,
					dist: cp.dist,
					poly2D: [[p0x, p0y], [p1x, p1y], [p2x, p2y]],
					minX, maxX, minY, maxY
				});
				totalPatchTriangles += 1;
			}
		}
	}

	// Cluster triangles within each canonical plane bucket into connected SolidShellPatch instances
	let patchBucketIdx = 0;
	const totalPlaneBuckets = planeBuckets.size;
	for (const [bucketKey, bucket] of planeBuckets.entries()) {
		patchBucketIdx += 1;
		reportProgress('shell-patches', patchBucketIdx, totalPlaneBuckets, `Membangun shell patch topologi ${patchBucketIdx.toLocaleString('id-ID')} / ${totalPlaneBuckets.toLocaleString('id-ID')}...`);
		const numShells = bucket.shells.length;
		if (numShells === 0) continue;

		const minSeedArea = 0.04;

		// Fast-path: single shell in bucket
		if (numShells === 1) {
			const s = bucket.shells[0];
			const area = polygonArea(s.poly2D);
			const isShallowest = s.hierarchyDepth <= minSceneHierarchyDepth;
			const isShell = (isShallowest || (s.sourceSurfaceArea || 0) >= minSeedArea || area >= minSeedArea) &&
				!['doors', 'windows', 'openings', 'railings'].includes(s.partKey);
			const p: SolidShellPatch = {
				minHierarchyDepth: s.hierarchyDepth,
				aggregateArea: area,
				isShell,
				minX: s.minX, maxX: s.maxX, minY: s.minY, maxY: s.maxY,
				shells: [s],
				memberIndices: [0]
			};

			if (isShell) {
				shellPatchCount += 1;
				if (area < minSeedArea) smallTrianglesAcceptedViaPatchGrowth += 1;
				const bucketGrid = new Map<number, number[]>();
				const minGx = Math.floor(s.minX / 2.0);
				const maxGx = Math.floor(s.maxX / 2.0);
				const minGy = Math.floor(s.minY / 2.0);
				const maxGy = Math.floor(s.maxY / 2.0);
				for (let gx = minGx; gx <= maxGx; gx += 1) {
					for (let gy = minGy; gy <= maxGy; gy += 1) {
						bucketGrid.set(cellHash(gx, gy), [0]);
					}
				}
				bucket.grid = bucketGrid;
				bucket.largeShells = [];
			} else {
				internalPatchCount += 1;
				isolatedSmallTrianglesRejected += 1;
			}
			patchMemberCounts.push(1);
			patchAreas.push(area);
			bucket.patches = [p];
			continue;
		}

		// Group shells by groupIndex:occurrence
		let allSameBatch = true;
		const firstGrp = bucket.shells[0].groupIndex;
		const firstOcc = bucket.shells[0].occurrence;
		for (let i = 1; i < numShells; i += 1) {
			if (bucket.shells[i].groupIndex !== firstGrp || bucket.shells[i].occurrence !== firstOcc) {
				allSameBatch = false;
				break;
			}
		}

		let batchList: number[][];
		let numBatches: number;
		let parent: Int32Array;

		if (allSameBatch) {
			const allIndices: number[] = new Array(numShells);
			for (let i = 0; i < numShells; i += 1) allIndices[i] = i;
			batchList = [allIndices];
			numBatches = 1;
			parent = new Int32Array([0]);
		} else {
			const groupBatches = new Map<string, number[]>();
			for (let i = 0; i < numShells; i += 1) {
				const s = bucket.shells[i];
				const key = `${s.groupIndex}:${s.occurrence}`;
				let list = groupBatches.get(key);
				if (!list) { list = []; groupBatches.set(key, list); }
				list.push(i);
			}

			batchList = Array.from(groupBatches.values());
			numBatches = batchList.length;
			parent = new Int32Array(numBatches);
			for (let i = 0; i < numBatches; i += 1) parent[i] = i;

			const find = (i: number): number => {
				let root = i;
				while (parent[root] !== root) root = parent[root];
				let curr = i;
				while (curr !== root) {
					const next = parent[curr];
					parent[curr] = root;
					curr = next;
				}
				return root;
			};
			const union = (i: number, j: number) => {
				const rootI = find(i);
				const rootJ = find(j);
				if (rootI !== rootJ) parent[rootI] = rootJ;
			};

			// Compute 2D bounds per batch
			const batchBounds = batchList.map((indices) => {
				let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
				for (const idx of indices) {
					const s = bucket.shells[idx];
					if (s.minX < minX) minX = s.minX;
					if (s.maxX > maxX) maxX = s.maxX;
					if (s.minY < minY) minY = s.minY;
					if (s.maxY > maxY) maxY = s.maxY;
				}
				return { minX, maxX, minY, maxY };
			});

			// Fast 2D spatial grid for batch merging (replaces O(N^2) pairwise comparisons)
			const batchGridCellSize = 2.0;
			const batchGrid = new Map<number, number[]>();
			for (let i = 0; i < numBatches; i += 1) {
				const b = batchBounds[i];
				const minGx = Math.floor((b.minX - 0.005) / batchGridCellSize);
				const maxGx = Math.floor((b.maxX + 0.005) / batchGridCellSize);
				const minGy = Math.floor((b.minY - 0.005) / batchGridCellSize);
				const maxGy = Math.floor((b.maxY + 0.005) / batchGridCellSize);
				for (let gx = minGx; gx <= maxGx; gx += 1) {
					for (let gy = minGy; gy <= maxGy; gy += 1) {
						const k = cellHash(gx, gy);
						let list = batchGrid.get(k);
						if (!list) { list = []; batchGrid.set(k, list); }
						list.push(i);
					}
				}
			}

			const testedPairs = new Set<string>();
			for (const list of batchGrid.values()) {
				if (list.length <= 1) continue;
				for (let li = 0; li < list.length; li += 1) {
					const i = list[li];
					const bA = batchBounds[i];
					const sA = bucket.shells[batchList[i][0]];
					for (let lj = li + 1; lj < list.length; lj += 1) {
						const j = list[lj];
						const pairKey = i < j ? `${i}:${j}` : `${j}:${i}`;
						if (testedPairs.has(pairKey)) continue;
						testedPairs.add(pairKey);

						const sB = bucket.shells[batchList[j][0]];
						if (sA.definitionIndex !== sB.definitionIndex) continue;
						const bB = batchBounds[j];
						if (bA.minX <= bB.maxX + 0.005 && bA.maxX >= bB.minX - 0.005 &&
							bA.minY <= bB.maxY + 0.005 && bA.maxY >= bB.minY - 0.005) {
							union(i, j);
						}
					}
				}
			}
		}

		const find = (i: number): number => {
			let root = i;
			while (parent[root] !== root) root = parent[root];
			let curr = i;
			while (curr !== root) {
				const next = parent[curr];
				parent[curr] = root;
				curr = next;
			}
			return root;
		};

		const patchMap = new Map<number, SolidShellPatch>();
		for (let bIdx = 0; bIdx < numBatches; bIdx += 1) {
			const root = find(bIdx);
			const existing = patchMap.get(root);
			const p: SolidShellPatch = existing || {
				minHierarchyDepth: Infinity,
				aggregateArea: 0,
				isShell: false,
				minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity,
				shells: [],
				memberIndices: []
			};
			if (!existing) patchMap.set(root, p);
			for (const sIdx of batchList[bIdx]) {
				const s = bucket.shells[sIdx];
				p.shells.push(s);
				p.memberIndices.push(sIdx);
				p.aggregateArea += polygonArea(s.poly2D);
				if (s.hierarchyDepth < p.minHierarchyDepth) p.minHierarchyDepth = s.hierarchyDepth;
				if (s.minX < p.minX) p.minX = s.minX;
				if (s.maxX > p.maxX) p.maxX = s.maxX;
				if (s.minY < p.minY) p.minY = s.minY;
				if (s.maxY > p.maxY) p.maxY = s.maxY;
			}
		}

		for (const p of patchMap.values()) {
			const isShallowest = p.minHierarchyDepth <= minSceneHierarchyDepth;
			const hasSeed = p.shells.some((s) => (s.sourceSurfaceArea || 0) >= minSeedArea || polygonArea(s.poly2D) >= minSeedArea);
			p.isShell = (isShallowest || p.aggregateArea >= minSeedArea || hasSeed) && !p.shells.some((s) => ['doors', 'windows', 'openings', 'railings'].includes(s.partKey));

			if (p.isShell) {
				shellPatchCount += 1;
				for (const s of p.shells) {
					if (polygonArea(s.poly2D) < minSeedArea) smallTrianglesAcceptedViaPatchGrowth += 1;
				}
			} else {
				internalPatchCount += 1;
				isolatedSmallTrianglesRejected += p.shells.length;
			}
			patchMemberCounts.push(p.shells.length);
			patchAreas.push(p.aggregateArea);
		}

		// Build 2D spatial grid for the bucket indexing qualified shell triangles
		const bucketGrid = new Map<number, number[]>();
		const largeShells: number[] = [];
		const cellSize = 2.0;

		for (const p of patchMap.values()) {
			if (!p.isShell) continue;
			for (const globalIdx of p.memberIndices) {
				const s = bucket.shells[globalIdx];
				const spanX = s.maxX - s.minX;
				const spanY = s.maxY - s.minY;

				if (spanX > 8.0 || spanY > 8.0) {
					largeShells.push(globalIdx);
				} else {
					const minGx = Math.floor(s.minX / cellSize);
					const maxGx = Math.floor(s.maxX / cellSize);
					const minGy = Math.floor(s.minY / cellSize);
					const maxGy = Math.floor(s.maxY / cellSize);
					for (let gx = minGx; gx <= maxGx; gx += 1) {
						for (let gy = minGy; gy <= maxGy; gy += 1) {
							const k = cellHash(gx, gy);
							let list = bucketGrid.get(k);
							if (!list) { list = []; bucketGrid.set(k, list); }
							list.push(globalIdx);
						}
					}
				}
			}
		}
		bucket.grid = bucketGrid;
		bucket.largeShells = largeShells;
		bucket.patches = Array.from(patchMap.values());
	}
	console.timeEnd('patch-build');
	const patchBuildMs = performance.now() - patchBuildStart;

	// 3. Scan candidate triangles against qualified SolidShellPatch instances
	console.time('candidate-scan');
	const coverageStart = performance.now();
	let candidatesEvaluated = 0;
	const coverageRatios: number[] = [];

	const neighborOffsetRadius = Math.max(1, Math.ceil(policy.neighboringPlaneTolerance / policy.planeBucketStep));
	const neighborOffsets: number[] = [];
	for (let offset = -neighborOffsetRadius; offset <= neighborOffsetRadius; offset += 1) {
		neighborOffsets.push(offset);
	}

	const minCandArea = 1e-8;
	const cellSize = 2.0;
	let currentCandidateStamp = 1;
	let scanBucketIdx = 0;
	for (const [bucketKey, bucket] of planeBuckets.entries()) {
		scanBucketIdx += 1;
		reportProgress('candidate-query', scanBucketIdx, totalPlaneBuckets, `Menyaring kandidat permukaan internal ${scanBucketIdx.toLocaleString('id-ID')} / ${totalPlaneBuckets.toLocaleString('id-ID')}...`);
		if (!bucket.patches) continue;

		let maxShellArea = 0;
		let minShellDepth = Infinity;
		let hasCandidate = false;

		for (const p of bucket.patches) {
			if (p.isShell) {
				if (p.aggregateArea > maxShellArea) maxShellArea = p.aggregateArea;
				if (p.minHierarchyDepth < minShellDepth) minShellDepth = p.minHierarchyDepth;
			} else {
				hasCandidate = true;
			}
		}

		if (!hasCandidate) {
			for (const p of bucket.patches) {
				if (p.minHierarchyDepth > minShellDepth || p.aggregateArea < maxShellArea * 0.75) {
					hasCandidate = true;
					break;
				}
			}
		}
		if (!hasCandidate) continue;

		const normBase = bucket.normBase || (bucketKey.slice(0, bucketKey.lastIndexOf('#')));
		const dInt = bucket.dInt !== undefined ? bucket.dInt : parseInt(bucketKey.slice(bucketKey.lastIndexOf('#') + 1), 10);

		const targetBuckets: PlaneBucket[] = [];
		if ((bucket.grid && bucket.grid.size > 0) || (bucket.largeShells && bucket.largeShells.length > 0)) {
			targetBuckets.push(bucket);
		}
		for (const offset of neighborOffsets) {
			if (offset === 0) continue;
			const nb = planeBuckets.get(`${normBase}#${dInt + offset}`);
			if (nb && ((nb.grid && nb.grid.size > 0) || (nb.largeShells && nb.largeShells.length > 0))) {
				targetBuckets.push(nb);
			}
		}
		if (targetBuckets.length === 0) continue;

		for (const candPatch of bucket.patches) {
			const isPotentialCandidate = !candPatch.isShell ||
				candPatch.minHierarchyDepth > minShellDepth ||
				candPatch.aggregateArea < maxShellArea * 0.75;
			if (!isPotentialCandidate) continue;

			for (const cand of candPatch.shells) {
				if (cand.sourceSurfaceArea < minCandArea) continue;
				if (exactSuppressed[cand.groupIndex].has(cand.triangleIndex)) continue;

				candidatesEvaluated += 1;
				const candArea2D = polygonArea(cand.poly2D);
				if (candArea2D < 1e-8) continue;

				const candMinX = cand.minX;
				const candMaxX = cand.maxX;
				const candMinY = cand.minY;
				const candMaxY = cand.maxY;

				const minGx = Math.floor(candMinX / cellSize);
				const maxGx = Math.floor(candMaxX / cellSize);
				const minGy = Math.floor(candMinY / cellSize);
				const maxGy = Math.floor(candMaxY / cellSize);

				const clippedPolys: Array<[number, number][]> = [];
				let bestSingleShell: ShellCandidate | undefined;
				let bestSingleOverlapRatio = 0;
				const matchingShells: ShellCandidate[] = [];
				currentCandidateStamp += 1;

				for (const b of targetBuckets) {
					if (b.largeShells) {
						for (const sIdx of b.largeShells) {
							const shell = b.shells[sIdx];
							if (shell.stamp === currentCandidateStamp) continue;
							shell.stamp = currentCandidateStamp;

							if (shell.hierarchyDepth > cand.hierarchyDepth) continue;
							if (shell.hierarchyDepth === cand.hierarchyDepth && shell.definitionIndex === cand.definitionIndex) continue;
							if (shell.definitionIndex === cand.definitionIndex) continue;
							if (shell.groupIndex === cand.groupIndex && shell.occurrence === cand.occurrence) continue;
							if (shell.maxX < candMinX - 1e-4 || shell.minX > candMaxX + 1e-4) continue;
							if (shell.maxY < candMinY - 1e-4 || shell.minY > candMaxY + 1e-4) continue;

							const clipped = clipConvex(cand.poly2D, shell.poly2D);
							if (clipped.length < 3) continue;
							const overlapArea = polygonArea(clipped);
							const overlapRatio = overlapArea / candArea2D;
							if (overlapRatio <= 0.001) continue;

							clippedPolys.push(clipped);
							matchingShells.push(shell);
							if (overlapRatio > bestSingleOverlapRatio) {
								bestSingleOverlapRatio = overlapRatio;
								bestSingleShell = shell;
							}
							if (bestSingleOverlapRatio >= 0.95) break;
						}
					}
					if (bestSingleOverlapRatio >= 0.95) break;

					if (b.grid) {
						for (let gx = minGx; gx <= maxGx; gx += 1) {
							for (let gy = minGy; gy <= maxGy; gy += 1) {
								const list = b.grid.get(cellHash(gx, gy));
								if (!list) continue;
								for (const sIdx of list) {
									const shell = b.shells[sIdx];
									if (shell.stamp === currentCandidateStamp) continue;
									shell.stamp = currentCandidateStamp;

									if (shell.hierarchyDepth > cand.hierarchyDepth) continue;
									if (shell.hierarchyDepth === cand.hierarchyDepth && shell.definitionIndex === cand.definitionIndex) continue;
									if (shell.definitionIndex === cand.definitionIndex) continue;
									if (shell.groupIndex === cand.groupIndex && shell.occurrence === cand.occurrence) continue;
									if (shell.maxX < candMinX - 1e-4 || shell.minX > candMaxX + 1e-4) continue;
									if (shell.maxY < candMinY - 1e-4 || shell.minY > candMaxY + 1e-4) continue;

									const clipped = clipConvex(cand.poly2D, shell.poly2D);
									if (clipped.length < 3) continue;
									const overlapArea = polygonArea(clipped);
									const overlapRatio = overlapArea / candArea2D;
									if (overlapRatio <= 0.001) continue;

									clippedPolys.push(clipped);
									matchingShells.push(shell);
									if (overlapRatio > bestSingleOverlapRatio) {
										bestSingleOverlapRatio = overlapRatio;
										bestSingleShell = shell;
									}
									if (bestSingleOverlapRatio >= 0.95) break;
								}
								if (bestSingleOverlapRatio >= 0.95) break;
							}
							if (bestSingleOverlapRatio >= 0.95) break;
						}
					}
					if (bestSingleOverlapRatio >= 0.95) break;
				}

				if (clippedPolys.length === 0) continue;

				let resolved = false;

				// Single triangle containment
				if (bestSingleOverlapRatio >= 0.95 && bestSingleShell) {
					trianglePairSuppressions += 1;
					resolved = true;
					const winnerGroup = scene.groups[bestSingleShell.groupIndex];
					const loserGroup = scene.groups[cand.groupIndex];
					suppressionDetails.push({
						reason: 'coplanar-contained-in-opaque-shell',
						confidence: 0.95,
						overlapRatio: Math.min(bestSingleOverlapRatio, 1),
						individualBestCoverage: bestSingleOverlapRatio,
						shellTriangleCount: 1,
						winner: {
							sourceMeshIndex: winnerGroup.sourceMeshIndex,
							definitionIndex: winnerGroup.definitionIndex,
							sourceFaceIndex: winnerGroup.sourceFaceIndicesByTriangle?.[bestSingleShell.triangleIndex],
							occurrenceHandle: winnerGroup.occurrenceHandles?.[bestSingleShell.occurrence]
						},
						loser: {
							sourceMeshIndex: loserGroup.sourceMeshIndex,
							definitionIndex: loserGroup.definitionIndex,
							sourceFaceIndex: loserGroup.sourceFaceIndicesByTriangle?.[cand.triangleIndex],
							occurrenceHandle: loserGroup.occurrenceHandles?.[cand.occurrence]
						}
					});
					coverageRatios.push(bestSingleOverlapRatio);
				} else if (clippedPolys.length >= 1 && matchingShells.length > 0) {
					// Multi-triangle patch union coverage
					const unionArea = clippedPolys.length === 1 ? polygonArea(clippedPolys[0]) : computePolygonUnionArea(clippedPolys);
					const unionRatio = unionArea / candArea2D;
					const isStandardCovered = unionRatio >= 0.95;

					// Scale-aware residual sliver rule
					let isSliver = false;
					if (!isStandardCovered && unionRatio >= (1 - policy.relativeSliverAreaTolerance)) {
						const uncovArea = candArea2D * (1 - unionRatio);
						const p = cand.poly2D;
						const perimeter = Math.hypot(p[1][0]-p[0][0], p[1][1]-p[0][1]) + Math.hypot(p[2][0]-p[1][0], p[2][1]-p[1][1]) + Math.hypot(p[0][0]-p[2][0], p[0][1]-p[2][1]);
						const estWidth = perimeter > 0 ? (uncovArea / (perimeter * 0.5)) : 0;
						const allowedWidth = Math.max(policy.minAllowedSliverWidthM, (perimeter / 3) * policy.localSliverWidthToleranceRatio);
						const allowedArea = candArea2D * policy.relativeSliverAreaTolerance;
						if (uncovArea <= allowedArea && estWidth <= allowedWidth) {
							isSliver = true;
						}
					}

					if (isStandardCovered || isSliver) {
						patchUnionSuppressions += 1;
						resolved = true;
						const winnerGroup = scene.groups[matchingShells[0].groupIndex];
						const loserGroup = scene.groups[cand.groupIndex];
						suppressionDetails.push({
							reason: isSliver ? 'coplanar-sliver-residual' : 'coplanar-shell-patch-union',
							confidence: isSliver ? 0.90 : 0.92,
							overlapRatio: Math.min(unionRatio, 1),
							individualBestCoverage: bestSingleOverlapRatio,
							shellTriangleCount: matchingShells.length,
							winner: {
								sourceMeshIndex: winnerGroup.sourceMeshIndex,
								definitionIndex: winnerGroup.definitionIndex,
								sourceFaceIndex: winnerGroup.sourceFaceIndicesByTriangle?.[matchingShells[0].triangleIndex],
								occurrenceHandle: winnerGroup.occurrenceHandles?.[matchingShells[0].occurrence]
							},
							loser: {
								sourceMeshIndex: loserGroup.sourceMeshIndex,
								definitionIndex: loserGroup.definitionIndex,
								sourceFaceIndex: loserGroup.sourceFaceIndicesByTriangle?.[cand.triangleIndex],
								occurrenceHandle: loserGroup.occurrenceHandles?.[cand.occurrence]
							}
						});
						coverageRatios.push(unionRatio);
					} else if (unionRatio > 0.01) {
						ambiguousConflicts += 1;
					}
				} else if (bestSingleOverlapRatio > 0.3) {
					ambiguousConflicts += 1;
				}

				if (resolved) {
					let occMap = shellSuppressedByOccurrence[cand.groupIndex].get(cand.occurrence);
					if (!occMap) {
						occMap = new Set<number>();
						shellSuppressedByOccurrence[cand.groupIndex].set(cand.occurrence, occMap);
					}
					occMap.add(cand.triangleIndex);
				}
			}
		}
	}
	console.timeEnd('candidate-scan');
	const coverageMs = performance.now() - coverageStart;

	// Calculate coverage percentiles
	coverageRatios.sort((a, b) => a - b);
	const coverageP50 = coverageRatios.length ? coverageRatios[Math.floor(coverageRatios.length * 0.5)] : 0;
	const coverageP95 = coverageRatios.length ? coverageRatios[Math.floor(coverageRatios.length * 0.95)] : 0;

	// 4. Build resolved solid index buffers
	let shellSuppressions = 0;
	let solidTriangles = 0;
	const resolvedGroups: PreparedRuntimeGeometryGroup[] = [];

	for (const [groupIndex, group] of scene.groups.entries()) {
		const occurrenceCount = Math.max(group.matrices.length / 16, 1);
		const occurrenceRows = new Map<string, number[]>();
		for (let occurrence = 0; occurrence < occurrenceCount; occurrence += 1) {
			const signature = [...(shellSuppressedByOccurrence[groupIndex].get(occurrence) || [])].sort((a, b) => a - b).join(',');
			const rows = occurrenceRows.get(signature) || [];
			rows.push(occurrence);
			occurrenceRows.set(signature, rows);
		}
		for (const [signature, occurrences] of occurrenceRows) {
			const shellMask = new Set(signature ? signature.split(',').map(Number) : []);
			const retained: number[] = [];
			const retainedSourceTriangles: number[] = [];
			for (let triangleIndex = 0; triangleIndex < group.indices.length / 3; triangleIndex += 1) {
				if (exactSuppressed[groupIndex].has(triangleIndex) || shellMask.has(triangleIndex)) continue;
				retained.push(group.indices[triangleIndex * 3], group.indices[triangleIndex * 3 + 1], group.indices[triangleIndex * 3 + 2]);
				retainedSourceTriangles.push(triangleIndex);
			}
			const IndexArray = group.indices instanceof Uint32Array ? Uint32Array : Uint16Array;
			const matrices = new Float32Array(occurrences.length * 16);
			occurrences.forEach((occ, index) => matrices.set(group.matrices.subarray(occ * 16, occ * 16 + 16), index * 16));
			const isFullGroup = occurrences.length === occurrenceCount && retained.length === group.indices.length;
			const resolved: PreparedRuntimeGeometryGroup = isFullGroup ? group : {
				...group,
				matrices,
				occurrenceHandles: group.occurrenceHandles ? occurrences.map((occ) => group.occurrenceHandles![occ]) : undefined,
				occurrenceHierarchyDepths: group.occurrenceHierarchyDepths ? Uint16Array.from(occurrences.map((occ) => group.occurrenceHierarchyDepths![occ])) : undefined,
				solidIndices: new IndexArray(retained),
				solidSourceTriangleIndices: Uint32Array.from(retainedSourceTriangles)
			};
			resolvedGroups.push(resolved);
			shellSuppressions += shellMask.size * occurrences.length;
			solidTriangles += (retained.length / 3) * occurrences.length;
		}
	}
	scene.groups = resolvedGroups;
	reportProgress('solid-indices', 1, 1, 'Menyusun indeks segitiga solid...', true);
	console.time('resolve-edges');
	const { solidEdgeSets, metrics: edgeMetrics } = resolveSolidSourceEdges(scene, planeBuckets, policy, onProgress);
	console.timeEnd('resolve-edges');
	scene.solidEdgeSets = solidEdgeSets;

	const patchMembers = patchMemberCounts.sort((a, b) => a - b);
	patchAreas.sort((a, b) => a - b);

	const metrics = {
		preparationMs: performance.now() - started,
		exactEquivalentBefore,
		exactEquivalentAfter: 0,
		shellSuppressions,
		trianglePairSuppressions,
		patchUnionSuppressions,
		ambiguousConflicts,
		fullTriangles,
		solidTriangles,
		planeBuckets: planeBuckets.size,
		shellPatches: shellPatchCount,
		internalPatches: internalPatchCount,
		patchTriangles: totalPatchTriangles,
		smallTrianglesAcceptedViaPatchGrowth,
		isolatedSmallTrianglesRejected,
		candidatesEvaluated,
		coverageP50,
		coverageP95,
		patchBuildMs,
		coverageMs,
		tolerancePolicy: policy,
		...edgeMetrics
	};
	scene.solidCoplanarResolution = metrics;
	scene.solidCoplanarSuppressions = suppressionDetails;

	if (typeof globalThis !== 'undefined') {
		(globalThis as any).__SIBAMBO_SHELL_PATCH_METRICS__ = {
			patchCount: patchMembers.length,
			shellPatchCount,
			internalPatchCount,
			patchMembers: {
				min: patchMembers.length ? patchMembers[0] : 0,
				median: patchMembers.length ? patchMembers[Math.floor(patchMembers.length / 2)] : 0,
				p95: patchMembers.length ? patchMembers[Math.floor(patchMembers.length * 0.95)] : 0,
				max: patchMembers.length ? patchMembers[patchMembers.length - 1] : 0
			},
			patchAggregateArea: {
				median: patchAreas.length ? patchAreas[Math.floor(patchAreas.length / 2)] : 0,
				p95: patchAreas.length ? patchAreas[Math.floor(patchAreas.length * 0.95)] : 0
			},
			smallTrianglesAcceptedViaPatchGrowth,
			isolatedSmallTrianglesRejected,
			protectedPrimaryEdges: edgeMetrics.protectedPrimaryEdges ?? 0,
			protectedSecondaryEdges: edgeMetrics.protectedSecondaryEdges ?? 0,
			suppressedInternalEdges: edgeMetrics.suppressedInternalEdges ?? 0,
			clippedInternalEdges: edgeMetrics.clippedInternalEdges ?? 0,
			surfaceSuppressions: suppressionDetails.length,
			residualSurfaceCandidates: 0,
			patchBuildMs,
			surfaceResolutionMs: coverageMs,
			edgeResolutionMs: edgeMetrics.clipMs ?? 0
		};
	}

	return metrics;
}

export function clipSegmentAgainstConvexPolygon(
	p0: readonly [number, number],
	p1: readonly [number, number],
	poly: readonly [number, number][]
): [number, number] | null {
	let t0 = 0;
	let t1 = 1;
	const dx = p1[0] - p0[0];
	const dy = p1[1] - p0[1];
	const n = poly.length;
	if (n < 3) return null;

	let area = 0;
	for (let i = 0; i < n; i += 1) {
		const c = poly[i];
		const next = poly[(i + 1) % n];
		area += c[0] * next[1] - next[0] * c[1];
	}
	const isCCW = area >= 0;

	for (let i = 0; i < n; i += 1) {
		const v0 = poly[i];
		const v1 = poly[(i + 1) % n];
		const ex = v1[0] - v0[0];
		const ey = v1[1] - v0[1];

		const nx = isCCW ? ey : -ey;
		const ny = isCCW ? -ex : ex;

		const denom = dx * nx + dy * ny;
		const numer = -((p0[0] - v0[0]) * nx + (p0[1] - v0[1]) * ny);

		if (Math.abs(denom) < 1e-12) {
			if (numer < -1e-8) return null;
		} else {
			const t = numer / denom;
			if (denom > 0) {
				if (t < t1) t1 = t;
			} else {
				if (t > t0) t0 = t;
			}
			if (t0 > t1 + 1e-7) return null;
		}
	}

	t0 = Math.max(0, t0);
	t1 = Math.min(1, t1);
	if (t0 >= t1 - 1e-5) return null;
	return [t0, t1];
}

export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
	if (intervals.length === 0) return [];
	intervals.sort((a, b) => a[0] - b[0]);
	const result: Array<[number, number]> = [intervals[0]];
	for (let i = 1; i < intervals.length; i += 1) {
		const prev = result[result.length - 1];
		const curr = intervals[i];
		if (curr[0] <= prev[1] + 1e-5) {
			prev[1] = Math.max(prev[1], curr[1]);
		} else {
			result.push(curr);
		}
	}
	return result;
}

export function computeUncoveredIntervals(covered: readonly [number, number][]): Array<[number, number]> {
	const uncovered: Array<[number, number]> = [];
	let cursor = 0;
	for (const [c0, c1] of covered) {
		if (c0 > cursor + 1e-5) {
			uncovered.push([cursor, c0]);
		}
		cursor = Math.max(cursor, c1);
	}
	if (cursor < 1 - 1e-5) {
		uncovered.push([cursor, 1]);
	}
	return uncovered;
}

export function resolveSolidSourceEdges(
	scene: PreparedRuntimeGeometryScene,
	existingPlaneBuckets?: Map<string, PlaneBucket>,
	tolerancePolicy?: SolidGeometryTolerancePolicy,
	onProgress?: (progress: GeometryPreparationProgress) => void
): {
	solidEdgeSets: PreparedRuntimeEdgeSet[];
	metrics: {
		sourceEdgeSegments: number;
		hardSourceEdgeSegments: number;
		solidEdgeSegments: number;
		protectedPrimaryEdges?: number;
		protectedSecondaryEdges?: number;
		suppressedInternalEdges?: number;
		clippedInternalEdges?: number;
		edgesSuppressedBySolidOwnership: number;
		fullVisibleFastPath: number;
		fullySuppressedFastPath: number;
		partialCandidates: number;
		fullyCoveredSegmentsRemoved: number;
		partiallyClippedSegments: number;
		resultingSubsegments: number;
		visibilitySummaryMs: number;
		patchLookupMs: number;
		clipMs: number;
		totalEdgePrepMs: number;
		typedArrayBytesFull: number;
		typedArrayBytesSolid: number;
	};
} {
	const edgePrepStart = performance.now();
	if (!scene.edgeSets || scene.edgeSets.length === 0) {
		return {
			solidEdgeSets: [],
			metrics: {
				sourceEdgeSegments: 0,
				hardSourceEdgeSegments: 0,
				solidEdgeSegments: 0,
				edgesSuppressedBySolidOwnership: 0,
				fullVisibleFastPath: 0,
				fullySuppressedFastPath: 0,
				partialCandidates: 0,
				fullyCoveredSegmentsRemoved: 0,
				partiallyClippedSegments: 0,
				resultingSubsegments: 0,
				visibilitySummaryMs: 0,
				patchLookupMs: 0,
				clipMs: 0,
				totalEdgePrepMs: 0,
				typedArrayBytesFull: 0,
				typedArrayBytesSolid: 0
			}
		};
	}

	const visSummaryStart = performance.now();
	// 1. Build face visibility map: handle -> faceIdx -> { total, surviving }
	const faceStatsByOccurrence = new Map<string, Map<number, { total: number; surviving: number }>>();

	for (const group of scene.groups) {
		if (!group.occurrenceHandles || !group.sourceFaceIndicesByTriangle) continue;
		const totalTriCount = group.indices.length / 3;
		const isFullGroup = group.solidSourceTriangleIndices === undefined;
		const survivingSet = isFullGroup ? null : new Set(group.solidSourceTriangleIndices || []);

		const faceTriTotals = new Map<number, { total: number; surviving: number }>();
		for (let t = 0; t < totalTriCount; t += 1) {
			const faceIdx = group.sourceFaceIndicesByTriangle[t];
			if (faceIdx === undefined) continue;
			let stat = faceTriTotals.get(faceIdx);
			if (!stat) { stat = { total: 0, surviving: 0 }; faceTriTotals.set(faceIdx, stat); }
			stat.total += 1;
			if (survivingSet === null || survivingSet.has(t)) stat.surviving += 1;
		}

		for (const handle of group.occurrenceHandles) {
			let map = faceStatsByOccurrence.get(handle);
			if (!map) { map = new Map(); faceStatsByOccurrence.set(handle, map); }
			for (const [faceIdx, stat] of faceTriTotals) {
				let fStat = map.get(faceIdx);
				if (!fStat) { fStat = { total: 0, surviving: 0 }; map.set(faceIdx, fStat); }
				fStat.total += stat.total;
				fStat.surviving += stat.surviving;
			}
		}
	}

	function getFaceState(handle: string | undefined, faceIdx: number): 'FULL_VISIBLE' | 'PARTIAL_VISIBLE' | 'FULL_SUPPRESSED' {
		if (!handle) return 'FULL_VISIBLE';
		const map = faceStatsByOccurrence.get(handle);
		if (!map) return 'FULL_VISIBLE';
		const stat = map.get(faceIdx);
		if (!stat) return 'FULL_VISIBLE';
		if (stat.surviving === 0) return 'FULL_SUPPRESSED';
		if (stat.surviving === stat.total) return 'FULL_VISIBLE';
		return 'PARTIAL_VISIBLE';
	}
	const visibilitySummaryMs = performance.now() - visSummaryStart;

	// 2. Precompute definition-level face normals per mesh
	const patchLookupStart = performance.now();
	const faceNormalsByMesh = new Map<number, Map<number, Vector3>>();
	const meshMap = new Map<number, PreparedRuntimeGeometryMesh>();
	for (const mesh of scene.meshes) {
		faceNormalsByMesh.set(mesh.sourceMeshIndex, new Map());
		meshMap.set(mesh.sourceMeshIndex, mesh);
	}
	const fnV0 = new Vector3();
	const fnV1 = new Vector3();
	const fnV2 = new Vector3();
	const fnE1 = new Vector3();
	const fnE2 = new Vector3();
	const fnNorm = new Vector3();

	for (const group of scene.groups) {
		const mesh = meshMap.get(group.sourceMeshIndex);
		if (!mesh || !group.sourceFaceIndicesByTriangle) continue;
		const map = faceNormalsByMesh.get(group.sourceMeshIndex)!;
		for (let t = 0; t < group.indices.length / 3; t += 1) {
			const faceIdx = group.sourceFaceIndicesByTriangle[t];
			if (faceIdx === undefined || map.has(faceIdx)) continue;
			const i0 = group.indices[t * 3];
			const i1 = group.indices[t * 3 + 1];
			const i2 = group.indices[t * 3 + 2];
			fnV0.set(mesh.positions[i0 * 3], mesh.positions[i0 * 3 + 1], mesh.positions[i0 * 3 + 2]);
			fnV1.set(mesh.positions[i1 * 3], mesh.positions[i1 * 3 + 1], mesh.positions[i1 * 3 + 2]);
			fnV2.set(mesh.positions[i2 * 3], mesh.positions[i2 * 3 + 1], mesh.positions[i2 * 3 + 2]);
			fnE1.subVectors(fnV1, fnV0);
			fnE2.subVectors(fnV2, fnV0);
			fnNorm.crossVectors(fnE1, fnE2).normalize();
			if (!Number.isNaN(fnNorm.x)) map.set(faceIdx, fnNorm.clone());
		}
	}

	// 3. Obtain or construct plane buckets with 2D spatial cell grid
	const planeBuckets: Map<string, PlaneBucket> = existingPlaneBuckets || new Map();
	const cellSize = 1.0;

	if (!existingPlaneBuckets) {
		for (const group of scene.groups) {
			if ((group.opacity ?? group.baseColorRgba?.[3] ?? 1) < 1) continue;
			if (['doors', 'windows', 'openings', 'railings'].includes(group.key)) continue;
			const mesh = scene.meshes.find((m) => m.sourceMeshIndex === group.sourceMeshIndex);
			if (!mesh || !group.sourceFaceAreasByTriangle || !group.occurrenceHierarchyDepths) continue;
			const numOcc = Math.max(group.matrices.length / 16, 1);
			const numTriangles = group.indices.length / 3;
			const survivingTriangles = group.solidSourceTriangleIndices ?? Array.from({ length: numTriangles }, (_, i) => i);

			for (let i = 0; i < survivingTriangles.length; i += 1) {
				const triangleIndex = survivingTriangles[i];
				const area = group.sourceFaceAreasByTriangle[triangleIndex] || 0;
				if (area < 0.015) continue;

				const i0 = group.indices[triangleIndex * 3];
				const i1 = group.indices[triangleIndex * 3 + 1];
				const i2 = group.indices[triangleIndex * 3 + 2];
				const lv0 = [mesh.positions[i0 * 3], mesh.positions[i0 * 3 + 1], mesh.positions[i0 * 3 + 2]] as [number, number, number];
				const lv1 = [mesh.positions[i1 * 3], mesh.positions[i1 * 3 + 1], mesh.positions[i1 * 3 + 2]] as [number, number, number];
				const lv2 = [mesh.positions[i2 * 3], mesh.positions[i2 * 3 + 1], mesh.positions[i2 * 3 + 2]] as [number, number, number];

				for (let occ = 0; occ < numOcc; occ += 1) {
					const mat = new Matrix4().fromArray(group.matrices, occ * 16);
					const wv0 = new Vector3(...lv0).applyMatrix4(mat);
					const wv1 = new Vector3(...lv1).applyMatrix4(mat);
					const wv2 = new Vector3(...lv2).applyMatrix4(mat);
					const e1 = new Vector3().subVectors(wv1, wv0);
					const e2 = new Vector3().subVectors(wv2, wv0);
					const norm = new Vector3().crossVectors(e1, e2).normalize();
					if (Number.isNaN(norm.x)) continue;

					const cp = canonicalPlane(norm, wv0);
					let bucket = planeBuckets.get(cp.key);
					if (!bucket) {
						const axis = dominantAxis(cp.normal);
						bucket = { axis, normal: cp.normal, shells: [] };
						planeBuckets.set(cp.key, bucket);
					}

					const p2D: [number, number][] = [
						project([wv0.x, wv0.y, wv0.z], bucket.axis),
						project([wv1.x, wv1.y, wv1.z], bucket.axis),
						project([wv2.x, wv2.y, wv2.z], bucket.axis)
					];
					const minX = Math.min(p2D[0][0], p2D[1][0], p2D[2][0]);
					const maxX = Math.max(p2D[0][0], p2D[1][0], p2D[2][0]);
					const minY = Math.min(p2D[0][1], p2D[1][1], p2D[2][1]);
					const maxY = Math.max(p2D[0][1], p2D[1][1], p2D[2][1]);

					bucket.shells.push({
						groupIndex: -1,
						triangleIndex,
						occurrence: occ,
						v0: [wv0.x, wv0.y, wv0.z],
						v1: [wv1.x, wv1.y, wv1.z],
						v2: [wv2.x, wv2.y, wv2.z],
						normal: cp.normal,
						sourceSurfaceArea: area,
						hierarchyDepth: group.occurrenceHierarchyDepths[occ],
						definitionIndex: group.definitionIndex,
						partKey: group.key,
						poly2D: p2D,
						minX, maxX, minY, maxY
					});
				}
			}
		}
	}

	for (const bucket of planeBuckets.values()) {
		if (!bucket.grid && bucket.shells.length > 16) {
			const grid = new Map<number, number[]>();
			for (let s = 0; s < bucket.shells.length; s += 1) {
				const sh = bucket.shells[s];
				const minGx = Math.floor(sh.minX / cellSize);
				const maxGx = Math.floor(sh.maxX / cellSize);
				const minGy = Math.floor(sh.minY / cellSize);
				const maxGy = Math.floor(sh.maxY / cellSize);
				for (let gx = minGx; gx <= maxGx; gx += 1) {
					for (let gy = minGy; gy <= maxGy; gy += 1) {
						const k = cellHash(gx, gy);
						let list = grid.get(k);
						if (!list) { list = []; grid.set(k, list); }
						list.push(s);
					}
				}
			}
			bucket.grid = grid;
		}
	}
	const patchLookupMs = performance.now() - patchLookupStart;

	// 4. Resolve edge sets with explicit SolidEdgeDisposition
	const clipStart = performance.now();
	let sourceEdgeSegments = 0;
	let hardSourceEdgeSegments = 0;
	let solidEdgeSegments = 0;
	let protectedPrimaryEdges = 0;
	let protectedSecondaryEdges = 0;
	let suppressedInternalEdges = 0;
	let clippedInternalEdges = 0;
	let edgesSuppressedBySolidOwnership = 0;
	let fullVisibleFastPath = 0;
	let fullySuppressedFastPath = 0;
	let partialCandidates = 0;
	let fullyCoveredSegmentsRemoved = 0;
	let partiallyClippedSegments = 0;
	let resultingSubsegments = 0;
	let typedArrayBytesFull = 0;
	let typedArrayBytesSolid = 0;

	// Collect all visible shell source faces directly from patch.memberSourceFaces using integer keys
	const visibleShellFaces = new Set<number>();
	for (const bucket of planeBuckets.values()) {
		for (const patch of bucket.patches || []) {
			if (!patch.isShell) continue;
			for (const s of patch.shells) {
				const grp = scene.groups[s.groupIndex];
				const faceIdx = grp?.sourceFaceIndicesByTriangle?.[s.triangleIndex];
				if (faceIdx !== undefined) {
					visibleShellFaces.add((grp.sourceMeshIndex << 20) | faceIdx);
				}
			}
		}
	}

	const solidEdgeSets: PreparedRuntimeEdgeSet[] = [];

	const v0 = new Vector3();
	const v1 = new Vector3();
	const mat = new Matrix4();
	const faceWorldNorm = new Vector3();
	let currentEdgeStamp = 1;

	const neighborOffsetRadius = tolerancePolicy
		? Math.max(1, Math.ceil(tolerancePolicy.neighboringPlaneTolerance / tolerancePolicy.planeBucketStep))
		: 1;
	const neighborOffsets: number[] = [];
	for (let offset = -neighborOffsetRadius; offset <= neighborOffsetRadius; offset += 1) {
		neighborOffsets.push(offset);
	}

	let lastEdgeProgressMs = performance.now();
	for (let edgeSetIdx = 0; edgeSetIdx < scene.edgeSets.length; edgeSetIdx += 1) {
		const edgeSet = scene.edgeSets[edgeSetIdx];
		const nowTime = performance.now();
		if (onProgress && (nowTime - lastEdgeProgressMs >= 40 || edgeSetIdx === scene.edgeSets.length - 1)) {
			lastEdgeProgressMs = nowTime;
			onProgress({
				phase: 'solid-edges',
				completed: edgeSetIdx + 1,
				total: scene.edgeSets.length,
				message: `Menyelesaikan garis tepi solid ${edgeSetIdx + 1} / ${scene.edgeSets.length}...`
			});
		}
		const segCount = edgeSet.flags.length;
		const occCount = edgeSet.matrices.length / 16;
		sourceEdgeSegments += segCount * occCount;
		typedArrayBytesFull += edgeSet.positions.byteLength + edgeSet.flags.byteLength + edgeSet.matrices.byteLength;

		const hardEdgeIndices: number[] = [];
		for (let e = 0; e < segCount; e += 1) {
			const f = edgeSet.flags[e];
			if ((f & (SOURCE_EDGE_HIDDEN | SOURCE_EDGE_SOFT | SOURCE_EDGE_SMOOTH)) === 0) {
				hardEdgeIndices.push(e);
			}
		}
		hardSourceEdgeSegments += hardEdgeIndices.length * occCount;

		const occurrenceRows = new Map<string, number[]>();
		const extraOccurrences: Array<{ occ: number; positions: number[] }> = [];
		const faceNormals = faceNormalsByMesh.get(edgeSet.sourceMeshIndex);

		for (let occ = 0; occ < occCount; occ += 1) {
			const handle = edgeSet.occurrenceHandles?.[occ] ?? `occ-${occ}`;
			const faceStats = faceStatsByOccurrence.get(handle);
			mat.fromArray(edgeSet.matrices, occ * 16);
			const keptIndices: number[] = [];

			for (let idx = 0; idx < hardEdgeIndices.length; idx += 1) {
				const e = hardEdgeIndices[idx];
				const incFaces = edgeSet.incidentFaceIndicesByEdge?.[e];
				if (!incFaces || incFaces.length === 0) {
					fullVisibleFastPath += 1;
					protectedPrimaryEdges += 1;
					keptIndices.push(e);
					continue;
				}

				const srcMeshIdx = edgeSet.sourceMeshIndex;
				let hasVisibleShell = false;
				let allSuppressed = true;
				let allVisible = true;
				let hasPartial = false;

				for (let i = 0; i < incFaces.length; i++) {
					const fId = incFaces[i];
					const stat = faceStats ? faceStats.get(fId) : undefined;
					const isPureWinner = visibleShellFaces.has((srcMeshIdx << 20) | fId) && (!stat || stat.surviving === stat.total);
					if (isPureWinner) {
						hasVisibleShell = true;
					}
					const isFull = stat ? stat.surviving === 0 : false;
					const isVis = stat ? stat.surviving === stat.total : true;
					if (!isFull) allSuppressed = false;
					if (!isVis) allVisible = false;
					if (stat && stat.surviving > 0 && stat.surviving < stat.total) hasPartial = true;
				}

				// PRESERVE_PRIMARY / PRESERVE_SECONDARY:
				// Winner shell does NOT occlude its own authored boundary edges!
				if (hasVisibleShell && !allSuppressed) {
					fullVisibleFastPath += 1;
					if (incFaces.length === 1 || hasPartial) {
						protectedPrimaryEdges += 1;
					} else {
						protectedSecondaryEdges += 1;
					}
					keptIndices.push(e);
					continue;
				}

				// SUPPRESS_INTERNAL:
				if (allSuppressed) {
					fullySuppressedFastPath += 1;
					suppressedInternalEdges += 1;
					edgesSuppressedBySolidOwnership += 1;
					continue;
				}

				// Fully visible non-shell feature:
				if (allVisible) {
					fullVisibleFastPath += 1;
					protectedSecondaryEdges += 1;
					keptIndices.push(e);
					continue;
				}

				// CLIP_INTERNAL: Partial internal candidates tested against coplanar plane buckets
				partialCandidates += 1;
				clippedInternalEdges += 1;
				v0.set(edgeSet.positions[e * 6], edgeSet.positions[e * 6 + 1], edgeSet.positions[e * 6 + 2]).applyMatrix4(mat);
				v1.set(edgeSet.positions[e * 6 + 3], edgeSet.positions[e * 6 + 4], edgeSet.positions[e * 6 + 5]).applyMatrix4(mat);

				const coveredIntervals: Array<[number, number]> = [];
				for (let i = 0; i < incFaces.length; i += 1) {
					const faceIdx = incFaces[i];
					const localNorm = faceNormals?.get(faceIdx);
					if (!localNorm) continue;
					faceWorldNorm.copy(localNorm).transformDirection(mat).normalize();
					const cp = canonicalPlane(faceWorldNorm, v0, tolerancePolicy || 0.001);
					const normBase = cp.normBase;
					const dInt = cp.dInt;

					for (const offset of neighborOffsets) {
						const k = `${normBase}#${dInt + offset}`;
						const foundBucket = planeBuckets.get(k);
						if (!foundBucket || foundBucket.shells.length === 0) continue;

						const s0 = project([v0.x, v0.y, v0.z], foundBucket.axis);
						const s1 = project([v1.x, v1.y, v1.z], foundBucket.axis);
						const minX = Math.min(s0[0], s1[0]);
						const maxX = Math.max(s0[0], s1[0]);
						const minY = Math.min(s0[1], s1[1]);
						const maxY = Math.max(s0[1], s1[1]);

						if (foundBucket.grid) {
							const minGx = Math.floor(minX / cellSize);
							const maxGx = Math.floor(maxX / cellSize);
							const minGy = Math.floor(minY / cellSize);
							const maxGy = Math.floor(maxY / cellSize);
							currentEdgeStamp += 1;
							if (foundBucket.largeShells) {
								for (const sIdx of foundBucket.largeShells) {
									const sh = foundBucket.shells[sIdx];
									if (sh.stamp === currentEdgeStamp) continue;
									sh.stamp = currentEdgeStamp;
									if (maxX < sh.minX - 1e-4 || minX > sh.maxX + 1e-4 || maxY < sh.minY - 1e-4 || minY > sh.maxY + 1e-4) continue;
									if (sh.definitionIndex === edgeSet.definitionIndex) continue;
									if (tolerancePolicy && Math.abs((sh.dist ?? cp.dist) - cp.dist) > tolerancePolicy.planeTolerance) continue;

									const interval = clipSegmentAgainstConvexPolygon(s0, s1, sh.poly2D);
									if (interval) coveredIntervals.push(interval);
								}
							}
							for (let gx = minGx; gx <= maxGx; gx += 1) {
								for (let gy = minGy; gy <= maxGy; gy += 1) {
									const list = foundBucket.grid.get(cellHash(gx, gy));
									if (!list) continue;
									for (const sIdx of list) {
										const sh = foundBucket.shells[sIdx];
										if (sh.stamp === currentEdgeStamp) continue;
										sh.stamp = currentEdgeStamp;
										if (maxX < sh.minX - 1e-4 || minX > sh.maxX + 1e-4 || maxY < sh.minY - 1e-4 || minY > sh.maxY + 1e-4) continue;
										if (sh.definitionIndex === edgeSet.definitionIndex) continue;
										if (tolerancePolicy && Math.abs((sh.dist ?? cp.dist) - cp.dist) > tolerancePolicy.planeTolerance) continue;

										const interval = clipSegmentAgainstConvexPolygon(s0, s1, sh.poly2D);
										if (interval) coveredIntervals.push(interval);
									}
								}
							}
						} else {
							for (const sh of foundBucket.shells) {
								if (maxX < sh.minX - 1e-4 || minX > sh.maxX + 1e-4 || maxY < sh.minY - 1e-4 || minY > sh.maxY + 1e-4) continue;
								if (sh.definitionIndex === edgeSet.definitionIndex) continue;
								if (tolerancePolicy && Math.abs((sh.dist ?? cp.dist) - cp.dist) > tolerancePolicy.planeTolerance) continue;

								const interval = clipSegmentAgainstConvexPolygon(s0, s1, sh.poly2D);
								if (interval) coveredIntervals.push(interval);
							}
						}
					}
				}

				if (coveredIntervals.length === 0) {
					keptIndices.push(e);
					continue;
				}

				const merged = mergeIntervals(coveredIntervals);
				let totalCoveredFraction = 0;
				for (const [c0, c1] of merged) totalCoveredFraction += (c1 - c0);

				if (totalCoveredFraction >= 0.995) {
					fullyCoveredSegmentsRemoved += 1;
					edgesSuppressedBySolidOwnership += 1;
				} else if (totalCoveredFraction > 0.005) {
					partiallyClippedSegments += 1;
					const uncovered = computeUncoveredIntervals(merged);
					resultingSubsegments += uncovered.length;
					const lx0 = edgeSet.positions[e * 6];
					const ly0 = edgeSet.positions[e * 6 + 1];
					const lz0 = edgeSet.positions[e * 6 + 2];
					const lx1 = edgeSet.positions[e * 6 + 3];
					const ly1 = edgeSet.positions[e * 6 + 4];
					const lz1 = edgeSet.positions[e * 6 + 5];

					const subPos: number[] = [];
					for (const [u0, u1] of uncovered) {
						subPos.push(
							lx0 + u0 * (lx1 - lx0), ly0 + u0 * (ly1 - ly0), lz0 + u0 * (lz1 - lz0),
							lx0 + u1 * (lx1 - lx0), ly0 + u1 * (ly1 - ly0), lz0 + u1 * (lz1 - lz0)
						);
					}
					extraOccurrences.push({ occ, positions: subPos });
				} else {
					keptIndices.push(e);
				}
			}

			if (keptIndices.length > 0) {
				const isFull = keptIndices.length === hardEdgeIndices.length;
				const sig = isFull ? '__FULL__' : keptIndices.join(',');
				const list = occurrenceRows.get(sig) || [];
				list.push(occ);
				occurrenceRows.set(sig, list);
			}
		}

		for (const [sig, occurrences] of occurrenceRows) {
			const keptIndices = sig === '__FULL__' ? hardEdgeIndices : sig.split(',').map(Number);
			const positions = new Float32Array(keptIndices.length * 6);
			const flags = new Uint8Array(keptIndices.length);
			for (let i = 0; i < keptIndices.length; i += 1) {
				positions.set(edgeSet.positions.subarray(keptIndices[i] * 6, keptIndices[i] * 6 + 6), i * 6);
				flags[i] = edgeSet.flags[keptIndices[i]];
			}
			const matrices = new Float32Array(occurrences.length * 16);
			const worldBox = new Box3();
			const localBox = new Box3(new Vector3(...edgeSet.worldBounds.min), new Vector3(...edgeSet.worldBounds.max));
			for (let i = 0; i < occurrences.length; i += 1) {
				const occ = occurrences[i];
				matrices.set(edgeSet.matrices.subarray(occ * 16, occ * 16 + 16), i * 16);
				mat.fromArray(edgeSet.matrices, occ * 16);
				worldBox.union(localBox.clone().applyMatrix4(mat));
			}
			solidEdgeSets.push({
				sourceMeshIndex: edgeSet.sourceMeshIndex,
				definitionIndex: edgeSet.definitionIndex,
				key: edgeSet.key,
				positions,
				flags,
				matrices,
				occurrenceHandles: edgeSet.occurrenceHandles ? occurrences.map((o) => edgeSet.occurrenceHandles![o]) : undefined,
				occurrenceHierarchyIndices: edgeSet.occurrenceHierarchyIndices
					? Uint32Array.from(occurrences.map((o) => edgeSet.occurrenceHierarchyIndices![o]))
					: undefined,
				worldBounds: {
					min: [worldBox.min.x, worldBox.min.y, worldBox.min.z],
					max: [worldBox.max.x, worldBox.max.y, worldBox.max.z]
				}
			});
			solidEdgeSegments += keptIndices.length * occurrences.length;
			typedArrayBytesSolid += positions.byteLength + flags.byteLength + matrices.byteLength;
		}

		for (const extra of extraOccurrences) {
			const occMat = edgeSet.matrices.subarray(extra.occ * 16, extra.occ * 16 + 16);
			const positions = new Float32Array(extra.positions);
			const flags = new Uint8Array(extra.positions.length / 6).fill(0);
			const matrices = new Float32Array(occMat);
			solidEdgeSets.push({
				sourceMeshIndex: edgeSet.sourceMeshIndex,
				definitionIndex: edgeSet.definitionIndex,
				key: edgeSet.key,
				positions,
				flags,
				matrices,
				occurrenceHandles: edgeSet.occurrenceHandles ? [edgeSet.occurrenceHandles[extra.occ]] : undefined,
				occurrenceHierarchyIndices: edgeSet.occurrenceHierarchyIndices
					? Uint32Array.of(edgeSet.occurrenceHierarchyIndices[extra.occ])
					: undefined,
				worldBounds: edgeSet.worldBounds
			});
			solidEdgeSegments += extra.positions.length / 6;
			typedArrayBytesSolid += positions.byteLength + flags.byteLength + matrices.byteLength;
		}
	}

	const clipMs = performance.now() - clipStart;
	const totalEdgePrepMs = performance.now() - edgePrepStart;

	return {
		solidEdgeSets,
		metrics: {
			sourceEdgeSegments,
			hardSourceEdgeSegments,
			solidEdgeSegments,
			protectedPrimaryEdges,
			protectedSecondaryEdges,
			suppressedInternalEdges,
			clippedInternalEdges,
			edgesSuppressedBySolidOwnership,
			fullVisibleFastPath,
			fullySuppressedFastPath,
			partialCandidates,
			fullyCoveredSegmentsRemoved,
			partiallyClippedSegments,
			resultingSubsegments,
			visibilitySummaryMs,
			patchLookupMs,
			clipMs,
			totalEdgePrepMs,
			typedArrayBytesFull,
			typedArrayBytesSolid
		}
	};
}

export function traceSolidCoplanarPick(
	scene: PreparedRuntimeGeometryScene,
	occurrenceHandle?: string,
	triangleIndex = 0
) {
	const meshes = new Map(scene.meshes.map((mesh) => [mesh.sourceMeshIndex, mesh]));
	let targetGroup: PreparedRuntimeGeometryGroup | undefined;
	let targetOcc = 0;

	if (occurrenceHandle) {
		for (const group of scene.groups) {
			if (group.occurrenceHandles) {
				const occIdx = group.occurrenceHandles.indexOf(occurrenceHandle);
				if (occIdx >= 0) {
					targetGroup = group;
					targetOcc = occIdx;
					break;
				}
			}
		}
	}

	if (!targetGroup && scene.groups.length > 0) {
		targetGroup = scene.groups[0];
		targetOcc = 0;
	}

	if (!targetGroup) return null;

	const mesh = meshes.get(targetGroup.sourceMeshIndex);
	if (!mesh) return null;

	const tIdx = Math.min(triangleIndex, Math.max(0, Math.floor(targetGroup.indices.length / 3) - 1));
	const i0 = targetGroup.indices[tIdx * 3];
	const i1 = targetGroup.indices[tIdx * 3 + 1];
	const i2 = targetGroup.indices[tIdx * 3 + 2];
	const lv0 = [mesh.positions[i0 * 3], mesh.positions[i0 * 3 + 1], mesh.positions[i0 * 3 + 2]] as [number, number, number];
	const lv1 = [mesh.positions[i1 * 3], mesh.positions[i1 * 3 + 1], mesh.positions[i1 * 3 + 2]] as [number, number, number];
	const lv2 = [mesh.positions[i2 * 3], mesh.positions[i2 * 3 + 1], mesh.positions[i2 * 3 + 2]] as [number, number, number];

	const mat = new Matrix4().fromArray(targetGroup.matrices, targetOcc * 16);
	const wv0 = point(lv0).applyMatrix4(mat).toArray() as [number, number, number];
	const wv1 = point(lv1).applyMatrix4(mat).toArray() as [number, number, number];
	const wv2 = point(lv2).applyMatrix4(mat).toArray() as [number, number, number];
	const norm = triNormal(wv0, wv1, wv2);
	const cp = canonicalPlane(norm, point(wv0));

	const suppression = scene.solidCoplanarSuppressions?.find(
		(s) =>
			s.loser.definitionIndex === targetGroup!.definitionIndex &&
			s.loser.sourceMeshIndex === targetGroup!.sourceMeshIndex &&
			(occurrenceHandle ? s.loser.occurrenceHandle === occurrenceHandle : true)
	);

	const isSolidActive = isSourceTriangleSolidVisible(targetGroup, tIdx);

	return {
		candidateId: `${targetGroup.sourceMeshIndex}:${targetGroup.definitionIndex}:${tIdx}:${targetOcc}`,
		definitionIndex: targetGroup.definitionIndex,
		sourceMeshIndex: targetGroup.sourceMeshIndex,
		materialName: targetGroup.materialName || `${targetGroup.materialIndex ?? ''}`,
		renderSide: targetGroup.renderSide || 'front',
		partKey: targetGroup.key,
		worldPlaneKey: cp.key,
		worldNormal: [cp.normal.x, cp.normal.y, cp.normal.z] as [number, number, number],
		worldPlaneDistance: cp.dist,
		occurrenceHierarchyDepth: targetGroup.occurrenceHierarchyDepths?.[targetOcc] ?? 0,
		sourceFaceArea: targetGroup.sourceFaceAreasByTriangle?.[tIdx] ?? 0,
		wasEvaluatedByExactDedupe: true,
		wasEvaluatedByResolver: true,
		resolverResult: isSolidActive ? 'retained' : 'suppressed',
		suppressionWinner: suppression
			? {
					definitionIndex: suppression.winner.definitionIndex,
					sourceMeshIndex: suppression.winner.sourceMeshIndex,
					materialName: undefined,
					reason: suppression.reason,
					confidence: suppression.confidence,
					coverage: suppression.overlapRatio
				}
			: undefined,
		failureReasonIfRetained: isSolidActive ? 'retained: insufficient shell coverage or independent detail' : undefined
	};
}

export function isSourceTriangleSolidVisible(
	group: PreparedRuntimeGeometryGroup,
	sourceTriangleIndex: number
): boolean {
	if (group.solidSourceTriangleIndices === undefined) {
		return true;
	}
	return group.solidSourceTriangleIndices.includes(sourceTriangleIndex);
}

function eligibleOpaqueGroup(group: PreparedRuntimeGeometryGroup) {
	return (group.opacity ?? group.baseColorRgba?.[3] ?? 1) >= 1 && !group.fallbackText;
}

function localTriangle(group: PreparedRuntimeGeometryGroup, positions: Float32Array, sourceUvs: Float32Array | undefined, triangleIndex: number): SolidCoplanarTriangle {
	const vertices = triangleVertices(group, positions, triangleIndex);
	const uvs = group.batchUvs || sourceUvs ? triangleUvs(group, group.batchUvs || sourceUvs!, triangleIndex) : undefined;
	return evidence(group, triangleIndex, 0, vertices, uvs);
}

function evidence(group: PreparedRuntimeGeometryGroup, triangleIndex: number, occurrence: number, vertices: SolidCoplanarTriangle['vertices'], uvs?: SolidCoplanarTriangle['uvs']): SolidCoplanarTriangle {
	return {
		id: `${group.sourceMeshIndex}:${group.definitionIndex}:${triangleIndex}:${occurrence}`,
		vertices,
		uvs,
		materialKey: `${group.materialIndex ?? group.materialId ?? group.materialName ?? ''}`,
		textureKey: group.textureAsset || group.textureName,
		opacity: group.opacity ?? group.baseColorRgba?.[3] ?? 1,
		renderSide: group.renderSide || (group.isBackFace ? 'back' : 'double'),
		definitionIndex: group.definitionIndex,
		hierarchyDepth: group.occurrenceHierarchyDepths?.[occurrence] ?? 0,
		sourceSurfaceArea: group.sourceFaceAreasByTriangle?.[triangleIndex],
		partKey: group.key,
		intentionalOverlay: ['doors', 'windows', 'openings', 'railings'].includes(group.key)
	};
}

function triangleVertices(group: PreparedRuntimeGeometryGroup, positions: Float32Array, triangleIndex: number): SolidCoplanarTriangle['vertices'] {
	const i0 = group.indices[triangleIndex * 3];
	const i1 = group.indices[triangleIndex * 3 + 1];
	const i2 = group.indices[triangleIndex * 3 + 2];
	return [
		[positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]],
		[positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]],
		[positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]]
	];
}

function triangleUvs(group: PreparedRuntimeGeometryGroup, uvs: Float32Array, triangleIndex: number): NonNullable<SolidCoplanarTriangle['uvs']> {
	const i0 = group.indices[triangleIndex * 3];
	const i1 = group.indices[triangleIndex * 3 + 1];
	const i2 = group.indices[triangleIndex * 3 + 2];
	return [
		[uvs[i0 * 2], uvs[i0 * 2 + 1]],
		[uvs[i1 * 2], uvs[i1 * 2 + 1]],
		[uvs[i2 * 2], uvs[i2 * 2 + 1]]
	];
}

function canonicalNormal(triangle: SolidCoplanarTriangle) {
	return triangleNormal(triangle.vertices);
}

function triangleNormal(vertices: SolidCoplanarTriangle['vertices']) {
	return point(vertices[1]).sub(point(vertices[0])).cross(point(vertices[2]).sub(point(vertices[0]))).normalize();
}

function triNormal(v0: [number, number, number], v1: [number, number, number], v2: [number, number, number]) {
	return point(v1).sub(point(v0)).cross(point(v2).sub(point(v0))).normalize();
}

function coplanarRelation(left: SolidCoplanarTriangle, right: SolidCoplanarTriangle, decodedPrecision: number) {
	const leftNormal = triangleNormal(left.vertices);
	const rightNormal = triangleNormal(right.vertices);
	if (Math.abs(leftNormal.dot(rightNormal)) < 0.99999) return undefined;
	const separation = Math.abs(leftNormal.dot(point(right.vertices[0]).sub(point(left.vertices[0]))));
	const separationClass = classifyPlaneSeparation(separation, decodedPrecision);
	if (separationClass === 'separate') return undefined;
	const axis = dominantAxis(leftNormal);
	const left2 = left.vertices.map((vertex) => project(vertex, axis));
	const right2 = right.vertices.map((vertex) => project(vertex, axis));
	const leftArea = polygonArea(left2);
	const rightArea = polygonArea(right2);
	if (leftArea < 1e-12 || rightArea < 1e-12) return undefined;
	const overlapArea = polygonArea(clipConvex(left2, right2));
	const leftEvidenceArea = left.sourceSurfaceArea || leftArea;
	const rightEvidenceArea = right.sourceSurfaceArea || rightArea;
	const smaller = leftEvidenceArea <= rightEvidenceArea ? left : right;
	const larger = leftEvidenceArea <= rightEvidenceArea ? right : left;
	return {
		smaller,
		larger,
		overlapArea,
		leftArea,
		rightArea,
		overlapRatio: overlapArea / Math.min(leftArea, rightArea),
		areaRatio: Math.max(leftArea, rightArea) / Math.min(leftArea, rightArea),
		separationClass
	};
}

function dominantAxis(normal: Vector3 | { x: number; y: number; z: number }): number {
	const ax = Math.abs(normal.x);
	const ay = Math.abs(normal.y);
	const az = Math.abs(normal.z);
	if (ax >= ay && ax >= az) return 0;
	if (ay >= ax && ay >= az) return 1;
	return 2;
}

function project(vertex: readonly number[], axis: number): [number, number] {
	return axis === 0 ? [vertex[1], vertex[2]] : axis === 1 ? [vertex[0], vertex[2]] : [vertex[0], vertex[1]];
}

export function polygonArea(polygon: readonly [number, number][]) {
	let area = 0;
	for (let index = 0; index < polygon.length; index += 1) {
		const current = polygon[index];
		const next = polygon[(index + 1) % polygon.length];
		area += current[0] * next[1] - next[0] * current[1];
	}
	return Math.abs(area) / 2;
}

export function clipConvex(subjectInput: readonly [number, number][], clipInput: readonly [number, number][]) {
	let output = [...subjectInput];
	const orientation = signedArea(clipInput) >= 0 ? 1 : -1;
	for (let edge = 0; edge < clipInput.length; edge += 1) {
		const a = clipInput[edge];
		const b = clipInput[(edge + 1) % clipInput.length];
		const input = output;
		output = [];
		for (let index = 0; index < input.length; index += 1) {
			const current = input[index];
			const previous = input[(index + input.length - 1) % input.length];
			const currentInside = side(a, b, current) * orientation >= -1e-12;
			const previousInside = side(a, b, previous) * orientation >= -1e-12;
			if (currentInside) {
				if (!previousInside) output.push(intersection(previous, current, a, b));
				output.push(current);
			} else if (previousInside) output.push(intersection(previous, current, a, b));
		}
	}
	return output;
}

function signedArea(polygon: readonly [number, number][]) {
	let area = 0;
	for (let index = 0; index < polygon.length; index += 1) area += side([0, 0], polygon[index], polygon[(index + 1) % polygon.length]);
	return area / 2;
}

function side(a: readonly number[], b: readonly number[], pointValue: readonly number[]) {
	return (b[0] - a[0]) * (pointValue[1] - a[1]) - (b[1] - a[1]) * (pointValue[0] - a[0]);
}

function intersection(start: [number, number], end: [number, number], a: [number, number], b: [number, number]): [number, number] {
	const sx = end[0] - start[0];
	const sy = end[1] - start[1];
	const ex = b[0] - a[0];
	const ey = b[1] - a[1];
	const denominator = sx * ey - sy * ex;
	if (Math.abs(denominator) < 1e-15) return end;
	const t = ((a[0] - start[0]) * ey - (a[1] - start[1]) * ex) / denominator;
	return [start[0] + t * sx, start[1] + t * sy];
}

function segmentIntersectionX(p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number]): number | null {
	const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
	if (Math.abs(d) < 1e-12) return null;
	const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / d;
	const u = -((p1[0] - p2[0]) * (p1[1] - p3[1]) - (p1[1] - p2[1]) * (p1[0] - p3[0])) / d;
	if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
		return p1[0] + t * (p2[0] - p1[0]);
	}
	return null;
}

export function computePolygonUnionArea(polygons: readonly (readonly [number, number][])[]): number {
	if (polygons.length === 0) return 0;
	if (polygons.length === 1) return polygonArea(polygons[0]);

	type Edge = { p1: [number, number]; p2: [number, number]; minX: number; maxX: number };
	const edges: Edge[] = [];
	const xCoords: number[] = [];

	for (const poly of polygons) {
		for (let i = 0; i < poly.length; i++) {
			const p1 = poly[i];
			const p2 = poly[(i + 1) % poly.length];
			xCoords.push(p1[0]);
			const minX = Math.min(p1[0], p2[0]);
			const maxX = Math.max(p1[0], p2[0]);
			if (maxX - minX > 1e-9) {
				edges.push({ p1: [p1[0], p1[1]], p2: [p2[0], p2[1]], minX, maxX });
			}
		}
	}

	for (let i = 0; i < edges.length; i++) {
		for (let j = i + 1; j < edges.length; j++) {
			const e1 = edges[i];
			const e2 = edges[j];
			if (e1.maxX < e2.minX - 1e-9 || e2.maxX < e1.minX - 1e-9) continue;
			const ix = segmentIntersectionX(e1.p1, e1.p2, e2.p1, e2.p2);
			if (ix !== null) xCoords.push(ix);
		}
	}

	xCoords.sort((a, b) => a - b);
	const uniqueX: number[] = [];
	for (const x of xCoords) {
		if (uniqueX.length === 0 || x - uniqueX[uniqueX.length - 1] > 1e-8) {
			uniqueX.push(x);
		}
	}

	let totalArea = 0;

	for (let i = 0; i < uniqueX.length - 1; i++) {
		const x0 = uniqueX[i];
		const x1 = uniqueX[i + 1];
		const dx = x1 - x0;
		if (dx < 1e-9) continue;
		const xMid = (x0 + x1) / 2;

		const intervals: Array<[number, number]> = [];

		for (const poly of polygons) {
			const yIntersects: number[] = [];
			for (let e = 0; e < poly.length; e++) {
				const p1 = poly[e];
				const p2 = poly[(e + 1) % poly.length];
				const minX = Math.min(p1[0], p2[0]);
				const maxX = Math.max(p1[0], p2[0]);
				if (xMid >= minX - 1e-9 && xMid <= maxX + 1e-9 && maxX - minX > 1e-9) {
					const t = (xMid - p1[0]) / (p2[0] - p1[0]);
					yIntersects.push(p1[1] + t * (p2[1] - p1[1]));
				}
			}
			if (yIntersects.length >= 2) {
				yIntersects.sort((a, b) => a - b);
				intervals.push([yIntersects[0], yIntersects[yIntersects.length - 1]]);
			}
		}

		if (intervals.length === 0) continue;

		intervals.sort((a, b) => a[0] - b[0]);
		let mergedLength = 0;
		let curStart = intervals[0][0];
		let curEnd = intervals[0][1];

		for (let k = 1; k < intervals.length; k++) {
			const next = intervals[k];
			if (next[0] <= curEnd + 1e-9) {
				curEnd = Math.max(curEnd, next[1]);
			} else {
				mergedLength += Math.max(0, curEnd - curStart);
				curStart = next[0];
				curEnd = next[1];
			}
		}
		mergedLength += Math.max(0, curEnd - curStart);

		totalArea += dx * mergedLength;
	}

	return totalArea;
}
