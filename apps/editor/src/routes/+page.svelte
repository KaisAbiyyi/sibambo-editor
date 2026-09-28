<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import SibamboHeader from '$lib/components/SibamboHeader.svelte';
	import '$lib/ui/sibambo.css';
	import type { AdaptedBomcResult } from '@sibambo/e4-import';
	import { EditorSession } from '$lib/editor/EditorSession';
	import { loadE4InWorker } from '$lib/e4-worker-client';
	import type { PreparedSceneViewport, ViewMode, ViewportPick } from '@sibambo/viewport';
	import { admitE4File } from '$lib/e4-admission';
	import { readBoundedJsonText } from '@sibambo/provenance';
	import type { ResearchProvenance } from '@sibambo/contracts';

	let sourceFile = $state<File | null>(null);
	let provenanceFile = $state<File | null>(null);
	let provenance = $state<ResearchProvenance | null>(null);
	let artifactSha256 = $state('');
	let result = $state.raw<AdaptedBomcResult | null>(null);
	let session = $state.raw<EditorSession | null>(null);
	let viewport = $state.raw<PreparedSceneViewport | null>(null);
	let viewportHost = $state<HTMLDivElement | null>(null);
	let sourceInput: HTMLInputElement;
	let provenanceInput: HTMLInputElement;
	let provenanceUpgradeInput: HTMLInputElement;
	let busy = $state(false);
	let loadStatus = $state('Choose a BOMC 1.2 model file.');
	let ready = $state(false);
	let error = $state('');
	let activeOperation: 'import' | 'provenance' = 'import';
	let picked = $state<ViewportPick | null>(null);
	let viewMode = $state<ViewMode>('solid');
	let sceneId = $state('');
	let generation = 0;
	let evidenceGeneration = 0;
	let controller: AbortController | null = null;
	let lastCancelledSnapshot: LoadedEditorState | null = null;
	let lastCancelGeneration = -1;
	type LoadedEditorState = {
		provenance: ResearchProvenance | null;
		artifactSha256: string;
		result: AdaptedBomcResult | null;
		session: EditorSession | null;
		viewport: PreparedSceneViewport | null;
		ready: boolean;
		picked: ViewportPick | null;
		sceneId: string;
		hostChildren: Node[];
	};
	let activeLoadSnapshot: LoadedEditorState | null = null;

	function snapshotLoadedState(): LoadedEditorState {
		return {
			provenance, artifactSha256, result, session, viewport, ready, picked, sceneId,
			hostChildren: viewportHost ? Array.from(viewportHost.childNodes) : []
		};
	}

	function restoreHostChildren(children: Node[]) {
		if (viewportHost) viewportHost.replaceChildren(...children);
	}
	function isCurrentCancelledSnapshot(snapshot: LoadedEditorState) {
		return lastCancelledSnapshot === snapshot && lastCancelGeneration === generation;
	}

	function restoreLoadedState(snapshot: LoadedEditorState) {
		if (viewport && viewport !== snapshot.viewport) viewport.dispose();
		if (session && session !== snapshot.session) session.dispose();
		provenance = snapshot.provenance;
		artifactSha256 = snapshot.artifactSha256;
		result = snapshot.result;
		session = snapshot.session;
		viewport = snapshot.viewport;
		ready = snapshot.ready;
		picked = snapshot.picked;
		sceneId = snapshot.sceneId;
		restoreHostChildren(snapshot.hostChildren);
	}

	function stageSource(event: Event) {
		sourceFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
		// A staged source record belongs to the previously selected artifact.
		// Clear it when the artifact changes so replacement can fall back to file-only.
		provenanceFile = null;
		if (provenanceInput) provenanceInput.value = '';
		error = '';
	}
	function stageProvenance(event: Event) {
		provenanceFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
		error = '';
	}
	function stageUpgradeProvenance(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const sidecar = input.files?.[0] ?? null;
		input.value = '';
		error = '';
		if (sidecar) void attachProvenance(sidecar);
	}
	function clearStagedProvenance() {
		provenanceFile = null;
		if (provenanceInput) provenanceInput.value = '';
		error = '';
	}

	async function openModel() {
		if (!sourceFile || busy) return;
		const file = sourceFile;
		const sidecar = provenanceFile;
		const previous = snapshotLoadedState();
		activeLoadSnapshot = previous;
		const request = ++generation;
		evidenceGeneration += 1;
		lastCancelledSnapshot = null;
		lastCancelGeneration = -1;
		controller?.abort();
		controller = new AbortController();
		let candidateSession: EditorSession | null = null;
		let candidateViewport: PreparedSceneViewport | null = null;
		busy = true;
		activeOperation = 'import';
		loadStatus = sidecar ? 'Checking BOMC and provenance…' : 'Checking BOMC format and artifact hash…';
		error = '';
		try {
			const parsedSidecar = sidecar ? JSON.parse(await readBoundedJsonText(sidecar, 'Provenance sidecar')) as unknown : undefined;
			const admitted = await admitE4File(file, parsedSidecar);
			if (request !== generation) return;
			loadStatus = 'Starting E4 import worker…';
			const loaded = await loadE4InWorker(admitted.buffer, file.name, controller.signal, (progress) => {
				if (request === generation) loadStatus = progress.message;
			});
			if (admitted.provenance && loaded.encodingContract?.profile !== admitted.provenance.artifact.profile) {
				throw new Error('BOMC encoding profile does not match the admitted provenance profile.');
			}
			if (request !== generation) return;
			const nextSceneId = loaded.activeSceneId ?? loaded.scenes[0]?.id ?? '';
			const nextSession = new EditorSession(file, admitted.provenance, admitted.artifactSha256, loaded.encodingContract?.profile ?? null);
			candidateSession = nextSession;
			if (!previous.result) {
				provenance = admitted.provenance;
				artifactSha256 = admitted.artifactSha256;
				result = loaded;
				session = nextSession;
				sceneId = nextSceneId;
				ready = false;
				picked = null;
			}
			await tick();
			if (request !== generation) { nextSession.dispose(); return; }
			if (!viewportHost) throw new Error('The Editor viewport host is unavailable.');
			const { PreparedSceneViewport } = await import('@sibambo/viewport');
			if (request !== generation) { nextSession.dispose(); return; }
			const nextViewport = await PreparedSceneViewport.mount(viewportHost, {
				scene: loaded.preparedRuntimeScene,
				appearance: loaded.appearance,
				scenes: loaded.scenes, activeSceneId: nextSceneId, clipPlanes: loaded.clipPlanes,
				encodingProfile: loaded.encodingContract?.profile, editorMode: false
			});
			candidateViewport = nextViewport;
			if (request !== generation) {
				nextViewport.dispose();
				nextSession.dispose();
				if (isCurrentCancelledSnapshot(previous)) restoreHostChildren(previous.hostChildren);
				return;
			}
			const selectedScene = loaded.scenes.find((scene) => scene.id === nextSceneId);
			nextViewport.setScene(selectedScene ?? null);
			nextViewport.setViewMode(viewMode);
			nextViewport.setOnPick((item) => { if (viewport === nextViewport && request === generation) picked = item; });
			provenance = admitted.provenance;
			artifactSha256 = admitted.artifactSha256;
			result = loaded;
			session = nextSession;
			sceneId = nextSceneId;
			viewport = nextViewport;
			ready = false;
			picked = null;
			nextViewport.setOnReady(() => { if (viewport === nextViewport && request === generation) ready = true; });
			if (previous.viewport && previous.viewport !== nextViewport) previous.viewport.dispose();
			if (previous.session && previous.session !== nextSession) previous.session.dispose();
			activeLoadSnapshot = null;
		} catch (cause) {
			if (request === generation) {
				if (candidateViewport && candidateViewport !== previous.viewport) {
					candidateViewport.dispose();
					if (viewport === candidateViewport) viewport = previous.viewport;
				}
				if (candidateSession && candidateSession !== previous.session) candidateSession.dispose();
				if (session === candidateSession) session = previous.session;
				restoreLoadedState(previous);
				activeLoadSnapshot = null;
				if (!(cause instanceof DOMException && cause.name === 'AbortError')) error = cause instanceof Error ? cause.message : 'The E4 model could not be opened.';
			}
		} finally {
			if (request === generation) busy = false;
		}
	}

	async function attachProvenance(sidecar: File) {
		const activeSession = session;
		const activeResult = result;
		if (!activeSession || !activeResult || provenance || busy) return;
		const parsedProfile = activeResult.encodingContract?.profile ?? null;
		const request = ++evidenceGeneration;
		busy = true;
		activeOperation = 'provenance';
		loadStatus = 'Checking provenance against the open model…';
		error = '';
		try {
			const parsedSidecar = JSON.parse(await readBoundedJsonText(sidecar, 'Provenance sidecar')) as unknown;
			const admitted = await admitE4File(activeSession.source.file, parsedSidecar);
			if (!admitted.provenance) throw new Error('Provenance JSON is required to match a source record.');
			if (!parsedProfile || parsedProfile !== admitted.provenance.artifact.profile) {
				throw new Error('BOMC encoding profile does not match the admitted provenance profile.');
			}
			if (request !== evidenceGeneration || session !== activeSession) return;
			activeSession.attachProvenance(admitted.provenance);
			provenance = admitted.provenance;
			loadStatus = 'Provenance matched to the open BOMC file.';
		} catch (cause) {
			if (request === evidenceGeneration && session === activeSession) {
				error = cause instanceof Error ? cause.message : 'The provenance record could not be matched.';
			}
		} finally {
			if (request === evidenceGeneration) busy = false;
		}
	}

	function setMode(mode: ViewMode) { viewMode = mode; viewport?.setViewMode(mode); }
	function sceneChanged(event: Event) {
		sceneId = (event.currentTarget as HTMLSelectElement).value;
		const selected = result?.scenes.find((scene) => scene.id === sceneId);
		viewport?.setScene(selected ?? null);
	}
	function downloadCapture() {
		if (!viewport || !result) return;
		const link = document.createElement('a');
		link.href = viewport.capture();
		link.download = `${provenance?.model.id ?? result.modelName ?? 'e4-model'}-editor-view.png`;
		link.click();
	}
	function cancelLoad() {
		const cancelledOperation = activeOperation;
		generation += 1;
		evidenceGeneration += 1;
		controller?.abort();
		controller = null;
		lastCancelledSnapshot = activeLoadSnapshot;
		lastCancelGeneration = generation;
		if (activeLoadSnapshot) restoreLoadedState(activeLoadSnapshot);
		activeLoadSnapshot = null;
		busy = false;
		loadStatus = cancelledOperation === 'provenance' ? 'Provenance check cancelled.' : 'Model load cancelled.';
		error = loadStatus;
	}
	function unload() {
		generation += 1;
		evidenceGeneration += 1;
		controller?.abort();
		controller = null;
		activeLoadSnapshot = null;
		viewport?.dispose();
		viewport = null;
		session?.dispose();
		session = null;
		result = null;
		sceneId = '';
		provenance = null;
		artifactSha256 = '';
		ready = false;
		picked = null;
		busy = false;
		if (sourceInput) sourceInput.value = '';
		if (provenanceInput) provenanceInput.value = '';
		if (provenanceUpgradeInput) provenanceUpgradeInput.value = '';
		sourceFile = null;
		provenanceFile = null;
		loadStatus = 'Choose a BOMC 1.2 model file.';
	}
	onDestroy(() => { generation += 1; evidenceGeneration += 1; controller?.abort(); viewport?.dispose(); session?.dispose(); });
</script>

<svelte:head>
	<title>Sibambo Editor</title>
	<meta name="description" content="Open a local BOMC 1.2 file and inspect it with basic camera and navigation controls. Provenance matching is optional." />
</svelte:head>

<main data-app="editor">
	<SibamboHeader current="editor" />
	<div class="visually-hidden">
		<label>BOMC 1.2 file<input bind:this={sourceInput} type="file" accept=".bomc,application/octet-stream" onchange={stageSource} disabled={busy} tabindex="-1" /></label>
		<label>Provenance JSON for next model<input bind:this={provenanceInput} type="file" accept=".json,application/json" onchange={stageProvenance} disabled={busy} tabindex="-1" /></label>
		<label>Provenance JSON for current model<input bind:this={provenanceUpgradeInput} type="file" accept=".json,application/json" onchange={stageUpgradeProvenance} disabled={busy || !session || !!provenance} tabindex="-1" /></label>
	</div>
	{#if result || busy}
		<section class="toolbar" aria-label="Model and camera controls">
			{#if busy}<button type="button" class="secondary" onclick={cancelLoad}>Cancel</button><output class="load-progress">{loadStatus}</output>{/if}
			{#if result}
			<button class="primary" type="button" onclick={openModel} disabled={busy || !sourceFile}>{busy ? 'Opening…' : 'Open model file'}</button>
			<span class="divider"></span>
			<button type="button" class="secondary" onclick={() => sourceInput?.click()}>Change artifact</button>
			<button type="button" class="secondary" onclick={() => provenanceInput?.click()}>Choose sidecar for next model</button>
			<button type="button" onclick={() => { viewport?.fit(); }}>Fit</button>
			<button type="button" onclick={() => viewport?.view('top')}>Top</button>
			<button type="button" onclick={() => viewport?.view('front')}>Front</button>
			<button type="button" onclick={() => viewport?.view('iso')}>Iso</button>
			<label>Display<select value={viewMode} onchange={(event) => setMode((event.currentTarget as HTMLSelectElement).value as ViewMode)}><option value="solid">Solid</option><option value="xray">X-Ray</option><option value="wireframe">Wireframe</option></select></label>
			{#if result.scenes.length}<label>Scene<select aria-label="Visible scene" value={sceneId} onchange={sceneChanged}>{#each result.scenes as scene}<option value={scene.id}>{scene.name || scene.id}</option>{/each}</select></label>{/if}
			<button type="button" onclick={downloadCapture} disabled={!ready}>Save view</button>
			<button type="button" class="secondary" onclick={unload} disabled={busy}>Unload</button>
		{/if}
		</section>
	{/if}
	{#if result || busy}
		<section class="mobile-toolbar" aria-label="Mobile model controls">
			{#if busy}<div class="mobile-progress"><output class="load-progress">{loadStatus}</output><button type="button" class="secondary" onclick={cancelLoad}>Cancel</button></div>{/if}
			{#if result}
				<div class="mobile-primary-actions">
					<button type="button" class="secondary" onclick={() => viewport?.fit()}>Fit</button>
					<details class="mobile-control-group">
						<summary>Views</summary>
						<div class="mobile-control-panel" aria-label="Standard camera views">
							<button type="button" onclick={() => viewport?.view('top')}>Top</button>
							<button type="button" onclick={() => viewport?.view('front')}>Front</button>
							<button type="button" onclick={() => viewport?.view('iso')}>Iso</button>
						</div>
					</details>
					<details class="mobile-control-group">
						<summary>Display / scene</summary>
						<div class="mobile-control-panel">
							<label>Display<select aria-label="Display mode" value={viewMode} onchange={(event) => setMode((event.currentTarget as HTMLSelectElement).value as ViewMode)}><option value="solid">Solid</option><option value="xray">X-Ray</option><option value="wireframe">Wireframe</option></select></label>
							{#if result.scenes.length}<label>Scene<select value={sceneId} onchange={sceneChanged}>{#each result.scenes as scene}<option value={scene.id}>{scene.name || scene.id}</option>{/each}</select></label>{/if}
						</div>
					</details>
				</div>
				<div class="mobile-secondary-actions">
					<details class="mobile-control-group">
						<summary>Source</summary>
						<div class="mobile-control-panel">
							<button type="button" class="secondary" onclick={() => sourceInput?.click()} disabled={busy}>Change artifact</button>
							<output aria-label="Replacement artifact filename">{sourceFile?.name ?? 'No replacement artifact selected'}</output>
							<button type="button" class="secondary" onclick={() => provenanceInput?.click()} disabled={busy}>Choose sidecar for next model (optional)</button>
							<output aria-label="Replacement sidecar filename">{provenanceFile?.name ?? 'No sidecar selected for next model'}</output>
							{#if provenanceFile}<button type="button" class="secondary" onclick={clearStagedProvenance} disabled={busy}>Remove sidecar for next model</button>{/if}
							<button type="button" class="primary" onclick={openModel} disabled={busy || !sourceFile}>{busy ? 'Opening…' : 'Open model file'}</button>
							<button type="button" class="secondary" onclick={unload} disabled={busy}>Unload</button>
						</div>
					</details>
					<details class="mobile-control-group">
						<summary>Save</summary>
						<div class="mobile-control-panel">
							<button type="button" onclick={downloadCapture} disabled={!ready}>Save view</button>
						</div>
					</details>
				</div>
			{/if}
		</section>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if result}
		<section class="source-bar" aria-label="Imported source status">
			<strong>{provenance?.model.id ?? result.modelName ?? session?.source.file.name}</strong>
			<span class="evidence-level" aria-label="Evidence level" data-evidence-level={session?.source.evidenceLevel ?? 'file-only'}>{provenance ? 'Provenance-matched · operator-attested source record' : 'File-only · source not recorded'}</span>
			<span>{result.encodingContract?.profile?.toUpperCase()} · BOMC {result.diagnostics.version}</span>
			<span>{result.counts.faces.toLocaleString()} faces · {result.counts.instances.toLocaleString()} instances · {result.counts.meshes.toLocaleString()} meshes</span>
			<span class:ready>{ready ? 'Textures settled and first frame observed' : 'Preparing viewport'}</span>
		</section>
		<div class="workspace">
			<div class="viewport-frame"><div class="viewport" bind:this={viewportHost} aria-label="3D viewport"></div><p class="touch-hint" data-testid="touch-hint">One finger rotates; two fingers pan and pinch to zoom. Scroll outside the model to move the page.</p></div>
			<aside aria-label="Source and selection information">
				<details class="inspection-details" open>
					<summary>Model and selection details</summary>
					<div class="inspection-content">
						<h1>Model inspection</h1>
						<p>This imported source is read-only. Editor-owned edits use a separate store and keep this source reference unchanged.</p>
						<dl><dt>Artifact SHA-256</dt><dd>{session?.source.artifactSha256 ?? artifactSha256}</dd><dt>Source</dt><dd>{session?.source.file.name ?? 'Unavailable'}</dd><dt>Evidence level</dt><dd>{session?.source.evidenceLevel ?? 'file-only'}</dd><dt>Source bytes</dt><dd>{session?.source.file.size.toLocaleString() ?? 'Unavailable'}</dd><dt>Model ID</dt><dd>{session?.source.modelId ?? 'Unknown (not recorded)'}</dd><dt>Profile</dt><dd>{session?.source.profile ?? result.encodingContract?.profile ?? 'Unknown'}</dd><dt>Provenance method</dt><dd>{session?.source.provenance?.capture.method ?? 'Not provided'}</dd></dl>
						<div class="source-evidence-actions">
							{#if !provenance}<button type="button" class="secondary" onclick={() => provenanceUpgradeInput?.click()} disabled={busy}>Add provenance JSON to this model</button>{/if}
							<button type="button" class="secondary" onclick={() => provenanceInput?.click()} disabled={busy}>Choose sidecar for next model (optional)</button>
							{#if provenanceFile}<span>Next model sidecar: {provenanceFile.name}</span><button type="button" class="secondary" onclick={clearStagedProvenance} disabled={busy}>Remove sidecar for next model</button>{/if}
						</div>
						{#if picked}<section class="pick"><h2>Picked geometry</h2><dl><dt>Source mesh</dt><dd>{picked.sourceMeshIndex}</dd><dt>Definition</dt><dd>{picked.definitionIndex}</dd><dt>Occurrence</dt><dd>{picked.occurrenceHandle ?? picked.occurrenceIndex ?? 'Unavailable'}</dd><dt>Source face</dt><dd>{picked.sourceFaceIndex ?? 'Unavailable'}</dd></dl></section>{/if}
					</div>
				</details>
			</aside>
		</div>
	{:else}
		<div class="empty-workspace">
			<section class="empty viewport" aria-labelledby="empty-editor-title">
				<div class="empty-dropzone">
					<span class="empty-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m21 16-9 5-9-5V8l9-5 9 5v8Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg></span>
					<p class="eyebrow">MODEL INSPECTION</p>
					<h1 id="empty-editor-title">Open a model file</h1>
					<p>Choose one BOMC 1.2 file to inspect it in 3D. A matching provenance JSON is optional.</p>
					<div class="file-pickers">
						<button type="button" class="secondary" onclick={() => sourceInput?.click()} disabled={busy}>Choose model file</button><span>{sourceFile?.name ?? 'No model file selected'}</span>
					</div>
					<details class="optional-provenance">
						<summary>Source record (optional)</summary>
						<div class="optional-provenance-content">
							<button type="button" class="secondary" onclick={() => provenanceInput?.click()} disabled={busy}>Choose provenance JSON (optional)</button>
							<span>{provenanceFile?.name ?? 'No provenance JSON selected'}</span>
							{#if provenanceFile}<button type="button" class="secondary" onclick={clearStagedProvenance} disabled={busy}>Remove optional sidecar</button>{/if}
						</div>
					</details>
					<button class="primary" type="button" onclick={openModel} disabled={busy || !sourceFile}>{busy ? 'Opening…' : 'Open model file'}</button>
					<p class="validation-note">Editor checks the BOMC 1.2 format and resource limits before loading. A matching source record is shown separately.</p>
				</div>
			</section>
			<aside class="guide" aria-label="Editor workflow">
				<p class="eyebrow">EDITOR WORKSPACE</p><h2>Inspect the model</h2>
				<p>Use the viewport to inspect the checked file and its available source evidence.</p>
				<ol class="workflow-steps"><li><strong>Choose one BOMC file</strong><span>A matching provenance JSON is optional.</span></li><li><strong>Open the model</strong><span>The file format and resource limits are checked before loading.</span></li><li><strong>Explore the view</strong><span>Change camera, scene, display mode, and inspect source geometry.</span></li></ol>
				<p class="note">The imported source stays read-only. Editor does not load Rooms or Benchmark sessions.</p>
			</aside>
		</div>
	{/if}
</main>
