export { orbitCameraDrag, panCameraDrag } from '@sibambo/viewport/camera-navigation';
export type { CameraPose } from '@sibambo/viewport/camera-navigation';
import type { EditorTool } from './EditorState';

export function temporaryCameraTool(selected: EditorTool, button: number, shiftKey: boolean): EditorTool {
	if (button !== 1) return selected;
	return shiftKey ? 'pan' : 'orbit';
}

export type EditorSelectionModifier = 'replace' | 'add' | 'toggle' | 'subtract';

/** SketchUp-style left-to-right encloses, right-to-left intersects. */
export function selectionDragMode(startX: number, endX: number): 'enclose' | 'intersect' {
	return endX >= startX ? 'enclose' : 'intersect';
}

/** Ctrl adds, Shift toggles, and Ctrl+Shift subtracts occurrences. */
export function selectionModifierMode(ctrlKey: boolean, shiftKey: boolean): EditorSelectionModifier {
	if (ctrlKey && shiftKey) return 'subtract';
	if (ctrlKey) return 'add';
	if (shiftKey) return 'toggle';
	return 'replace';
}

/** Middle or middle+left is camera navigation independent of the active edit tool. */
export function pointerCameraTool(buttons: ReadonlySet<number>, shiftKey: boolean): 'orbit' | 'pan' | null {
	if (!buttons.has(1)) return null;
	return shiftKey || buttons.has(0) ? 'pan' : 'orbit';
}

/** Convert one pinch-distance change into the incremental delta expected by zoomAt. */
export function pinchZoomDelta(previousDistance: number, currentDistance: number): number {
	const previous = Math.max(Number.isFinite(previousDistance) ? previousDistance : 1, 1);
	const current = Math.max(Number.isFinite(currentDistance) ? currentDistance : 1, 1);
	return -Math.log(current / previous) * 1000;
}
