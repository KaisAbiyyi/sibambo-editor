import { WebGLRenderer } from 'three';
import type WebGPURenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';
import { resolveRenderProfile } from './render-profile';

export type ViewerRenderer = WebGLRenderer | WebGPURenderer;
export type RendererBackendName = 'webgl2' | 'webgpu';
export type RendererBackendResult = {
	renderer: ViewerRenderer;
	backend: RendererBackendName;
	initializationMs: number;
	requested: 'webgl2' | 'webgpu' | 'auto';
	fallbackReason?: string;
};

export function resolveRendererRequest(search: string, webGpuAvailable: boolean): 'webgl2' | 'webgpu' | 'auto' {
	if (resolveRenderProfile(search) === 'cpu-safe') return 'webgl2';
	const value = new URLSearchParams(search).get('renderer')?.toLowerCase();
	if (value === 'webgpu') return 'webgpu';
	if (value === 'auto') return webGpuAvailable ? 'auto' : 'webgl2';
	return 'webgl2';
}

/** WebGL2 stays the measured-safe default. `?renderer=webgpu` or `auto` enables the candidate. */
export async function createViewerRenderer(search = window.location.search): Promise<RendererBackendResult> {
	const started = performance.now();
	const webGpuAvailable = Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
	const requested = resolveRendererRequest(search, webGpuAvailable);
	if ((requested === 'webgpu' || requested === 'auto') && webGpuAvailable) {
		try {
			const module = await import('three/webgpu');
			const candidate = new module.WebGPURenderer({ antialias: true, alpha: false });
			await candidate.init();
			return { renderer: candidate, backend: 'webgpu', initializationMs: performance.now() - started, requested };
		} catch (error) {
			const renderer = createWebGlRenderer();
			return {
				renderer, backend: 'webgl2', initializationMs: performance.now() - started, requested,
				fallbackReason: error instanceof Error ? error.message : 'WebGPU initialization failed.'
			};
		}
	}
	const renderer = createWebGlRenderer();
	return {
		renderer, backend: 'webgl2', initializationMs: performance.now() - started, requested,
		fallbackReason: requested === 'webgpu' && !webGpuAvailable ? 'navigator.gpu is unavailable.' : undefined
	};
}

export function isWebGlRenderer(renderer: ViewerRenderer | null): renderer is WebGLRenderer {
	return renderer instanceof WebGLRenderer;
}

function createWebGlRenderer() {
	return new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
}
