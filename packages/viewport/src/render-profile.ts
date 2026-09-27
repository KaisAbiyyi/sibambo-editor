export type RenderProfile = 'auto' | 'cpu-safe';

export function resolveRenderProfile(search: string): RenderProfile {
	const value = new URLSearchParams(search).get('renderProfile')?.toLowerCase();
	return value === 'cpu' || value === 'cpu-safe' ? 'cpu-safe' : 'auto';
}
export function renderProfilePolicy(profile: RenderProfile) {
	return profile === 'cpu-safe'
		? { maxPixelRatio: 1, enableDamping: false, allowWebGpu: false, lazyOverlays: true }
		: { maxPixelRatio: 1.5, enableDamping: false, allowWebGpu: true, lazyOverlays: false };
}
