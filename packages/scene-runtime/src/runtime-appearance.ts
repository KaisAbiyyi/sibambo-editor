import { BackSide, DoubleSide, FrontSide, Matrix3, Matrix4, Vector3, type Side, type Texture } from 'three';
export type RuntimeRenderSide = 'front' | 'back' | 'double';

export type SourceFaceAppearanceInput = {
	frontMaterial?: number;
	backMaterial?: number;
	inheritedMaterial?: number;
	frontUv?: boolean;
	backUv?: boolean;
	neutralBackFallback?: boolean;
};

export type SourceFaceRenderPass = {
	kind: 'front-source' | 'back-source' | 'front-default' | 'back-default' | 'inherited';
	sourceSide: 'front' | 'back';
	materialIndex?: number;
	renderSide: RuntimeRenderSide;
	uvSide?: 'front' | 'back';
};

/** Resolves authored SketchUp sides before format-specific geometry is partitioned. */
export function resolveFaceRenderPasses(input: SourceFaceAppearanceInput): SourceFaceRenderPass[] {
	const frontMaterial = input.frontMaterial ?? input.inheritedMaterial;
	const passes: SourceFaceRenderPass[] = [{
		kind: input.frontMaterial !== undefined ? 'front-source' : input.inheritedMaterial !== undefined ? 'inherited' : 'front-default',
		sourceSide: 'front',
		materialIndex: frontMaterial,
		renderSide: input.neutralBackFallback
			&& input.frontMaterial === undefined
			&& input.inheritedMaterial === undefined
			&& input.backMaterial === undefined
			&& !input.backUv ? 'double' : 'front',
		uvSide: input.frontUv ? 'front' : undefined
	}];
	if (input.backMaterial !== undefined || input.backUv) {
		passes.push({
			kind: input.backMaterial !== undefined ? 'back-source' : input.inheritedMaterial !== undefined ? 'inherited' : 'back-default',
			sourceSide: 'back',
			materialIndex: input.backMaterial ?? input.inheritedMaterial,
			renderSide: 'back',
			uvSide: input.backUv ? 'back' : undefined
		});
	}
	return passes;
}

export function classifySourceFaceCameraSide(
	localNormal: readonly [number, number, number],
	matrixElements: ArrayLike<number>,
	localPoint: readonly [number, number, number],
	cameraPosition: readonly [number, number, number]
) {
	const matrix = new Matrix4().fromArray(matrixElements);
	const worldNormal = new Vector3(...localNormal).applyMatrix3(new Matrix3().getNormalMatrix(matrix)).normalize();
	const worldPoint = new Vector3(...localPoint).applyMatrix4(matrix);
	const viewDirection = new Vector3(...cameraPosition).sub(worldPoint).normalize();
	const normalDotViewDirection = worldNormal.dot(viewDirection);
	return {
		worldNormal: worldNormal.toArray() as [number, number, number],
		worldPoint: worldPoint.toArray() as [number, number, number],
		viewDirection: viewDirection.toArray() as [number, number, number],
		normalDotViewDirection,
		cameraSide: normalDotViewDirection >= 0 ? 'front' as const : 'back' as const
	};
}

export type RuntimeAppearanceInput = {
	materialIndex?: number;
	materialId?: string;
	materialName?: string;
	baseColor?: string;
	baseColorRgba?: [number, number, number, number];
	opacity?: number;
	colorSpace?: string;
	textureName?: string;
	textureAsset?: string;
	textureWidthM?: number;
	textureHeightM?: number;
	renderSide?: RuntimeRenderSide;
	isBackFace?: boolean;
};

export type RuntimeAppearance = {
	materialIndex?: number;
	materialId?: string;
	materialName?: string;
	baseColor?: string;
	baseColorRgba?: [number, number, number, number];
	opacity?: number;
	colorSpace?: string;
	textureName?: string;
	textureAsset?: string;
	textureWidthM?: number;
	textureHeightM?: number;
	renderSide: RuntimeRenderSide;
	threeSide: Side;
	sourceAppearance: boolean;
	sourceTexture: Texture | null;
};

export function normalizeRuntimeAppearance(
	group: RuntimeAppearanceInput,
	sourceTexture: Texture | null,
	sourceAppearance: boolean
): RuntimeAppearance {
	const renderSide = group.renderSide || (group.isBackFace ? 'back' : 'double');
	return {
		materialIndex: group.materialIndex,
		materialId: group.materialId,
		materialName: group.materialName,
		baseColor: group.baseColor,
		baseColorRgba: group.baseColorRgba,
		opacity: group.opacity,
		colorSpace: group.colorSpace,
		textureName: group.textureName,
		textureAsset: group.textureAsset,
		textureWidthM: group.textureWidthM,
		textureHeightM: group.textureHeightM,
		renderSide,
		threeSide: renderSide === 'front' ? FrontSide : renderSide === 'back' ? BackSide : DoubleSide,
		sourceAppearance,
		sourceTexture
	};
}

export function runtimeTextureForDisplay(
	appearance: RuntimeAppearance,
	mode: 'original' | 'analysis',
	highlighted = false
): Texture | null {
	return mode === 'original' && !highlighted && appearance.sourceAppearance ? appearance.sourceTexture : null;
}
