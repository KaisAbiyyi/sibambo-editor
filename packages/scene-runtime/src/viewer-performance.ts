import { BatchedMesh, InstancedMesh, LineSegments, Material, Mesh, Object3D, Scene, Vector3, type Camera } from 'three';

export type PerspectiveClipBounds = {
	min: { x: number; y: number; z: number };
	max: { x: number; y: number; z: number };
};

type CoplanarPoint = { x: number; y: number; z: number };

export type CoplanarDiagnostics = {
	trianglesInspected: number;
	exactDuplicates: number;
	nearCoplanarCandidates: number;
	samePlaneDifferentMaterialCandidates: number;
};

export function createQuantizedCoplanarDiagnostics({
	positionQuantum = 0.0001,
	planeQuantum = 0.001,
	spatialCell = 0.25
}: { positionQuantum?: number; planeQuantum?: number; spatialCell?: number } = {}) {
	type Bucket = { count: number; materials: Set<number> };
	const exactBuckets = new Map<string, Bucket>();
	const planeBuckets = new Map<string, Bucket>();
	let trianglesInspected = 0;
	const quantize = (value: number, quantum: number) => Math.round(value / quantum);
	const pointKey = (point: CoplanarPoint, quantum: number) =>
		`${quantize(point.x, quantum)},${quantize(point.y, quantum)},${quantize(point.z, quantum)}`;
	const addBucket = (buckets: Map<string, Bucket>, key: string, material: number) => {
		const bucket = buckets.get(key) ?? { count: 0, materials: new Set<number>() };
		bucket.count += 1;
		bucket.materials.add(material);
		buckets.set(key, bucket);
	};

	return {
		add(a: CoplanarPoint, b: CoplanarPoint, c: CoplanarPoint, material: number) {
			const ab = new Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
			const ac = new Vector3(c.x - a.x, c.y - a.y, c.z - a.z);
			const normal = ab.cross(ac);
			if (normal.lengthSq() < 1e-18) return;
			normal.normalize();
			const firstSignificant = Math.abs(normal.x) > 1e-9 ? normal.x : Math.abs(normal.y) > 1e-9 ? normal.y : normal.z;
			if (firstSignificant < 0) normal.multiplyScalar(-1);
			const planeDistance = -(normal.x * a.x + normal.y * a.y + normal.z * a.z);
			const center = {
				x: (a.x + b.x + c.x) / 3,
				y: (a.y + b.y + c.y) / 3,
				z: (a.z + b.z + c.z) / 3
			};
			const exactKey = [pointKey(a, positionQuantum), pointKey(b, positionQuantum), pointKey(c, positionQuantum)].sort().join('|');
			const planeKey = [
				quantize(normal.x, planeQuantum), quantize(normal.y, planeQuantum), quantize(normal.z, planeQuantum),
				quantize(planeDistance, planeQuantum), pointKey(center, spatialCell)
			].join(',');
			addBucket(exactBuckets, exactKey, material);
			addBucket(planeBuckets, planeKey, material);
			trianglesInspected += 1;
		},
		finish(): CoplanarDiagnostics {
			const exactDuplicates = [...exactBuckets.values()].reduce((sum, bucket) => sum + Math.max(0, bucket.count - 1), 0);
			const planeCandidates = [...planeBuckets.values()].reduce((sum, bucket) => sum + Math.max(0, bucket.count - 1), 0);
			const samePlaneDifferentMaterialCandidates = [...planeBuckets.values()].reduce(
				(sum, bucket) => sum + (bucket.materials.size > 1 ? bucket.count - 1 : 0), 0
			);
			return {
				trianglesInspected,
				exactDuplicates,
				nearCoplanarCandidates: Math.max(0, planeCandidates - exactDuplicates),
				samePlaneDifferentMaterialCandidates
			};
		}
	};
}

export function computePerspectiveClipPlanes(
	position: { x: number; y: number; z: number },
	target: { x: number; y: number; z: number },
	bounds: PerspectiveClipBounds
) {
	const cameraPosition = new Vector3(position.x, position.y, position.z);
	const direction = new Vector3(target.x, target.y, target.z).sub(cameraPosition);
	if (direction.lengthSq() < 1e-12) direction.set(0, 0, -1);
	direction.normalize();
	let nearestDepth = Infinity;
	let farthestDepth = 0;
	let crossesCameraPlane = false;
	for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
		const depth = new Vector3(x, y, z).sub(cameraPosition).dot(direction);
		if (depth <= 0) crossesCameraPlane = true;
		else nearestDepth = Math.min(nearestDepth, depth);
		farthestDepth = Math.max(farthestDepth, depth);
	}
	const modelSpan = Math.max(
		bounds.max.x - bounds.min.x,
		bounds.max.y - bounds.min.y,
		bounds.max.z - bounds.min.z,
		0.001
	);
	if (!Number.isFinite(nearestDepth)) nearestDepth = 0;
	const minimumNear = Math.max(0.01, Math.min(modelSpan * 0.001, 0.05));
	const cameraDistanceToTarget = cameraPosition.distanceTo(new Vector3(target.x, target.y, target.z));
	const near = crossesCameraPlane
		? Math.max(minimumNear, Math.min(nearestDepth * 0.35, cameraDistanceToTarget * 0.15))
		: nearestDepth <= minimumNear
			? minimumNear
			: Math.max(minimumNear, nearestDepth * 0.35);
	const far = Math.max(near + Math.max(modelSpan * 0.1, 1), farthestDepth * 1.15);
	return { near, far, nearestDepth, farthestDepth, farNearRatio: far / near, modelSpan };
}

export function perspectiveDepthStepMeters(distance: number, near: number, far: number, depthBits = 24) {
	if (!(distance > 0) || !(near > 0) || !(far > near) || !(depthBits > 0)) return Infinity;
	const depthLevels = 2 ** depthBits - 1;
	return distance * distance * (far - near) / (far * near * depthLevels);
}

export function isPerspectiveSeparationStable(
	separationMeters: number,
	distance: number,
	near: number,
	far: number
) {
	return separationMeters >= perspectiveDepthStepMeters(distance, near, far) * 4;
}

export type FramePerformance = {
	frames: number;
	averageFps: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	worstMs: number;
	longFrames: number;
};

export type ScenePerformance = {
	objectCount: number;
	meshCount: number;
	instancedMeshCount: number;
	batchedMeshCount: number;
	lineSegmentCount: number;
	instancedLineSegmentCount: number;
	edgeSegmentCount: number;
	geometryCount: number;
	materialCount: number;
	uniqueTriangles: number;
	instanceCount: number;
};

type RendererLike = {
	render(scene: Scene, camera: Camera): unknown;
	info?: { render?: { calls?: number; triangles?: number }; memory?: { geometries?: number; textures?: number } };
};

export function percentile(samples: number[], fraction: number) {
	if (!samples.length) return 0;
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

export function summarizeFrames(frameTimes: number[]): FramePerformance {
	const total = frameTimes.reduce((sum, value) => sum + value, 0);
	return {
		frames: frameTimes.length,
		averageFps: total > 0 ? 1000 / (total / frameTimes.length) : 0,
		p50Ms: percentile(frameTimes, 0.5),
		p95Ms: percentile(frameTimes, 0.95),
		p99Ms: percentile(frameTimes, 0.99),
		worstMs: Math.max(0, ...frameTimes),
		longFrames: frameTimes.filter((value) => value > 33).length
	};
}

export function collectScenePerformance(root: Object3D): ScenePerformance {
	let objectCount = 0;
	let meshCount = 0;
	let instancedMeshCount = 0;
	let batchedMeshCount = 0;
	let lineSegmentCount = 0;
	let instancedLineSegmentCount = 0;
	let edgeSegmentCount = 0;
	let uniqueTriangles = 0;
	let instanceCount = 0;
	const geometries = new Set<string>();
	const materials = new Set<string>();
	root.traverse((object) => {
		objectCount += 1;
		if (object instanceof LineSegments) {
			lineSegmentCount += 1;
			geometries.add(object.geometry.uuid);
			const lineMaterials = Array.isArray(object.material) ? object.material : [object.material];
			for (const material of lineMaterials) if (material instanceof Material) materials.add(material.uuid);
			const instanced = Boolean((object as unknown as { isInstancedMesh?: boolean }).isInstancedMesh);
			const instances = instanced ? Number((object as unknown as { count?: number }).count || 1) : 1;
			if (instanced) instancedLineSegmentCount += 1;
			edgeSegmentCount += (object.geometry.getAttribute('position')?.count || 0) / 2 * instances;
			return;
		}
		if (!(object instanceof Mesh)) return;
		meshCount += 1;
		geometries.add(object.geometry.uuid);
		const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
		for (const material of objectMaterials) if (material instanceof Material) materials.add(material.uuid);
		const triangles = object.geometry.index ? object.geometry.index.count / 3 : object.geometry.getAttribute('position')?.count / 3 || 0;
		uniqueTriangles += triangles;
		if (object instanceof InstancedMesh) {
			instancedMeshCount += 1;
			instanceCount += object.count;
		} else if (object instanceof BatchedMesh) {
			batchedMeshCount += 1;
			instanceCount += object.instanceCount;
		} else instanceCount += 1;
	});
	return {
		objectCount, meshCount, instancedMeshCount, batchedMeshCount, lineSegmentCount, instancedLineSegmentCount, edgeSegmentCount,
		geometryCount: geometries.size, materialCount: materials.size, uniqueTriangles, instanceCount
	};
}

export async function benchmarkDeterministicOrbit(
	renderer: RendererLike,
	scene: Scene,
	camera: Camera,
	target: Vector3,
	durationMs = 1800
): Promise<FramePerformance & { drawCalls: number | null; renderedTriangles: number | null }> {
	const original = camera.position.clone();
	const relative = original.clone().sub(target);
	const radius = Math.max(Math.hypot(relative.x, relative.z), 0.001);
	const y = relative.y;
	const started = performance.now();
	let previous = started;
	const frames: number[] = [];
	await new Promise<void>((resolve) => {
		const step = (now: number) => {
			const elapsed = now - started;
			if (frames.length) frames.push(now - previous);
			else frames.push(0);
			previous = now;
			const angle = elapsed / durationMs * Math.PI * 2;
			camera.position.set(target.x + Math.cos(angle) * radius, target.y + y, target.z + Math.sin(angle) * radius);
			camera.lookAt(target);
			renderer.render(scene, camera);
			if (elapsed >= durationMs) resolve();
			else requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
	camera.position.copy(original);
	camera.lookAt(target);
	frames.shift();
	return {
		...summarizeFrames(frames),
		drawCalls: renderer.info?.render?.calls ?? null,
		renderedTriangles: renderer.info?.render?.triangles ?? null
	};
}

export async function benchmarkDeterministicPan(
	renderer: RendererLike,
	scene: Scene,
	camera: Camera,
	target: Vector3,
	durationMs = 1800
): Promise<FramePerformance & { drawCalls: number | null; renderedTriangles: number | null }> {
	const originalPosition = camera.position.clone();
	const originalTarget = target.clone();
	const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
	const span = Math.max(camera.position.distanceTo(target) * 0.12, 0.25);
	const started = performance.now();
	let previous = started;
	const frames: number[] = [];
	await new Promise<void>((resolve) => {
		const step = (now: number) => {
			const elapsed = now - started;
			if (frames.length) frames.push(now - previous);
			else frames.push(0);
			previous = now;
			const offset = right.clone().multiplyScalar(Math.sin(elapsed / durationMs * Math.PI * 2) * span);
			camera.position.copy(originalPosition).add(offset);
			camera.lookAt(originalTarget.clone().add(offset));
			renderer.render(scene, camera);
			if (elapsed >= durationMs) resolve();
			else requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
	camera.position.copy(originalPosition);
	camera.lookAt(originalTarget);
	frames.shift();
	return {
		...summarizeFrames(frames),
		drawCalls: renderer.info?.render?.calls ?? null,
		renderedTriangles: renderer.info?.render?.triangles ?? null
	};
}
