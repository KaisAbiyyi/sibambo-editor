import type { EditableEntity, EditableExtrusion, EditablePlanarFace } from '../EditorState';
import { EditableGeometryStore } from '../EditableGeometryStore';

export interface EditorCommand { execute(): void; undo(): void; }

export class CreateShapeCommand implements EditorCommand {
	constructor(private readonly store: EditableGeometryStore, private readonly entity: EditablePlanarFace) {}
	execute() { this.store.set(this.entity); }
	undo() { this.store.delete(this.entity.id); }
}

export class PushPullCommand implements EditorCommand {
	private readonly before: EditableEntity | undefined;
	constructor(private readonly store: EditableGeometryStore, private readonly extrusion: EditableExtrusion) {
		this.before = store.get(extrusion.id) ? structuredClone(store.get(extrusion.id)) : undefined;
	}
	execute() { this.store.set(this.extrusion); }
	undo() { if (this.before) this.store.set(this.before); else this.store.delete(this.extrusion.id); }
}

export class CommandHistory {
	private undoStack: EditorCommand[] = [];
	private redoStack: EditorCommand[] = [];
	execute(command: EditorCommand) { command.execute(); this.undoStack.push(command); this.redoStack = []; }
	undo() { const command = this.undoStack.pop(); if (!command) return false; command.undo(); this.redoStack.push(command); return true; }
	redo() { const command = this.redoStack.pop(); if (!command) return false; command.execute(); this.undoStack.push(command); return true; }
	get canUndo() { return this.undoStack.length > 0; }
	get canRedo() { return this.redoStack.length > 0; }
}
