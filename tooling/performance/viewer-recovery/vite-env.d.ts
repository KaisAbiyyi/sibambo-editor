interface ImportMetaEnv {
	readonly DEV: boolean;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

declare module '*?url' {
	const assetUrl: string;
	export default assetUrl;
}
