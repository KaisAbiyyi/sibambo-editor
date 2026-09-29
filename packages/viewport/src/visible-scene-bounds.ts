import { Box3, Matrix4, Vector3, type InstancedMesh } from 'three';

export type VisibleBoundsRecord = {
	mesh: InstancedMesh;
	visibleOccurrenceIndices: ReadonlySet<number>;
};

/** Bounds only geometry that is currently rendered, excluding hidden scene outliers. */
export function visibleSceneBounds(records: readonly VisibleBoundsRecord[]) {
	const bounds = new Box3().makeEmpty();
	const matrix = new Matrix4();
	const transformed = new Box3();
	const corner = new Vector3();
	for (const record of records) {
		if (!record.mesh.visible) continue;
		const geometry = record.mesh.geometry;
		if (!geometry.boundingBox) geometry.computeBoundingBox();
		if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) continue;
		for (const occurrenceIndex of record.visibleOccurrenceIndices) {
			if (occurrenceIndex < 0 || occurrenceIndex >= record.mesh.count) continue;
			record.mesh.getMatrixAt(occurrenceIndex, matrix);
			transformed.copy(geometry.boundingBox).applyMatrix4(matrix);
			for (let i = 0; i < 8; i += 1) {
				corner.set(
					i & 1 ? transformed.max.x : transformed.min.x,
					i & 2 ? transformed.max.y : transformed.min.y,
					i & 4 ? transformed.max.z : transformed.min.z
				);
				bounds.expandByPoint(corner);
			}
		}
	}
	if (bounds.isEmpty()) return null;
	return {
		min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
		max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z }
	};
}
