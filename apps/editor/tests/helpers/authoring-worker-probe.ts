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

declare global {
	interface Window { __editorAuthoringWorkerProbe?: AuthoringWorkerProbe }
}

/**
 * Installs a read-only observer around browser Workers. It records only the
 * authoring protocol envelope and cloned replies; it does not change messages,
 * add route hooks, or synthesize a successful worker response.
 */
export async function installAuthoringWorkerProbe(page: Page) {
	await page.addInitScript(() => {
		const NativeWorker = window.Worker;
		const probe: AuthoringWorkerProbe = { workers: [] };
		window.__editorAuthoringWorkerProbe = probe;
		class ObservedWorker extends NativeWorker {
			constructor(scriptURL: string | URL, options?: WorkerOptions) {
				super(scriptURL, options);
				const record: AuthoringWorkerProbe['workers'][number] = { url: String(scriptURL), terminated: 0, requests: [], replies: [] };
				probe.workers.push(record);
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
