import { BufferGeometry, DoubleSide, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Plane, Raycaster, Vector3 } from 'three';
import { isPointClipped } from './viewport-render-state.js';

export type NavigationSurfaceRecord = {
	mesh: InstancedMesh;
	navigationVisible: boolean;
	visibleOccurrenceIndices: ReadonlySet<number>;
};

export type NavigationSurfaceHit = {
	point: Vector3;
	distance: number;
	recordIndex: number;
	instanceIndex: number;
	faceIndex: number;
};

/**
 * A non-rendered, side-independent ray boundary for camera navigation. The proxy
 * borrows source geometry only during a synchronous query and never owns it.
 */
export class NavigationSurfaceQuery {
	private readonly proxyMaterial = new MeshBasicMaterial({ side: DoubleSide });
	private readonly proxy = new Mesh<BufferGeometry, MeshBasicMaterial>(undefined as unknown as BufferGeometry, this.proxyMaterial);
	private readonly instanceMatrix = new Matrix4();
	private readonly worldMatrix = new Matrix4();
	private readonly intersections: Array<{ point: Vector3; distance: number; faceIndex?: number | null }> = [];
	private disposed = false;

	query(raycaster: Raycaster, records: readonly NavigationSurfaceRecord[], clipPlanes: readonly Plane[], epsilon: number): NavigationSurfaceHit | null {
		if (this.disposed || !Number.isFinite(epsilon) || epsilon < 0 || !raycaster.ray.direction.toArray().every(Number.isFinite)) return null;
		let best: NavigationSurfaceHit | null = null;
		for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
			const record = records[recordIndex]!;
			const geometry = record.mesh.geometry;
			if (!record.navigationVisible || !geometry.index || geometry.index.count === 0 || record.visibleOccurrenceIndices.size === 0) continue;
			record.mesh.updateWorldMatrix(true, false);
			for (const instanceIndex of record.visibleOccurrenceIndices) {
				if (!Number.isInteger(instanceIndex) || instanceIndex < 0 || instanceIndex >= record.mesh.count) continue;
				record.mesh.getMatrixAt(instanceIndex, this.instanceMatrix);
				if (!this.isFiniteMatrix(this.instanceMatrix)) continue;
				this.worldMatrix.multiplyMatrices(record.mesh.matrixWorld, this.instanceMatrix);
				if (!this.isFiniteMatrix(this.worldMatrix) || Math.abs(this.worldMatrix.determinant()) <= 1e-15) continue;
				this.proxy.geometry = geometry;
				this.proxy.matrixWorld.copy(this.worldMatrix);
				this.intersections.length = 0;
				this.proxy.raycast(raycaster, this.intersections as never);
				for (const intersection of this.intersections) {
					const distance = intersection.distance;
					if (!Number.isFinite(distance) || distance <= epsilon || !intersection.point.toArray().every(Number.isFinite) || isPointClipped(intersection.point, clipPlanes)) continue;
					const faceIndex = Number.isInteger(intersection.faceIndex) && intersection.faceIndex! >= 0 ? intersection.faceIndex! : -1;
					const candidate: NavigationSurfaceHit = {
						point: intersection.point.clone(), distance, recordIndex, instanceIndex, faceIndex
					};
					if (!best || this.precedes(candidate, best, epsilon)) best = candidate;
				}
			}
		}
		return best;
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.proxyMaterial.dispose();
		this.intersections.length = 0;
	}

	private precedes(candidate: NavigationSurfaceHit, current: NavigationSurfaceHit, epsilon: number) {
		if (candidate.distance < current.distance - epsilon) return true;
		if (Math.abs(candidate.distance - current.distance) > epsilon) return false;
		if (candidate.recordIndex !== current.recordIndex) return candidate.recordIndex < current.recordIndex;
		if (candidate.instanceIndex !== current.instanceIndex) return candidate.instanceIndex < current.instanceIndex;
		return candidate.faceIndex < current.faceIndex;
	}

	private isFiniteMatrix(matrix: Matrix4) {
		return matrix.elements.every(Number.isFinite);
	}
}
