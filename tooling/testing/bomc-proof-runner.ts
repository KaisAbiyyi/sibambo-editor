import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	claimProofAttempt, collectExecutionRootFiles, captureSourceIdentity, evaluateFinalGate,
	inventoryFiles, parsePlaywrightReportJson, resolveProofPaths, setupFailureReason, validateSealedSourceSnapshot, writeProofSidecar, type ColdCycle, type PlaywrightReport,
	type PlaywrightSpec, type ProofAttempt, type ProofPaths, type ProofTicket, type ProofTrack
} from './proof-run-contract';

const nodePath = 'C:/Users/kaisa/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe';
const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const portByTrack: Record<ProofTrack, number> = { mirror: 5197, cold: 5198, semantic: 5202, writer: 5201 };
const cliPath = path.join(editorRoot, 'node_modules', '@playwright', 'test', 'cli.js');

type Arguments = {
	mode: 'discover' | 'run'; track: ProofTrack; root: string; attempt: ProofAttempt;
	cycle?: ColdCycle; coldReceipt?: string
};
type ProcessRow = { pid: number; parentProcessId: number; name: string; creationDate: string };

async function main() {
	let args: Arguments;
	try { args = parseArguments(process.argv.slice(2)); }
	catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
	if (!path.isAbsolute(args.root)) return fail('--root must be an absolute path.');
	let paths: ProofPaths;
	try { paths = resolveProofPaths({ track: args.track, executionRoot: args.root, attempt: args.attempt, cycle: args.cycle }); }
	catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
	if (!existsSync(nodePath)) return fail(`The pinned Node runtime is unavailable: ${nodePath}`);
	if (!existsSync(cliPath)) return fail(`The installed Playwright CLI is unavailable: ${cliPath}`);
	const runtime = captureRuntime();
	const port = portByTrack[args.track];
	const occupied = inspectPort(port);
	if (occupied.length) return fail(`Port ${port} is occupied before ${args.track}; owners=${JSON.stringify(occupied)}`);
	if (args.mode === 'discover') return await discover(args, paths, runtime, port);
	return await run(args, paths, runtime, port);
}

function parseArguments(argv: string[]): Arguments {
	const [modeValue, ...rest] = argv;
	if (modeValue !== 'discover' && modeValue !== 'run') throw new Error('Usage: bun tooling/testing/bomc-proof-runner.ts discover|run --track mirror|cold|semantic|writer --root <absolute path> --attempt 01|02 [--cycle cold-01|cold-02|cold-03|warm-01] [--cold-receipt <path>]');
	const values = new Map<string, string>();
	for (let index = 0; index < rest.length; index += 1) {
		const key = rest[index];
		if (!key?.startsWith('--')) throw new Error(`Unexpected positional argument: ${key ?? ''}`);
		if (values.has(key)) throw new Error(`Duplicate flag: ${key}`);
		const value = rest[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
		values.set(key, value);
		index += 1;
	}
	for (const key of values.keys()) if (!['--track', '--root', '--attempt', '--cycle', '--cold-receipt'].includes(key)) throw new Error(`Unknown flag: ${key}`);
	const track = values.get('--track');
	if (track !== 'mirror' && track !== 'cold' && track !== 'semantic' && track !== 'writer') throw new Error('--track must be mirror, cold, semantic, or writer.');
	const root = values.get('--root');
	if (!root) throw new Error('--root is required.');
	const attempt = values.get('--attempt');
	if (attempt !== '01' && attempt !== '02') throw new Error('--attempt must be 01 or 02.');
	const cycleValue = values.get('--cycle');
	const coldReceipt = values.get('--cold-receipt');
	if (track === 'cold') {
		if (cycleValue !== 'cold-01' && cycleValue !== 'cold-02' && cycleValue !== 'cold-03' && cycleValue !== 'warm-01') throw new Error('Cold track requires --cycle cold-01|cold-02|cold-03|warm-01.');
		if (cycleValue === 'warm-01' && modeValue === 'run' && !coldReceipt) throw new Error('warm-01 run requires --cold-receipt.');
		if (cycleValue === 'warm-01' && modeValue === 'discover' && coldReceipt) throw new Error('warm-01 discovery must not consume a cold receipt.');
		if (cycleValue !== 'warm-01' && coldReceipt) throw new Error('--cold-receipt is allowed only for warm-01.');
	} else {
		if (cycleValue || coldReceipt) throw new Error('--cycle and --cold-receipt are valid only for the cold track; warm additionally requires --cold-receipt.');
	}
	if (coldReceipt && !path.isAbsolute(coldReceipt)) throw new Error('--cold-receipt must be absolute.');
	return { mode: modeValue, track, root: path.resolve(root), attempt, cycle: cycleValue as ColdCycle | undefined, coldReceipt };
}

function captureRuntime(): ProofTicket['runtime'] {
	const node = execFileSync(nodePath, ['--version'], { cwd: editorRoot, encoding: 'utf8' }).trim();
	const bun = execFileSync('bun', ['--version'], { cwd: editorRoot, encoding: 'utf8' }).trim();
	const playwright = (JSON.parse(readFileSync(path.join(editorRoot, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')) as { version: string }).version;
	return { node, nodePath, bun, playwright };
}

async function discover(args: Arguments, paths: ProofPaths, runtime: ProofTicket['runtime'], port: number) {
	const sourceBefore = captureSourceIdentity();
	validateSealedSourceSnapshot(sourceBefore);
	const before = inventoryFiles(collectExecutionRootFiles(paths.executionRoot));
	const env = proofEnvironment(args, paths, null);
	const grep = titleGrep(paths.testTitles);
	const specFilter = path.basename(paths.specPath);
	const child = await spawnCaptured(nodePath, [cliPath, 'test', '--config', paths.configPath, specFilter, '--list', '--reporter=list', '--grep', grep], env);
	const after = inventoryFiles(collectExecutionRootFiles(paths.executionRoot));
	let sourceIdentityUnchanged = false;
	try { const sourceAfter = captureSourceIdentity(); validateSealedSourceSnapshot(sourceAfter); sourceIdentityUnchanged = sourceAfter.identitySha256 === sourceBefore.identitySha256; }
	catch (error) { process.stderr.write(`Source snapshot validation failed after discovery: ${error instanceof Error ? error.message : String(error)}\n`); }
	const listed = parseListOutput(child.stdout, paths.testTitles);
	const cleanup = inspectCleanup(port, child.pid, child.preexistingProcesses, child.witnessedProcesses, child.processSnapshotErrors);
	const passed = child.exitCode === 0 && !child.signal && sourceIdentityUnchanged && before.length === after.length && JSON.stringify(before) === JSON.stringify(after)
		&& listed.join('\0') === paths.testTitles.join('\0') && cleanup.passed;
	const result = {
		mode: 'discover', track: args.track, cycle: paths.cycle, attempt: args.attempt,
		runtime, config: paths.configPath, spec: paths.specPath, selectedTitles: paths.testTitles,
		listedTitles: listed, sourceIdentityUnchanged, child: { exitCode: child.exitCode, signal: child.signal },
		rootInventoryUnchanged: JSON.stringify(before) === JSON.stringify(after), cleanup, verdict: passed ? 'pass' : 'fail',
		stdout: child.stdout, stderr: child.stderr
	};
	console.log(JSON.stringify(result, null, 2));
	if (!passed) process.exitCode = 1;
}

async function run(args: Arguments, paths: ProofPaths, runtime: ProofTicket['runtime'], port: number) {
	const ticket = claimProofAttempt({
		track: args.track, executionRoot: args.root, attempt: args.attempt, cycle: args.cycle,
		previousReceipt: args.coldReceipt, runtime, requireCommonSnapshot: true
	});
	const reportDir = path.dirname(ticket.reportFile);
	mkdirSync(reportDir, { recursive: true });
	const stdoutPath = path.join(reportDir, 'runner-stdout.log');
	const stderrPath = path.join(reportDir, 'runner-stderr.log');
	writeFileSync(stdoutPath, '', { flag: 'wx' });
	writeFileSync(stderrPath, '', { flag: 'wx' });
	const env = proofEnvironment(args, paths, ticket);
	const grep = titleGrep(ticket.testTitles);
	const specFilter = path.basename(ticket.specPath);
	let child: Awaited<ReturnType<typeof spawnCaptured>> | null = null;
	let spawnFailure: string | null = null;
	try {
		child = await spawnCaptured(nodePath, [cliPath, 'test', '--config', ticket.configPath, specFilter, '--grep', grep], env, stdoutPath, stderrPath);
	} catch (error) {
		spawnFailure = error instanceof Error ? error.message : String(error);
		writeFileSync(stderrPath, `${spawnFailure}\n`, { flag: 'a' });
	}
	const stdout = child?.stdout ?? '';
	const stderr = `${child?.stderr ?? ''}${spawnFailure ? `\n${spawnFailure}` : ''}`;
	const report = readOptionalPlaywrightReport(ticket.reportFile);
	const materializationErrors = report && ticket.track === 'semantic' ? materializeSemanticSidecars(ticket, report) : [];
	const markerDir = path.join(ticket.claimRoot, 'outcomes');
	const markerFiles = listJsonFiles(markerDir);
	const sidecarFiles = listJsonFiles(path.join(ticket.claimRoot, 'reports', 'cases'));
	const setupFailure = setupFailureReason(stdout, stderr, report, markerFiles.length);
	const cleanup = inspectCleanup(port, child?.pid ?? null, child?.preexistingProcesses ?? [], child?.witnessedProcesses ?? [], child?.processSnapshotErrors ?? []);
	const currentIdentity = captureSourceIdentity();
	let snapshotFailure: string | null = null;
	try { validateSealedSourceSnapshot(currentIdentity); }
	catch (error) { snapshotFailure = error instanceof Error ? error.message : String(error); }
	const receipt = evaluateFinalGate({
		ticket, report,
		child: { exitCode: child?.exitCode ?? null, signal: child?.signal ?? (spawnFailure ? 'spawn-error' : null) },
		cleanup, currentIdentity, markerFiles, sidecarFiles, setupFailureReason: setupFailure
	});
	if (materializationErrors.length) {
		receipt.errors.push(...materializationErrors);
		receipt.gate = 'failed';
		receipt.retryEligible = false;
	}
	if (snapshotFailure) {
		receipt.errors.push(`Common source snapshot validation failed after the run: ${snapshotFailure}`);
		receipt.gate = 'failed';
		receipt.retryEligible = false;
	}
	writeFileSync(ticket.finalGateFile, `${JSON.stringify({ ...receipt, stdoutPath, stderrPath }, null, 2)}\n`, { flag: 'wx' });
	console.log(JSON.stringify({ track: ticket.track, cycle: ticket.cycle, attempt: ticket.attempt, gate: receipt.gate, retryEligible: receipt.retryEligible, finalGate: ticket.finalGateFile, playwrightReport: ticket.reportFile, errorCount: receipt.errors.length, errors: receipt.errors, cleanup }, null, 2));
	if (receipt.gate !== 'passed') process.exitCode = 1;
}

function proofEnvironment(args: Arguments, paths: ProofPaths, ticket: ProofTicket | null): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.SIBAMBO_RECOVERY_WORKLOG; delete env.SIBAMBO_RECOVERY_ATTEMPT;
	delete env.SIBAMBO_WRITER_WORKLOG; delete env.SIBAMBO_WRITER_ATTEMPT;
	delete env.SIBAMBO_STABILITY_RUN; delete env.SIBAMBO_STABILITY_CYCLE;
	delete env.SIBAMBO_M2_WORKLOG;
	delete env.SIBAMBO_PROOF_TICKET; delete env.SIBAMBO_PROOF_NONCE; delete env.SIBAMBO_PROOF_ATTEMPT;
	if (args.track === 'mirror') { env.SIBAMBO_RECOVERY_WORKLOG = args.root; env.SIBAMBO_RECOVERY_ATTEMPT = args.attempt; }
	if (args.track === 'writer') { env.SIBAMBO_WRITER_WORKLOG = args.root; env.SIBAMBO_WRITER_ATTEMPT = args.attempt; }
	if (args.track === 'cold') { env.SIBAMBO_STABILITY_RUN = args.root; env.SIBAMBO_STABILITY_CYCLE = args.cycle; }
	if (args.track === 'semantic') { env.SIBAMBO_STABILITY_RUN = args.root; env.SIBAMBO_STABILITY_CYCLE = 'stability'; }
	if (args.track === 'cold' || args.track === 'semantic') {
		env.SIBAMBO_M2_WORKLOG = path.resolve(editorRoot, '..', 'docs', 'worklogs', 'BOMC-MATERIALS-V2-001', '2026-10-05-viewer-recovery-run-001');
	}
	env.SIBAMBO_PROOF_ATTEMPT = args.attempt;
	if (ticket) {
		env.SIBAMBO_PROOF_DISCOVERY = '0';
		env.SIBAMBO_PROOF_TICKET = path.join(ticket.claimRoot, 'run-ticket.json');
		env.SIBAMBO_PROOF_NONCE = ticket.nonce;
	} else {
		env.SIBAMBO_PROOF_DISCOVERY = '1';
	}
	return env;
}

function titleGrep(titles: string[]) {
	return `(?:${titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
}

function parseListOutput(output: string, expected: string[]) {
	const titleLines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes('›'));
	return titleLines.map((line) => expected.find((title) => line.endsWith(title)) ?? `UNEXPECTED:${line}`);
}

function readOptionalPlaywrightReport(filePath: string): PlaywrightReport | null {
	try { return parsePlaywrightReportJson(readFileSync(filePath, 'utf8')); }
	catch { return null; }
}

function listJsonFiles(directory: string) {
	if (!existsSync(directory)) return [];
	const result: string[] = [];
	const walk = (current: string) => {
		for (const row of readdirSync(current, { withFileTypes: true })) {
			const file = path.join(current, row.name);
			if (row.isSymbolicLink()) continue;
			if (row.isDirectory()) walk(file);
			else if (row.isFile() && file.endsWith('.json')) result.push(file);
		}
	};
	walk(directory);
	return result.sort();
}

function materializeSemanticSidecars(ticket: ProofTicket, report: PlaywrightReport) {
	const errors: string[] = [];
	const specs = flattenReportSpecs(report.suites ?? []);
	for (const title of ticket.testTitles) {
		const spec = specs.find((candidate) => candidate.title === title);
		const result = spec?.tests.length === 1 ? spec.tests[0]?.results[0] : undefined;
		const attachment = result?.attachments?.find((candidate) => candidate.contentType === 'application/json' && candidate.name?.endsWith('-proof-report'));
		if (!spec || !result || !attachment?.body) {
			errors.push(`Selected semantic case ${title} has no attached JSON UI report to materialize its ticket sidecar.`);
			continue;
		}
		try {
			const decoded = Buffer.from(attachment.body, 'base64').toString('utf8');
			let diagnosticReport: unknown;
			try { diagnosticReport = JSON.parse(decoded); }
			catch { diagnosticReport = JSON.parse(attachment.body); }
			writeProofSidecar(ticket, title, {
				observedStatus: result.status ?? 'unknown', expectedStatus: spec.tests[0]?.expectedStatus ?? 'passed',
				stage: 'materials-v2-ui-report', errors: result.errors ?? [], attachmentName: attachment.name,
				diagnosticReport
			});
		} catch (error) {
			errors.push(`Could not materialize the selected semantic report for ${title}: ${error instanceof Error ? error.message : String(error)}.`);
		}
	}
	return errors;
}

function flattenReportSpecs(suites: NonNullable<PlaywrightReport['suites']>): PlaywrightSpec[] {
	const rows: PlaywrightSpec[] = [];
	for (const suite of suites) {
		if (suite.specs) rows.push(...suite.specs);
		if (suite.suites) rows.push(...flattenReportSpecs(suite.suites));
	}
	return rows;
}

async function spawnCaptured(binary: string, argv: string[], env: NodeJS.ProcessEnv, stdoutPath?: string, stderrPath?: string) {
	const preexistingProcesses = snapshotProcesses();
	const child = spawn(binary, argv, { cwd: editorRoot, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
	if (!child.pid) throw new Error('Playwright child process did not receive a process ID.');
	const output: string[] = [];
	const errors: string[] = [];
	const witnessedProcesses = new Map<string, ProcessRow>();
	const processSnapshotErrors: string[] = [];
	const preexistingKeys = new Set(preexistingProcesses.map(processKey));
	const rememberDescendants = () => {
		try {
			const rows = snapshotProcesses();
			const descendantsNow = new Set(descendants(child.pid!, rows));
			for (const row of rows) if (descendantsNow.has(row.pid) && !preexistingKeys.has(processKey(row))) witnessedProcesses.set(processKey(row), row);
		} catch (error) {
			processSnapshotErrors.push(error instanceof Error ? error.message : String(error));
		}
	};
	rememberDescendants();
	const processMonitor = setInterval(rememberDescendants, 1_000);
	const read = (stream: NodeJS.ReadableStream | null, chunks: string[], filePath: string | undefined, destination: NodeJS.WriteStream) => {
		stream?.on('data', (chunk: Buffer | string) => {
			const value = chunk.toString(); chunks.push(value); destination.write(value);
			if (filePath) writeFileSync(filePath, value, { flag: 'a' });
		});
	};
	read(child.stdout, output, stdoutPath, process.stdout);
	read(child.stderr, errors, stderrPath, process.stderr);
	let result: { exitCode: number | null; signal: string | null };
	try {
		result = await new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
			child.once('error', reject);
			child.once('close', (code, signal) => resolve({ exitCode: code, signal }));
		});
	} finally {
		clearInterval(processMonitor);
		rememberDescendants();
	}
	return { ...result, pid: child.pid, preexistingProcesses, witnessedProcesses: [...witnessedProcesses.values()], processSnapshotErrors, stdout: output.join(''), stderr: errors.join('') };
}

function inspectCleanup(port: number, rootPid: number | null, preexistingProcesses: ProcessRow[], witnessedProcesses: ProcessRow[], processSnapshotErrors: string[]) {
	const errors: string[] = [];
	if (processSnapshotErrors.length) errors.push(`Process ownership sampling had errors: ${processSnapshotErrors.join(' | ')}`);
	const before = new Set(preexistingProcesses.map(processKey));
	let rows: ProcessRow[] = [];
	try { rows = snapshotProcesses(); }
	catch (error) { errors.push(`Could not inspect process ownership: ${error instanceof Error ? error.message : String(error)}`); }
	const ownedByKey = new Map(witnessedProcesses.map((row) => [processKey(row), row]));
	if (rootPid !== null) {
		const currentIds = new Set(descendants(rootPid, rows));
		for (const row of rows) if (currentIds.has(row.pid) && !before.has(processKey(row))) ownedByKey.set(processKey(row), row);
	}
	const owned = [...ownedByKey.values()].filter((row) => !before.has(processKey(row)));
	const remaining = owned.filter((ownedRow) => rows.some((row) => processKey(row) === processKey(ownedRow)));
	if (remaining.length) {
		try { stopExactProcesses(remaining); }
		catch (error) { errors.push(`Could not stop exact owned descendants ${remaining.map((row) => row.pid).join(',')}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	const afterRows = (() => { try { return snapshotProcesses(); } catch (error) { errors.push(`Could not confirm process cleanup: ${error instanceof Error ? error.message : String(error)}`); return []; } })();
	const stillRunning = remaining.filter((ownedRow) => afterRows.some((row) => processKey(row) === processKey(ownedRow)));
	if (stillRunning.length) errors.push(`Owned descendants remain alive: ${stillRunning.map((row) => row.pid).join(',')}`);
	let portOwners: Array<{ localPort: number; owningProcess: number }> = [];
	try { portOwners = inspectPort(port); }
	catch (error) { errors.push(`Could not inspect strict port ${port}: ${error instanceof Error ? error.message : String(error)}`); }
	if (portOwners.length) errors.push(`Strict port ${port} remains occupied: ${JSON.stringify(portOwners)}`);
	return { passed: errors.length === 0, details: { rootPid, ownedDescendants: owned, terminatedOwnedPids: remaining.map((row) => ({ pid: row.pid, creationDate: row.creationDate })), stillRunning: stillRunning.map((row) => ({ pid: row.pid, creationDate: row.creationDate })), port, portOwners, errors } };
}

function snapshotProcesses(): ProcessRow[] {
	if (process.platform !== 'win32') return [];
	const script = 'Get-CimInstance Win32_Process | Select-Object @{Name="pid";Expression={$_.ProcessId}},@{Name="parentProcessId";Expression={$_.ParentProcessId}},@{Name="name";Expression={$_.Name}},@{Name="creationDate";Expression={$_.CreationDate.ToString()}} | ConvertTo-Json -Compress';
	const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	if (!output) return [];
	const value = JSON.parse(output) as ProcessRow | ProcessRow[];
	return Array.isArray(value) ? value : [value];
}

function descendants(rootPid: number, rows: ProcessRow[]) {
	const found = new Set<number>([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) if (found.has(row.parentProcessId) && !found.has(row.pid)) { found.add(row.pid); changed = true; }
	}
	found.delete(rootPid);
	return [...found];
}

function stopExactProcesses(processes: ProcessRow[]) {
	if (!processes.length || process.platform !== 'win32') return;
	if (processes.some((row) => !Number.isSafeInteger(row.pid) || row.pid <= 0 || !row.creationDate)) throw new Error('Refusing an invalid process identity.');
	const encodedRows = Buffer.from(JSON.stringify(processes.map(({ pid, creationDate }) => ({ pid, creationDate }))), 'utf8').toString('base64');
	const script = `$targets = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRows}')) | ConvertFrom-Json; foreach ($target in $targets) { $p = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$target.pid) -ErrorAction SilentlyContinue; if ($p -and $p.CreationDate.ToString() -ceq [string]$target.creationDate) { Stop-Process -Id ([int]$target.pid) -Force -ErrorAction SilentlyContinue } }`;
	const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
	execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encodedScript], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function processKey(row: Pick<ProcessRow, 'pid' | 'creationDate'>) { return `${row.pid}:${row.creationDate}`; }

function inspectPort(port: number) {
	if (process.platform !== 'win32') return [] as Array<{ localPort: number; owningProcess: number }>;
	const script = `$rows = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object @{Name="localPort";Expression={$_.LocalPort}},@{Name="owningProcess";Expression={$_.OwningProcess}}); ConvertTo-Json -InputObject $rows -Compress`;
	const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	if (!output || output === 'null' || output === '[]') return [];
	const value = JSON.parse(output) as { localPort: number; owningProcess: number } | Array<{ localPort: number; owningProcess: number }>;
	return Array.isArray(value) ? value : [value];
}

function fail(message: string): never {
	console.error(message);
	process.exitCode = 1;
	throw new Error(message);
}

await main();
