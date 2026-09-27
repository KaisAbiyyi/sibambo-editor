import { afterEach, describe, expect, test } from 'bun:test';
import { loadE4InWorker } from '../../src/lib/e4-worker-client';

const NativeWorker = globalThis.Worker;

class TestWorker {
	static instances: TestWorker[] = [];
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	readonly messages: unknown[] = [];
	terminated = false;
	constructor() { TestWorker.instances.push(this); }
	postMessage(message: unknown) { this.messages.push(message); }
	terminate() { this.terminated = true; }
}

afterEach(() => {
	Object.defineProperty(globalThis, 'Worker', { configurable: true, value: NativeWorker });
	TestWorker.instances = [];
});

describe('Editor E4 worker cancellation', () => {
	test('cancels the app-owned worker and ignores a late completion', async () => {
		Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker });
		const controller = new AbortController();
		let receivedProgress: unknown;
		const pending = loadE4InWorker(new ArrayBuffer(12), 'source.bomc', controller.signal, (progress) => receivedProgress = progress);
		const worker = TestWorker.instances[0];
		const loadId = (worker.messages[0] as { id: number }).id;
		const progress = { stage: 'geometry', completed: 2, total: 4, message: 'Preparing geometry', unit: 'stage' };
		worker.onmessage?.({ data: { type: 'progress', id: loadId, progress } } as MessageEvent);
		expect(receivedProgress).toEqual(progress);
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(worker.messages.map((message) => (message as { type: string }).type)).toEqual(['load', 'cancel']);
		expect(worker.terminated).toBe(true);
		worker.onmessage?.({ data: { type: 'complete', id: loadId } } as MessageEvent);
		expect(worker.messages).toHaveLength(2);
	});

	test('terminates immediately when a load starts with an already-cancelled signal', async () => {
		Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker });
		const controller = new AbortController();
		controller.abort();

		await expect(loadE4InWorker(new ArrayBuffer(4), 'cancelled.bomc', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
		expect(TestWorker.instances[0].messages.map((message) => (message as { type: string }).type)).toEqual(['cancel']);
		expect(TestWorker.instances[0].terminated).toBe(true);
	});
});
