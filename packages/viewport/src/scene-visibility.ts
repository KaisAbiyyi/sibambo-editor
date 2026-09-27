import type { SceneProfile } from '@sibambo/contracts';
import type { OccurrenceHierarchy } from '@sibambo/contracts';
import { SOURCE_EDGE_HIDDEN } from '@sibambo/scene-runtime';

/** Compiles authored tag/node visibility once and resolves parent inheritance. */
export class SceneVisibilityIndex {
	private readonly visibleTags: Set<number>;
	private readonly hiddenTags: Set<number>;
	private readonly visibleNodes: Set<number>;
	private readonly hiddenNodes: Set<number>;

	constructor(readonly profile: SceneProfile) {
		this.visibleTags = new Set(profile.visibility.visibleTagIndices ?? []);
		this.hiddenTags = new Set(profile.visibility.hiddenTagIndices ?? []);
		this.visibleNodes = new Set(profile.visibility.visibleNodeIndices ?? []);
		this.hiddenNodes = new Set(profile.visibility.hiddenNodeIndices ?? []);
	}

	isTagVisible(tagIndex?: number | null) {
		if (tagIndex == null || tagIndex < 0 || tagIndex === 0xffffffff || tagIndex === 0xffff || tagIndex === 0xff || !this.profile.storesTagVisibility) return true;
		if (this.visibleTags.size) return this.visibleTags.has(tagIndex);
		return !this.hiddenTags.has(tagIndex);
	}

	isNodeDirectlyVisible(nodeIndex?: number | null, tagIndex?: number | null) {
		if (!this.isTagVisible(tagIndex)) return false;
		if (nodeIndex != null && nodeIndex >= 0) {
			if (this.hiddenNodes.has(nodeIndex)) return false;
			if (this.visibleNodes.has(nodeIndex)) return true;
		}
		return true;
	}

	compileOccurrenceVisibility(hierarchy: OccurrenceHierarchy) {
		const count = hierarchy.parentIndices.length;
		if (hierarchy.instanceIndices.length !== count || hierarchy.tagIndices.length !== count) throw new Error('Occurrence hierarchy columns must have equal lengths.');
		const visible = new Uint8Array(count);
		for (let index = 0; index < count; index += 1) {
			const parent = hierarchy.parentIndices[index];
			if (parent >= index || parent < -1) throw new Error(`Occurrence hierarchy parent ${parent} must precede child ${index}.`);
			visible[index] = (parent < 0 || visible[parent] === 1) && this.isNodeDirectlyVisible(hierarchy.instanceIndices[index], hierarchy.tagIndices[index]) ? 1 : 0;
		}
		return visible;
	}

	isOccurrenceVisible(instanceIndex?: number | null, tagIndex?: number | null, hierarchyIndex?: number | null, compiled?: Uint8Array | null) {
		if (compiled && hierarchyIndex != null && hierarchyIndex >= 0 && hierarchyIndex < compiled.length) return compiled[hierarchyIndex] === 1;
		return this.isNodeDirectlyVisible(instanceIndex, tagIndex);
	}

	isFaceVisible(faceIndex: number, tagIndex?: number | null) {
		if (this.profile.visibility.hiddenFaceIndices?.includes(faceIndex)) return false;
		if (this.profile.visibility.visibleFaceIndices?.includes(faceIndex)) return true;
		return this.isTagVisible(tagIndex);
	}

	isEdgeVisible(edgeIndex: number, tagIndex?: number | null) {
		if (this.profile.visibility.hiddenEdgeIndices?.includes(edgeIndex)) return false;
		if (this.profile.visibility.visibleEdgeIndices?.includes(edgeIndex)) return true;
		return this.isTagVisible(tagIndex);
	}
}

/**
 * Native importer edge sets already encode authored per-scene edge overrides.
 * Keep the source hidden bit authoritative when there is no authored scene or
 * when consuming the legacy synthetic visibility contract.
 */
export function shouldRenderSourceEdge(
	flags: number,
	scene: SceneProfile | null,
	sceneSignature: string | null,
	visibleSceneSignatures?: readonly string[]
) {
	if (sceneSignature && visibleSceneSignatures?.length && !visibleSceneSignatures.includes(sceneSignature)) return false;
	if ((flags & SOURCE_EDGE_HIDDEN) === 0) return true;
	return scene !== null && scene.source !== 'legacy-synthetic' && sceneSignature !== null;
}
