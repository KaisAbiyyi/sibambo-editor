import { isBomcBuffer } from '@sibambo/e4-import';
import { sha256, validateProvenance } from '@sibambo/provenance';
import { E4_PROVENANCE_POLICY_V1 } from '@sibambo/provenance/policies/e4-v1';
import type { ResearchProvenance } from '@sibambo/contracts';

export async function admitE4File(file: File, sidecar: unknown) {
	if (file.size <= 0) throw new Error('E4 artifact is empty.');
	const provenance = validateProvenance(sidecar, E4_PROVENANCE_POLICY_V1) as ResearchProvenance;
	if (provenance.artifact.bytes !== file.size) throw new Error('Artifact byte count mismatch: provenance belongs to another file.');
	const buffer = await file.arrayBuffer();
	const artifactSha256 = await sha256(buffer);
	if (artifactSha256 !== provenance.artifact.sha256.toLowerCase()) throw new Error('Artifact SHA-256 mismatch: provenance belongs to another file.');
	if (!isBomcBuffer(buffer)) throw new Error('Editor accepts BOMC 1.2 only. No compatibility fallback is available.');
	const header = new DataView(buffer);
	if (header.getUint16(8, true) !== 1 || header.getUint16(10, true) !== 2) throw new Error('Editor accepts BOMC 1.2 only; legacy versions are rejected.');
	return { buffer, provenance, artifactSha256 };
}
