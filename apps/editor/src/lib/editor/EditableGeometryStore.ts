import type { EditableEntity } from './EditorState';

export type EditorMutation = { added: string[]; updated: string[]; removed: string[] };

export class EditableGeometryStore {
	private readonly entities = new Map<string, EditableEntity>();
	private readonly listeners = new Set<(mutation: EditorMutation) => void>();

	get size() { return this.entities.size; }
	get(id: string) { return this.entities.get(id); }
	values() { return [...this.entities.values()]; }

	set(entity: EditableEntity) {
		const existed = this.entities.has(entity.id);
		this.entities.set(entity.id, structuredClone(entity));
		this.emit({ added: existed ? [] : [entity.id], updated: existed ? [entity.id] : [], removed: [] });
	}

	delete(id: string) {
		if (!this.entities.delete(id)) return;
		this.emit({ added: [], updated: [], removed: [id] });
	}

	clear() {
		const removed = [...this.entities.keys()];
		this.entities.clear();
		if (removed.length) this.emit({ added: [], updated: [], removed });
	}

	replaceAll(entities: EditableEntity[]) {
		const removed = [...this.entities.keys()];
		this.entities.clear();
		for (const entity of entities) this.entities.set(entity.id, structuredClone(entity));
		this.emit({ added: entities.map((entity) => entity.id), updated: [], removed });
	}

	subscribe(listener: (mutation: EditorMutation) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(mutation: EditorMutation) { for (const listener of this.listeners) listener(mutation); }
}
