type MaterialProof = {
	materialIndex: number; textureIndex: number; mode: 1 | 2; expectedRgbaSha256: string; actualRgbaSha256: string;
	assetPath: string; colorizeMs: number; hashMs: number; encodeMs: number; reusedAsset: boolean;
};
type ExpectedMaterial = {
	materialIndex: number; name: string | null; displayName: string | null; rgba: number[]; opacity: number;
	textureIndex: number | null; textureWidthM: number; textureHeightM: number; activeSemantic: boolean;
	semantic?: { materialType: number; colorizeMode: number; deltas: number[]; outputRgbaSha256: string };
};
type PngCase = {
	width: number; height: number; sourceRgba: number[][]; mode: 1 | 2; deltas: number[];
	expectedRgba: number[][]; expectedRgbaSha256: string;
};
type ProofRequest = { fixtureId: string; sha256: string; expectedMaterials: ExpectedMaterial[]; pngCase?: PngCase };
type ProofResult = {
	requestId: number; status: 'complete' | 'error' | 'cancelled'; error?: string; rows: MaterialProof[];
	workerLifecycle: { created: boolean; terminated: boolean; listenersRemoved: boolean; terminalMessageCount: number; terminalType: string | null };
	report?: unknown;
};
type ActiveProof = { requestId: number; rows: MaterialProof[]; cancel: (reason: string) => void };

declare global {
	interface Window {
		__m2Proof: {
			run(request: ProofRequest): Promise<ProofResult>;
			cancel(): void;
			snapshot(): { requestId: number | null; active: boolean; rows: MaterialProof[]; lastResult: ProofResult | null };
		};
	}
}

let nextRequestId = 0;
let activeProof: ActiveProof | null = null;
let lastResult: ProofResult | null = null;
const status = document.querySelector<HTMLElement>('#status');

window.__m2Proof = { run, cancel: () => activeProof?.cancel('cancelled by test'), snapshot };
window.addEventListener('pagehide', () => activeProof?.cancel('page unloaded'), { once: true });
if (status) status.textContent = 'Texture proof worker ready';

function run(request: ProofRequest): Promise<ProofResult> {
	if (activeProof) {
		return Promise.resolve({
			requestId: activeProof.requestId, status: 'error', error: 'A texture proof request is already active.', rows: [],
			workerLifecycle: { created: false, terminated: false, listenersRemoved: true, terminalMessageCount: 0, terminalType: null }
		});
	}
	const requestId = ++nextRequestId;
	const rows: MaterialProof[] = [];
	return new Promise((resolve) => {
		let worker: Worker;
		try {
			worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
		} catch (error) {
			const result: ProofResult = {
				requestId, status: 'error', error: error instanceof Error ? error.message : String(error), rows,
				workerLifecycle: { created: false, terminated: false, listenersRemoved: true, terminalMessageCount: 0, terminalType: null }
			};
			lastResult = result;
			resolve(result);
			return;
		}

		let terminalSeen = false;
		let terminalMessageCount = 0;
		let terminalType: string | null = null;
		let finished = false;
		const onMessage = (event: MessageEvent) => {
			const message = event.data as { id?: number; type?: string; proof?: MaterialProof; report?: unknown; error?: string };
			if (message.id !== requestId) {
				finish('error', `Stale proof worker message ${String(message.id)} for request ${requestId}.`);
				return;
			}
			if (message.type === 'row') {
				if (terminalSeen || !message.proof) {
					finish('error', 'Invalid or late proof row message.');
					return;
				}
				rows.push({ ...message.proof });
				return;
			}
			if (message.type !== 'complete' && message.type !== 'error') {
				finish('error', `Unknown proof worker message type ${String(message.type)}.`);
				return;
			}
			if (terminalSeen) {
				finish('error', 'Duplicate proof worker terminal message.');
				return;
			}
			terminalSeen = true;
			terminalMessageCount += 1;
			terminalType = message.type;
			finish(message.type === 'complete' ? 'complete' : 'error', message.error, message.report);
		};
		const onError = (event: ErrorEvent) => {
			event.preventDefault();
			finish('error', event.message || 'Uncaught proof worker error.');
		};
		const onMessageError = () => finish('error', 'Proof worker message could not be cloned.');

		const finish = (resultStatus: ProofResult['status'], error?: string, report?: unknown) => {
			if (finished) {
				if (terminalSeen) terminalMessageCount += 1;
				return;
			}
			finished = true;
			worker.removeEventListener('message', onMessage);
			worker.removeEventListener('error', onError);
			worker.removeEventListener('messageerror', onMessageError);
			worker.terminate();
			if (activeProof?.requestId === requestId) activeProof = null;
			const result: ProofResult = {
				requestId, status: resultStatus, error, rows: rows.map((row) => ({ ...row })), report,
				workerLifecycle: { created: true, terminated: true, listenersRemoved: true, terminalMessageCount, terminalType }
			};
			lastResult = result;
			if (status) status.textContent = `Texture proof ${resultStatus}: ${error || 'complete'}`;
			resolve(result);
		};

		worker.addEventListener('message', onMessage);
		worker.addEventListener('error', onError);
		worker.addEventListener('messageerror', onMessageError);
		activeProof = { requestId, rows, cancel: (reason) => finish('cancelled', reason) };
		if (status) status.textContent = `Texture proof running: ${request.fixtureId}`;
		worker.postMessage({ id: requestId, request });
	});
}

function cancel() {
	activeProof?.cancel('cancelled by test');
}

function snapshot() {
	return {
		requestId: activeProof?.requestId ?? lastResult?.requestId ?? null,
		active: activeProof !== null,
		rows: activeProof ? activeProof.rows.map((row) => ({ ...row })) : lastResult?.rows.map((row) => ({ ...row })) || [],
		lastResult
	};
}
