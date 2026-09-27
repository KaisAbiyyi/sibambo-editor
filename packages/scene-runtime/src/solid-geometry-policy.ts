import type { ViewMode } from '@sibambo/contracts';

export type SolidGeometryPolicyInput = {
	viewMode: ViewMode;
	editorMode: boolean;
	encodingProfile?: 'exact' | 'research' | 'visual';
};

/** Solid-mode suppression is a visual optimization and never alters Exact geometry. */
export function shouldUseSuppressedSolidGeometry(input: SolidGeometryPolicyInput): boolean {
	return input.viewMode === 'solid' && !input.editorMode && input.encodingProfile !== 'exact';
}

export function shouldPrepareSuppressedSolidGeometry(
	requested: boolean | undefined,
	encodingProfile?: 'exact' | 'research' | 'visual'
): boolean {
	return requested === true && encodingProfile !== 'exact';
}
