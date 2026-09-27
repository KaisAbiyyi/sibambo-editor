export type EditorTool = 'select' | 'orbit' | 'pan' | 'tape' | 'rectangle' | 'circle' | 'pushpull';
export type EditorPoint = [number, number, number];

export type EditorPlane = {
	origin: EditorPoint;
	normal: EditorPoint;
	u: EditorPoint;
	v: EditorPoint;
};

export type EditablePlanarFace = {
	id: string;
	kind: 'face';
	shape: 'rectangle' | 'circle' | 'derived';
	plane: EditorPlane;
	outer: EditorPoint[];
	holes: EditorPoint[][];
	color: string;
	sourceSurfaceId?: string;
};

export type EditableExtrusion = {
	id: string;
	kind: 'extrusion';
	base: EditablePlanarFace;
	distance: number;
	color: string;
	sourceSurfaceId?: string;
};

export type EditableEntity = EditablePlanarFace | EditableExtrusion;

export type EditorSelectionHit = {
	point: EditorPoint;
	plane: EditorPlane;
	face: EditablePlanarFace;
	distance: number;
	imported: boolean;
};

export type EditorPreview = {
	entity: EditableEntity | null;
	label: string;
	hover: EditablePlanarFace | null;
};
