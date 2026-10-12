import { Matrix3, Matrix4, Vector3 } from 'three';
import type { Mesh } from '@sibambo/bomc-document';
import type { AuthoringPoint } from './protocol.js';
import { AuthoringGeometryError, faceFromRing } from './geometry.js';

export function normalThrough(normal: AuthoringPoint, matrix: Matrix4): AuthoringPoint {
	const value = new Vector3(...normal).applyMatrix3(new Matrix3().getNormalMatrix(matrix)).normalize();
	return [value.x || 0, value.y || 0, value.z || 0];
}

/** Affine conversion owns both the normal covector and reflected winding. */
export function meshThrough(mesh: Mesh, matrix: Matrix4): Mesh {
	const positions: number[] = [];
	for (let i = 0; i < mesh.positions.length; i += 3)
		positions.push(...new Vector3(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]).applyMatrix4(matrix).toArray());
	const transformed = { ...mesh, positions };
	const reflected = matrix.determinant() < 0;
	return { ...transformed, faces: mesh.faces.map(face => {
		const normal = normalThrough(face.normal, matrix);
		const label = face.label?.includes('sibambo-editor-shape-v1') ? JSON.stringify(['sibambo-editor-shape-v2', 'split', face.id]) : face.label!;
		const outer = reflected ? [...face.outer].reverse() : face.outer;
		if (face.holes.length) return faceFromRing(transformed, face.id, outer, face.frontMaterialId!, face.backMaterialId,
			label, normal, reflected ? face.holes.map(ring => [...ring].reverse()) : face.holes);
		const triangles = [...face.triangles];
		if (reflected) for (let i = 0; i < triangles.length; i += 3) [triangles[i + 1], triangles[i + 2]] = [triangles[i + 2]!, triangles[i + 1]!];
		return { ...face, outer, triangles, normal, label };
	}) };
}

export function assertAffine(matrix: readonly number[]): void {
	if (matrix.length !== 16 || !matrix.every(Number.isFinite) || matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1)
		throw new AuthoringGeometryError('Projective or nonfinite transforms are unsupported.');
	const value = new Matrix4().fromArray(matrix), inverse = value.clone().invert();
	// Bound both expansion and contraction; negative determinants represent a real mirror.
	if (Math.abs(value.determinant()) < 1e-18 || [value, inverse].some(m => [0, 1, 2].some(axis => {
		const length = new Vector3().setFromMatrixColumn(m, axis).length();
		return !Number.isFinite(length) || length > 1e6;
	}))) throw new AuthoringGeometryError('Transform is singular or exceeds the supported scale range.');
}
