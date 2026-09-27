import { BufferAttribute, Matrix4, type BufferGeometry, type InstancedMesh, type Material, type Plane, type Vector3 } from 'three';

export function prepareIndexedGeometry(
	geometry: BufferGeometry,
	indices: Uint16Array | Uint32Array,
	computeNormalsFromGeometry: boolean
) {
	geometry.setIndex(new BufferAttribute(indices, 1));
	if (computeNormalsFromGeometry) {
		geometry.deleteAttribute('normal');
		geometry.computeVertexNormals();
	}
}

/** Readiness is sampled only after a renderer frame has completed. */
export function isReadyAfterRenderedFrame(firstFrameRendered: boolean, pendingTextureCount: number) {
	return firstFrameRendered && pendingTextureCount === 0;
}

export function applyMaterialClipPlanes(material: Material, planes: Plane[]) {
	material.clippingPlanes = planes;
	material.clipIntersection = false;
	material.needsUpdate = true;
}

/** Three keeps the Plane's positive half-space and discards hits on the negative side. */
export function isPointClipped(point: Vector3, planes: readonly Plane[]) {
	return planes.some((plane) => plane.distanceToPoint(point) < 0);
}

/** InstancedMesh owns GPU instance attributes in addition to its geometry. */
export function disposeInstancedMesh(mesh: InstancedMesh) {
	mesh.geometry.dispose();
	mesh.dispose();
}

/** Instance matrices affect InstancedMesh bounds; keep raycasts and frustum culling in sync. */
export function refreshInstancedMeshBounds(mesh: InstancedMesh) {
	mesh.computeBoundingBox();
	mesh.computeBoundingSphere();
}

/** Apply occurrence visibility and refresh bounds before raycasting/culling. */
export function applyInstancedMeshVisibility(
	mesh: InstancedMesh,
	baseMatrices: Float32Array,
	isOccurrenceVisible: (index: number) => boolean
) {
	const matrices = mesh.instanceMatrix.array as Float32Array;
	matrices.set(baseMatrices);
	const hiddenMatrix = new Matrix4().makeScale(0, 0, 0);
	const visibleOccurrences = new Set<number>();
	for (let index = 0; index < mesh.count; index += 1) {
		if (isOccurrenceVisible(index)) visibleOccurrences.add(index);
		else hiddenMatrix.toArray(matrices, index * 16);
	}
	mesh.instanceMatrix.needsUpdate = true;
	refreshInstancedMeshBounds(mesh);
	return visibleOccurrences;
}
