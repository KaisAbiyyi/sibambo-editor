import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
	acceleratedCaseDefinitions, acceleratedFixturesForSuite, acceleratedReferencesForSuite,
	acceleratedSpecAndConfig, captureAcceleratedSourceIdentity, claimAcceleratedAttempt,
	finalizeAcceleratedAttempt, sameAcceleratedIdentity, type AcceleratedColdCycle, type AcceleratedRuntime,
	type AcceleratedSuite, type AcceleratedPlaywrightReport
} from './accelerated-proof';
import { withRuntimeProofLease } from './runtime-proof-lease.js';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const topicRoot = path.resolve(editorRoot, '..', 'docs', 'worklogs', 'EDITOR-ACCELERATED-001');
const playwrightCli = path.join(editorRoot, 'node_modules', '@playwright', 'test', 'cli.js');
const defaultNodePath = 'C:/Users/kaisa/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe';
const portBySuite: Record<AcceleratedSuite, number> = { profiles: 5203, 'current-cold': 5198, 'current-semantic': 5202 };

type Arguments = {
	mode: 'discover' | 'run'; suite: AcceleratedSuite; root: string; attempt: number;
	cycle?: AcceleratedColdCycle; cacheReceipt?: string; previousReceipt?: string;
};
type ProcessRow = { pid: number; parentProcessId: number; name: string; creationDate: string };
type ChildResult = {
	exitCode: number | null; signal: string | null; pid: number | null; spawnError: string | null;
	stdout: string; stderr: string; preexistingProcesses: ProcessRow[]; witnessedProcesses: ProcessRow[]; processSnapshotErrors: string[];
};

async function main() {
	const args = parseArguments(process.argv.slice(2));
	if (!path.isAbsolute(args.root)) throw new Error('--root must be an absolute path.');
	if (!pathExistsWithinTopic(args.root)) throw new Error('--root must be a strict child of docs/worklogs/EDITOR-ACCELERATED-001.');
	if (!existsSync(defaultNodePath) && !process.env.SIBAMBO_NODE_PATH) throw new Error(`The pinned Node runtime is unavailable: ${defaultNodePath}`);
	if (!existsSync(playwrightCli)) throw new Error(`The installed Playwright CLI is unavailable: ${playwrightCli}`);
	return await withRuntimeProofLease(
		async () => {
			const runtime = captureRuntime();
			if (args.mode === 'discover') return await discover(args, runtime);
			return await run(args, runtime);
		},
		{ repository: editorRoot, onWaiting: (owner, waitedMs) => process.stderr.write(`Heavy proof lease held by ${owner.repository} PID ${owner.ownerPID}; waited ${Math.round(waitedMs / 1000)}s.\n`) }
	);
}

function parseArguments(argv: string[]): Arguments {
	const [modeValue, ...rest] = argv;
	if (modeValue !== 'discover' && modeValue !== 'run') throw new Error('Usage: bun tooling/testing/run-accelerated-proof.ts discover|run --suite profiles|current-cold|current-semantic --root <absolute new run root> --attempt 1|2 [--cycle cold-01|cold-02|cold-03|warm-01] [--cache-receipt <cold-03 receipt>] [--previous-receipt <attempt-1 setup receipt>]');
	const values = new Map<string, string>();
	for (let index = 0; index < rest.length; index += 1) {
		const key = rest[index];
		if (!key?.startsWith('--')) throw new Error(`Unexpected positional argument: ${key ?? ''}`);
		if (values.has(key)) throw new Error(`Duplicate flag: ${key}`);
		const value = rest[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
		values.set(key, value); index += 1;
	}
	for (const key of values.keys()) if (!['--suite', '--root', '--attempt', '--cycle', '--cache-receipt', '--previous-receipt'].includes(key)) throw new Error(`Unknown flag: ${key}`);
	const suite = values.get('--suite');
	if (suite !== 'profiles' && suite !== 'current-cold' && suite !== 'current-semantic') throw new Error('--suite must be profiles, current-cold, or current-semantic.');
	const root = values.get('--root');
	if (!root) throw new Error('--root is required.');
	const attemptValue = values.get('--attempt');
	if (attemptValue !== '1' && attemptValue !== '2') throw new Error('--attempt must be 1 or 2.');
	const cycleValue = values.get('--cycle');
	const cacheReceipt = values.get('--cache-receipt');
	const previousReceipt = values.get('--previous-receipt');
	if (suite === 'current-cold') {
		if (cycleValue !== 'cold-01' && cycleValue !== 'cold-02' && cycleValue !== 'cold-03' && cycleValue !== 'warm-01') throw new Error('current-cold requires --cycle cold-01|cold-02|cold-03|warm-01.');
		if (cycleValue === 'warm-01' && modeValue === 'run' && !cacheReceipt) throw new Error('warm-01 run requires --cache-receipt with the passed cold-03 receipt.');
		if (cycleValue === 'warm-01' && modeValue === 'discover' && cacheReceipt) throw new Error('Discovery does not consume a cold cache receipt.');
		if (cycleValue !== 'warm-01' && cacheReceipt) throw new Error('--cache-receipt is allowed only for warm-01.');
	} else if (cycleValue || cacheReceipt) throw new Error('--cycle and --cache-receipt are valid only for current-cold.');
	if (modeValue === 'discover' && previousReceipt) throw new Error('Discovery never consumes a previous receipt.');
	if (cacheReceipt && !path.isAbsolute(cacheReceipt)) throw new Error('--cache-receipt must be an absolute path.');
	if (previousReceipt && !path.isAbsolute(previousReceipt)) throw new Error('--previous-receipt must be an absolute path.');
	return { mode: modeValue, suite, root: path.resolve(root), attempt: Number(attemptValue), cycle: cycleValue as AcceleratedColdCycle | undefined, cacheReceipt, previousReceipt };
}

function captureRuntime(): AcceleratedRuntime {
	const nodePath = path.resolve(process.env.SIBAMBO_NODE_PATH ?? defaultNodePath);
	if (!existsSync(nodePath)) throw new Error(`The selected Node runtime is unavailable: ${nodePath}`);
	const node = execFileSync(nodePath, ['--version'], { cwd: editorRoot, encoding: 'utf8' }).trim();
	const bun = execFileSync('bun', ['--version'], { cwd: editorRoot, encoding: 'utf8' }).trim();
	const playwright = (JSON.parse(readFileSync(path.join(editorRoot, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')) as { version: string }).version;
	const browserPath = chromium.executablePath();
	if (!existsSync(browserPath)) throw new Error(`The pinned Playwright Chromium executable is unavailable: ${browserPath}`);
	const browserInstallDirectory = path.dirname(path.dirname(browserPath));
	const browserRevision = path.basename(browserInstallDirectory).match(/^chromium-(\d+)$/)?.[1];
	if (!browserRevision) throw new Error(`The pinned Playwright Chromium path has no recognized revision: ${browserPath}`);
	const browserCacheDirectory = path.dirname(browserInstallDirectory);
	const headlessShellPath = path.join(browserCacheDirectory, `chromium_headless_shell-${browserRevision}`, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
	if (!existsSync(headlessShellPath)) throw new Error(`The pinned Playwright Chromium headless shell is unavailable: ${headlessShellPath}`);
	const browserVersion = execFileSync(headlessShellPath, ['--version'], { cwd: editorRoot, encoding: 'utf8', timeout: 15_000 }).trim();
	if (!browserVersion) throw new Error('The pinned Chromium headless shell returned an empty version string.');
	return { node, nodePath, bun, playwright, browser: 'chromium', browserVersion, backend: 'chromium-headless-webgl2' };
}

async function discover(args: Arguments, runtime: AcceleratedRuntime) {
	const fixtures = acceleratedFixturesForSuite(args.suite);
	const references = acceleratedReferencesForSuite(args.suite);
	const before = captureAcceleratedSourceIdentity({ fixtures, references });
	const definitions = acceleratedCaseDefinitions(args.suite, args.cycle ?? null, fixtures.map((row) => row.id));
	const paths = acceleratedSpecAndConfig(args.suite);
	const child = await spawnCaptured(runtime.nodePath, [playwrightCli, 'test', '--config', paths.configPath, path.basename(paths.specPath), '--list', '--reporter=list', '--grep', titleGrep(definitions.map((row) => row.title))], discoveryEnvironment());
	const listed = parseListOutput(child.stdout, definitions.map((row) => row.title));
	const after = captureAcceleratedSourceIdentity({ fixtures, references });
	const passed = child.exitCode === 0 && !child.signal && child.spawnError === null
		&& sameAcceleratedIdentity(before, after) && listed.join('\0') === definitions.map((row) => row.title).join('\0');
	const receipt = {
		mode: 'discover', suite: args.suite, cycle: args.cycle ?? null, attempt: args.attempt, executionRoot: args.root, runtime,
		config: paths.configPath, spec: paths.specPath, expectedTitles: definitions.map((row) => row.title), listedTitles: listed,
		sourceIdentityUnchanged: sameAcceleratedIdentity(before, after), child: { exitCode: child.exitCode, signal: child.signal, spawnError: child.spawnError },
		stdout: child.stdout, stderr: child.stderr, verdict: passed ? 'pass' : 'fail'
	};
	process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
	if (!passed) process.exitCode = 1;
}

async function run(args: Arguments, runtime: AcceleratedRuntime) {
	const port = portBySuite[args.suite];
	const portBefore = inspectPort(port);
	if (portBefore.length) throw new Error(`Strict port ${port} is occupied before ${args.suite}; owners=${JSON.stringify(portBefore)}`);
	const ticket = claimAcceleratedAttempt({
		suite: args.suite, executionRoot: args.root, attempt: args.attempt, runtime, cycle: args.cycle,
		cacheSourceReceipt: args.cacheReceipt ?? null, previousReceipt: args.previousReceipt ?? null
	});
	writeFileSync(ticket.stdoutFile, '', { flag: 'wx' });
	writeFileSync(ticket.stderrFile, '', { flag: 'wx' });
	const env = runEnvironment(ticket);
	const child = await spawnCaptured(runtime.nodePath, [playwrightCli, 'test', '--config', ticket.configPath, path.basename(ticket.specPath), '--grep', titleGrep(ticket.testTitles)], env, ticket.stdoutFile, ticket.stderrFile);
	const report = readOptionalReport(ticket.reportFile);
	const cleanup = inspectCleanup(port, child.pid, child.preexistingProcesses, child.witnessedProcesses, child.processSnapshotErrors);
	const identityAfter = captureAcceleratedSourceIdentity({
		fixtures: acceleratedFixturesForSuite(ticket.suite), references: acceleratedReferencesForSuite(ticket.suite)
	});
	const stdout = `${child.stdout}${child.spawnError ? `\n${child.spawnError}` : ''}`;
	const stderr = child.stderr;
	const receipt = finalizeAcceleratedAttempt({
		ticket, report, child: { exitCode: child.exitCode, signal: child.signal ?? (child.spawnError ? 'spawn-error' : null) },
		cleanup, identityAfter, stdout, stderr
	});
	writeFileSync(ticket.finalReceiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
	process.stdout.write(`${JSON.stringify({
		suite: ticket.suite, cycle: ticket.cycle, attempt: ticket.attempt, gate: receipt.gate, retryEligible: receipt.retryEligible,
		executionRoot: ticket.executionRoot, ticketFile: ticket.ticketFile, runUUID: ticket.runUUID, nonce: ticket.nonce,
		testedHead: ticket.testedHead, identitySha256: ticket.identitySha256,
		finalReceipt: ticket.finalReceiptFile, playwrightReport: ticket.reportFile,
		errorCount: receipt.errors.length, errors: receipt.errors, cleanup
	}, null, 2)}\n`);
	if (receipt.gate !== 'passed') process.exitCode = 1;
}

function discoveryEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, SIBAMBO_ACCELERATED_DISCOVERY: '1' };
	delete env.SIBAMBO_ACCELERATED_TICKET; delete env.SIBAMBO_ACCELERATED_NONCE; delete env.SIBAMBO_ACCELERATED_RUN_ROOT;
	return env;
}

function runEnvironment(ticket: ReturnType<typeof claimAcceleratedAttempt>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) if (/^SIBAMBO_(?:PROOF_|RECOVERY_|STABILITY_|M2_|WRITER_|AUTHORING_)/.test(key)) delete env[key];
	env.SIBAMBO_ACCELERATED_DISCOVERY = '0';
	env.SIBAMBO_ACCELERATED_TICKET = ticket.ticketFile;
	env.SIBAMBO_ACCELERATED_NONCE = ticket.nonce;
	env.SIBAMBO_ACCELERATED_RUN_ROOT = ticket.executionRoot;
	return env;
}

function titleGrep(titles: string[]) {
	return `(?:${titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
}

function parseListOutput(output: string, expected: string[]) {
	const titleLines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes('›'));
	return titleLines.map((line) => expected.find((title) => line.endsWith(title)) ?? `UNEXPECTED:${line}`);
}

function readOptionalReport(filePath: string): AcceleratedPlaywrightReport | null {
	try { return JSON.parse(readFileSync(filePath, 'utf8')) as AcceleratedPlaywrightReport; }
	catch { return null; }
}

async function spawnCaptured(binary: string, argv: string[], env: NodeJS.ProcessEnv, stdoutPath?: string, stderrPath?: string): Promise<ChildResult> {
	const preexistingProcesses = snapshotProcesses();
	const child = spawn(binary, argv, { cwd: editorRoot, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
	const output: string[] = [];
	const errors: string[] = [];
	const witnessed = new Map<string, ProcessRow>();
	const processSnapshotErrors: string[] = [];
	const preexistingKeys = new Set(preexistingProcesses.map(processKey));
	let monitor: ReturnType<typeof setInterval> | undefined;
	const rememberDescendants = () => {
		if (!child.pid) return;
		try {
			const rows = snapshotProcesses();
			const descendantPids = new Set(descendants(child.pid, rows));
			for (const row of rows) if (descendantPids.has(row.pid) && !preexistingKeys.has(processKey(row))) witnessed.set(processKey(row), row);
		} catch (error) { processSnapshotErrors.push(message(error)); }
	};
	const readStream = (stream: NodeJS.ReadableStream | null, chunks: string[], filePath: string | undefined, destination: NodeJS.WriteStream) => {
		stream?.on('data', (chunk: Buffer | string) => {
			const value = chunk.toString(); chunks.push(value); destination.write(value);
			if (filePath) writeFileSync(filePath, value, { flag: 'a' });
		});
	};
	readStream(child.stdout, output, stdoutPath, process.stdout);
	readStream(child.stderr, errors, stderrPath, process.stderr);
	if (child.pid) { rememberDescendants(); monitor = setInterval(rememberDescendants, 1_000); }
	const close = new Promise<{ exitCode: number | null; signal: string | null; spawnError: string | null }>((resolve) => {
		let spawnError: string | null = null;
		child.once('error', (error) => { spawnError = message(error); });
		child.once('close', (code, signal) => resolve({ exitCode: code, signal, spawnError }));
	});
	const result = await close;
	if (monitor) clearInterval(monitor);
	rememberDescendants();
	return {
		...result, pid: child.pid ?? null, stdout: output.join(''), stderr: errors.join(''),
		preexistingProcesses, witnessedProcesses: [...witnessed.values()], processSnapshotErrors
	};
}

function inspectCleanup(port: number, rootPid: number | null, preexistingProcesses: ProcessRow[], witnessedProcesses: ProcessRow[], processSnapshotErrors: string[]) {
	const errors: string[] = [];
	if (processSnapshotErrors.length) errors.push(`Process ownership sampling had errors: ${processSnapshotErrors.join(' | ')}`);
	const before = new Set(preexistingProcesses.map(processKey));
	let rows: ProcessRow[] = [];
	try { rows = snapshotProcesses(); } catch (error) { errors.push(`Could not inspect process ownership: ${message(error)}`); }
	const owned = new Map(witnessedProcesses.map((row) => [processKey(row), row]));
	if (rootPid !== null) {
		for (const row of rows) if (descendants(rootPid, rows).includes(row.pid) && !before.has(processKey(row))) owned.set(processKey(row), row);
	}
	const remaining = [...owned.values()].filter((row) => rows.some((current) => processKey(current) === processKey(row)));
	if (remaining.length) {
		try { stopExactProcesses(remaining); } catch (error) { errors.push(`Could not stop exact owned descendants: ${message(error)}`); }
	}
	let afterRows: ProcessRow[] = [];
	try { afterRows = snapshotProcesses(); } catch (error) { errors.push(`Could not confirm process cleanup: ${message(error)}`); }
	const stillRunning = remaining.filter((row) => afterRows.some((current) => processKey(current) === processKey(row)));
	if (stillRunning.length) errors.push(`Owned descendants remain alive: ${stillRunning.map((row) => row.pid).join(',')}`);
	let portOwners: Array<{ localPort: number; owningProcess: number }> = [];
	try { portOwners = inspectPort(port); } catch (error) { errors.push(`Could not inspect strict port ${port}: ${message(error)}`); }
	if (portOwners.length) errors.push(`Strict port ${port} remains occupied: ${JSON.stringify(portOwners)}`);
	return { passed: errors.length === 0, details: { rootPid, ownedDescendants: [...owned.values()], terminatedOwnedPids: remaining.map((row) => ({ pid: row.pid, creationDate: row.creationDate })), stillRunning: stillRunning.map((row) => ({ pid: row.pid, creationDate: row.creationDate })), port, portOwners, errors } };
}

function snapshotProcesses(): ProcessRow[] {
	if (process.platform !== 'win32') return [];
	const script = 'Get-CimInstance Win32_Process | Select-Object @{Name="pid";Expression={$_.ProcessId}},@{Name="parentProcessId";Expression={$_.ParentProcessId}},@{Name="name";Expression={$_.Name}},@{Name="creationDate";Expression={$_.CreationDate.ToString()}} | ConvertTo-Json -Compress';
	const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	if (!output) return [];
	const parsed = JSON.parse(output) as ProcessRow | ProcessRow[];
	return Array.isArray(parsed) ? parsed : [parsed];
}

function descendants(rootPid: number, rows: ProcessRow[]) {
	const found = new Set<number>([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) if (found.has(row.parentProcessId) && !found.has(row.pid)) { found.add(row.pid); changed = true; }
	}
	found.delete(rootPid); return [...found];
}

function stopExactProcesses(rows: ProcessRow[]) {
	if (!rows.length || process.platform !== 'win32') return;
	if (rows.some((row) => !Number.isSafeInteger(row.pid) || row.pid < 1 || !row.creationDate)) throw new Error('Refusing to stop a process without exact PID and creation identity.');
	const encodedRows = Buffer.from(JSON.stringify(rows.map(({ pid, creationDate }) => ({ pid, creationDate }))), 'utf8').toString('base64');
	const script = `$targets = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRows}')) | ConvertFrom-Json; foreach ($target in $targets) { $p = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$target.pid) -ErrorAction SilentlyContinue; if ($p -and $p.CreationDate.ToString() -ceq [string]$target.creationDate) { Stop-Process -Id ([int]$target.pid) -Force -ErrorAction SilentlyContinue } }`;
	execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function inspectPort(port: number) {
	if (process.platform !== 'win32') return [] as Array<{ localPort: number; owningProcess: number }>;
	const script = `$rows = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object @{Name="localPort";Expression={$_.LocalPort}},@{Name="owningProcess";Expression={$_.OwningProcess}}); ConvertTo-Json -InputObject $rows -Compress`;
	const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	if (!output || output === 'null' || output === '[]') return [] as Array<{ localPort: number; owningProcess: number }>;
	const value = JSON.parse(output) as { localPort: number; owningProcess: number } | Array<{ localPort: number; owningProcess: number }>;
	return Array.isArray(value) ? value : [value];
}

function processKey(row: Pick<ProcessRow, 'pid' | 'creationDate'>) { return `${row.pid}:${row.creationDate}`; }
function pathExistsWithinTopic(target: string) {
	const relative = path.relative(topicRoot, path.resolve(target));
	return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function message(error: unknown) { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }

main().catch((error) => {
	process.stderr.write(`${message(error)}\n`);
	process.exitCode = 1;
});
