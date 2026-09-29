import type { EditableEntity } from './EditorState';

export type EditorMutation = { added: string[]; updated: string[]; removed: string[] };
export type OccurrenceTranslation = readonly [number, number, number];
export type OccurrenceTransform = {
	id: string;
	artifactSha256: string;
	occurrenceHandle: string;
	translation: OccurrenceTranslation;
};

export function occurrenceTransformId(artifactSha256: string, occurrenceHandle: string) {
	return `${artifactSha256.toLowerCase()}\u001f${occurrenceHandle}`;
}

export class EditableGeometryStore {
	private readonly entities = new Map<string, EditableEntity>();
	private readonly listeners = new Set<(mutation: EditorMutation) => void>();
	private readonly occurrenceTransforms = new Map<string, OccurrenceTransform>();
	private readonly occurrenceListeners = new Set<(transforms: readonly OccurrenceTransform[]) => void>();

	get size() { return this.entities.size; }
	get(id: string) { return this.entities.get(id); }
	values() { return [...this.entities.values()]; }
	getOccurrenceTransform(id: string) { return this.occurrenceTransforms.get(id); }
	occurrenceTransformsFor(artifactSha256: string) {
		const normalizedHash = artifactSha256.toLowerCase();
		return [...this.occurrenceTransforms.values()].filter((item) => item.artifactSha256 === normalizedHash);
	}

	setOccurrenceTransform(transform: OccurrenceTransform) {
		if (!/^[a-f0-9]{64}$/i.test(transform.artifactSha256) || !transform.occurrenceHandle.trim()) {
			throw new Error('An imported occurrence transform requires an artifact SHA-256 and stable occurrence handle.');
		}
		if (transform.id !== occurrenceTransformId(transform.artifactSha256, transform.occurrenceHandle)) {
			throw new Error('Occurrence transform identity does not match its artifact and imported occurrence.');
		}
		if (!transform.translation.every(Number.isFinite)) throw new Error('Occurrence translation must contain finite coordinates.');
		const normalized = Object.freeze({
			...transform,
			artifactSha256: transform.artifactSha256.toLowerCase(),
			translation: Object.freeze([...transform.translation]) as unknown as OccurrenceTranslation
		});
		this.occurrenceTransforms.set(transform.id, normalized);
		this.emitOccurrenceTransforms();
	}

	deleteOccurrenceTransform(id: string) {
		if (!this.occurrenceTransforms.delete(id)) return;
		this.emitOccurrenceTransforms();
	}

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
		if (this.occurrenceTransforms.size) {
			this.occurrenceTransforms.clear();
			this.emitOccurrenceTransforms();
		}
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

	subscribeOccurrenceTransforms(listener: (transforms: readonly OccurrenceTransform[]) => void) {
		this.occurrenceListeners.add(listener);
		listener([...this.occurrenceTransforms.values()]);
		return () => this.occurrenceListeners.delete(listener);
	}

	private emit(mutation: EditorMutation) { for (const listener of this.listeners) listener(mutation); }
	private emitOccurrenceTransforms() {
		const snapshot = [...this.occurrenceTransforms.values()];
		for (const listener of this.occurrenceListeners) listener(snapshot);
	}
}
