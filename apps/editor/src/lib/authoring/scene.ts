import {
	BufferGeometry,
	Color,
	DoubleSide,
	Float32BufferAttribute,
	FrontSide,
	Group,
	LineBasicMaterial,
	LineSegments,
	type Material,
	Mesh,
	MeshStandardMaterial,
	Matrix4,
	Vector3,
	SRGBColorSpace
} from 'three';
import type { BomcSnapshot, Face, Mesh as BomcMesh } from '@sibambo/bomc-document';
import { MaterialStateManager, sourceEdgeMaterialDescriptor, type DisplayState, type ViewportBounds } from '@sibambo/viewport';
import { validateEditableSubset } from './geometry.js';
import { definitionGraph, modelMetadata, modelOccurrences, validateAuthoringDocument } from './model.js';

const EMPTY_AUTHORING_BOUNDS: ViewportBounds = {
	min: { x: -5, y: 0, z: -5 },
	max: { x: 5, y: 3, z: 5 }
};

export type AuthoringSceneProjection = { group: Group; bounds: ViewportBounds };

export class AuthoringSceneError extends Error {
	constructor(message: string) { super(message); this.name = 'AuthoringSceneError'; }
}

function boundsForSnapshot(snapshot: BomcSnapshot): ViewportBounds {
	const positions = snapshot.graph.meshes.flatMap((mesh) => mesh.positions);
	if (positions.length === 0) return {
		min: { ...EMPTY_AUTHORING_BOUNDS.min },
		max: { ...EMPTY_AUTHORING_BOUNDS.max }
	};
	const bounds: ViewportBounds = {
		min: { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY },
		max: { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY }
	};
	for (let index = 0; index < positions.length; index += 3) {
		const x = positions[index]!;
		const y = positions[index + 1]!;
		const z = positions[index + 2]!;
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new AuthoringSceneError('Canonical snapshot contains a nonfinite position.');
		bounds.min.x = Math.min(bounds.min.x, x);
		bounds.min.y = Math.min(bounds.min.y, y);
		bounds.min.z = Math.min(bounds.min.z, z);
		bounds.max.x = Math.max(bounds.max.x, x);
		bounds.max.y = Math.max(bounds.max.y, y);
		bounds.max.z = Math.max(bounds.max.z, z);
	}
	return bounds;
}

function vertex(mesh: BomcMesh, index: number): [number, number, number] {
	return [mesh.positions[index * 3]!, mesh.positions[index * 3 + 1]!, mesh.positions[index * 3 + 2]!];
}

function geometryForFace(mesh: BomcMesh, face: Face): BufferGeometry {
	const vertexIndices = [...new Set([face.outer, ...face.holes].flatMap((ring) => [...ring]))];
	const localIndex = new Map(vertexIndices.map((sourceIndex, index) => [sourceIndex, index]));
	const positions = vertexIndices.flatMap((sourceIndex) => vertex(mesh, sourceIndex));
	const normals = vertexIndices.flatMap(() => [...face.normal]);
	const indices = face.triangles.map((sourceIndex) => {
		const index = localIndex.get(sourceIndex);
		if (index === undefined) throw new AuthoringSceneError(`Face ${face.id} references a vertex outside its canonical outer ring.`);
		return index;
	});
	const geometry = new BufferGeometry();
	try {
		geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
		geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
		geometry.setIndex(indices);
		geometry.computeBoundingSphere();
		return geometry;
	} catch (error) {
		geometry.dispose();
		throw error;
	}
}

function materialForFace(face: Face, snapshot: BomcSnapshot, displayState: DisplayState, doubleSided: boolean): Material {
	const material = snapshot.graph.materials.find((candidate) => candidate.id === face.frontMaterialId);
	if (!material) throw new AuthoringSceneError(`Face ${face.id} references a missing front material.`);
	const alpha = material.rgba[3] / 255 * material.opacityU16 / 65535;
	const original = new MeshStandardMaterial({
		color: 0xffffff,
		roughness: 0.88,
		metalness: 0.02,
		opacity: alpha,
		transparent: alpha < 1,
		side: doubleSided ? DoubleSide : FrontSide,
		polygonOffset: true,
		polygonOffsetFactor: 1,
		polygonOffsetUnits: 1
	});
	original.color.setRGB(material.rgba[0] / 255, material.rgba[1] / 255, material.rgba[2] / 255, SRGBColorSpace);
	const manager = new MaterialStateManager();
	manager.register(face.id, original, 'structure');
	try {
		const selected = manager.materialFor(face.id, displayState, false, false);
		manager.derivedMaterials.clear();
		manager.originalMaterials.clear();
		if (selected !== original) original.dispose();
		return selected;
	} catch (error) {
		manager.dispose();
		original.dispose();
		throw error;
	}
}

function edgePositionsForEntity(mesh: BomcMesh, faces: readonly Face[]): number[] {
	const seen = new Set<string>();
	const positions: number[] = [];
	for (const face of faces) {
		for (const ring of [face.outer, ...face.holes]) for (let index = 0; index < ring.length; index += 1) {
			const first = ring[index]!;
			const second = ring[(index + 1) % ring.length]!;
			const key = first < second ? `${first}:${second}` : `${second}:${first}`;
			if (seen.has(key)) continue;
			seen.add(key);
			positions.push(...vertex(mesh, first), ...vertex(mesh, second));
		}
	}
	return positions;
}

function disposeUntransferred(group: Group): void {
	const geometries = new Set<BufferGeometry>();
	const materials = new Set<Material>();
	group.traverse((object) => {
		const drawable = object as typeof object & { geometry?: BufferGeometry; material?: Material | Material[] };
		if (drawable.geometry) geometries.add(drawable.geometry);
		if (Array.isArray(drawable.material)) for (const material of drawable.material) materials.add(material);
		else if (drawable.material) materials.add(drawable.material);
	});
	for (const geometry of geometries) geometry.dispose();
	for (const material of materials) material.dispose();
}

/** Build a dedicated render-only projection from the acknowledged canonical snapshot. */
function projectFlatAuthoringScene(snapshot: BomcSnapshot, displayState: DisplayState): AuthoringSceneProjection {
	const subset = validateEditableSubset(snapshot.graph);
	if (!subset.editable) throw new AuthoringSceneError(`Canonical snapshot is outside the editable subset: ${subset.reason}`);
	const group = new Group();
	group.name = 'editor-authoring-content';
	const mesh = snapshot.graph.meshes[0];
		try {
			if (mesh) {
				const entityForFace = new Map(subset.entities.flatMap((entity) => entity.faces.map((face) => [face.id, entity] as const)));
				for (const face of mesh.faces) {
					const entity = entityForFace.get(face.id);
					if (!entity) throw new AuthoringSceneError(`Face ${face.id} has no validated authoring entity.`);
					const geometry = geometryForFace(mesh, face);
					let material: Material;
					try { material = materialForFace(face, snapshot, displayState, true); }
				catch (error) { geometry.dispose(); throw error; }
				try {
					const projected = new Mesh(geometry, material);
					projected.name = face.id;
					projected.visible = displayState.faceStyle !== 'wireframe';
					projected.userData = {
						authoringFaceId: face.id,
						authoringEntityId: entity.entityId,
						authoringSequence: entity.sequence,
						authoringKind: entity.kind
					};
					group.add(projected);
				} catch (error) {
					geometry.dispose();
					material.dispose();
					throw error;
				}
			}
				const edgePositions = edgePositionsForEntity(mesh, mesh.faces);
			if (edgePositions.length > 0) {
				const geometry = new BufferGeometry();
				let material: LineBasicMaterial | null = null;
				try {
					geometry.setAttribute('position', new Float32BufferAttribute(edgePositions, 3));
					const descriptor = sourceEdgeMaterialDescriptor(displayState);
					material = new LineBasicMaterial({
						...descriptor,
						opacity: displayState.faceStyle === 'wireframe' ? descriptor.opacity : Math.max(0.82, descriptor.opacity)
					});
					material.toneMapped = false;
					const edges = new LineSegments(geometry, material);
					edges.name = 'editor-authoring-source-edges';
					edges.renderOrder = 8;
					group.add(edges);
				} catch (error) {
					geometry.dispose();
					material?.dispose();
					throw error;
				}
			}
		}
		return { group, bounds: boundsForSnapshot(snapshot) };
	} catch (error) {
		disposeUntransferred(group);
		if (error instanceof AuthoringSceneError) throw error;
		throw new AuthoringSceneError(error instanceof Error ? error.message : 'Unable to project canonical authoring geometry.');
	}
}

export function projectAuthoringScene(snapshot: BomcSnapshot, displayState: DisplayState): AuthoringSceneProjection {
	if (snapshot.graph.instances.length === 1 && snapshot.graph.instances[0]?.label === null) return projectFlatAuthoringScene(snapshot, displayState);
	const valid = validateAuthoringDocument(snapshot.graph);
	if (!valid.editable) throw new AuthoringSceneError(valid.reason);
	const group = new Group(); group.name = 'editor-authoring-content';
	const metadata = modelMetadata(snapshot.graph);
	const bounds: ViewportBounds = { min: {x:Infinity,y:Infinity,z:Infinity}, max: {x:-Infinity,y:-Infinity,z:-Infinity} };
	const include = (point: readonly number[], matrix: Matrix4) => {
		const p = new Vector3(point[0],point[1],point[2]).applyMatrix4(matrix);
		for (const axis of ['x','y','z'] as const) { bounds.min[axis]=Math.min(bounds.min[axis],p[axis]);bounds.max[axis]=Math.max(bounds.max[axis],p[axis]); }
	};
	try {
		for (const occurrence of modelOccurrences(snapshot.graph)) {
			const flat = definitionGraph(snapshot.graph, occurrence.definitionId);
			const projected = projectFlatAuthoringScene({...snapshot,graph:flat},displayState);
			projected.group.applyMatrix4(occurrence.matrix);
			group.add(projected.group);
			for (const mesh of flat.meshes) for (let i=0;i<mesh.positions.length;i+=3) include(mesh.positions.slice(i,i+3),occurrence.matrix);
			for (const [items,color,name] of [[metadata.looseEdges,'#343a40','loose-edges'],[metadata.guides,'#b87d00','construction-guides']] as const) {
				const positions:number[]=[];
				for (const item of items.filter(e=>e.ownerDefinitionId===occurrence.definitionId)) {
					include(item.start,occurrence.matrix); include(item.end,occurrence.matrix);
					if ('kind' in item && item.kind==='point') {
						for (let axis=0;axis<3;axis++) { const a=[...item.start],b=[...item.start];a[axis]-=0.035;b[axis]+=0.035;positions.push(...a,...b); }
					} else if ('kind' in item) {
						const direction=new Vector3(...item.end).sub(new Vector3(...item.start)).normalize();
						const extent=flat.meshes.reduce((max,mesh)=>mesh.positions.reduce((value,coordinate)=>Math.max(value,Math.abs(coordinate)),max),100)*2;
						positions.push(...new Vector3(...item.start).addScaledVector(direction,-extent).toArray(),...new Vector3(...item.end).addScaledVector(direction,extent).toArray());
					} else positions.push(...item.start,...item.end);
				}
				if (positions.length) {
					const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(positions,3));
					const material=new LineBasicMaterial({color});material.toneMapped=false;
					const lines=new LineSegments(geometry,material);lines.name=name;lines.renderOrder=9;lines.applyMatrix4(occurrence.matrix);group.add(lines);
				}
			}
		}
		return {group,bounds:Number.isFinite(bounds.min.x)?bounds:EMPTY_AUTHORING_BOUNDS};
	} catch(error) { disposeUntransferred(group);throw error; }
}
