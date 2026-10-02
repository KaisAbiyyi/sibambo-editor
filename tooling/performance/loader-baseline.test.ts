import { describe, it, expect } from 'bun:test';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { computePercentiles } from './baseline-stats.ts';
import { inventorySingleFixture, type FixtureManifest } from './bomc-inventory.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workspaceRoot = resolve(__dirname, '../../..');

describe('loader-baseline manifest & inventory verification', () => {
	const manifestPath = join(__dirname, 'fixtures.json');
	const manifest: FixtureManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

	it('should verify all eight manifest fixtures exist with exact bytes and SHA-256', async () => {
		expect(manifest.fixtures).toHaveLength(8);

		for (const fixture of manifest.fixtures) {
			const result = await inventorySingleFixture(fixture, workspaceRoot);
			expect(result.bytesMatch).toBe(true);
			expect(result.hashMatch).toBe(true);
			expect(result.bytes).toBe(fixture.bytes);
			expect(result.sha256).toBe(fixture.sha256.toLowerCase());
			expect(result.header.major).toBe(1);
			expect(result.header.minor).toBeLessThanOrEqual(2);
		}
	});

	it('should reject a mutated fixture with hash mismatch before any run', async () => {
		const targetFixture = manifest.fixtures[0]; // S1-new
		const sourcePath = resolve(workspaceRoot, targetFixture.locator);
		const tempPath = join(tmpdir(), `mutated-${Date.now()}-${targetFixture.id}.bomc`);

		try {
			const originalBytes = readFileSync(sourcePath);
			const mutatedBytes = new Uint8Array(originalBytes);
			// Mutate a single byte in the payload
			mutatedBytes[100] = (mutatedBytes[100] ^ 0xff);
			writeFileSync(tempPath, mutatedBytes);

			const mutatedFixture = {
				...targetFixture,
				locator: tempPath
			};

			// Should throw hash mismatch error
			let errorThrown: Error | null = null;
			try {
				await inventorySingleFixture(mutatedFixture, '/');
			} catch (err) {
				errorThrown = err as Error;
			}

			expect(errorThrown).not.toBeNull();
			expect(errorThrown?.message).toContain('Hash mismatch');
		} finally {
			if (existsSync(tempPath)) {
				unlinkSync(tempPath);
			}
		}
	});
});

describe('loader-baseline percentile and failure preservation', () => {
	it('should compute correct median and nearest-rank P95 for 10 known durations', () => {
		const tenDurations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
		const stats = computePercentiles(tenDurations, 0, 0);

		expect(stats.count).toBe(10);
		// P50 is average of 5th (500) and 6th (600) element
		expect(stats.p50).toBe(550);
		// P95 for n=10: ceil(0.95 * 10) = 10th element -> 1000
		expect(stats.p95).toBe(1000);
		expect(stats.min).toBe(100);
		expect(stats.max).toBe(1000);
		expect(stats.mean).toBe(550);
	});

	it('should compute correct P50 and P95 for 20 known durations', () => {
		// 100, 200, ..., 2000
		const twentyDurations = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
		const stats = computePercentiles(twentyDurations, 0, 0);

		expect(stats.count).toBe(20);
		// P50 is average of 10th (1000) and 11th (1100) -> 1050
		expect(stats.p50).toBe(1050);
		// P95 for n=20: ceil(0.95 * 20) = 19th element -> 1900
		expect(stats.p95).toBe(1900);
	});

	it('should retain failed rows and timeouts separately without zero-duration omission', () => {
		const durations = [500, 600, 700];
		const failedCount = 2;
		const timeoutsCount = 1;
		const stats = computePercentiles(durations, failedCount, timeoutsCount);

		expect(stats.count).toBe(3);
		expect(stats.failedCount).toBe(2);
		expect(stats.timeoutsCount).toBe(1);
		// P50 must be 600 (middle of valid durations)
		expect(stats.p50).toBe(600);
		// Failed count must not be silently replaced by 0 or excluded
		expect(stats.failedCount + stats.timeoutsCount).toBe(3);
	});
});
