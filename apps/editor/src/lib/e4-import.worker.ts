import { BomcLoader, type E4WorkerProgress } from '@sibambo/e4-import';
import { prepareApplicationRenderScene } from '@sibambo/scene-runtime';

type LoadMessage = { type: 'load'; id: number; buffer: ArrayBuffer; sourceName: string };
type CancelMessage = { type: 'cancel'; id: number };
const cancelled = new Set<number>();
const transferMessage = (message: unknown, transfer: Transferable[]) =>
	(self as unknown as { postMessage(value: unknown, transferList?: Transferable[]): void }).postMessage(message, transfer);

function collectTransferables(value: unknown, buffers = new Set<ArrayBuffer>(), seen = new WeakSet<object>()) {
	if (!value || typeof value !== 'object') return buffers;
	if (value instanceof ArrayBuffer) { buffers.add(value); return buffers; }
	if (ArrayBuffer.isView(value)) { if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer); return buffers; }
	if (seen.has(value)) return buffers;
	seen.add(value);
	for (const child of Object.values(value)) collectTransferables(child, buffers, seen);
	return buffers;
}

self.onmessage = async (event: MessageEvent<LoadMessage | CancelMessage>) => {
	const message = event.data;
	if (message.type === 'cancel') { cancelled.add(message.id); return; }
	const sendProgress = (progress: E4WorkerProgress) => self.postMessage({ type: 'progress', id: message.id, progress });
	try {
		const result = await new BomcLoader().load(message.buffer, message.sourceName, {
			prepareSolid: true,
			callbacks: {
				isCancelled: () => cancelled.has(message.id),
				onCoreMetadataReady: () => sendProgress({ stage: 'metadata', completed: 1, total: 4, unit: 'stage', message: 'Artifact sections decoded' }),
				onTextureReady: (_asset, progress) => sendProgress({ stage: 'textures', completed: progress.loaded, total: progress.total, unit: 'asset', message: `Texture data decoded: ${progress.loaded} of ${progress.total}` }),
				onGeometryReady: () => sendProgress({ stage: 'geometry', completed: 3, total: 4, unit: 'stage', message: 'Geometry and scene data prepared' }),
				onSolidPreparationProgress: (progress) => sendProgress({
					stage: progress.phase === 'solid-edges' ? 'building-solid-edges' : 'resolving-solid-surfaces',
					completed: progress.completed,
					total: progress.total,
					unit: progress.phase === 'shell-patches' || progress.phase === 'candidate-query' ? 'patch' : 'unit',
					message: progress.message ?? 'Preparing render surfaces.'
				}),
				onFirstRenderable: () => sendProgress({ stage: 'complete', completed: 4, total: 4, unit: 'stage', message: 'Import data ready; preparing the viewport' })
			}
		});
		if (cancelled.has(message.id)) {
			self.postMessage({ type: 'cancelled', id: message.id });
			return;
		}
		const preparation = prepareApplicationRenderScene(result.preparedRuntimeScene, result.encodingContract?.profile, (progress) => {
			if (progress.phase === 'batching') {
				sendProgress({ stage: 'batching', completed: progress.completed, total: progress.total, unit: 'group', message: progress.message ?? 'Compacting render surfaces.' });
				return;
			}
			sendProgress({
				stage: progress.phase === 'solid-edges' ? 'building-solid-edges' : 'resolving-solid-surfaces',
				completed: progress.completed,
				total: progress.total,
				unit: progress.phase === 'shell-patches' || progress.phase === 'candidate-query' ? 'patch' : 'unit',
				message: progress.message ?? 'Preparing render surfaces.'
			});
		});
		if (preparation.solidCoplanarResolutionMs !== undefined) result.diagnostics.timings.solidCoplanarResolutionMs = preparation.solidCoplanarResolutionMs;
		if (preparation.surfaceBatching) {
			result.diagnostics.finalTypedArrayBytes = preparation.surfaceBatching.typedArrayBytes;
			result.diagnostics.timings.surfaceBatchingMs = preparation.surfaceBatching.preparationMs;
		}
		if (cancelled.has(message.id)) {
			self.postMessage({ type: 'cancelled', id: message.id });
			return;
		}
		transferMessage({ type: 'complete', id: message.id, result }, [...collectTransferables(result)]);
	} catch (cause) {
		transferMessage({ type: cancelled.has(message.id) ? 'cancelled' : 'error', id: message.id, error: cause instanceof Error ? cause.message : 'BOMC import failed.' }, []);
	} finally {
		cancelled.delete(message.id);
	}
};
