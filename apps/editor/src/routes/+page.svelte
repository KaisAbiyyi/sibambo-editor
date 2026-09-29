<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import type { AdaptedBomcResult } from '@sibambo/e4-import';
	import { EditorSession } from '$lib/editor/EditorSession';
	import { loadE4InWorker } from '$lib/e4-worker-client';
	import { PreparedSceneViewport, type ViewMode, type ViewportPick } from '@sibambo/viewport';
	import { admitE4File } from '$lib/e4-admission';
	import { readBoundedJsonText } from '@sibambo/provenance';
	import type { ResearchProvenance } from '@sibambo/contracts';

	const build = __SIBAMBO_APP_BUILD__;
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
	let busy = $state(false);
	let loadStatus = $state('Choose a BOMC 1.2 file and its provenance sidecar.');
	let ready = $state(false);
	let error = $state('');
	let picked = $state<ViewportPick | null>(null);
	let viewMode = $state<ViewMode>('solid');
	let sceneId = $state('');
	let generation = 0;
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
		error = '';
	}
	function stageProvenance(event: Event) {
		provenanceFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
		error = '';
	}

	async function openModel() {
		if (!sourceFile || !provenanceFile || busy) return;
		const file = sourceFile;
		const sidecar = provenanceFile;
		const previous = snapshotLoadedState();
		activeLoadSnapshot = previous;
		const request = ++generation;
		lastCancelledSnapshot = null;
		lastCancelGeneration = -1;
		controller?.abort();
		controller = new AbortController();
		let candidateSession: EditorSession | null = null;
		let candidateViewport: PreparedSceneViewport | null = null;
		busy = true;
		loadStatus = 'Checking provenance and artifact hash…';
		error = '';
		try {
			const parsedSidecar = JSON.parse(await readBoundedJsonText(sidecar, 'Provenance sidecar')) as unknown;
			const admitted = await admitE4File(file, parsedSidecar);
			if (request !== generation) return;
			loadStatus = 'Starting E4 import worker…';
			const loaded = await loadE4InWorker(admitted.buffer, file.name, controller.signal, (progress) => {
				if (request === generation) loadStatus = progress.message;
			});
			if (loaded.encodingContract?.profile !== admitted.provenance.artifact.profile) {
				throw new Error('BOMC encoding profile does not match the admitted provenance profile.');
			}
			if (request !== generation) return;
			const nextSceneId = loaded.activeSceneId ?? loaded.scenes[0]?.id ?? '';
			const nextSession = new EditorSession(file, admitted.provenance, admitted.artifactSha256);
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
		generation += 1;
		controller?.abort();
		controller = null;
		lastCancelledSnapshot = activeLoadSnapshot;
		lastCancelGeneration = generation;
		if (activeLoadSnapshot) restoreLoadedState(activeLoadSnapshot);
		activeLoadSnapshot = null;
		busy = false;
		loadStatus = 'Model load cancelled.';
		error = 'Model load cancelled.';
	}
	function unload() {
		generation += 1;
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
		sourceFile = null;
		provenanceFile = null;
		loadStatus = 'Choose a BOMC 1.2 file and its provenance sidecar.';
	}
	onDestroy(() => { generation += 1; controller?.abort(); viewport?.dispose(); session?.dispose(); });
</script>

<svelte:head>
	<title>Sibambo Editor</title>
	<meta name="description" content="Open a verified BOMC 1.2 model and inspect it with basic camera and navigation controls." />
</svelte:head>

<main data-app="editor">
	<header class="topbar">
		<div class="brand">Sibambo <small>EDITOR</small></div>
		<nav aria-label="Editor navigation"><a href="/">Editor foundation</a></nav>
		<output data-testid="build-fingerprint" aria-label="Build fingerprint">{build.sourceSha256}</output>
	</header>
	<section class="toolbar" aria-label="Model and camera controls">
		<label class="file-control">BOMC 1.2 file<input bind:this={sourceInput} type="file" accept=".bomc,application/octet-stream" onchange={stageSource} disabled={busy} /></label>
		<label class="file-control">Provenance sidecar<input bind:this={provenanceInput} type="file" accept=".json,application/json" onchange={stageProvenance} disabled={busy} /></label>
		<button type="button" onclick={openModel} disabled={busy || !sourceFile || !provenanceFile}>{busy ? 'Opening…' : 'Open verified model'}</button>
		{#if busy}<button type="button" class="secondary" onclick={cancelLoad}>Cancel</button><output class="load-progress">{loadStatus}</output>{/if}
		{#if result}
			<span class="divider"></span>
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
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if result}
		<section class="source-bar" aria-label="Imported source status">
			<strong>{provenance?.model.id ?? result.modelName ?? sourceFile?.name}</strong>
			<span>{result.encodingContract?.profile?.toUpperCase()} · BOMC {result.diagnostics.version}</span>
			<span>{result.counts.faces.toLocaleString()} faces · {result.counts.instances.toLocaleString()} instances · {result.counts.meshes.toLocaleString()} meshes</span>
			<span class:ready>{ready ? 'Textures settled and first frame observed' : 'Preparing viewport'}</span>
		</section>
		<div class="workspace">
			<div class="viewport" bind:this={viewportHost} aria-label="3D viewport"></div>
			<aside aria-label="Source and selection information">
				<h1>Editor foundation</h1>
				<p>This imported source is read-only. Editor-owned edits use a separate store and keep this source reference unchanged.</p>
				<dl><dt>Artifact SHA-256</dt><dd>{session?.source.artifactSha256 ?? artifactSha256}</dd><dt>Source</dt><dd>{session?.source.file.name ?? sourceFile?.name}</dd><dt>Source bytes</dt><dd>{session?.source.file.size.toLocaleString() ?? sourceFile?.size.toLocaleString()}</dd><dt>Profile</dt><dd>{session?.source.profile ?? result.encodingContract?.profile ?? 'Unavailable'}</dd><dt>Provenance</dt><dd>{session?.source.provenance.capture.method ?? provenance?.capture.method ?? 'Unavailable'}</dd></dl>
				{#if picked}<section class="pick"><h2>Picked geometry</h2><dl><dt>Source mesh</dt><dd>{picked.sourceMeshIndex}</dd><dt>Definition</dt><dd>{picked.definitionIndex}</dd><dt>Occurrence</dt><dd>{picked.occurrenceHandle ?? picked.occurrenceIndex ?? 'Unavailable'}</dd><dt>Source face</dt><dd>{picked.sourceFaceIndex ?? 'Unavailable'}</dd></dl></section>{/if}
			</aside>
		</div>
	{:else}
		<section class="empty">
			<p class="eyebrow">E4 FOUNDATION</p>
			<h1>Open a verified model</h1>
			<p>Choose a BOMC 1.2 artifact and its hash-bound provenance sidecar. Older BOMC versions, unsigned engine claims, and unverified files are rejected.</p>
			<p>Editor does not load Benchmark or Rooms sessions. Camera and display controls act on a separate read-only source view.</p>
		</section>
	{/if}
</main>

<style>
	:global(body) { margin: 0; color: #202933; background: #f4f6f8; font: 14px system-ui, sans-serif; }
	main[data-app="editor"] { min-height: 100dvh; display: flex; flex-direction: column; }
	.topbar { height: 52px; display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0 1rem; background: #fff; border-bottom: 1px solid #dfe4e8; }
	.brand { font-weight: 750; }.brand small { margin-left: .45rem; color: #8a2841; font-size: .68rem; letter-spacing: .08em; }
	a { color: #555f69; } output { max-width: 28vw; overflow-wrap: anywhere; color: #73808b; font: 10px ui-monospace, monospace; }
	.toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .7rem 1rem; background: #fff; border-bottom: 1px solid #dfe4e8; }
	.file-control { display: inline-flex; align-items: center; gap: .45rem; color: #505a64; font-size: 12px; } input { max-width: 235px; font: 12px system-ui, sans-serif; }
	button, select { min-height: 30px; border: 1px solid #c8ced5; border-radius: 5px; padding: .3rem .55rem; color: #25313b; background: #fff; font: inherit; } button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; }.secondary { color: #59636d; }.divider { height: 22px; border-left: 1px solid #dfe4e8; margin: 0 .2rem; }
	.source-bar { display: flex; flex-wrap: wrap; gap: .35rem 1.2rem; padding: .55rem 1rem; color: #54616d; background: #edf1f4; font-size: 12px; }.source-bar strong { color: #242f39; }.ready { color: #28784f; }
	.workspace { flex: 1; min-height: 420px; display: grid; grid-template-columns: minmax(0,1fr) 290px; }.viewport { min-height: 420px; background: #f3f5f7; }.workspace aside { overflow: auto; padding: 1rem; border-left: 1px solid #dfe4e8; background: #fff; }.workspace h1,.empty h1 { margin: 0 0 .6rem; font-size: 1.25rem; }.workspace aside p,.empty p { color: #596570; line-height: 1.55; }.workspace dl { display: grid; grid-template-columns: 95px minmax(0,1fr); gap: .4rem .65rem; font-size: 11px; }.workspace dt { color: #77838e; }.workspace dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: #34404b; }.pick { margin-top: 1.3rem; padding-top: .75rem; border-top: 1px solid #e4e8eb; }.pick h2 { font-size: 13px; }
	.empty { width: min(650px, calc(100% - 3rem)); margin: 11vh auto; padding: 2rem; background: #fff; border: 1px solid #dfe4e8; border-radius: 12px; }.empty .eyebrow { color: #8a2841; font-size: .75rem; font-weight: 750; letter-spacing: .09em; }.error { margin: .6rem 1rem; padding: .7rem; color: #8b2439; background: #fff0f2; border: 1px solid #edc1ca; border-radius: 6px; }
	@media (max-width: 760px) { .workspace { grid-template-columns: 1fr; }.workspace aside { border-left: 0; border-top: 1px solid #dfe4e8; }.source-bar { align-items: flex-start; flex-direction: column; } }
</style>
