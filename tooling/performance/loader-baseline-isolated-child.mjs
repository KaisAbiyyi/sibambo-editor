import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import {
	APPS,
	assertWithinRoot,
	discoverBrowserEnvironment,
	makeContext,
	performExpectedRejection,
	performModelAttempt,
	performModelAttemptInContext,
	stableEnvironment,
	verifyFixtureBytes
} from './loader-baseline.mjs';

const PROTOCOL = 'bomc-isolation-ipc-v1';
let active = null;
let sequence = 0;
let browser = null;
let warmContext = null;
let heartbeatTimer = null;
let stopping = false;
let fatalSendError = null;
const waiters = new Map();

function envelope(type, payload, attemptId = null) {
	return {
		protocol: PROTOCOL,
		runToken: active.runToken,
		jobToken: active.jobToken,
		attemptId,
		seq: ++sequence,
		type,
		payload
	};
}

function send(type, payload = {}, attemptId = null) {
	if (!process.connected || fatalSendError) throw new Error(fatalSendError || 'Supervisor IPC is unavailable.');
	const message = envelope(type, payload, attemptId);
	process.send(message, (error) => {
		if (error) fatalSendError = 'Supervisor IPC send failed: ' + error.message;
	});
	return message.seq;
}

function sendAndWait(type, payload = {}, attemptId = null) {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	const message = envelope(type, payload, attemptId);
	waiters.set(message.seq, { resolve, reject });
	try {
		if (!process.connected || fatalSendError) throw new Error(fatalSendError || 'Supervisor IPC is unavailable.');
		process.send(message, (error) => {
			if (!error) return;
			fatalSendError = 'Supervisor IPC send failed: ' + error.message;
			const waiter = waiters.get(message.seq);
			if (waiter) {
				waiters.delete(message.seq);
				waiter.reject(new Error(fatalSendError));
			}
		});
	} catch (error) {
		waiters.delete(message.seq);
		reject(error);
	}
	return promise;
}

function stable(value) {
	return stableEnvironment(value);
}

function verifiedFixture(job, run) {
	if (!job.fixture || !run.workspaceRoot) throw new Error('Child job is missing its selected fixture descriptor or workspace root.');
	const filePath = assertWithinRoot(run.workspaceRoot, job.fixture.locator);
	const payloadBytes = readFileSync(filePath);
	verifyFixtureBytes(job.fixture, payloadBytes);
	return { ...job.fixture, filePath, payloadBytes };
}

function attemptCallback(attemptId) {
	let resultAck = null;
	const onAttemptEvent = (event) => {
		if (event.attemptId !== attemptId) throw new Error('Attempt callback ID differs from the active child attempt.');
		if (event.type === 'attempt-result') {
			const seq = send(event.type, event.payload, event.attemptId);
			resultAck = waitForAck(seq);
		}
		else send(event.type, event.payload, event.attemptId);
		if (fatalSendError) throw new Error(fatalSendError);
	};
	return {
		onAttemptEvent,
		async waitForResultAck() {
			if (!resultAck) throw new Error('Attempt function returned without an attempt-result observation.');
			const pending = resultAck;
			resultAck = null;
			return pending;
		}
	};
}

function waitForAck(seq) {
	return new Promise((resolve, reject) => {
		const previous = waiters.get(seq);
		if (previous) {
			const resolvePrevious = previous.resolve;
			const rejectPrevious = previous.reject;
			waiters.set(seq, {
				resolve: (value) => { resolvePrevious(value); resolve(value); },
				reject: (error) => { rejectPrevious(error); reject(error); }
			});
			return;
		}
		waiters.set(seq, { resolve, reject });
	});
}

async function runAttempt(job, fixture, run, attemptId, isPrime = false) {
	const attempt = attemptCallback(attemptId);
	const diagnosticStreamToken = job.kind === 'diagnostic' ? active.jobToken + ':' + attemptId : null;
	const onDiagnosticEvent = diagnosticStreamToken
		? (event) => send('diagnostic-event', event, attemptId)
		: null;
	let row;
	if (job.kind === 'diagnostic') {
		row = await performModelAttempt({
			browser,
			app: APPS.find((item) => item.id === job.appId),
			fixture,
			baseUrl: run.urls[job.appId],
			mode: 'diagnostic-excluded',
			outputDir: path.join(run.outputDir, 'child-captures', active.jobToken),
			index: 1,
			diagnostic: job.mode === 'wrapped',
			workerControl: job.mode === 'native',
			expectedOutcome: 'ready',
			scenarioRowId: attemptId,
			onAttemptEvent: attempt.onAttemptEvent,
			diagnosticStreamToken,
			onDiagnosticEvent
		});
		row.diagnosticMode = job.mode;
	} else if (job.kind === 'rejection') {
		row = await performExpectedRejection({
			browser,
			app: APPS.find((item) => item.id === job.appId),
			fixture,
			baseUrl: run.urls[job.appId],
			outputDir: path.join(run.outputDir, 'child-captures', active.jobToken),
			scenarioRowId: attemptId,
			onAttemptEvent: attempt.onAttemptEvent
		});
	} else if (job.mode === 'warm') {
		row = await performModelAttemptInContext({
			context: warmContext,
			browser,
			app: APPS.find((item) => item.id === job.appId),
			fixture,
			baseUrl: run.urls[job.appId],
			outputDir: path.join(run.outputDir, 'child-captures', active.jobToken),
			mode: 'warm',
			index: isPrime ? 0 : Number(attemptId.slice(attemptId.lastIndexOf('-') + 1)),
			prime: isPrime,
			expectedOutcome: job.expectedOutcome || 'ready',
			scenarioRowId: attemptId,
			onAttemptEvent: attempt.onAttemptEvent
		});
	} else {
		row = await performModelAttempt({
			browser,
			app: APPS.find((item) => item.id === job.appId),
			fixture,
			baseUrl: run.urls[job.appId],
			outputDir: path.join(run.outputDir, 'child-captures', active.jobToken),
			mode: 'cold',
			index: Number(attemptId.slice(attemptId.lastIndexOf('-') + 1)),
			expectedOutcome: job.expectedOutcome || 'ready',
			scenarioRowId: attemptId,
			prime: isPrime,
			onAttemptEvent: attempt.onAttemptEvent
		});
	}
	const resultDecision = await attempt.waitForResultAck();
	return { row, resultDecision };
}

function setupPageResult(row) {
	return row && row.openOccurred === false && (row.status === 'setup-error' || row.status === 'failed-after-open' || row.status === 'harness-error-observer');
}

async function runAssignedJob(message) {
	active = message;
	const { wsEndpoint, job, run } = message.payload;
	heartbeatTimer = setInterval(() => {
		try { send('heartbeat', { epochMs: Date.now() }); }
		catch (error) { fatalSendError = error instanceof Error ? error.message : String(error); }
	}, 250);
	heartbeatTimer.unref();
	browser = await chromium.connect(wsEndpoint, { timeout: 10_000 });
	send('connected', { childPid: process.pid, connectedAtEpochMs: Date.now() });
	const beforeEnvironment = await discoverBrowserEnvironment(browser);
	send('environment-before', { environment: stable(beforeEnvironment) });
	if (job.kind === 'environment-recovery') {
		const afterEnvironment = stable(await discoverBrowserEnvironment(browser));
		send('environment-after', { environment: afterEnvironment });
		const terminalSeq = await sendAndWait('job-terminal', { status: 'ok', lastAttemptId: null, afterEnvironment, afterEnvironmentStatus: 'available', recoveryOnly: true });
		if (terminalSeq === 'continue') await browser.close();
		browser = null;
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = null;
		if (process.connected) process.disconnect();
		return;
	}
	const fixture = verifiedFixture(job, run);

	const jobs = job.kind === 'warm'
		? [{ id: job.primeRowId, prime: true }, ...job.attemptRowIds.map((id) => ({ id, prime: false }))]
		: [{ id: job.id, prime: false }];
	let warmPrimePassed = true;
	let lastAttemptId = null;
	let terminalStatus = 'ok';
	let terminalError = null;
	for (const item of jobs) {
		if (stopping || fatalSendError) throw new Error(fatalSendError || 'Child was asked to stop before the next attempt.');
		const attemptId = item.id;
		lastAttemptId = attemptId;
		const readyDecision = await sendAndWait('attempt-entered', {
			attemptId,
			appId: job.appId,
			fixtureId: job.fixtureId,
			mode: item.prime ? 'warm-prime' : job.mode,
			prime: item.prime,
			expectedOutcome: job.expectedOutcome || 'ready'
		}, attemptId);
		if (readyDecision !== 'continue') { stopping = true; break; }
		if (item.prime) warmContext = (await makeContext(browser, { cacheDisabled: false })).context;
		const { row, resultDecision } = await runAttempt(job, fixture, run, attemptId, item.prime);
		if (item.prime) {
			warmPrimePassed = row.outcomeStatus === 'ready' || row.status === 'prime-excluded';
			warmPrimePassed = warmPrimePassed && Number.isFinite(row.elapsedMs) && row.elapsedMs <= 120_000 && row.firstValidFrame !== null && row.cleanupStatus === 'complete' && !row.observerError;
			if (!warmPrimePassed && row.cleanupStatus === 'complete') {
				terminalStatus = 'prime-failed';
				break;
			}
		}
		if (resultDecision !== 'continue') {
			if (row.cleanupStatus !== 'complete') {
				const primeReadyWithFrame = item.prime && row.outcomeStatus === 'ready' && Boolean(row.firstValidFrame) && !row.observerError;
				const measuredWarmContextLost = job.kind === 'warm' && !item.prime && warmPrimePassed && row.openOccurred && !row.observerError;
				terminalStatus = primeReadyWithFrame || measuredWarmContextLost ? 'warm-context-lost' : 'cleanup-failed';
			} else if (item.prime && ['error', 'timeout', 'failed-no-valid-frame'].includes(row.outcomeStatus ?? row.status) && !row.observerError) terminalStatus = 'prime-failed';
			else terminalStatus = 'attempt-failed';
			break;
		}
		if (setupPageResult(row) || row.cleanupStatus !== 'complete' || row.observerError) {
			terminalStatus = job.kind === 'warm' && warmPrimePassed && row.openOccurred && row.cleanupStatus !== 'complete' && !row.observerError
				? 'warm-context-lost'
				: row.cleanupStatus !== 'complete' ? 'cleanup-failed' : 'attempt-failed';
			terminalError = row.observerError || row.cleanupErrors?.join('; ') || row.outcomeText || null;
			break;
		}
	}

	let afterEnvironment = null;
	let afterEnvironmentStatus = 'available';
	const quarantinedTerminal = ['cleanup-failed', 'warm-context-lost'].includes(terminalStatus);
	if (warmContext && !quarantinedTerminal) {
		try { await warmContext.close(); warmContext = null; }
		catch (error) {
			if (terminalStatus === 'prime-failed' && !warmPrimePassed) terminalStatus = 'prime-failed-context-cleanup-failed';
			else terminalStatus = 'warm-context-lost';
			terminalError = error instanceof Error ? error.message : String(error);
		}
	}
	if (['ok', 'prime-failed'].includes(terminalStatus)) {
		afterEnvironment = stable(await discoverBrowserEnvironment(browser));
		send('environment-after', { environment: afterEnvironment });
	} else afterEnvironmentStatus = 'unavailable-quarantined';
	const terminalSeq = await sendAndWait('job-terminal', {
		status: terminalStatus,
		error: terminalError,
		lastAttemptId,
		warmPrimePassed,
		afterEnvironment,
		afterEnvironmentStatus
	});
	if (terminalSeq !== 'continue') {
		stopping = true;
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = null;
		if (process.connected) process.disconnect();
		return;
	}
	await browser.close();
	browser = null;
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	heartbeatTimer = null;
	if (process.connected) process.disconnect();
}

async function stopChild() {
	stopping = true;
	for (const [seq, waiter] of waiters) {
		waiters.delete(seq);
		waiter.resolve('stop');
	}
	try { if (warmContext) await warmContext.close(); } catch {}
	try { if (browser) await browser.close(); } catch {}
}

process.on('message', (message) => {
	if (message?.type === 'ack') {
		if (!active || message.protocol !== PROTOCOL || message.runToken !== active.runToken || message.jobToken !== active.jobToken || !Number.isInteger(message.acknowledgedSeq)) return;
		const waiter = waiters.get(message.acknowledgedSeq);
		if (!waiter) return;
		waiters.delete(message.acknowledgedSeq);
		waiter.resolve(message.decision);
		return;
	}
	if (message?.type === 'stop') {
		void stopChild();
		return;
	}
	if (message?.type === 'job' && message.protocol === PROTOCOL && message.seq === 0 && !active) {
		void runAssignedJob(message).catch(async (error) => {
			try { send('fatal-error', { message: error instanceof Error ? error.stack || error.message : String(error) }, null); } catch {}
			await stopChild();
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			if (process.connected) process.disconnect();
		});
	}
});

process.on('disconnect', () => { void stopChild(); });
