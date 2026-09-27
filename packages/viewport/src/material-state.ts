import { type BufferGeometry, Color, DoubleSide, EdgesGeometry, type Material, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import type { PartKey } from '@sibambo/contracts';

export type ViewMode = 'solid' | 'xray' | 'wireframe';

type MaterialRecord = { original: Material; category: PartKey };

export class MaterialStateManager {
	viewMode: ViewMode = 'solid';
	readonly originalMaterials = new Map<string, MaterialRecord>();
	readonly derivedMaterials = new Map<string, Material>();

	register(id: string, material: Material, category: PartKey) {
		this.originalMaterials.set(id, { original: material, category });
	}

	applyMode(mode: ViewMode) { this.viewMode = mode; }

	materialFor(id: string, mode: ViewMode = this.viewMode, highlight = false, dense = false): Material {
		const record = this.originalMaterials.get(id);
		if (!record) throw new Error(`Material ${id} is not registered.`);
		if (mode === 'solid' && !highlight) return record.original;
		const cacheKey = `${id}:${mode}:${highlight ? 'highlight' : 'default'}:${dense ? 'dense' : 'regular'}`;
		const cached = this.derivedMaterials.get(cacheKey);
		const material = cached || derivedMaterial(record.original, mode);
		configureDerivedMaterial(material, record.original, record.category, mode, highlight, dense);
		if (!cached) this.derivedMaterials.set(cacheKey, material);
		return material;
	}

	restoreOriginal() { this.viewMode = 'solid'; }

	dispose() {
		for (const material of this.derivedMaterials.values()) material.dispose();
		this.derivedMaterials.clear();
		this.originalMaterials.clear();
	}
}

function derivedMaterial(original: Material, mode: ViewMode) {
	if ((mode === 'xray' || mode === 'wireframe') && original instanceof MeshStandardMaterial) {
		return new MeshBasicMaterial({ color: original.color, side: DoubleSide, toneMapped: false });
	}
	return original.clone();
}

function configureDerivedMaterial(material: Material, original: Material, category: PartKey, mode: ViewMode, highlight: boolean, dense: boolean) {
	if (material instanceof MeshBasicMaterial && original instanceof MeshStandardMaterial) {
		let programChanged = false;
		material.color.copy(original.color);
		if (material.map !== null) {
			material.map = null;
			programChanged = true;
		}
		if (material.side !== DoubleSide) {
			material.side = DoubleSide;
			programChanged = true;
		}
		const wireframe = mode === 'wireframe';
		if (material.wireframe !== wireframe) {
			material.wireframe = wireframe;
			programChanged = true;
		}
		const transparent = mode === 'xray';
		if (material.transparent !== transparent) {
			material.transparent = transparent;
			programChanged = true;
		}
		if (!material.depthTest) {
			material.depthTest = true;
			programChanged = true;
		}
		// Dense X-Ray writes the nearest translucent layer. This avoids the massive
		// fragment overdraw caused by every hidden face blending through every wall.
		const depthWrite = mode === 'xray' ? dense : true;
		if (material.depthWrite !== depthWrite) {
			material.depthWrite = depthWrite;
			programChanged = true;
		}
		material.opacity = mode === 'xray' ? (highlight ? 0.72 : xrayCategoryOpacity(category)) : 1;
		if (highlight) material.color.lerp(new Color('#2dd4bf'), 0.35);
		if (programChanged) material.needsUpdate = true;
		return;
	}
	if (material instanceof MeshStandardMaterial && original instanceof MeshStandardMaterial) {
		material.copy(original);
		material.side = DoubleSide;
		if (highlight) {
			material.emissive.set('#2dd4bf');
			material.emissiveIntensity = 0.55;
		}
	}
}

export function xrayCategoryOpacity(category: PartKey) {
	if (category === 'doors' || category === 'windows' || category === 'openings') return 0.42;
	if (category === 'furniture' || category === 'structure') return 0.34;
	if (category === 'roof' || category === 'walls') return 0.2;
	return 0.27;
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
