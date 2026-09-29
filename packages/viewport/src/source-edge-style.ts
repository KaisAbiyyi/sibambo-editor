import type { DisplayState, ViewMode } from './material-state.js';
import { displayStateFromLegacyMode, normalizeDisplayState } from './material-state.js';

export type SourceEdgeMaterialDescriptor = {
	color: '#111318';
	transparent: true;
	opacity: number;
	depthTest: boolean;
	depthWrite: false;
};

export function sourceEdgeMaterialDescriptor(input: DisplayState | ViewMode): SourceEdgeMaterialDescriptor {
	const state = typeof input === 'string' ? displayStateFromLegacyMode(input) : normalizeDisplayState(input);
	const xray = state.effects.xray;
	const opacity = xray ? 0.26
		: state.faceStyle === 'wireframe' ? 0.74
		: state.faceStyle === 'hidden-line' ? 0.72
		: state.faceStyle === 'monochrome' ? 0.62
		: 0.58;
	return {
		color: '#111318',
		transparent: true,
		opacity,
		depthTest: !xray,
		depthWrite: false
	};
}
