import { RepeatWrapping, Texture, TextureLoader, SRGBColorSpace } from 'three';

export type TextureCacheStats = {
	referencesCount: number;
	uniqueAssetCount: number;
	decodedTexturesCount: number;
	cacheHits: number;
	assetBytes: number;
};

export class RuntimeAssetResolver {
	private assets = new Map<string, Uint8Array>();
	private objectUrls = new Map<string, string>();
	private textureCache = new Map<string, Texture>();
	private unsupportedTextureWarnings = new Set<string>();
	private successfulDecodes = new Set<string>();
	private failedDecodes = new Set<string>();
	private missingAssets = new Set<string>();
	private stats: TextureCacheStats = {
		referencesCount: 0,
		uniqueAssetCount: 0,
		decodedTexturesCount: 0,
		cacheHits: 0,
		assetBytes: 0
	};
	private textureSettledListeners = new Set<(event: { path: string; ok: boolean }) => void>();

	constructor(assets?: Map<string, Uint8Array>) {
		if (assets) {
			for (const [path, bytes] of assets) {
				this.registerAsset(path, bytes);
			}
		}
	}

	registerAsset(path: string, bytes: Uint8Array): void {
		// Clean and normalize asset path to prevent path traversal
		const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
		if (cleanPath.includes('../')) {
			throw new Error(`Runtime asset path traversal is not allowed (${path}).`);
		}
		const previous = this.assets.get(cleanPath);
		if (previous) this.stats.assetBytes -= previous.byteLength;
		this.assets.set(cleanPath, bytes);
		this.stats.uniqueAssetCount = this.assets.size;
		this.stats.assetBytes += bytes.byteLength;
	}

	hasAsset(path: string): boolean {
		const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
		return this.assets.has(cleanPath);
	}

	getObjectUrl(path: string): string | null {
		const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
		const existingUrl = this.objectUrls.get(cleanPath);
		if (existingUrl) return existingUrl;

		const bytes = this.assets.get(cleanPath);
		if (!bytes) { this.missingAssets.add(cleanPath); return null; }
		// Three's regular TextureLoader cannot transcode KTX2. Retain the bytes in
		// the asset table, but let the material's base colour be the deterministic
		// fallback until a KTX2Loader/transcoder is configured by the host.
		if (cleanPath.toLowerCase().endsWith('.ktx2')) {
			if (!this.unsupportedTextureWarnings.has(cleanPath)) {
				this.unsupportedTextureWarnings.add(cleanPath);
				console.warn(`[viewport] KTX2 asset retained but not decoded: ${cleanPath}`);
			}
			return null;
		}

		let mime = 'image/png';
		if (cleanPath.endsWith('.jpg') || cleanPath.endsWith('.jpeg')) mime = 'image/jpeg';
		else if (cleanPath.endsWith('.webp')) mime = 'image/webp';
		else if (cleanPath.endsWith('.avif')) mime = 'image/avif';
		else if (cleanPath.endsWith('.ktx2')) mime = 'image/ktx2';
		else if (cleanPath.endsWith('.svg')) mime = 'image/svg+xml';

		const blob = new Blob([bytes as BlobPart], { type: mime });
		const url = URL.createObjectURL(blob);
		this.objectUrls.set(cleanPath, url);
		return url;
	}

	getTexture(archivePath: string): Texture | null {
		this.stats.referencesCount += 1;
		const cleanPath = archivePath.replace(/\\/g, '/').replace(/^\/+/, '');

		const cached = this.textureCache.get(cleanPath);
		if (cached) {
			this.stats.cacheHits += 1;
			return cached;
		}

		const bytes = this.assets.get(cleanPath);
		if (!bytes) { this.missingAssets.add(cleanPath); return null; }
		// Three's regular TextureLoader cannot transcode KTX2. Retain the bytes in
		// the asset table, but let the material's base colour be the deterministic
		// fallback until a KTX2Loader/transcoder is configured by the host.
		if (cleanPath.toLowerCase().endsWith('.ktx2')) {
			if (!this.unsupportedTextureWarnings.has(cleanPath)) {
				this.unsupportedTextureWarnings.add(cleanPath);
				console.warn(`[viewport] KTX2 asset retained but not decoded: ${cleanPath}`);
			}
			return null;
		}

		const url = this.getObjectUrl(cleanPath);
		if (!url && typeof document !== 'undefined') {
			this.missingAssets.add(cleanPath);
			return null;
		}
		let texture: Texture;
		if (url && typeof document !== 'undefined') {
			texture = new TextureLoader().load(
				url,
				() => this.notifyTextureSettled(cleanPath, true),
				undefined,
				() => {
					console.warn(`[viewport] Texture asset could not be decoded: ${cleanPath}`);
					this.notifyTextureSettled(cleanPath, false);
				}
			);
		} else {
			// Headless tests retain the same cache/lifecycle semantics without a DOM decoder.
			texture = new Texture();
		}
		texture.name = cleanPath;
		texture.colorSpace = SRGBColorSpace;
		texture.wrapS = RepeatWrapping;
		texture.wrapT = RepeatWrapping;

		this.textureCache.set(cleanPath, texture);
		this.stats.decodedTexturesCount = this.textureCache.size;
		return texture;
	}

	onTextureSettled(listener: (event: { path: string; ok: boolean }) => void): () => void {
		this.textureSettledListeners.add(listener);
		return () => this.textureSettledListeners.delete(listener);
	}

	private notifyTextureSettled(path: string, ok: boolean): void {
		(ok ? this.successfulDecodes : this.failedDecodes).add(path);
		for (const listener of this.textureSettledListeners) listener({ path, ok });
	}

	getStats() {
		return { ...this.stats, successfulDecodes: this.successfulDecodes.size, failedDecodes: this.failedDecodes.size, failedDecodePaths: [...this.failedDecodes], missingAssetPaths: [...this.missingAssets], unsupportedTexturePaths: [...this.unsupportedTextureWarnings] };
	}

	dispose(): void {
		for (const url of this.objectUrls.values()) {
			if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
				URL.revokeObjectURL(url);
			}
		}
		for (const texture of this.textureCache.values()) {
			texture.dispose();
		}
		this.assets.clear();
		this.objectUrls.clear();
		this.textureCache.clear();
		this.unsupportedTextureWarnings.clear();
		this.successfulDecodes.clear(); this.failedDecodes.clear(); this.missingAssets.clear();
		this.textureSettledListeners.clear();
		this.stats = {
			referencesCount: 0,
			uniqueAssetCount: 0,
			decodedTexturesCount: 0,
			cacheHits: 0,
			assetBytes: 0
		};
	}
}
