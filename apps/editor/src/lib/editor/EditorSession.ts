import type { ResearchProvenance } from '@sibambo/contracts';
import { EditableGeometryStore } from './EditableGeometryStore';

export type EditorSourceReference = Readonly<{
	file: File;
	artifactSha256: string;
	modelId: string | null;
	profile: string | null;
	evidenceLevel: 'file-only' | 'provenance-matched';
	provenance: Readonly<ResearchProvenance> | null;
}>;

/** Source evidence is held by reference; edits live only in the Editor-owned store. */
export class EditorSession {
	readonly editableGeometry = new EditableGeometryStore();
	private sourceValue: EditorSourceReference;
	private closed = false;

	constructor(file: File, provenance: ResearchProvenance | null, artifactSha256: string, profile: string | null = provenance?.artifact.profile ?? null) {
		const normalizedHash = artifactSha256.toLowerCase();
		if (!/^[a-f0-9]{64}$/.test(normalizedHash)) throw new Error('Editor source requires a SHA-256 artifact identity.');
		if (provenance) this.assertMatchingProvenance(file, provenance, normalizedHash, profile);
		const frozenProvenance = provenance ? freezeProvenance(provenance) : null;
		this.sourceValue = Object.freeze({
			file,
			artifactSha256: normalizedHash,
			modelId: frozenProvenance?.model.id ?? null,
			profile: profile ?? frozenProvenance?.artifact.profile ?? null,
			evidenceLevel: frozenProvenance ? 'provenance-matched' : 'file-only',
			provenance: frozenProvenance
		});
	}

	get source(): EditorSourceReference { return this.sourceValue; }

	attachProvenance(provenance: ResearchProvenance) {
		if (this.closed) throw new Error('Cannot attach provenance to a closed Editor session.');
		if (this.sourceValue.provenance) throw new Error('This Editor session already has matched provenance.');
		this.assertMatchingProvenance(this.sourceValue.file, provenance, this.sourceValue.artifactSha256, this.sourceValue.profile);
		if (!this.sourceValue.profile) throw new Error('BOMC encoding profile is unavailable; provenance cannot be matched to this session.');
		this.sourceValue = Object.freeze({
			...this.sourceValue,
			modelId: provenance.model.id,
			evidenceLevel: 'provenance-matched',
			provenance: freezeProvenance(provenance)
		});
	}

	get isClosed() { return this.closed; }

	private assertMatchingProvenance(file: File, provenance: ResearchProvenance, artifactSha256: string, profile: string | null) {
		if (provenance.artifact.sha256.toLowerCase() !== artifactSha256) {
			throw new Error('Editor source hash does not match its imported provenance.');
		}
		if (provenance.engine !== 'e4' || provenance.artifact.format !== 'bomc-1.2' || file.size !== provenance.artifact.bytes) {
			throw new Error('Editor sessions require E4 BOMC 1.2 provenance with a matching byte count.');
		}
		if (profile && profile !== provenance.artifact.profile) {
			throw new Error('BOMC encoding profile does not match the admitted provenance profile.');
		}
	}

	dispose() {
		if (this.closed) return;
		this.closed = true;
		this.editableGeometry.clear();
	}
}

function freezeProvenance(provenance: ResearchProvenance): Readonly<ResearchProvenance> {
	return deepFreeze(structuredClone(provenance));
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}
