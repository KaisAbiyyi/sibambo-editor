import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type RuntimeProofLeaseRecord = {
	schemaVersion: 1;
	runUUID: string;
	repository: string;
	ownerPID: number;
	processCreationIdentity: string;
};

export type RuntimeProofLease = {
	readonly record: RuntimeProofLeaseRecord;
	readonly leasePath: string;
	release(): Promise<boolean>;
};

export type RuntimeProofLeaseOptions = {
	leasePath?: string;
	repository?: string;
	ownerPID?: number;
	processCreationIdentity?: string;
	processIdentityForPID?: (pid: number) => Promise<string | null>;
	waitIntervalMs?: number;
	onWaiting?: (owner: RuntimeProofLeaseRecord, waitedMs: number) => void;
};

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceRoot = path.resolve(editorRoot, '..');
export const sharedRuntimeProofLeasePath = path.join(workspaceRoot, 'docs', 'worklogs', '.sibambo-browser-proof-lease.json');

/** Acquire the workspace-wide heavy browser proof lease without stealing stale ownership. */
export async function acquireRuntimeProofLease(options: RuntimeProofLeaseOptions = {}): Promise<RuntimeProofLease> {
	const leasePath = path.resolve(options.leasePath ?? sharedRuntimeProofLeasePath);
	const parent = path.dirname(leasePath);
	if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
	const parentReal = realpathSync(parent);
	if (path.resolve(parentReal) !== path.resolve(parent)) throw new Error(`Lease parent resolves through a link: ${parent}`);
	const ownerPID = options.ownerPID ?? process.pid;
	if (!Number.isSafeInteger(ownerPID) || ownerPID < 1) throw new Error('Lease ownerPID must be a positive safe integer.');
	const processCreationIdentity = options.processCreationIdentity ?? await getProcessCreationIdentity(ownerPID);
	if (!processCreationIdentity) throw new Error(`Could not establish process creation identity for PID ${ownerPID}.`);
	const record: RuntimeProofLeaseRecord = {
		schemaVersion: 1,
		runUUID: randomUUID(),
		repository: path.resolve(options.repository ?? editorRoot),
		ownerPID,
		processCreationIdentity
	};
	const waitIntervalMs = options.waitIntervalMs ?? 30_000;
	if (!Number.isSafeInteger(waitIntervalMs) || waitIntervalMs < 1 || waitIntervalMs > 30_000) throw new Error('Lease wait interval must be between 1 and 30000 milliseconds.');
	const processIdentityForPID = options.processIdentityForPID ?? getProcessCreationIdentity;
	const startedAt = Date.now();
	let lastNotice = 0;

	for (;;) {
		try {
			writeFileSync(leasePath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
			if (lstatSync(leasePath).isSymbolicLink()) throw new Error('Newly created lease path was replaced by a symbolic link.');
			const leaseRealParent = realpathSync(path.dirname(leasePath));
			if (leaseRealParent !== parentReal) throw new Error('Lease parent identity changed during acquisition.');
			return createOwnedLease(leasePath, record);
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
		}

		const owner = readOwner(leasePath);
		const ownerIdentity = await processIdentityForPID(owner.ownerPID);
		if (!ownerIdentity) throw new Error(`Proof lease is abandoned by PID ${owner.ownerPID}; explicit disposition is required. Lease was not removed: ${leasePath}`);
		if (ownerIdentity !== owner.processCreationIdentity) throw new Error(`Proof lease owner identity disagrees for PID ${owner.ownerPID}; explicit disposition is required. Lease was not removed: ${leasePath}`);
		const waitedMs = Date.now() - startedAt;
		if (waitedMs - lastNotice >= waitIntervalMs) {
			lastNotice = waitedMs;
			options.onWaiting?.(owner, waitedMs);
		}
		await delay(waitIntervalMs);
	}
}

/** Holds the lease for exactly the duration of a heavy proof command. */
export async function withRuntimeProofLease<T>(work: (lease: RuntimeProofLease) => Promise<T>, options: RuntimeProofLeaseOptions = {}): Promise<T> {
	const lease = await acquireRuntimeProofLease(options);
	try {
		return await work(lease);
	} finally {
		await lease.release();
	}
}

function createOwnedLease(leasePath: string, record: RuntimeProofLeaseRecord): RuntimeProofLease {
	let released = false;
	return {
		record,
		leasePath,
		async release() {
			if (released) return false;
			if (!existsSync(leasePath)) throw new Error('Owned proof lease disappeared before release.');
			if (lstatSync(leasePath).isSymbolicLink()) throw new Error('Proof lease path became a symbolic link before release.');
			const current = readOwner(leasePath);
			if (current.runUUID !== record.runUUID) throw new Error('Proof lease UUID changed; refusing to remove another owner’s lease.');
			unlinkSync(leasePath);
			released = true;
			return true;
		}
	};
}

function readOwner(leasePath: string): RuntimeProofLeaseRecord {
	if (lstatSync(leasePath).isSymbolicLink()) throw new Error(`Proof lease cannot be a symbolic link: ${leasePath}`);
	let value: unknown;
	try { value = JSON.parse(readFileSync(leasePath, 'utf8')); }
	catch (error) { throw new Error(`Proof lease is malformed and will not be replaced: ${error instanceof Error ? error.message : String(error)}`); }
	if (!value || typeof value !== 'object') throw new Error('Proof lease metadata is not an object.');
	const row = value as Partial<RuntimeProofLeaseRecord>;
	if (row.schemaVersion !== 1 || typeof row.runUUID !== 'string' || !row.runUUID
		|| typeof row.repository !== 'string' || !path.isAbsolute(row.repository)
		|| !Number.isSafeInteger(row.ownerPID) || (row.ownerPID ?? 0) < 1
		|| typeof row.processCreationIdentity !== 'string' || !row.processCreationIdentity) {
		throw new Error('Proof lease metadata does not match schemaVersion/runUUID/repository/ownerPID/processCreationIdentity.');
	}
	return row as RuntimeProofLeaseRecord;
}

async function getProcessCreationIdentity(pid: number): Promise<string | null> {
	if (process.platform !== 'win32') {
		try {
			process.kill(pid, 0);
			return pid === process.pid ? `node-start-${Math.round(Date.now() - process.uptime() * 1000)}` : null;
		} catch { return null; }
	}
	const script = `(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToUniversalTime().ToString('o')`;
	try {
		const value = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
		return value || null;
	} catch {
		return null;
	}
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function delay(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
