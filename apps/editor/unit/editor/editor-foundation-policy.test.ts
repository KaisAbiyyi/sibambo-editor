import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('read-only Editor foundation render policy', () => {
	test('allows prepared Solid geometry because foundation rendering is not edit mode', () => {
		const route = readFileSync(fileURLToPath(new URL('../../src/routes/+page.svelte', import.meta.url)), 'utf8');
		expect(route).toMatch(/encodingProfile:\s*loaded\.encodingContract\?\.profile,\s*editorMode:\s*false/);
	});
});
