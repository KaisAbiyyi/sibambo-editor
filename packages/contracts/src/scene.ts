export type SceneCamera = {
	projection: 'perspective' | 'orthographic';
	eyeM: [number, number, number];
	targetM: [number, number, number];
	up: [number, number, number];
	fieldOfViewDegrees?: number | null;
	fovIsHeight?: boolean;
	orthographicHeightM?: number | null;
	aspectRatio?: number;
	is2d?: boolean;
};

export type SceneVisibility = {
	visibleTagIds: string[];
	hiddenTagIds: string[];
	visibleNodeOverrides: string[];
	hiddenNodeOverrides: string[];
	visibleTagIndices?: number[];
	hiddenTagIndices?: number[];
	visibleNodeIndices?: number[];
	hiddenNodeIndices?: number[];
	sourceVisibleNodeOverrideCount?: number;
	sourceHiddenNodeOverrideCount?: number;
	resolvedVisibleNodeOverrideCount?: number;
	resolvedHiddenNodeOverrideCount?: number;
	unresolvedVisibleNodeOverrides?: string[];
	unresolvedHiddenNodeOverrides?: string[];
	visibleFaceOverrides?: string[];
	hiddenFaceOverrides?: string[];
	visibleEdgeOverrides?: string[];
	hiddenEdgeOverrides?: string[];
	visibleFaceIndices?: number[];
	hiddenFaceIndices?: number[];
	visibleEdgeIndices?: number[];
	hiddenEdgeIndices?: number[];
	unresolvedVisibleFaceOverrides?: string[];
	unresolvedHiddenFaceOverrides?: string[];
	unresolvedVisibleEdgeOverrides?: string[];
	unresolvedHiddenEdgeOverrides?: string[];
	unresolvedPrimitiveOverrides?: string[];
	resolvedVisiblePrimitiveOverrideCount?: number;
	resolvedHiddenPrimitiveOverrideCount?: number;
	unresolvedPrimitiveOverrideCount?: number;
};

export type ClipPlaneRecord = {
	index: number;
	stableId: string;
	sourcePersistentId: string;
	originM: [number, number, number];
	normal: [number, number, number];
	planeConstant: number;
	keepSide: number;
	ownerDefinitionId?: string | null;
	ownerInstanceId?: string | null;
	flags: number;
};

export type SceneSectionState = {
	activeSectionPlaneIds: string[];
	activeClipPlaneIndices?: number[];
	sectionCutsDisplayed?: boolean;
	sectionPlanesDisplayed?: boolean;
	renderingSupport: 'metadata-only' | 'none' | 'full';
};

export type SceneProfile = {
	id: string;
	name: string;
	description?: string;
	isActiveAtExport: boolean;
	source: 'sketchup-page' | 'legacy-synthetic' | 'bomc-native';
	sourceBinding: { provider: 'sketchup' | 'bomc'; persistentId: string };
	camera: SceneCamera;
	useCamera: boolean;
	transitionTimeSeconds: number;
	visibility: SceneVisibility;
	storesTagVisibility: boolean;
	storesHiddenObjects: boolean;
	storesHiddenGeometry: boolean;
	storesSectionPlanes: boolean;
	sectionState: SceneSectionState;
	visibilitySignature: string;
	clipPlanes?: ClipPlaneRecord[];
};
