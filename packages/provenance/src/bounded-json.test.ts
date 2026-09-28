import { describe, expect, test } from 'bun:test';
import { MAX_SELECTED_JSON_BYTES, readBoundedJsonText } from './index';

describe('bounded JSON file reads', () => {
	test('accepts an input at the exact byte limit', async () => {
		const file = { size: MAX_SELECTED_JSON_BYTES, text: async () => '{"ok":true}' } as Blob;
		expect(await readBoundedJsonText(file)).toBe('{"ok":true}');
	});

	test('rejects an oversized input before reading it', async () => {
		let read = false;
		const file = { size: MAX_SELECTED_JSON_BYTES + 1, text: async () => { read = true; return '{}'; } } as Blob;
		await expect(readBoundedJsonText(file, 'Provenance sidecar')).rejects.toThrow(/4 MiB/);
		expect(read).toBe(false);
	});

	test('rejects an invalid size before reading it', async () => {
		let read = false;
		const file = { size: Number.NaN, text: async () => { read = true; return '{}'; } } as Blob;
		await expect(readBoundedJsonText(file)).rejects.toThrow(/4 MiB/);
		expect(read).toBe(false);
	});
});
