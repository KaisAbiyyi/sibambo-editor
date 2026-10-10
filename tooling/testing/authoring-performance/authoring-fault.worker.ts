import '../../../apps/editor/src/lib/authoring/bomc-authoring.worker.js';

type AuthoringWorkerRequest = { type?: string; protocolVersion?: string };
type WorkerScopeWithHandler = typeof globalThis & {
	onmessage: ((event: MessageEvent<unknown>) => void) | null;
};

const scope = globalThis as WorkerScopeWithHandler;
const productionReceiver = scope.onmessage;
let failNextCommand = false;

scope.onmessage = (event: MessageEvent<unknown>) => {
	const value = event.data as (AuthoringWorkerRequest & { proofControl?: string }) | null;
	if (value && typeof value === 'object' && value.proofControl === 'arm-one-worker-fault') {
		failNextCommand = true;
		return;
	}
	if (failNextCommand && value?.protocolVersion === 'sibambo-editor-authoring-1' && value.type === 'COMMAND') {
		failNextCommand = false;
		setTimeout(() => { throw new Error('Test-only authoring worker fault after an acknowledged checkpoint.'); }, 0);
		return;
	}
	productionReceiver?.call(scope, event as MessageEvent<unknown>);
};
