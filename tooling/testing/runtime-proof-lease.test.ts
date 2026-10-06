import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireRuntimeProofLease, withRuntimeProofLease, type RuntimeProofLeaseOptions } from './runtime-proof-lease.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) if (existsSync(root)) rmSync(root, { recursive: true, force: true }); });

describe('shared heavy-proof lease ownership', () => {
	test('queues behind one matching live owner, then acquires after that exact lease is released', async () => {
		const leasePath = newLeasePath();
		const identities = new Map([[101, 'owner-101-start'], [202, 'owner-202-start']]);
		const processIdentityForPID = async (pid: number) => identities.get(pid) ?? null;
		const first = await acquireRuntimeProofLease({ leasePath, ownerPID: 101, processCreationIdentity: 'owner-101-start', processIdentityForPID });
		let waiting!: () => void;
		const noticed = new Promise<void>((resolve) => { waiting = resolve; });
		const secondPromise = acquireRuntimeProofLease({
			leasePath, ownerPID: 202, processCreationIdentity: 'owner-202-start', processIdentityForPID,
			waitIntervalMs: 10, onWaiting: () => waiting()
		});
		await noticed;
		expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toMatchObject({ schemaVersion: 1, runUUID: first.record.runUUID, ownerPID: 101 });
		await first.release();
		const second = await secondPromise;
		expect(second.record.ownerPID).toBe(202);
		expect(JSON.parse(readFileSync(leasePath, 'utf8')).runUUID).toBe(second.record.runUUID);
		await second.release();
		expect(existsSync(leasePath)).toBe(false);
	});

	test('refuses stale or mismatched process identity without deleting the incumbent lease', async () => {
		const leasePath = newLeasePath();
		const owner = { schemaVersion: 1, runUUID: 'other-run', repository: 'D:/projects/sibambo/sibambo-editor', ownerPID: 303, processCreationIdentity: 'old-process' };
		writeFileSync(leasePath, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
		await expect(acquireRuntimeProofLease({ leasePath, ownerPID: 404, processCreationIdentity: 'new-process', processIdentityForPID: async () => 'reused-pid' })).rejects.toThrow(/identity disagrees/);
		expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toEqual(owner);
	});

	test('release checks the UUID and leaves a replacement owner untouched', async () => {
		const leasePath = newLeasePath();
		const lease = await acquireRuntimeProofLease(options(leasePath, 505, 'owner-505-start'));
		const replacement = { ...lease.record, runUUID: 'replacement-run' };
		writeFileSync(leasePath, `${JSON.stringify(replacement)}\n`);
		await expect(lease.release()).rejects.toThrow(/UUID changed/);
		expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toEqual(replacement);
	});

	test('releases the owned lease when the proof command throws', async () => {
		const leasePath = newLeasePath();
		const failure = new Error('proof command failed');
		await expect(withRuntimeProofLease(async () => { throw failure; }, options(leasePath, 606, 'owner-606-start'))).rejects.toBe(failure);
		expect(existsSync(leasePath)).toBe(false);
	});
});

function newLeasePath() {
	const root = mkdtempSync(path.join(os.tmpdir(), 'sibambo-proof-lease-'));
	roots.push(root);
	return path.join(root, '.sibambo-browser-proof-lease.json');
}

function options(leasePath: string, ownerPID: number, processCreationIdentity: string): RuntimeProofLeaseOptions {
	return { leasePath, ownerPID, processCreationIdentity, processIdentityForPID: async () => processCreationIdentity, waitIntervalMs: 10 };
}
