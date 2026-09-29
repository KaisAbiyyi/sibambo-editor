import type { ResearchProvenance } from '@sibambo/contracts';
import { EditableGeometryStore } from './EditableGeometryStore';

export type EditorSourceReference = Readonly<{
	file: File;
	artifactSha256: string;
	modelId: string;
	profile: string;
	provenance: Readonly<ResearchProvenance>;
}>;

/** Source evidence is held by reference; edits live only in the Editor-owned store. */
export class EditorSession {
	readonly editableGeometry = new EditableGeometryStore();
	readonly source: EditorSourceReference;
	private closed = false;

	constructor(file: File, provenance: ResearchProvenance, artifactSha256: string) {
		const normalizedHash = artifactSha256.toLowerCase();
		if (!/^[a-f0-9]{64}$/.test(normalizedHash) || provenance.artifact.sha256.toLowerCase() !== normalizedHash) {
			throw new Error('Editor source hash does not match its imported provenance.');
		}
		if (provenance.engine !== 'e4' || provenance.artifact.format !== 'bomc-1.2' || file.size !== provenance.artifact.bytes) {
			throw new Error('Editor sessions require a verified E4 BOMC 1.2 source with matching byte count.');
		}
		const frozenProvenance = deepFreeze(structuredClone(provenance));
		this.source = Object.freeze({
			file,
			artifactSha256: normalizedHash,
			modelId: provenance.model.id,
			profile: provenance.artifact.profile,
			provenance: frozenProvenance
		});
	}

	get isClosed() { return this.closed; }

	dispose() {
		if (this.closed) return;
		this.closed = true;
		this.editableGeometry.clear();
	}
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}
