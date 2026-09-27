import type { ViewMode } from './material-state.js';

export type SourceEdgeMaterialDescriptor = {
	color: '#111318';
	transparent: true;
	opacity: number;
	depthTest: true;
	depthWrite: false;
};

/** Keep source-edge rendering aligned with the established model viewport. */
export function sourceEdgeMaterialDescriptor(mode: ViewMode): SourceEdgeMaterialDescriptor {
	return {
		color: '#111318',
		transparent: true,
		opacity: mode === 'xray' ? 0.48 : mode === 'wireframe' ? 0.24 : 0.58,
		depthTest: true,
		depthWrite: false
	};
}
