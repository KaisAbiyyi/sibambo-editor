import type { PreparedRuntimeGeometryScene } from './prepared-types.js';
import { prepareSolidCoplanarScene, type GeometryPreparationProgress } from './solid-coplanar-resolution.js';
import { shouldPrepareSuppressedSolidGeometry } from './solid-geometry-policy.js';
import { compactPreparedSurfaceGeometry, shouldCompactPreparedSurfaceGeometry } from './surface-batching.js';
import { normalizePreparedMirroredInstances, type MirroredInstancingMetrics } from './mirrored-instancing.js';

export type ApplicationEncodingProfile = 'exact' | 'research' | 'visual' | undefined;
export type ApplicationPreparationProgress = GeometryPreparationProgress | { phase: 'batching'; completed: number; total: number; message?: string };
export type ApplicationPreparationMetrics = {
	solidCoplanarResolutionMs?: number;
	surfaceBatching?: NonNullable<PreparedRuntimeGeometryScene['surfaceBatching']>;
	mirroredInstancing?: MirroredInstancingMetrics;
};

/** Restore the established worker-side rendering preparation after a shared E4 decode. */
export function prepareApplicationRenderScene(
	scene: PreparedRuntimeGeometryScene,
	encodingProfile?: ApplicationEncodingProfile,
	onProgress?: (progress: ApplicationPreparationProgress) => void
): ApplicationPreparationMetrics {
	const metrics: ApplicationPreparationMetrics = {};
	if (scene.solidCoplanarResolution) {
		metrics.solidCoplanarResolutionMs = scene.solidCoplanarResolution.preparationMs;
	} else if (shouldPrepareSuppressedSolidGeometry(true, encodingProfile)) {
		const startedAt = performance.now();
		prepareSolidCoplanarScene(scene, 0.00003, undefined, onProgress);
		metrics.solidCoplanarResolutionMs = performance.now() - startedAt;
	}
	if (shouldCompactPreparedSurfaceGeometry(scene)) {
		metrics.surfaceBatching = compactPreparedSurfaceGeometry(scene, (completed, total) => {
			onProgress?.({ phase: 'batching', completed, total, message: `Compacting render surfaces ${completed.toLocaleString()} of ${total.toLocaleString()}.` });
		});
	}
	metrics.mirroredInstancing = normalizePreparedMirroredInstances(scene);
	return metrics;
}
