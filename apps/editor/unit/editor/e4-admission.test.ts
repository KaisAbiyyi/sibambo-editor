import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { E4_PROVENANCE_POLICY_V1 } from '@sibambo/provenance/policies/e4-v1';
import { admitE4File } from '../../src/lib/e4-admission';
import { makeTinyBomc12 } from '../../../../tooling/test-fixtures/tiny-bomc';

const artifactBytes = Buffer.from(makeTinyBomc12());
const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex');
const provenance = {
	schema: 'sibambo-research-provenance-v1',
	engine: 'e4',
	artifact: { sha256: artifactSha256, bytes: artifactBytes.length, format: 'bomc-1.2', profile: 'exact' },
	producer: { label: 'Admission test fixture', sourceTreeSha256: E4_PROVENANCE_POLICY_V1.producer.sourceTreeSha256![0] },
	model: { id: 'admission-test-model' },
	capture: { id: 'admission-test-capture', exportedAt: '2026-09-28T00:00:00.000Z', evidence: 'Generated test fixture.', method: 'operator-attested' }
} as const;

describe('Editor E4 file admission', () => {
	test('admits one structurally valid BOMC file with explicit null provenance', async () => {
		const file = new File([artifactBytes], 'file-only.bomc');
		const admitted = await admitE4File(file);

		expect(admitted.provenance).toBeNull();
		expect(admitted.artifactSha256).toBe(artifactSha256);
		expect(admitted.buffer.byteLength).toBe(file.size);
	});

	test('admits a sidecar only when policy, byte count, and digest match', async () => {
		const file = new File([artifactBytes], 'matched.bomc');
		const admitted = await admitE4File(file, provenance);

		expect(admitted.provenance?.model.id).toBe('admission-test-model');
		expect(admitted.artifactSha256).toBe(artifactSha256);
		await expect(admitE4File(file, { ...provenance, artifact: { ...provenance.artifact, bytes: file.size + 1 } })).rejects.toThrow(/byte count mismatch/i);
		await expect(admitE4File(file, { ...provenance, artifact: { ...provenance.artifact, sha256: 'b'.repeat(64) } })).rejects.toThrow(/SHA-256 mismatch/i);
		await expect(admitE4File(file, { ...provenance, producer: { label: 'Unknown producer', sourceTreeSha256: 'c'.repeat(64) } })).rejects.toThrow(/Unrecognized E4 producer/i);
	});

	test('continues to reject malformed and unsupported BOMC files without a sidecar', async () => {
		const malformed = new File([new Uint8Array([1, 2, 3])], 'malformed.bomc');
		const wrongVersion = Buffer.from(artifactBytes);
		wrongVersion.writeUInt16LE(3, 10);

		await expect(admitE4File(malformed)).rejects.toThrow(/BOMC 1\.2/i);
		await expect(admitE4File(new File([wrongVersion], 'legacy.bomc'))).rejects.toThrow(/BOMC 1\.2 only/i);
	});
});
