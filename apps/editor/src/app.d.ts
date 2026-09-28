declare global {
	const __SIBAMBO_APP_BUILD__: {
		schema: 'sibambo-app-build-identity-v2'; app: string; version: string; commit: string;
		dirty: boolean; fingerprintScheme: 'sibambo-app-closure-sha256-v1'; sourceSha256: string;
		buildConfigSha256: string; lockfileSha256: string | null; policySha256: string | null; dataManifestSha256: string | null;
		workingTree: {
			buildInputModifiedPaths: string[]; buildInputUntrackedPaths: string[];
			otherModifiedPaths: string[]; otherUntrackedPaths: string[]; generatedOutputPaths: string[];
		};
		packageClosure: Array<{ name: string; version: string; manifestSha256: string }>;
		capturedAt: string;
	};
	namespace App {}
}

export {};
