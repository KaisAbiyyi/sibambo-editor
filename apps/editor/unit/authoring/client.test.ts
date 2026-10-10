import { describe, expect, test } from 'bun:test';
import { AuthoringWorkerDispatcher } from '../../src/lib/authoring/bomc-authoring.worker.js';
import { AuthoringClient } from '../../src/lib/authoring/bomc-authoring-client.js';
import { AUTHORING_PROTOCOL_VERSION, type AuthoringRequest, type AuthoringWorkerMessage } from '../../src/lib/authoring/protocol.js';
import { assembleContainer } from '../../../../packages/bomc-document/src/binary.js';

const SESSION_ID = 'd7f7e62a-d503-4cb7-9e46-706fc8c06132';
const DOCUMENT_ID = 'a4f2d141-64e1-4c62-8d0d-53623f71a220';

class DispatcherWorker extends EventTarget {
	private readonly dispatcher: AuthoringWorkerDispatcher;
	private incoming: unknown[] = [];
	lastRequest: unknown = null;
	paused = false;
	terminated = false;
	transformMessage: (value: unknown) => unknown = (value) => value;

	constructor() {
		super();
		this.dispatcher = new AuthoringWorkerDispatcher((message, transfer) => {
			const data = this.transformMessage(structuredClone(message, { transfer: transfer ?? [] }));
			queueMicrotask(() => {
				if (!this.terminated) this.dispatchEvent(new MessageEvent('message', { data }));
			});
		});
	}

	postMessage(message: unknown, transfer: Transferable[] = []): void {
		if (this.terminated) throw new Error('Fake authoring worker is terminated.');
		const data = structuredClone(message, { transfer });
		this.lastRequest = data;
		if (this.paused) this.incoming.push(data);
		else queueMicrotask(() => this.dispatcher.receive(data));
	}

	terminate(): void { this.terminated = true; }

	emit(value: unknown): void {
		this.dispatchEvent(new MessageEvent('message', { data: value }));
	}

	resume(): void {
		this.paused = false;
		for (const message of this.incoming.splice(0)) queueMicrotask(() => this.dispatcher.receive(message));
	}

	crash(): void {
		this.terminated = true;
		const event = new Event('error');
		Object.defineProperty(event, 'message', { value: 'simulated authoring worker crash' });
		this.dispatchEvent(event);
	}
}

function makeClient(factory: () => Worker = () => new DispatcherWorker() as unknown as Worker) {
	const workers: DispatcherWorker[] = [];
	const client = new AuthoringClient({
		sessionId: SESSION_ID,
		documentIdFactory: () => DOCUMENT_ID,
		workerFactory: () => {
			const worker = factory() as DispatcherWorker;
			workers.push(worker);
			return worker as unknown as Worker;
		}
	});
	return { client, workers };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error('Timed out waiting for the authoring worker adapter.');
}

describe('canonical authoring worker and client', () => {
	test('opens a valid E4 container without section 241 as viewer-only', async () => {
		const { client } = makeClient();
		const bytes = assembleContainer([{ type: 1, codec: 0, rawLength: 0, count: 0, bytes: new Uint8Array() }]);
		try {
			const result = await client.open(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
			expect(result).toMatchObject({ kind: 'viewer', authoringValidationPerformed: false });
			expect(client.checkpoint).toBeNull();
		} finally { await client.close(); }
	});

	test('uses owned bytes for WRITE/ACK and opens the actual serialized graph cleanly', async () => {
		const first = makeClient();
		try {
			const created = await first.client.create();
			expect(created.checkpoint.snapshot.graph.name).toBe('Untitled');
			expect(Object.isFrozen(created.checkpoint.snapshot.graph)).toBe(true);
			expect(Object.isFrozen(created.checkpoint.history.undo)).toBe(true);
			await first.client.command({ kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [2, 0, 3] });
			const write = await first.client.write();
			expect(write.ownedBuffer).toBeInstanceOf(ArrayBuffer);
			expect(write.ownedBuffer.byteLength).toBe(write.length);
			expect(write.sha256).toMatch(/^[0-9a-f]{64}$/i);
			const bytes = write.ownedBuffer.slice(0);
			const acknowledged = await first.client.acknowledgeDownload(write.writeId, write.revision);
			expect(acknowledged.dirty).toBe(false);
			expect(first.client.checkpoint?.history.savedGraph).toEqual(first.client.checkpoint?.snapshot.graph);
			const warmWrite = await first.client.write();
			expect(warmWrite.ownedBuffer.byteLength).toBe(warmWrite.length);
			expect(warmWrite.sha256).toBe(write.sha256);
			expect(bytes.byteLength).toBe(write.length);
			await first.client.acknowledgeDownload(warmWrite.writeId, warmWrite.revision);
			await first.client.close();
			expect(first.client.checkpoint).toBeNull();

			const reopened = makeClient();
			try {
				const openResult = await reopened.client.open(bytes);
				expect(openResult.kind).toBe('authoring');
				if (openResult.kind !== 'authoring') return;
				expect(openResult.dirty).toBe(false);
				expect(openResult.canUndo).toBe(false);
				expect(openResult.canRedo).toBe(false);
				expect(openResult.checkpoint.sequence).toBe(2);
				expect(openResult.checkpoint.history.undo).toHaveLength(0);
				expect(reopened.client.checkpoint?.snapshot.graph.meshes[0]?.faces).toHaveLength(1);
			} finally { await reopened.client.close(); }
		} finally {
			if (!first.client.isClosed) await first.client.close();
		}
	});

	test('reuses only previously acknowledged immutable history across worker transitions', async () => {
		const { client } = makeClient();
		try {
			await client.create();
			await client.command({ kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [2, 0, 3] });
			const first = client.checkpoint!;
			await client.command({ kind: 'CREATE_RECTANGLE', first: [4, 0, 0], opposite: [6, 0, 3] });
			const second = client.checkpoint!;
			expect(first.history.undo).toHaveLength(1);
			expect(second.history.undo).toHaveLength(2);
			expect(second.history.undo[0]).toBe(first.history.undo[0]);
			expect(second.history.undo[1]).not.toBe(first.history.undo[0]);

			await client.undo();
			const undone = client.checkpoint!;
			expect(undone.history.undo[0]).toBe(first.history.undo[0]);
			expect(undone.history.redo[0]).toBe(second.history.undo[1]);
			await client.redo();
			const redone = client.checkpoint!;
			expect(redone.history.undo[1]).toBe(second.history.undo[1]);
			expect(redone.history.redo).toHaveLength(0);
		} finally { await client.close(); }
	});

	test('cancels only the exact unacknowledged write and restores the latest ACK checkpoint', async () => {
		const { client, workers } = makeClient();
		try {
			await client.create();
			await client.command({ kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [2, 0, 3] });
			const acknowledged = client.checkpoint!;
			const issued = await client.write();

			await expect(client.cancelUnacknowledgedWrite('e8f2eaa7-c628-4aa9-9fd8-44f17fbe9de2'))
				.rejects.toMatchObject({ code: 'INVALID_COMMAND' });
			expect(client.checkpoint?.snapshot.graph).toEqual(acknowledged.snapshot.graph);
			expect(client.checkpoint?.history).toEqual(acknowledged.history);

			const cancelling = client.cancelUnacknowledgedWrite(issued.writeId);
			const joinedCancellation = client.cancelUnacknowledgedWrite(issued.writeId);
			expect(joinedCancellation).toBe(cancelling);
			const [restored] = await Promise.all([cancelling, joinedCancellation]);
			expect(workers).toHaveLength(2);
			expect(restored.checkpoint.snapshot.graph).toEqual(acknowledged.snapshot.graph);
			expect(restored.checkpoint.snapshot.revision).toBe(acknowledged.snapshot.revision);
			expect(restored.checkpoint.history).toEqual(acknowledged.history);
			expect(restored.checkpoint.sequence).toBe(acknowledged.sequence);
			expect(restored.checkpoint.history.savedGraph).toEqual(acknowledged.history.savedGraph);
			expect(restored.dirty).toBe(acknowledged.history.savedGraph === null);
			expect(client.checkpoint?.snapshot.graph).toEqual(acknowledged.snapshot.graph);

			const freshWrite = await client.write();
			expect(freshWrite.ownedBuffer.byteLength).toBe(freshWrite.length);
			expect(freshWrite.sha256).toMatch(/^[0-9a-f]{64}$/i);
			const saved = await client.acknowledgeDownload(freshWrite.writeId, freshWrite.revision);
			expect(saved.dirty).toBe(false);
		} finally { await client.close(); }
	});

	test('admits at most 32 active plus queued requests without dropping accepted FIFO work', async () => {
		const { client } = makeClient();
		try {
			await client.create();
			const requests = Array.from({ length: 33 }, (_, index) => client.command({
				kind: 'CREATE_RECTANGLE',
				first: [index * 3, 0, 0],
				opposite: [index * 3 + 1, 0, 1]
			}));
			const results = await Promise.allSettled(requests);
			expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(32);
			const rejected = results.filter((result) => result.status === 'rejected');
			expect(rejected).toHaveLength(1);
			if (rejected[0]?.status === 'rejected') expect(rejected[0].reason).toMatchObject({ code: 'BUSY' });
			expect(client.checkpoint?.history.undo).toHaveLength(32);
			expect(client.checkpoint?.sequence).toBe(33);
		} finally { await client.close(); }
	});

	test('aborts unsent queued work locally, aborts active work once, then restores only the ACK checkpoint', async () => {
		const { client, workers } = makeClient();
		try {
			await client.create();
			await client.command({ kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [2, 0, 3] });
			const acknowledged = client.checkpoint!;
			workers[0]!.paused = true;
			const activeAbort = new AbortController();
			const active = client.command({ kind: 'CREATE_RECTANGLE', first: [4, 0, 0], opposite: [6, 0, 3] }, { signal: activeAbort.signal });
			const queuedAbort = new AbortController();
			const queued = client.command({ kind: 'CREATE_RECTANGLE', first: [8, 0, 0], opposite: [10, 0, 3] }, { signal: queuedAbort.signal });
			queuedAbort.abort();
			await expect(queued).rejects.toMatchObject({ code: 'ABORTED' });
			activeAbort.abort();
			await expect(active).rejects.toMatchObject({ code: 'ABORTED' });
			await waitFor(() => !client.isRestoring);
			expect(client.restoreError).toBeNull();
			expect(client.checkpoint?.snapshot.graph).toEqual(acknowledged.snapshot.graph);
			expect(client.checkpoint?.history).toEqual(acknowledged.history);
			expect(Object.values(client.checkpoint!.snapshot.tokens).every((token) => token === acknowledged.snapshot.revision)).toBe(true);
		} finally { await client.close(); }
	});

	test('aborts an active WRITE on worker progress and restores the exact unsaved ACK checkpoint cold', async () => {
		const { client, workers } = makeClient();
		try {
			await client.create();
			await client.command({ kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [2, 0, 3] });
			const acknowledged = client.checkpoint!;
			const abort = new AbortController();
			let progressSeen = false;
			const write = client.write({
				signal: abort.signal,
				onProgress: () => {
					progressSeen = true;
					abort.abort();
				}
			});
			await expect(write).rejects.toMatchObject({ code: 'ABORTED' });
			await waitFor(() => progressSeen && !client.isRestoring);
			expect(workers).toHaveLength(2);
			expect(client.checkpoint?.snapshot.graph).toEqual(acknowledged.snapshot.graph);
			expect(client.checkpoint?.history).toEqual(acknowledged.history);
			expect(client.checkpoint?.history.savedGraph).toBeNull();
			expect(Object.values(client.checkpoint!.snapshot.tokens).every((token) => token === acknowledged.snapshot.revision)).toBe(true);
		} finally { await client.close(); }
	});

	test('recovers an active mutation after worker crash and leaves no speculative graph state', async () => {
		const { client, workers } = makeClient();
		try {
			await client.create();
			await client.command({ kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [2, 0, 3] });
			const acknowledged = client.checkpoint!;
			workers[0]!.paused = true;
			const pending = client.command({ kind: 'CREATE_RECTANGLE', first: [4, 0, 0], opposite: [6, 0, 3] });
			const originalRequest = workers[0]!.lastRequest as AuthoringRequest;
			workers[0]!.crash();
			await expect(pending).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
			await waitFor(() => !client.isRestoring);
			expect(workers).toHaveLength(2);
			workers[0]!.emit({
				protocolVersion: AUTHORING_PROTOCOL_VERSION, event: 'RESULT', sessionId: SESSION_ID,
				requestId: originalRequest.requestId, requestType: 'COMMAND', result: { kind: 'authoring' }
			});
			expect(client.checkpoint?.snapshot.graph).toEqual(acknowledged.snapshot.graph);
			expect(client.checkpoint?.history).toEqual(acknowledged.history);
			const next = await client.command({ kind: 'CREATE_RECTANGLE', first: [8, 0, 0], opposite: [10, 0, 3] });
			expect(next.commandResult?.entityId).toBe(`${DOCUMENT_ID}:rectangle:2`);
		} finally { await client.close(); }
	});

	test('ignores a matching request ID reply from the wrong worker session', async () => {
		const { client, workers } = makeClient();
		try {
			await client.create();
			const worker = workers[0]!;
			worker.paused = true;
			const pending = client.command({ kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [2, 0, 3] });
			await waitFor(() => (worker.lastRequest as AuthoringRequest | null)?.type === 'COMMAND');
			const sent = worker.lastRequest as AuthoringRequest;
			worker.emit({
				protocolVersion: AUTHORING_PROTOCOL_VERSION, event: 'RESULT',
				sessionId: 'e8f2eaa7-c628-4aa9-9fd8-44f17fbe9de2', requestId: sent.requestId,
				requestType: 'COMMAND', result: { kind: 'authoring' }
			});
			expect(client.checkpoint?.snapshot.graph.meshes).toHaveLength(0);
			worker.resume();
			const result = await pending;
			expect(result.checkpoint.snapshot.graph.meshes[0]?.faces).toHaveLength(1);
			expect(client.checkpoint?.snapshot.graph.meshes[0]?.faces).toHaveLength(1);
		} finally { await client.close(); }
	});

	test('rejects a structurally valid but noncanonical worker checkpoint before publication', async () => {
		const { client, workers } = makeClient();
		try {
			await client.create();
			const acknowledged = client.checkpoint!;
			workers[0]!.transformMessage = (value) => {
				const message = value as {
					event?: string;
					requestType?: string;
					result?: { checkpoint?: { snapshot?: { graph?: { meshes?: Array<{ positions?: number[] }> } } } };
				};
				if (message.event === 'RESULT' && message.requestType === 'COMMAND') {
					const positions = message.result?.checkpoint?.snapshot?.graph?.meshes?.[0]?.positions;
					if (positions) positions[0] = Number.NaN;
				}
				return value;
			};

			await expect(client.command({ kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [2, 0, 3] }))
				.rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
			await waitFor(() => !client.isRestoring);
			expect(workers).toHaveLength(2);
			expect(client.checkpoint?.snapshot.graph).toEqual(acknowledged.snapshot.graph);
			expect(client.checkpoint?.history).toEqual(acknowledged.history);
		} finally { await client.close(); }
	});

	test('recovers an acknowledged client after a malformed worker READY envelope', async () => {
		const { client, workers } = makeClient();
		try {
			await client.create();
			const acknowledged = client.checkpoint!;
			workers[0]!.emit({ protocolVersion: AUTHORING_PROTOCOL_VERSION, event: 'READY', sessionId: null, extra: true });
			await waitFor(() => !client.isRestoring);
			expect(workers).toHaveLength(2);
			expect(client.restoreError).toBeNull();
			expect(client.checkpoint?.snapshot.graph).toEqual(acknowledged.snapshot.graph);
		} finally { await client.close(); }
	});

	test('retains the checkpoint on failed restore, supports retry, and never restores after close', async () => {
		let failFactory = false;
		const { client, workers } = makeClient(() => {
			if (failFactory) throw new Error('controlled factory failure');
			return new DispatcherWorker() as unknown as Worker;
		});
		await client.create();
		await client.command({ kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [2, 0, 3] });
		const acknowledged = client.checkpoint!;
		failFactory = true;
		workers[0]!.crash();
		expect(client.restoreError).not.toBeNull();
		expect(client.checkpoint?.snapshot.graph).toEqual(acknowledged.snapshot.graph);
		failFactory = false;
		const restored = await client.retryRestore();
		expect(restored.checkpoint.snapshot.graph).toEqual(acknowledged.snapshot.graph);
		const workerCount = workers.length;
		await client.close();
		workers[workerCount - 1]!.crash();
		expect(workers).toHaveLength(workerCount);
		expect(client.checkpoint).toBeNull();
	});

	test('dispatcher checks expectedRevision and deduplicates duplicate in-flight/cached request IDs', async () => {
		const messages: AuthoringWorkerMessage[] = [];
		const dispatcher = new AuthoringWorkerDispatcher((message) => messages.push(message), () => 'cf1a8f05-5fdb-4af5-a6c1-96e6a244ecdd');
		const base = { protocolVersion: AUTHORING_PROTOCOL_VERSION, sessionId: SESSION_ID } as const;
		const create: AuthoringRequest = {
			...base, requestId: 1, type: 'CREATE', data: { documentId: DOCUMENT_ID, name: 'Untitled' }
		};
		dispatcher.receive(create);
		await waitFor(() => messages.some((message) => message.event === 'RESULT' && message.requestId === 1));
		const stale: AuthoringRequest = {
			...base, requestId: 2, type: 'COMMAND', expectedRevision: 9,
			data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [2, 0, 3] }
		};
		dispatcher.receive(stale);
		await waitFor(() => messages.some((message) => message.event === 'ERROR' && message.requestId === 2));
		const staleReply = messages.find((message) => message.event === 'ERROR' && message.requestId === 2);
		expect(staleReply?.event === 'ERROR' ? staleReply.error : null).toMatchObject({ code: 'STALE_REVISION', currentRevision: 0 });
		const command: AuthoringRequest = {
			...base, requestId: 3, type: 'COMMAND', expectedRevision: 0,
			data: { kind: 'CREATE_RECTANGLE', first: [0, 0, 0], opposite: [2, 0, 3] }
		};
		dispatcher.receive(command);
		dispatcher.receive(command);
		await waitFor(() => messages.filter((message) => message.event === 'RESULT' && message.requestId === 3).length === 1);
		dispatcher.receive(command);
		await waitFor(() => messages.filter((message) => message.event === 'RESULT' && message.requestId === 3).length === 2);
		const commandResults = messages.filter((message) => message.event === 'RESULT' && message.requestId === 3);
		expect(commandResults).toHaveLength(2);
		for (const message of commandResults) if (message.event === 'RESULT' && message.result.kind === 'authoring') {
			expect(message.result.checkpoint.snapshot.revision).toBe(1);
			expect(message.result.checkpoint.sequence).toBe(2);
			expect(message.result.checkpoint.snapshot.graph.meshes[0]?.faces).toHaveLength(1);
		}
	});
});
