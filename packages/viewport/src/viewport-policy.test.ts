import { describe, expect, test } from 'bun:test';
import { BufferGeometry, BoxGeometry, Float32BufferAttribute, InstancedMesh, LineBasicMaterial, Matrix4, MOUSE, MeshBasicMaterial, Plane, Raycaster, Sphere, Vector3 } from 'three';
import type { SceneProfile } from '@sibambo/contracts';
import { partitionOccurrenceSourceFaces, resolveSourceFaceIndex } from './source-face-filter';
import { SceneVisibilityIndex, shouldRenderSourceEdge } from './scene-visibility';
import { applyInstancedMeshVisibility, applyMaterialClipPlanes, disposeInstancedMesh, isPointClipped, isReadyAfterRenderedFrame, prepareIndexedGeometry, refreshInstancedMeshBounds } from './viewport-render-state';
import { cameraPresetPose, middleMouseAction, resolveNavigationShortcut } from './camera-navigation';
import { sourceEdgeMaterialDescriptor } from './source-edge-style';
import { displayStateFromLegacyMode, legacyViewModeFromDisplayState, normalizeDisplayState } from './material-state';

describe('prepared viewport policies', () => {
	test('keeps source face selection paired with its occurrence', () => {
		const partitions = partitionOccurrenceSourceFaces([
			{ sourceFaceIndex: 10, occurrenceHandle: 'A' },
			{ sourceFaceIndex: 20, occurrenceHandle: 'B' }
		]);
		expect(partitions.map((item) => [item.occurrenceHandle, [...item.sourceFaceIndices]])).toEqual([['A', [10]], ['B', [20]]]);
	});

	test('resolves a hit triangle using its own solid source-face mapping', () => {
		expect(resolveSourceFaceIndex(0, new Uint32Array([90, 10]))).toBe(90);
		expect(resolveSourceFaceIndex(1, new Uint32Array([90, 10]))).toBe(10);
		expect(resolveSourceFaceIndex(0, new Uint32Array([10, 20, 30]), new Uint32Array([2, 0]))).toBe(30);
	});

	test('computes fallback normals only after installing the selected index', () => {
		const geometry = new BufferGeometry();
		geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
		prepareIndexedGeometry(geometry, new Uint16Array([0, 1, 2, 0, 2, 3]), true);
		expect(geometry.getAttribute('normal').count).toBe(4);
		expect(Array.from(geometry.getAttribute('normal').array)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
		geometry.dispose();
	});

	test('does not report ready before a rendered frame and texture settlement', () => {
		expect(isReadyAfterRenderedFrame(false, 0)).toBe(false);
		expect(isReadyAfterRenderedFrame(true, 1)).toBe(false);
		expect(isReadyAfterRenderedFrame(true, 0)).toBe(true);
	});

	test('applies hidden ancestor and node visibility to hierarchy descendants', () => {
		const scene: SceneProfile = {
			id: 'scene', name: 'Scene', isActiveAtExport: false, source: 'bomc-native', sourceBinding: { provider: 'bomc', persistentId: 'scene' },
			camera: { projection: 'perspective', eyeM: [0, 0, 1], targetM: [0, 0, 0], up: [0, 0, 1] }, useCamera: false,
			transitionTimeSeconds: 0, visibility: { visibleTagIds: [], hiddenTagIds: [], visibleNodeOverrides: [], hiddenNodeOverrides: [], hiddenNodeIndices: [4] },
			storesTagVisibility: true, storesHiddenObjects: true, storesHiddenGeometry: true, storesSectionPlanes: false,
			sectionState: { activeSectionPlaneIds: [], renderingSupport: 'none' }, visibilitySignature: 'scene'
		};
		const visibility = new SceneVisibilityIndex(scene).compileOccurrenceVisibility({
			parentIndices: new Int32Array([-1, 0]), instanceIndices: new Uint32Array([4, 5]), tagIndices: new Int32Array([-1, -1])
		});
		expect([...visibility]).toEqual([0, 0]);
	});

	test('keeps authored source-edge overrides while retaining the legacy hidden-bit rule', () => {
		const native = { source: 'bomc-native' } as SceneProfile;
		const synthetic = { source: 'legacy-synthetic' } as SceneProfile;
		expect(shouldRenderSourceEdge(1, null, null)).toBe(false);
		expect(shouldRenderSourceEdge(1, native, 'shown', ['shown'])).toBe(true);
		expect(shouldRenderSourceEdge(1, native, 'hidden', ['shown'])).toBe(false);
		expect(shouldRenderSourceEdge(1, synthetic, 'legacy', undefined)).toBe(false);
		expect(shouldRenderSourceEdge(0, null, null)).toBe(true);
	});

	test('shares clipping across mesh and line materials and skips clipped-away picks', () => {
		const plane = new Plane(new Vector3(1, 0, 0), 0);
		for (const material of [new MeshBasicMaterial(), new LineBasicMaterial()]) {
			applyMaterialClipPlanes(material, [plane]);
			expect(material.clippingPlanes).toEqual([plane]);
			expect(material.clipIntersection).toBe(false);
			material.dispose();
		}
		expect(isPointClipped(new Vector3(-1, 0, 0), [plane])).toBe(true);
		expect(isPointClipped(new Vector3(1, 0, 0), [plane])).toBe(false);
	});

	test('disposes InstancedMesh-owned GPU instance attributes with the mesh', () => {
		const mesh = new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), 1);
		let disposeEvents = 0;
		mesh.addEventListener('dispose', () => { disposeEvents += 1; });
		disposeInstancedMesh(mesh);
		expect(disposeEvents).toBe(1);
		(mesh.material as MeshBasicMaterial).dispose();
	});

	test('restores distant instance bounds and ray hits when scene visibility changes', () => {
		const geometry = new BoxGeometry(1, 1, 1);
		const material = new MeshBasicMaterial();
		const mesh = new InstancedMesh(geometry, material, 2);
		mesh.setMatrixAt(0, new Matrix4());
		mesh.setMatrixAt(1, new Matrix4().makeTranslation(100, 0, 0));
		const baseMatrices = (mesh.instanceMatrix.array as Float32Array).slice();
		mesh.boundingSphere = new Sphere(new Vector3(), Math.sqrt(3) / 2);

		const hidden = applyInstancedMeshVisibility(mesh, baseMatrices, (index) => index === 0);
		mesh.updateMatrixWorld(true);
		const raycaster = new Raycaster(new Vector3(100, 0, 5), new Vector3(0, 0, -1));
		expect([...hidden]).toEqual([0]);
		expect(raycaster.intersectObject(mesh)).toHaveLength(0);

		const restored = applyInstancedMeshVisibility(mesh, baseMatrices, () => true);
		mesh.updateMatrixWorld(true);
		const hits = raycaster.intersectObject(mesh);
		expect([...restored]).toEqual([0, 1]);
		expect(mesh.boundingSphere?.containsPoint(new Vector3(100, 0, 0))).toBe(true);
		expect(hits.some((hit) => hit.instanceId === 1)).toBe(true);
		geometry.dispose(); material.dispose(); mesh.dispose();
	});

	test('camera presets return a stable model-centred pose with normalized distance', () => {
		const bounds = { min: { x: -2, y: 0, z: -1 }, max: { x: 6, y: 4, z: 3 } };
		const first = cameraPresetPose(bounds, 'iso');
		const afterArbitraryNavigation = cameraPresetPose(bounds, 'iso');
		expect(afterArbitraryNavigation.target.toArray()).toEqual(first.target.toArray());
		expect(afterArbitraryNavigation.position.toArray()).toEqual(first.position.toArray());
		expect(first.target.toArray()).toEqual([2, 2, 1]);
		expect(first.position.distanceTo(first.target)).toBeCloseTo(Math.max(8, 4, 4, 1) * 1.6);
	});

	test('preserves the established navigation shortcuts and middle mouse actions', () => {
		expect(resolveNavigationShortcut('h', 'KeyH')).toBe('pan');
		expect(resolveNavigationShortcut('P', 'KeyP')).toBe('pan');
		expect(resolveNavigationShortcut('r', 'KeyR')).toBe('orbit');
		expect(resolveNavigationShortcut(' ', 'Space')).toBe('orbit');
		expect(resolveNavigationShortcut('p', 'KeyP', true)).toBeNull();
		expect(middleMouseAction()).toBe(MOUSE.ROTATE);
	});

	test('maps legacy display modes onto the richer face-style/effect state', () => {
		expect(displayStateFromLegacyMode('solid')).toEqual({
			faceStyle: 'shaded-textures', effects: { xray: false, ambientOcclusion: false }
		});
		expect(displayStateFromLegacyMode('xray')).toEqual({
			faceStyle: 'shaded-textures', effects: { xray: true, ambientOcclusion: false }
		});
		expect(legacyViewModeFromDisplayState(normalizeDisplayState({
			faceStyle: 'hidden-line', effects: { xray: true, ambientOcclusion: true }
		}))).toBe('xray');
	});

	test('styles authored source edges distinctly for x-ray, wireframe and opaque face styles', () => {
		expect(sourceEdgeMaterialDescriptor('solid')).toEqual({
			color: '#111318', transparent: true, opacity: 0.58, depthTest: true, depthWrite: false
		});
		expect(sourceEdgeMaterialDescriptor('xray')).toEqual({
			color: '#111318', transparent: true, opacity: 0.26, depthTest: false, depthWrite: false
		});
		expect(sourceEdgeMaterialDescriptor('wireframe')).toEqual({
			color: '#111318', transparent: true, opacity: 0.74, depthTest: true, depthWrite: false
		});
		expect(sourceEdgeMaterialDescriptor({
			faceStyle: 'hidden-line', effects: { xray: false, ambientOcclusion: false }
		})).toEqual({
			color: '#111318', transparent: true, opacity: 0.72, depthTest: true, depthWrite: false
		});
	});
});
