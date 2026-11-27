import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../../src/lib/arch/sha256';

describe('sha256Hex', () => {
	test('matches node:crypto for empty, boundary-length and unicode inputs', () => {
		const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(1000), 'dinding — 壁 — 🧱', JSON.stringify({ k: [1, 2, 3] })];
		for (const text of samples) expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'));
	});
});
