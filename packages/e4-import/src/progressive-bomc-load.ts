import type { AdaptedBomcResult, BomcEncodingContract, ProgressiveBomcCallbacks } from './types';
import { BomcLoader } from './bomc-loader';

export type ProgressiveLoadState = {
	stage: 'idle' | 'reading_metadata' | 'decoding_geometry' | 'first_renderable' | 'hydrating_textures' | 'completed' | 'cancelled' | 'error';
	coreMetadataReady: boolean;
	geometryReady: boolean;
	firstRenderableReady: boolean;
	texturesLoaded: number;
	texturesTotal: number;
	error?: Error;
};

export class ProgressiveBomcLoader {
	private cancelled = false;

	cancel() {
		this.cancelled = true;
	}

	isCancelled(): boolean {
		return this.cancelled;
	}

	async loadProgressive(
		buffer: ArrayBuffer,
		sourceName = 'model.bomc',
		callbacks: ProgressiveBomcCallbacks = {},
		options: { prepareSolid?: boolean } = {}
	): Promise<AdaptedBomcResult> {
		const loader = new BomcLoader();
		const mergedCallbacks: ProgressiveBomcCallbacks = {
			...callbacks,
			isCancelled: () => this.cancelled || (callbacks.isCancelled?.() ?? false)
		};

		return loader.load(buffer, sourceName, {
			...options,
			callbacks: mergedCallbacks
		});
	}
}
