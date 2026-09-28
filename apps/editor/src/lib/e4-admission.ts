import { isBomcBuffer } from '@sibambo/e4-import';
import { sha256, validateProvenance } from '@sibambo/provenance';
import { E4_PROVENANCE_POLICY_V1 } from '@sibambo/provenance/policies/e4-v1';
import type { ResearchProvenance } from '@sibambo/contracts';

const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

export async function admitE4File(file: File, sidecar?: unknown) {
	if (file.size <= 0 || file.size > MAX_ARTIFACT_BYTES) throw new Error('E4 artifact is empty or exceeds the 256 MiB limit.');
	const provenance = sidecar === undefined ? null : validateProvenance(sidecar, E4_PROVENANCE_POLICY_V1) as ResearchProvenance;
	if (provenance && provenance.artifact.bytes !== file.size) throw new Error('Artifact byte count mismatch: provenance belongs to another file.');
	const buffer = await file.arrayBuffer();
	if (!isBomcBuffer(buffer)) throw new Error('Editor accepts BOMC 1.2 only. No compatibility fallback is available.');
	if (buffer.byteLength < 12) throw new Error('BOMC invalid: truncated version header.');
	const header = new DataView(buffer);
	if (header.getUint16(8, true) !== 1 || header.getUint16(10, true) !== 2) throw new Error('Editor accepts BOMC 1.2 only; legacy versions are rejected.');
	const artifactSha256 = await sha256(buffer);
	if (provenance && artifactSha256 !== provenance.artifact.sha256.toLowerCase()) throw new Error('Artifact SHA-256 mismatch: provenance belongs to another file.');
	return { buffer, provenance, artifactSha256 };
}
