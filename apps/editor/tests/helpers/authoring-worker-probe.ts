import type { Page } from '@playwright/test';
import type {
	AuthoringCheckpoint,
	AuthoringRequest,
	AuthoringResultByRequest,
	OpenRequest,
	WorkerErrorMessage,
	WorkerProgressMessage,
	WorkerReadyMessage,
	WorkerResultMessage,
} from '../../src/lib/authoring/protocol';

type ObservedRequestData<TRequest> = TRequest extends OpenRequest
	? { ownedBuffer: null; byteLength: number }
	: TRequest extends { data: infer TData } ? TData : never;

type ObservedExpectedRevision<TRequest> = TRequest extends { expectedRevision: infer TRevision } ? TRevision : never;

type AuthoringWorkerRequestObservation<TRequest = AuthoringRequest> = TRequest extends AuthoringRequest
	? Omit<TRequest, 'data' | 'expectedRevision'> & {
		data?: ObservedRequestData<TRequest>;
		expectedRevision?: ObservedExpectedRevision<TRequest>;
	}
	: never;

type ObservedResultPayload<TPayload> = TPayload extends { ownedBuffer: ArrayBuffer }
	? Omit<TPayload, 'ownedBuffer'> & { ownedBuffer: null }
	: TPayload;

type ObservedResultFields = {
	checkpoint?: AuthoringCheckpoint;
	dirty?: boolean;
	canUndo?: boolean;
	canRedo?: boolean;
	writeId?: string;
	revision?: number;
	sha256?: string;
	length?: number;
};

type AuthoringWorkerResultObservation<TRequestType extends AuthoringRequest['type']> = Omit<WorkerResultMessage<TRequestType>, 'result'> & {
	result: ObservedResultPayload<AuthoringResultByRequest[TRequestType]> & ObservedResultFields;
};

type AuthoringWorkerResultObservations = {
	[TRequestType in AuthoringRequest['type']]: AuthoringWorkerResultObservation<TRequestType>;
}[AuthoringRequest['type']];

export type AuthoringWorkerReplyObservation = (
	| WorkerReadyMessage
	| WorkerProgressMessage
	| WorkerErrorMessage
	| AuthoringWorkerResultObservations
) & {
	requestId?: number;
	requestType?: AuthoringRequest['type'] | null;
	error?: WorkerErrorMessage['error'];
};

export type AuthoringWorkerProbe = {
	workers: Array<{
		url: string;
		terminated: number;
		requests: AuthoringWorkerRequestObservation[];
		replies: AuthoringWorkerReplyObservation[];
	}>;
};

export type AuthoringWorkerFaultControl = {
	failNextWorkerConstruction(): void;
	pauseNextRequest(type: AuthoringRequest['type']): void;
	triggerLatestMessageError(): boolean;
};

declare global {
	interface Window {
		__editorAuthoringWorkerProbe?: AuthoringWorkerProbe;
		__editorAuthoringWorkerFaultControl?: AuthoringWorkerFaultControl;
	}
}

/**
 * Installs an observer around browser Workers. Normal tests only record cloned
 * authoring envelopes. Explicit negative tests may opt into the fault control
 * to drop one request, dispatch messageerror, or fail one worker construction;
 * the helper never synthesizes a successful protocol reply.
 */
export async function installAuthoringWorkerProbe(page: Page) {
	await page.addInitScript(() => {
		const NativeWorker = window.Worker;
		const probe: AuthoringWorkerProbe = { workers: [] };
		const liveWorkers: Array<{ worker: Worker; record: AuthoringWorkerProbe['workers'][number] }> = [];
		let failNextConstruction = false;
		let pauseNextRequestType: string | null = null;
		window.__editorAuthoringWorkerProbe = probe;
		window.__editorAuthoringWorkerFaultControl = {
			failNextWorkerConstruction() { failNextConstruction = true; },
			pauseNextRequest(type) { pauseNextRequestType = type; },
			triggerLatestMessageError() {
				const target = [...liveWorkers].reverse().find(({ record }) => record.terminated === 0
					&& (record.requests.some((request) => request.protocolVersion === 'sibambo-editor-authoring-1')
						|| record.replies.some((reply) => reply.protocolVersion === 'sibambo-editor-authoring-1')));
				if (!target) return false;
				target.worker.dispatchEvent(new MessageEvent('messageerror'));
				return true;
			}
		};
		class ObservedWorker extends NativeWorker {
			constructor(scriptURL: string | URL, options?: WorkerOptions) {
				super(scriptURL, options);
				if (failNextConstruction) {
					failNextConstruction = false;
					super.terminate();
					throw new Error('simulated restore worker construction failure');
				}
				const record: AuthoringWorkerProbe['workers'][number] = { url: String(scriptURL), terminated: 0, requests: [], replies: [] };
				probe.workers.push(record);
				liveWorkers.push({ worker: this, record });
				this.addEventListener('message', (event: MessageEvent) => {
					const message = event.data;
					if (!message || message.protocolVersion !== 'sibambo-editor-authoring-1') return;
					const copy = structuredClone(message) as Record<string, unknown>;
					const result = copy.result;
					if (result && typeof result === 'object' && (result as Record<string, unknown>).ownedBuffer instanceof ArrayBuffer) {
						copy.result = { ...(result as Record<string, unknown>), ownedBuffer: null };
					}
					record.replies.push(copy as unknown as AuthoringWorkerReplyObservation);
				});
				const nativePostMessage = this.postMessage.bind(this);
				const observedPostMessage = (...args: [message: unknown, transfer?: Transferable[] | StructuredSerializeOptions]) => {
					const message = args[0];
					if (message && typeof message === 'object' && (message as Record<string, unknown>).protocolVersion === 'sibambo-editor-authoring-1') {
						const request = structuredClone(message) as Record<string, unknown>;
						const data = request.data;
						if (data && typeof data === 'object' && (data as Record<string, unknown>).ownedBuffer instanceof ArrayBuffer) {
							const ownedBuffer = (data as { ownedBuffer: ArrayBuffer }).ownedBuffer;
							request.data = { ...(data as Record<string, unknown>), ownedBuffer: null, byteLength: ownedBuffer.byteLength };
						}
								record.requests.push(request as unknown as AuthoringWorkerRequestObservation);
								if (pauseNextRequestType === request.type) {
									pauseNextRequestType = null;
									return;
								}
							}
					return Reflect.apply(nativePostMessage, this, args);
				};
				this.postMessage = observedPostMessage as typeof Worker.prototype.postMessage;
				const terminate = this.terminate.bind(this);
				this.terminate = () => { record.terminated += 1; terminate(); };
			}
		}
		Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: ObservedWorker });
	});
}
