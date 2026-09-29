import { type BufferGeometry, Color, DoubleSide, EdgesGeometry, type Material, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import type { DisplayState, FaceStyle, PartKey, ViewEffects, ViewMode } from '@sibambo/contracts';
export type { DisplayState, FaceStyle, ViewEffects, ViewMode } from '@sibambo/contracts';

type MaterialRecord = { original: Material; category: PartKey };

export const DEFAULT_DISPLAY_STATE: DisplayState = {
	faceStyle: 'shaded-textures',
	effects: { xray: false, ambientOcclusion: false }
};

export function normalizeDisplayState(state: DisplayState): DisplayState {
	return {
		faceStyle: state.faceStyle,
		effects: {
			xray: Boolean(state.effects?.xray),
			ambientOcclusion: Boolean(state.effects?.ambientOcclusion)
		}
	};
}

export function displayStateFromLegacyMode(mode: ViewMode): DisplayState {
	if (mode === 'wireframe') return { faceStyle: 'wireframe', effects: { xray: false, ambientOcclusion: false } };
	if (mode === 'xray') return { faceStyle: 'shaded-textures', effects: { xray: true, ambientOcclusion: false } };
	return normalizeDisplayState(DEFAULT_DISPLAY_STATE);
}

export function legacyViewModeFromDisplayState(state: DisplayState): ViewMode {
	if (state.faceStyle === 'wireframe') return 'wireframe';
	if (state.effects.xray) return 'xray';
	return 'solid';
}

export function withFaceStyle(state: DisplayState, faceStyle: FaceStyle): DisplayState {
	return normalizeDisplayState({ ...state, faceStyle });
}

export function withViewEffects(state: DisplayState, effects: Partial<ViewEffects>): DisplayState {
	return normalizeDisplayState({ ...state, effects: { ...state.effects, ...effects } });
}

export class MaterialStateManager {
	displayState: DisplayState = normalizeDisplayState(DEFAULT_DISPLAY_STATE);
	readonly originalMaterials = new Map<string, MaterialRecord>();
	readonly derivedMaterials = new Map<string, Material>();

	register(id: string, material: Material, category: PartKey) {
		this.originalMaterials.set(id, { original: material, category });
	}

	applyDisplayState(state: DisplayState) { this.displayState = normalizeDisplayState(state); }
	applyMode(mode: ViewMode) { this.applyDisplayState(displayStateFromLegacyMode(mode)); }

	materialFor(id: string, state: DisplayState | ViewMode = this.displayState, highlight = false, dense = false): Material {
		const record = this.originalMaterials.get(id);
		if (!record) throw new Error(`Material ${id} is not registered.`);
		const display = typeof state === 'string' ? displayStateFromLegacyMode(state) : normalizeDisplayState(state);
		if (display.faceStyle === 'shaded-textures' && !display.effects.xray && !highlight) return record.original;
		const cacheKey = `${id}:${display.faceStyle}:${display.effects.xray ? 'xray' : 'opaque'}:${highlight ? 'highlight' : 'default'}:${dense ? 'dense' : 'regular'}`;
		const cached = this.derivedMaterials.get(cacheKey);
		const material = cached || derivedMaterial(record.original, display.faceStyle);
		configureDerivedMaterial(material, record.original, record.category, display, highlight, dense);
		if (!cached) this.derivedMaterials.set(cacheKey, material);
		return material;
	}

	restoreOriginal() { this.displayState = normalizeDisplayState(DEFAULT_DISPLAY_STATE); }

	dispose() {
		for (const material of this.derivedMaterials.values()) material.dispose();
		this.derivedMaterials.clear();
		this.originalMaterials.clear();
	}
}

function derivedMaterial(original: Material, style: FaceStyle) {
	if ((style === 'hidden-line' || style === 'wireframe') && original instanceof MeshStandardMaterial) {
		return new MeshBasicMaterial({ color: '#f4f4f1', side: DoubleSide, toneMapped: false });
	}
	return original.clone();
}

function configureDerivedMaterial(material: Material, original: Material, category: PartKey, state: DisplayState, highlight: boolean, dense: boolean) {
	const style = state.faceStyle;
	const xray = state.effects.xray;
	if (material instanceof MeshBasicMaterial && original instanceof MeshStandardMaterial) {
		let programChanged = false;
		material.color.set('#f4f4f1');
		if (material.map !== null) { material.map = null; programChanged = true; }
		if (material.side !== DoubleSide) { material.side = DoubleSide; programChanged = true; }
		if (material.wireframe) { material.wireframe = false; programChanged = true; }
		if (material.transparent !== xray) { material.transparent = xray; programChanged = true; }
		if (!material.depthTest) { material.depthTest = true; programChanged = true; }
		const depthWrite = xray ? dense : true;
		if (material.depthWrite !== depthWrite) { material.depthWrite = depthWrite; programChanged = true; }
		material.opacity = xray ? (highlight ? 0.68 : Math.min(0.24, xrayCategoryOpacity(category))) : 1;
		if (highlight) material.color.lerp(new Color('#2dd4bf'), 0.35);
		if (programChanged) material.needsUpdate = true;
		return;
	}

	if (material instanceof MeshStandardMaterial && original instanceof MeshStandardMaterial) {
		material.copy(original);
		material.side = xray ? DoubleSide : original.side;
		if (style === 'shaded') {
			material.map = null;
		} else if (style === 'monochrome') {
			material.map = null;
			material.color.set('#e8e8e3');
			material.roughness = 1;
			material.metalness = 0;
		} else if (style === 'photoreal') {
			// BOMC 1.2 may not carry PBR maps yet. Preserve the authored texture/material
			// as the lossless fallback until optional PBR metadata is present.
			material.map = original.map;
		}
		if (xray) {
			material.transparent = true;
			material.opacity = highlight ? 0.68 : xrayCategoryOpacity(category);
			material.depthWrite = dense;
			material.depthTest = true;
		} else {
			material.transparent = original.transparent;
			material.opacity = original.opacity;
			material.depthWrite = original.depthWrite;
			material.depthTest = original.depthTest;
		}
		if (highlight) {
			material.emissive.set('#2dd4bf');
			material.emissiveIntensity = 0.55;
		}
		material.needsUpdate = true;
		return;
	}

	const generic = material as Material & { transparent?: boolean; opacity?: number; depthWrite?: boolean };
	if (xray) {
		generic.transparent = true;
		generic.opacity = highlight ? 0.68 : xrayCategoryOpacity(category);
		generic.depthWrite = dense;
	}
}

export function xrayCategoryOpacity(category: PartKey) {
	if (category === 'doors' || category === 'windows' || category === 'openings') return 0.30;
	if (category === 'furniture' || category === 'structure') return 0.24;
	if (category === 'roof' || category === 'walls') return 0.14;
	return 0.19;
}

export class EdgeGeometryCache {
	private readonly cache = new Map<string, EdgesGeometry>();

	get(id: string, geometry: BufferGeometry, thresholdAngle = 35) {
		const cached = this.cache.get(id);
		if (cached) return cached;
		const edges = new EdgesGeometry(geometry, thresholdAngle);
		this.cache.set(id, edges);
		return edges;
	}

	dispose() {
		for (const geometry of this.cache.values()) geometry.dispose();
		this.cache.clear();
	}

	get size() { return this.cache.size; }
}
