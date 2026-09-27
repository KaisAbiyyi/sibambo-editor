// src/lib/render/scene-clip-program.ts
import { Plane, Vector3, Matrix4 } from 'three';
import type { ClipPlaneRecord, SceneProfile } from '@sibambo/contracts';

/**
 * Converts a BOMC ClipPlaneRecord into a Three.js Plane in world coordinates.
 *
 * SketchUp coordinate system:
 *   X = East / Right
 *   Y = North / Forward
 *   Z = Up
 *
 * Three.js coordinate system (as used in model-eval):
 *   X_three = X_skp
 *   Y_three = Z_skp (Up)
 *   Z_three = -Y_skp (Forward)
 *
 * Three.js plane equation:
 *   dot(normal_three, point_three) + constant_three = 0
 * Points where dot(normal, point) + constant >= 0 are kept.
 */
export function bomcClipPlaneToThreePlane(
	clipPlane: ClipPlaneRecord,
	occurrenceMatrix?: Matrix4
): Plane {
	const [nx, ny, nz] = clipPlane.normal;
	const [ox, oy, oz] = clipPlane.originM;

	// Map normal: (nx, ny, nz) -> (nx, nz, -ny)
	let normal = new Vector3(nx, nz, -ny).normalize();
	// Map origin: (ox, oy, oz) -> (ox, oz, -oy)
	const point = new Vector3(ox, oz, -oy);

	// In SketchUp, normal points toward the retained half-space (dot(n, p) + d >= 0).
	// In Three.js, plane.normal points toward the kept half-space (dot(n, p) + d >= 0).
	// Therefore, Three.js normal matches SketchUp normal directly.
	// If keepSide === 0 (explicit reverse cut), normal is negated.
	if (clipPlane.keepSide === 0) {
		normal.negate();
	}

	const plane = new Plane().setFromNormalAndCoplanarPoint(normal, point);

	if (occurrenceMatrix) {
		plane.applyMatrix4(occurrenceMatrix);
	}

	return plane;
}

/**
 * Resolves the active clip planes for a given scene.
 */
export function resolveSceneClipPlanes(
  scene: SceneProfile | undefined,
  allClipPlanes: ClipPlaneRecord[] = []
): ClipPlaneRecord[] {
	// Active plane metadata is not executable unless SketchUp displayed section cuts.
	if (!scene || scene.sectionState?.sectionCutsDisplayed !== true) {
		return [];
	}

  // Metadata-only means producer could identify a cut but renderer cannot
  // execute its scope safely. Never turn uncertain metadata into global clips.
  if (scene.sectionState.renderingSupport !== 'full') {
    return [];
  }

	const activeIndices = scene.sectionState?.activeClipPlaneIndices;
	if (activeIndices && activeIndices.length > 0) {
		return activeIndices.map((idx) => allClipPlanes[idx]).filter(Boolean);
	}

	const activeIds = scene.sectionState?.activeSectionPlaneIds || [];
	if (activeIds.length > 0) {
		return allClipPlanes.filter(
			(cp) => activeIds.includes(cp.stableId) || activeIds.includes(cp.sourcePersistentId)
		);
	}

	return [];
}

/**
 * Builds Three.js Plane instances for a given scene and occurrence context.
 * Global planes apply everywhere.
 * Definition/instance scoped planes only apply if the occurrence matches the scope.
 */
export function createOccurrenceClipPlanes(
	scene: SceneProfile | undefined,
	allClipPlanes: ClipPlaneRecord[] = [],
	occurrence?: {
		definitionId?: string | null;
		instanceId?: string | null;
		matrix?: Matrix4;
	}
): Plane[] {
	const activeRecords = resolveSceneClipPlanes(scene, allClipPlanes);
	if (activeRecords.length === 0) return [];

	const planes: Plane[] = [];

	for (const record of activeRecords) {
		// Global plane (no owner definition or instance)
		if (!record.ownerDefinitionId && !record.ownerInstanceId) {
			planes.push(bomcClipPlaneToThreePlane(record));
			continue;
		}

		// Owner-scoped plane: check if this occurrence matches the scope
		if (occurrence) {
			const matchesDefinition = !record.ownerDefinitionId || record.ownerDefinitionId === occurrence.definitionId;
			const matchesInstance = !record.ownerInstanceId || record.ownerInstanceId === occurrence.instanceId;

			if (matchesDefinition && matchesInstance) {
				planes.push(bomcClipPlaneToThreePlane(record, occurrence.matrix));
			}
		}
	}

	return planes;
}
