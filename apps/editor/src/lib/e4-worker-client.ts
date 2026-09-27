import type { AdaptedBomcResult, E4WorkerProgress } from '@sibambo/e4-import';

export type { E4WorkerProgress } from '@sibambo/e4-import';
type WorkerReply = { type: 'progress'; id: number; progress: E4WorkerProgress } | { type: 'complete'; id: number; result: AdaptedBomcResult } | { type: 'error' | 'cancelled'; id: number; error?: string };
let nextId = 0;

export function loadE4InWorker(buffer: ArrayBuffer, sourceName: string, signal?: AbortSignal, onProgress?: (progress: E4WorkerProgress) => void): Promise<AdaptedBomcResult> {
	return new Promise((resolve, reject) => {
		const id = ++nextId;
		const worker = new Worker(new URL('./e4-import.worker.ts', import.meta.url), { type: 'module' });
		let settled = false;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener('abort', abort);
			worker.terminate();
			action();
		};
		const abort = () => {
			worker.postMessage({ type: 'cancel', id });
			finish(() => reject(new DOMException('BOMC load cancelled.', 'AbortError')));
		};
		worker.onerror = (event) => finish(() => reject(new Error(event.message || 'E4 worker failed.')));
		worker.onmessage = (event: MessageEvent<WorkerReply>) => {
			const reply = event.data;
			if (reply.id !== id) return;
			if (reply.type === 'progress') { onProgress?.(reply.progress); return; }
			if (reply.type === 'complete') finish(() => resolve(reply.result));
			else finish(() => reject(new Error(reply.error ?? 'BOMC load cancelled.')));
		};
		if (signal?.aborted) { abort(); return; }
		signal?.addEventListener('abort', abort, { once: true });
		worker.postMessage({ type: 'load', id, buffer, sourceName }, [buffer]);
	});
}
