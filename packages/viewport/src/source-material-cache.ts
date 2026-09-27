import {
	BackSide,
	Color,
	DoubleSide,
	FrontSide,
	LinearSRGBColorSpace,
	MeshStandardMaterial,
	SRGBColorSpace,
	type Texture
} from 'three';
export type RuntimeRenderSide = 'front' | 'back' | 'double';

export type SourceMaterialDescriptor = {
	index: number;
	id: string;
	name?: string;
	baseColor?: string;
	baseColorRgba?: [number, number, number, number];
	opacity: number;
	colorSpace: string;
	textureAsset?: string;
	textureWidthM?: number;
	textureHeightM?: number;
};

export type RuntimeTextureResolver = {
	getTexture(path: string): Texture | null;
	onTextureSettled(listener: (result: { path: string; ok: boolean }) => void): () => void;
};

/**
 * Source UVs are authoritative and already contain SketchUp tiling, rotation,
 * offset, and mirroring. Physical texture dimensions are diagnostics metadata;
 * applying them to Texture.repeat would double-apply source mapping.
 */
type TrackedMaterial = {
	material: MeshStandardMaterial;
	materialIndex: number;
	textureAsset?: string;
	baseColorRgba: [number, number, number, number];
	baseColor?: string;
	colorSpace: typeof SRGBColorSpace | typeof LinearSRGBColorSpace;
};

/**
 * Source UVs are authoritative and already contain SketchUp tiling, rotation,
 * offset, and mirroring. Physical texture dimensions are diagnostics metadata;
 * applying them to Texture.repeat would double-apply source mapping.
 */
export class RuntimeMaterialCache {
	private readonly variants = new Map<string, MeshStandardMaterial>();
	private readonly liveInstances = new Set<MeshStandardMaterial>();
	private readonly materialEntries = new Map<MeshStandardMaterial, TrackedMaterial>();
	private readonly missingAssets = new Set<string>();
	private readonly unsubscribeTextureSettled: () => void;

	constructor(
		private readonly materials: readonly SourceMaterialDescriptor[],
		private readonly assets: RuntimeTextureResolver
	) {
		this.unsubscribeTextureSettled = this.assets.onTextureSettled(({ path, ok }) => {
			for (const entry of this.materialEntries.values()) {
				if (entry.textureAsset !== path && entry.material.map?.name !== path) continue;
				if (ok) {
					const tex = this.assets.getTexture(path);
					if (tex) entry.material.map = tex;
					entry.material.color.set('#ffffff');
					entry.material.needsUpdate = true;
				} else {
					entry.material.map = null;
					if (entry.baseColor) entry.material.color.set(entry.baseColor);
					else entry.material.color.setRGB(
						entry.baseColorRgba[0], entry.baseColorRgba[1], entry.baseColorRgba[2], entry.colorSpace
					);
					entry.material.needsUpdate = true;
				}
			}
		});
	}

	private buildMaterial(normalizedIndex: number, side: RuntimeRenderSide, overrides?: Partial<SourceMaterialDescriptor>): MeshStandardMaterial {
		const base = normalizedIndex >= 0 ? this.materials[normalizedIndex] : undefined;
		const definedOverrides = overrides
			? Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) as Partial<SourceMaterialDescriptor>
			: undefined;
		const source = base || definedOverrides ? { ...(base ?? { index: normalizedIndex, id: 'source-neutral', opacity: 1, colorSpace: 'linear' }), ...definedOverrides } : undefined;
		const rgba: [number, number, number, number] = source?.baseColorRgba || [0.78, 0.78, 0.76, 1];
		const colorSpace = source?.colorSpace === 'srgb' ? SRGBColorSpace : LinearSRGBColorSpace;
		const opacity = clamp01((source?.opacity ?? 1) * (rgba[3] ?? 1));
		const map = source?.textureAsset ? this.assets.getTexture(source.textureAsset) : null;
		if (source?.textureAsset && !map && !this.missingAssets.has(source.textureAsset)) {
			this.missingAssets.add(source.textureAsset);
			console.warn(`[source-appearance] Texture asset missing; using base color: ${source.textureAsset}`);
		}
		// SketchUp's texture exporter exports pixels already tinted with the material's color (colorize=true).
		// Therefore, when a texture map is present, we use a neutral white multiplier (#ffffff) so that
		// Three.js does not double-tint the material. When untextured or missing, we use the source base color.
		const color = map
			? new Color('#ffffff')
			: source?.baseColor ? new Color(source.baseColor) : new Color().setRGB(rgba[0], rgba[1], rgba[2], colorSpace);

		const material = new MeshStandardMaterial({
			name: source?.name || source?.id || 'source-neutral',
			color,
			map,
			roughness: 0.88,
			metalness: 0.02,
			opacity,
			transparent: opacity < 1,
			depthWrite: opacity > 0.35,
			side: side === 'front' ? FrontSide : side === 'back' ? BackSide : DoubleSide
		});

		this.materialEntries.set(material, {
			material,
			materialIndex: normalizedIndex,
			textureAsset: source?.textureAsset,
			baseColorRgba: rgba,
			baseColor: source?.baseColor,
			colorSpace
		});

		return material;
	}

	get(materialIndex: number | undefined, side: RuntimeRenderSide, overrides?: Partial<SourceMaterialDescriptor>): MeshStandardMaterial {
		const normalizedIndex = materialIndex !== undefined && this.materials[materialIndex] ? materialIndex : -1;
		const overrideKey = overrides ? JSON.stringify(overrides) : '';
		const key = `${normalizedIndex}:${side}:${overrideKey}`;
		const cached = this.variants.get(key);
		if (cached) return cached;

		const material = this.buildMaterial(normalizedIndex, side, overrides);
		this.variants.set(key, material);
		return material;
	}

	/** Mutable per-runtime material; Texture.clone is intentionally avoided. */
	createRuntimeVariant(materialIndex: number | undefined, side: RuntimeRenderSide): MeshStandardMaterial {
		const prototype = this.get(materialIndex, side);
		const clone = prototype.clone();
		clone.map = prototype.map;

		const entry = this.materialEntries.get(prototype);
		if (entry) {
			this.materialEntries.set(clone, {
				material: clone,
				materialIndex: entry.materialIndex,
				textureAsset: entry.textureAsset,
				baseColorRgba: entry.baseColorRgba,
				baseColor: entry.baseColor,
				colorSpace: entry.colorSpace
			});
		}
		this.liveInstances.add(clone);
		return clone;
	}

	dispose(): void {
		if (this.unsubscribeTextureSettled) {
			this.unsubscribeTextureSettled();
		}
		for (const material of this.variants.values()) material.dispose();
		for (const material of this.liveInstances.values()) material.dispose();
		this.variants.clear();
		this.liveInstances.clear();
		this.materialEntries.clear();
		this.missingAssets.clear();
	}

	get size(): number { return this.variants.size; }
	get liveInstanceCount(): number { return this.liveInstances.size; }
}

function clamp01(value: number) {
	return Math.min(Math.max(Number.isFinite(value) ? value : 1, 0), 1);
}
