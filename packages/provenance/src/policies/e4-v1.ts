import type { EnginePolicy } from '../index.js';

/** Recorded consumer admission policy; it does not authenticate a producer signature. */
export const E4_PROVENANCE_POLICY_V1: EnginePolicy = {
	engine: 'e4',
	format: 'bomc-1.2',
	profiles: ['exact', 'research', 'visual'],
	producer: {
		sourceTreeSha256: [
			'a5816c9daf958e40865917b234beb95cbafa37c0c035cb47f19bebd39cd9f0eb',
			'34b2e377ee0549aa50384df14b033a4382eebac3e957b2c19b492df0b2f05f00',
			'3ca9bfa66cd7c1228a0852503c75c2aa72a3cf073c4aaeab659fd8836fa3975e',
			'de4f463f5e2cac478fbcc2c9f815ea0b25abf6bba2dbd459fd0232e5d06e76d9',
			// F1J measured candidate source tree (2026-10-21); native qualification remains pending.
			'72a9a4a851a9e927b0cbf0e352daf256cd7cdacf0326ae530fdcf7cf851c86a8'
		]
	}
};
