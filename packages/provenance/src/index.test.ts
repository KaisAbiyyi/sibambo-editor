import { describe, expect, test } from 'bun:test';
import { validateProvenance, type EnginePolicy } from './index';

const policy: EnginePolicy = {
	engine: 'e4', format: 'bomc-1.2', profiles: ['exact', 'research', 'visual'],
	producer: { sourceTreeSha256: ['a'.repeat(64)] }
};
const provenance = () => ({
	schema: 'sibambo-research-provenance-v1' as const,
	engine: 'e4' as const,
	artifact: { sha256: 'b'.repeat(64), bytes: 128, format: 'bomc-1.2' as const, profile: 'exact' },
	producer: { label: 'recorded', sourceTreeSha256: 'a'.repeat(64) },
	model: { id: 'fixture' },
	capture: { id: 'capture-1', exportedAt: '2026-09-26T00:00:00Z', evidence: 'ledger', method: 'operator-attested' as const }
});

describe('provenance leaf package', () => {
	test('validates caller policy and copies reactive records to plain objects', () => {
		const record = provenance();
		const reactive = new Proxy(record, {});
		const plain = validateProvenance(reactive, policy);
		expect(plain).toEqual(record);
		expect(plain).not.toBe(reactive);
		expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
	});

	test('rejects another engine, unregistered producer, and invalid profile', () => {
		const wrongEngine = provenance(); wrongEngine.engine = 'e3' as never;
		expect(() => validateProvenance(wrongEngine, policy)).toThrow('Wrong engine');
		const wrongProducer = provenance(); wrongProducer.producer.sourceTreeSha256 = 'c'.repeat(64);
		expect(() => validateProvenance(wrongProducer, policy)).toThrow('Unrecognized E4 producer');
		const wrongProfile = provenance(); wrongProfile.artifact.profile = 'legacy';
		expect(() => validateProvenance(wrongProfile, policy)).toThrow('Profile is not valid');
	});
});
