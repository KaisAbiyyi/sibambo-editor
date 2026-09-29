export { orbitCameraDrag, panCameraDrag } from '@sibambo/viewport/camera-navigation';
export type { CameraPose } from '@sibambo/viewport/camera-navigation';
import type { EditorTool } from './EditorState';

export function temporaryCameraTool(selected: EditorTool, button: number, shiftKey: boolean): EditorTool {
	if (button !== 1) return selected;
	return shiftKey ? 'pan' : 'orbit';
}
