import {
	Box3,
	BufferAttribute,
	BufferGeometry,
	Float32BufferAttribute,
	InstancedMesh,
	Matrix4,
	Sphere,
	Vector3,
	type Material
} from 'three';

export type PreparedSurfaceLocalBounds = {
	min: [number, number, number];
	max: [number, number, number];
	sphereCenter: [number, number, number];
	sphereRadius: number;
};

export type PreparedSurfaceWorldBounds = {
	min: [number, number, number];
	max: [number, number, number];
};

export type PreparedInstancedSurfaceInput = {
	positions: Float32Array;
	normals?: Float32Array;
	uvs?: Float32Array;
	indices: Uint16Array | Uint32Array;
	material: Material;
	instanceCount: number;
	localBounds?: PreparedSurfaceLocalBounds;
	worldBounds?: PreparedSurfaceWorldBounds;
};

export type PreparedSurfaceGroupLike = {
	indices: Uint16Array | Uint32Array;
	matrices: Float32Array;
	localBounds?: PreparedSurfaceLocalBounds;
	worldBounds?: PreparedSurfaceWorldBounds;
};

export type PreparedSurfaceBuffers = {
	positions: Float32Array;
	normals?: Float32Array;
	uvs?: Float32Array;
};

export type PreparedInstancedSurfaceGroupResult<Group, Source, SurfaceMaterial extends Material = Material> = {
	group: Group;
	groupIndex: number;
	source: Source;
	buffers: PreparedSurfaceBuffers;
	material: SurfaceMaterial;
	instanceCount: number;
	geometry: BufferGeometry;
	fullIndex: BufferAttribute;
	mesh: InstancedMesh;
};

export type PreparedInstancedSurfaceGroupsInput<Group extends PreparedSurfaceGroupLike, Source, SurfaceMaterial extends Material = Material> = {
	groups: readonly Group[];
	findSource: (group: Group, groupIndex: number) => Source | null | undefined;
	resolveBuffers: (group: Group, source: Source, groupIndex: number) => PreparedSurfaceBuffers;
	resolveMaterial: (group: Group, groupIndex: number) => SurfaceMaterial;
	includeGroup?: (group: Group, source: Source, buffers: PreparedSurfaceBuffers, groupIndex: number) => boolean;
	shouldContinue?: (groupIndex: number) => boolean;
	skipEmptyInstances?: boolean;
	populateMatrices?: boolean;
};

/**
 * Builds the neutral indexed surface objects used by both the prepared-scene
 * viewport and the legacy prepared-runtime adapter. Materials, scene policy,
 * instance upload scheduling, and domain overlays remain caller-owned.
 */
export function createPreparedInstancedSurface(input: PreparedInstancedSurfaceInput) {
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new Float32BufferAttribute(input.positions, 3));
	if (input.normals?.length === input.positions.length) geometry.setAttribute('normal', new Float32BufferAttribute(input.normals, 3));
	if (input.uvs?.length === (input.positions.length / 3) * 2) geometry.setAttribute('uv', new Float32BufferAttribute(input.uvs, 2));

	const fullIndex = new BufferAttribute(input.indices, 1);
	geometry.setIndex(fullIndex);
	if (input.localBounds) {
		geometry.boundingBox = new Box3(new Vector3(...input.localBounds.min), new Vector3(...input.localBounds.max));
		geometry.boundingSphere = new Sphere(new Vector3(...input.localBounds.sphereCenter), input.localBounds.sphereRadius);
	}

	const mesh = new InstancedMesh(geometry, input.material, input.instanceCount);
	mesh.frustumCulled = true;
	if (input.worldBounds) {
		mesh.boundingBox = new Box3(new Vector3(...input.worldBounds.min), new Vector3(...input.worldBounds.max));
		mesh.boundingSphere = mesh.boundingBox.getBoundingSphere(new Sphere());
	}
	return { geometry, fullIndex, mesh };
}

/**
 * Resolves and constructs the neutral base surface for each prepared group.
 * Callers own the source/material policies, mesh attachment, runtime records,
 * and any staged upload cadence between yielded groups.
 */
export function* buildPreparedInstancedSurfaceGroups<Group extends PreparedSurfaceGroupLike, Source, SurfaceMaterial extends Material = Material>(
	input: PreparedInstancedSurfaceGroupsInput<Group, Source, SurfaceMaterial>
): Generator<PreparedInstancedSurfaceGroupResult<Group, Source, SurfaceMaterial>, void, void> {
	for (let groupIndex = 0; groupIndex < input.groups.length; groupIndex++) {
		if (input.shouldContinue && !input.shouldContinue(groupIndex)) return;
		const group = input.groups[groupIndex];
		const source = input.findSource(group, groupIndex);
		if (source === null || source === undefined) continue;
		const buffers = input.resolveBuffers(group, source, groupIndex);
		if (input.includeGroup && !input.includeGroup(group, source, buffers, groupIndex)) continue;

		// Resolve materials before the empty-instance check to preserve caller-visible
		// material registration and cache behavior for prepared groups with no instances.
		const material = input.resolveMaterial(group, groupIndex);
		const instanceCount = Math.floor(group.matrices.length / 16);
		if (input.skipEmptyInstances && instanceCount === 0) continue;
		const { geometry, fullIndex, mesh } = createPreparedInstancedSurface({
			...buffers,
			indices: group.indices,
			material,
			instanceCount,
			localBounds: group.localBounds,
			worldBounds: group.worldBounds
		});
		if (input.populateMatrices) {
			writePreparedInstanceMatrices(mesh, group.matrices, 0, instanceCount);
			mesh.instanceMatrix.needsUpdate = true;
		}
		yield { group, groupIndex, source, buffers, material, instanceCount, geometry, fullIndex, mesh };
	}
}

/** Writes one caller-selected matrix range without changing count or upload state. */
export function writePreparedInstanceMatrices(
	target: { setMatrixAt: (index: number, matrix: Matrix4) => void },
	matrices: Float32Array,
	start = 0,
	end = Math.floor(matrices.length / 16)
) {
	const matrix = new Matrix4();
	for (let index = start; index < end; index++) {
		target.setMatrixAt(index, matrix.fromArray(matrices, index * 16));
	}
}
