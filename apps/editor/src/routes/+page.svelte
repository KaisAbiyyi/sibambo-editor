<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import '$lib/ui/sibambo.css';
	import '$lib/ui/editor-workspace.css';
	import type { AdaptedBomcResult } from '@sibambo/e4-import';
	import { EditorSession } from '$lib/editor/EditorSession';
	import { EditorController } from '$lib/editor/EditorController';
	import type { EditorTool } from '$lib/editor/EditorState';
	import { pinchZoomDelta, pointerCameraTool, selectionDragMode, selectionModifierMode, type EditorSelectionModifier } from '$lib/editor/camera-navigation';
	import { loadE4InWorker } from '$lib/e4-worker-client';
	import { type CameraDragSnapshot, type FaceStyle, type PreparedSceneViewport, type ViewEffects, type ViewportPick } from '@sibambo/viewport';
	import { admitE4File } from '$lib/e4-admission';
	import { readBoundedJsonText } from '@sibambo/provenance';
	import type { ResearchProvenance } from '@sibambo/contracts';
	import { loadedModelTabTitle as resolveLoadedModelTabTitle } from '$lib/model-tab-title';
	import { AuthoringClient } from '$lib/authoring/bomc-authoring-client';
	import { graphsEqual } from '$lib/authoring/history';
	import { projectAuthoringScene } from '$lib/authoring/scene';
	import { AuthoringToolController } from '$lib/authoring/tools';
	import type { AuthoringCheckpoint, AuthoringCommand, AuthoringResult, OpenResult } from '$lib/authoring/protocol';
	import type { PreparedRuntimeGeometryScene } from '@sibambo/scene-runtime/types';
	import type { ViewportBounds } from '@sibambo/viewport';

	const build = __SIBAMBO_APP_BUILD__;

	let sourceFile = $state<File | null>(null);
	let provenanceFile = $state<File | null>(null);
	let provenance = $state<ResearchProvenance | null>(null);
	let artifactSha256 = $state('');
	let modelTabTitle = $state('Sibambo Editor');
	type EditorMode = 'empty' | 'imported' | 'authoring';
	type AuthoringTool = 'select' | 'rectangle' | 'extrude';
	type PendingTransition = { kind: 'new' } | { kind: 'open'; file: File; sidecar: File | null } | { kind: 'close' };
	let mode = $state<EditorMode>('empty');
	let hasModel = $derived(mode !== 'empty');
	let result = $state.raw<AdaptedBomcResult | null>(null);
	let session = $state.raw<EditorSession | null>(null);
	let viewport = $state.raw<PreparedSceneViewport | null>(null);
	let authoringClient = $state.raw<AuthoringClient | null>(null);
	let authoringCheckpoint = $state.raw<AuthoringCheckpoint | null>(null);
	let authoringTools = $state.raw<AuthoringToolController | null>(null);
	let authoringTool = $state<AuthoringTool>('select');
	let extrusionDistanceText = $state('');
	let selectedEntityId = $state('');
	let authoringBounds = $state.raw<ViewportBounds | null>(null);
	let activeSourceName = $state<string | null>(null);
	let pendingTransition = $state<PendingTransition | null>(null);
	let transitionTrigger: HTMLElement | null = null;
	let transitionError = $state('');
	let projectionError = $state('');
	let saveBusy = $state(false);
	let authoringOperationBusy = $state(false);
	let saveProgress = $state('');
	let saveError = $state('');
	let saveController: AbortController | null = null;
	let ownedObjectUrls = new Set<string>();
	let ownedUrlTimers = new Map<number, string>();
	let beforeUnloadHandler: ((event: BeforeUnloadEvent) => void) | null = null;
	let globalKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
	let viewportHost = $state<HTMLDivElement | null>(null);
	let sourceInput: HTMLInputElement;
	let provenanceInput: HTMLInputElement;
	let provenanceUpgradeInput: HTMLInputElement;
	let busy = $state(false);
	let clientReady = $state(false);
	let loadStatus = $state('Choose a BOMC 1.2 model file.');
	let ready = $state(false);
	let error = $state('');
	let activeOperation: 'import' | 'provenance' = 'import';
	let activeTool = $state<EditorTool>('select');
	let editorNotice = $state('');
	let editorController = $state.raw<EditorController | null>(null);
	let pendingCandidateClient: AuthoringClient | null = null;
	let pendingCandidateViewports = new Set<PreparedSceneViewport>();
	let pendingCandidateSession: EditorSession | null = null;
	let picked = $state<ViewportPick | null>(null);
	let selectedOccurrenceHandles = $state<string[]>([]);
	let selectionBox = $state<{ left: number; top: number; width: number; height: number; direction: 'enclose' | 'intersect' } | null>(null);
	let activeCameraTool = $state<'orbit' | 'pan' | 'zoom' | null>(null);
	let moveDistanceText = $state('');
	let moveAxis = $state<'x' | 'y' | 'z' | null>(null);
	let faceStyle = $state<FaceStyle>('shaded-textures');
	let viewEffects = $state<ViewEffects>({ xray: false, ambientOcclusion: false });
	let sceneId = $state('');
	let darkMode = $state(false);
	let generation = 0;
	let evidenceGeneration = 0;
	let controller: AbortController | null = null;
	let lastCancelledSnapshot: LoadedEditorState | null = null;
	let lastCancelGeneration = -1;
	let unsubscribeOccurrenceTransforms: (() => void) | null = null;
	let pointerGesture: any = null;
	const activeTouchPoints = new Map<number, { x: number; y: number }>();
	type LoadedEditorState = {
		mode: EditorMode;
		provenance: ResearchProvenance | null;
		artifactSha256: string;
		modelTabTitle: string;
		result: AdaptedBomcResult | null;
		session: EditorSession | null;
		editorController: EditorController | null;
		viewport: PreparedSceneViewport | null;
		authoringClient: AuthoringClient | null;
		authoringCheckpoint: AuthoringCheckpoint | null;
		authoringTools: AuthoringToolController | null;
		authoringTool: AuthoringTool;
		selectedEntityId: string;
		authoringBounds: ViewportBounds | null;
		activeSourceName: string | null;
		ready: boolean;
		picked: ViewportPick | null;
		selectedOccurrenceHandles: string[];
		activeTool: EditorTool;
		activeCameraTool: 'orbit' | 'pan' | 'zoom' | null;
		selectionBox: { left: number; top: number; width: number; height: number; direction: 'enclose' | 'intersect' } | null;
		moveDistanceText: string;
		moveAxis: 'x' | 'y' | 'z' | null;
		extrusionDistanceText: string;
		editorNotice: string;
		projectionError: string;
		sceneId: string;
		hostChildren: Node[];
	};
	let activeLoadSnapshot: LoadedEditorState | null = null;

	function snapshotLoadedState(): LoadedEditorState {
		return {
			mode, provenance, artifactSha256, modelTabTitle, result, session, editorController, viewport,
			authoringClient, authoringCheckpoint, authoringTools, authoringTool, selectedEntityId, authoringBounds, activeSourceName,
			ready, picked,
			selectedOccurrenceHandles: [...selectedOccurrenceHandles], activeTool, activeCameraTool, selectionBox: selectionBox ? { ...selectionBox } : null,
			moveDistanceText, moveAxis, extrusionDistanceText, editorNotice, projectionError, sceneId,
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
		if (authoringTools && authoringTools !== snapshot.authoringTools) authoringTools.dispose();
		if (authoringClient && authoringClient !== snapshot.authoringClient) void authoringClient.close();
		mode = snapshot.mode;
		provenance = snapshot.provenance;
		artifactSha256 = snapshot.artifactSha256;
		modelTabTitle = snapshot.modelTabTitle;
		result = snapshot.result;
		session = snapshot.session;
		editorController = snapshot.editorController;
		viewport = snapshot.viewport;
		authoringClient = snapshot.authoringClient;
		authoringCheckpoint = snapshot.authoringCheckpoint;
		authoringTools = snapshot.authoringTools;
		authoringTool = snapshot.authoringTool;
		selectedEntityId = snapshot.selectedEntityId;
		authoringBounds = snapshot.authoringBounds;
		activeSourceName = snapshot.activeSourceName;
		ready = snapshot.ready;
		picked = snapshot.picked;
		selectedOccurrenceHandles = [...snapshot.selectedOccurrenceHandles];
		activeTool = snapshot.activeTool;
		activeCameraTool = snapshot.activeCameraTool;
		selectionBox = snapshot.selectionBox ? { ...snapshot.selectionBox } : null;
		moveDistanceText = snapshot.moveDistanceText;
		moveAxis = snapshot.moveAxis;
		extrusionDistanceText = snapshot.extrusionDistanceText;
		editorNotice = snapshot.editorNotice;
		projectionError = snapshot.projectionError;
		sceneId = snapshot.sceneId;
		snapshot.viewport?.setSelectedOccurrences(snapshot.selectedOccurrenceHandles);
		restoreHostChildren(snapshot.hostChildren);
	}

	function stageSource(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0] ?? null;
		input.value = '';
		if (!file) return;
		sourceFile = file;
		const sidecar = provenanceFile;
		provenanceFile = null;
		if (provenanceInput) provenanceInput.value = '';
		error = '';
		void requestTransition({ kind: 'open', file, sidecar }, transitionTrigger);
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

	const EMPTY_AUTHORING_SCENE: PreparedRuntimeGeometryScene = {
		meshes: [], groups: [], edgeSets: [], solidEdgeSets: [], totalUnits: 0, totalTriangles: 0, totalVertices: 0
	};
	const EMPTY_AUTHORING_BOUNDS: ViewportBounds = { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 3, z: 5 } };

	function setAuthoringProjection(target: PreparedSceneViewport, checkpoint: AuthoringCheckpoint, focus: boolean) {
		const projected = projectAuthoringScene(checkpoint.snapshot, { faceStyle, effects: viewEffects });
		const bounds = checkpoint.snapshot.graph.meshes.length ? projected.bounds : EMPTY_AUTHORING_BOUNDS;
		target.setAuthoringBounds(bounds);
		target.setDomainOverlay('editor-authoring-content', projected.group);
		if (focus) target.focusBounds(bounds);
		return bounds;
	}

	function makeAuthoringTools(client: AuthoringClient, target: PreparedSceneViewport, initial: AuthoringCheckpoint, request: number) {
		let tools!: AuthoringToolController;
		tools = new AuthoringToolController({
			viewport: target,
			getCheckpoint: () => authoringCheckpoint,
				submitCommand: async (command: AuthoringCommand) => {
					if (request !== generation || mode !== 'authoring' || authoringClient !== client || saveBusy || busy || authoringOperationBusy) throw new Error('Authoring input is unavailable while the document is changing.');
					authoringOperationBusy = true;
					try {
						const acknowledged = await client.command(command);
						if (request !== generation || mode !== 'authoring' || authoringClient !== client) return acknowledged;
						authoringCheckpoint = acknowledged.checkpoint;
						tools.setCheckpoint(acknowledged.checkpoint);
						if (acknowledged.commandResult?.entityId) selectedEntityId = acknowledged.commandResult.entityId;
						modelTabTitle = authoringTitle(acknowledged.checkpoint);
						try {
							authoringBounds = setAuthoringProjection(target, acknowledged.checkpoint, false);
							projectionError = '';
						} catch (cause) {
							projectionError = cause instanceof Error ? cause.message : 'Canonical content could not be projected.';
							editorNotice = 'The canonical edit was acknowledged, but its viewport projection failed. Retry render before continuing the visual proof.';
						}
						return acknowledged;
					} finally { if (request === generation) authoringOperationBusy = false; }
				},
			onSelectionChange: (entityId: string | null) => { if (request === generation && authoringClient === client) selectedEntityId = entityId ?? ''; },
			onError: (message: string) => { if (request === generation && authoringClient === client) editorNotice = message; }
		});
		tools.setCheckpoint(initial);
		return tools;
	}

	function authoringTitle(checkpoint: AuthoringCheckpoint) {
		return `${checkpoint.snapshot.graph.name || 'Untitled'}${isAuthoringDirty(checkpoint) ? ' *' : ''}`;
	}

	function isAuthoringDirty(checkpoint = authoringCheckpoint) {
		return Boolean(checkpoint && (checkpoint.history.savedGraph === null || !graphsEqual(checkpoint.history.savedGraph, checkpoint.snapshot.graph)));
	}

	function canAuthor() {
		return clientReady && mode === 'authoring' && !!authoringClient && !!authoringCheckpoint && !busy && !saveBusy && !authoringOperationBusy && !authoringClient.isRestoring;
	}

	function refreshAuthoringProjection(focus = false) {
		if (mode !== 'authoring' || !viewport || !authoringCheckpoint) return false;
		try {
			authoringBounds = setAuthoringProjection(viewport, authoringCheckpoint, focus);
			projectionError = '';
			return true;
		} catch (cause) {
			projectionError = cause instanceof Error ? cause.message : 'Canonical content could not be projected.';
			editorNotice = 'The canonical document is intact, but its viewport projection failed. Retry Render before continuing the visual proof.';
			return false;
		}
	}

	function acceptAuthoringResult(client: AuthoringClient, acknowledged: AuthoringResult, request = generation) {
		if (request !== generation || client !== authoringClient || mode !== 'authoring') return false;
		authoringCheckpoint = acknowledged.checkpoint;
		authoringTools?.setCheckpoint(acknowledged.checkpoint);
		if (acknowledged.commandResult?.entityId) selectedEntityId = acknowledged.commandResult.entityId;
		else if (selectedEntityId && !acknowledged.checkpoint.snapshot.graph.meshes.some((mesh) => mesh.id === selectedEntityId)) selectedEntityId = '';
		modelTabTitle = authoringTitle(acknowledged.checkpoint);
		refreshAuthoringProjection(false);
		return true;
	}

	async function runAuthoringHistory(direction: 'undo' | 'redo') {
		if (!canAuthor()) return false;
		const client = authoringClient!;
		const request = generation;
		const available = direction === 'undo' ? authoringCheckpoint!.history.undo.length > 0 : authoringCheckpoint!.history.redo.length > 0;
		if (!available) return false;
		authoringOperationBusy = true;
		try {
			const acknowledged = direction === 'undo' ? await client.undo() : await client.redo();
			acceptAuthoringResult(client, acknowledged, request);
			return true;
		} catch (cause) {
			if (request === generation && client === authoringClient) editorNotice = cause instanceof Error ? cause.message : `Authoring ${direction} failed.`;
			return false;
		} finally { if (request === generation) authoringOperationBusy = false; }
	}

	function setAuthoringTool(tool: AuthoringTool) {
		if (!canAuthor()) return;
		authoringTools?.setTool(tool);
		authoringTool = tool;
		if (tool !== 'extrude') { extrusionDistanceText = ''; authoringTools?.setExtrusionDistance(''); }
		activeTool = 'select';
		activeCameraTool = null;
	}

	function openFilePicker(trigger: HTMLElement | null) {
		if (!clientReady || busy || saveBusy || authoringOperationBusy || pendingTransition) return;
		transitionTrigger = trigger;
		sourceInput?.click();
	}

	function requestTransition(action: PendingTransition, trigger: HTMLElement | null = transitionTrigger) {
		if (!clientReady || busy || saveBusy || authoringOperationBusy || pendingTransition) return;
		transitionTrigger = trigger;
		transitionError = '';
		if (mode === 'authoring' && isAuthoringDirty()) {
			pendingTransition = Object.freeze({ ...action }) as PendingTransition;
			void tick().then(() => document.querySelector<HTMLButtonElement>('[data-transition-dialog] button[data-cancel]')?.focus());
			return;
		}
		void executeTransition(action);
	}

	async function executeTransition(action: PendingTransition) {
		if (!clientReady || busy || saveBusy || authoringOperationBusy) return;
		if (action.kind === 'new') await createNewAuthoringDocument();
		else if (action.kind === 'open') await openModel(action.file, action.sidecar);
		else unload();
	}

	function cancelTransition() {
		if (pendingTransition?.kind === 'open') {
			sourceFile = null;
			provenanceFile = null;
			if (sourceInput) sourceInput.value = '';
			if (provenanceInput) provenanceInput.value = '';
		}
		pendingTransition = null;
		transitionError = '';
		const trigger = transitionTrigger;
		transitionTrigger = null;
		if (trigger?.isConnected) trigger.focus({ preventScroll: true });
	}

	function trapTransitionFocus(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const dialog = event.currentTarget as HTMLElement;
		const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
			.filter((control) => control.getAttribute('aria-hidden') !== 'true');
		if (!controls.length) { event.preventDefault(); return; }
		const first = controls[0]!;
		const last = controls.at(-1)!;
		if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
			event.preventDefault(); last.focus();
		} else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
			event.preventDefault(); first.focus();
		}
	}

	function discardTransition() {
		const action = pendingTransition;
		if (!action || !clientReady || busy || saveBusy) return;
		pendingTransition = null;
		transitionError = '';
		transitionTrigger = null;
		void executeTransition(action);
	}

	function safeDownloadName(name: string) {
		const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
		return `${cleaned || 'Untitled'}.bomc`;
	}

	async function saveBomc() {
		if (!canAuthor()) return false;
		const client = authoringClient!;
		const checkpoint = authoringCheckpoint!;
		const request = generation;
		const transition = pendingTransition;
		let actionAfterSave: PendingTransition | null = null;
		let unacknowledgedWrite: Awaited<ReturnType<AuthoringClient['write']>> | null = null;
		const abort = new AbortController();
		saveController = abort;
		saveBusy = true;
		saveProgress = 'Starting BOMC serialization…';
		saveError = '';
		try {
			const write = await client.write({ signal: abort.signal, onProgress: (progress) => {
				if (saveController === abort && request === generation) saveProgress = `Saving BOMC · ${progress.phase} · ${progress.completedSections}/${progress.totalSections}`;
			} });
			unacknowledgedWrite = write;
			if (request !== generation || client !== authoringClient || abort.signal.aborted) throw new DOMException('BOMC save cancelled.', 'AbortError');
			if (write.revision !== checkpoint.snapshot.revision || write.ownedBuffer.byteLength !== write.length) throw new Error('The BOMC writer returned bytes for a different revision or an invalid transfer length.');
			const blob = new Blob([write.ownedBuffer], { type: 'application/octet-stream' });
			const url = URL.createObjectURL(blob);
			ownedObjectUrls.add(url);
			let dispatched = false;
			try {
				const anchor = document.createElement('a');
				anchor.href = url;
				anchor.download = safeDownloadName(checkpoint.snapshot.graph.name);
				document.body.append(anchor);
				try { anchor.click(); dispatched = true; } finally { anchor.remove(); }
			} catch (cause) {
				if (!dispatched) { URL.revokeObjectURL(url); ownedObjectUrls.delete(url); }
				throw cause;
			}
			if (!dispatched) throw new Error('The browser did not dispatch the BOMC download.');
			const timer = window.setTimeout(() => { URL.revokeObjectURL(url); ownedObjectUrls.delete(url); ownedUrlTimers.delete(timer); }, 0);
			ownedUrlTimers.set(timer, url);
			const acknowledged = await client.acknowledgeDownload(write.writeId, write.revision, { signal: abort.signal });
			unacknowledgedWrite = null;
			if (request !== generation || client !== authoringClient) throw new DOMException('The saved document changed before the download acknowledgment.', 'AbortError');
			acceptAuthoringResult(client, acknowledged, request);
			editorNotice = 'Download started. The canonical document is marked saved after the download dispatch acknowledgment.';
			if (transition && pendingTransition === transition) {
				pendingTransition = null;
				transitionError = '';
				transitionTrigger = null;
				actionAfterSave = transition;
			}
			return true;
		} catch (cause) {
			if (request === generation && client === authoringClient) {
				let message = cause instanceof Error ? cause.message : 'BOMC serialization or download dispatch failed.';
				if (unacknowledgedWrite) {
					try {
						const restored = await client.cancelUnacknowledgedWrite(unacknowledgedWrite.writeId);
						unacknowledgedWrite = null;
						if (request === generation && client === authoringClient) acceptAuthoringResult(client, restored, request);
					} catch (restoreCause) {
						const recoveryMessage = restoreCause instanceof Error ? restoreCause.message : 'The last acknowledged authoring checkpoint could not be restored.';
						message = `${message} Authoring recovery failed: ${recoveryMessage}`;
					}
				}
				saveError = message;
				if (pendingTransition === transition && transition) transitionError = `Save failed; the pending ${transition.kind} action is still waiting. ${message}`;
				else editorNotice = message;
			}
			return false;
		} finally {
			if (saveController === abort) saveController = null;
			if (request === generation) {
				saveBusy = false; saveProgress = '';
				if (actionAfterSave) queueMicrotask(() => { if (request === generation) void executeTransition(actionAfterSave!); });
			}
		}
	}

	function cancelSave() {
		saveController?.abort();
	}

	async function waitForViewportLayout(request: number) {
		await tick();
		for (let frame = 0; frame < 120; frame++) {
			if (request !== generation || !viewportHost?.isConnected) throw new DOMException('Editor transition cancelled.', 'AbortError');
			const rect = viewportHost.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) return;
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		}
		throw new Error('The connected Editor viewport did not acquire a positive layout size.');
	}

	function disposePreviousOwners(previous: LoadedEditorState, nextViewport: PreparedSceneViewport) {
		unsubscribeOccurrenceTransforms?.();
		unsubscribeOccurrenceTransforms = null;
		previous.authoringTools?.dispose();
		if (previous.viewport && previous.viewport !== nextViewport) previous.viewport.dispose();
		if (previous.session) previous.session.dispose();
		if (previous.authoringClient && previous.authoringClient !== authoringClient) void previous.authoringClient.close();
	}

	async function createNewAuthoringDocument() {
		if (!clientReady || busy || saveBusy) return;
		const previous = snapshotLoadedState();
		const request = ++generation;
		evidenceGeneration += 1;
		activeLoadSnapshot = previous;
		lastCancelledSnapshot = null;
		lastCancelGeneration = -1;
		controller?.abort();
		controller = null;
		busy = true;
		activeOperation = 'import';
		loadStatus = 'Creating a canonical BOMC document…';
		error = '';
		let candidateViewport: PreparedSceneViewport | null = null;
		let candidateClient: AuthoringClient | null = null;
		try {
			const client = new AuthoringClient({ sessionId: crypto.randomUUID(), documentIdFactory: crypto.randomUUID });
			candidateClient = client;
			pendingCandidateClient = client;
			const created = await client.create(crypto.randomUUID());
			if (request !== generation) return;
			await waitForViewportLayout(request);
			const { PreparedSceneViewport } = await import('@sibambo/viewport');
			candidateViewport = await PreparedSceneViewport.mount(viewportHost!, { scene: EMPTY_AUTHORING_SCENE, scenes: [], activeSceneId: null, editorMode: true });
			pendingCandidateViewports.add(candidateViewport);
			if (request !== generation) { candidateViewport.dispose(); pendingCandidateViewports.delete(candidateViewport); void client.close(); return; }
			candidateViewport.setDisplayState({ faceStyle, effects: viewEffects });
			const candidateBounds = setAuthoringProjection(candidateViewport, created.checkpoint, true);
			await waitForPreparedViewportReady(candidateViewport, request);
			if (request !== generation) return;
			mode = 'authoring'; result = null; session = null; editorController = null;
			provenance = null; artifactSha256 = ''; activeSourceName = null; sceneId = '';
			viewport = candidateViewport; authoringClient = client; authoringCheckpoint = created.checkpoint;
			authoringBounds = candidateBounds; authoringTool = 'select'; extrusionDistanceText = ''; selectedEntityId = '';
			picked = null; selectedOccurrenceHandles = []; activeTool = 'select'; activeCameraTool = null;
			selectionBox = null; pointerGesture = null; activeTouchPoints.clear(); moveDistanceText = ''; moveAxis = null;
			ready = true; editorNotice = 'Writable BOMC · New canonical document. Coordinates remain in metres.';
			modelTabTitle = authoringTitle(created.checkpoint);
			authoringTools = makeAuthoringTools(client, candidateViewport, created.checkpoint, request);
			candidateViewport.setOnReady(() => { if (viewport === candidateViewport && request === generation) ready = true; });
			disposePreviousOwners(previous, candidateViewport);
			pendingCandidateViewports.delete(candidateViewport); if (pendingCandidateClient === client) pendingCandidateClient = null;
			activeLoadSnapshot = null;
		} catch (cause) {
			if (candidateViewport && candidateViewport !== previous.viewport) { candidateViewport.dispose(); pendingCandidateViewports.delete(candidateViewport); }
				if (candidateClient && candidateClient !== previous.authoringClient) void candidateClient.close();
				if (pendingCandidateClient === candidateClient) pendingCandidateClient = null;
			if (request === generation) {
				for (const candidate of pendingCandidateViewports) { if (candidate !== previous.viewport) candidate.dispose(); }
				pendingCandidateViewports.clear();
				if (pendingCandidateClient && pendingCandidateClient !== previous.authoringClient) void pendingCandidateClient.close();
				pendingCandidateClient = null;
				restoreLoadedState(previous);
				activeLoadSnapshot = null;
				if (!(cause instanceof DOMException && cause.name === 'AbortError')) error = cause instanceof Error ? cause.message : 'A new BOMC document could not be created.';
			}
		} finally { if (request === generation) busy = false; }
	}

	async function waitForPreparedViewportReady(target: PreparedSceneViewport, request: number) {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let frames = 0;
			let timer = 0;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				cancelAnimationFrame(raf);
				window.clearTimeout(timer);
				target.setOnReady(undefined);
				if (error) reject(error); else resolve();
			};
			let raf = requestAnimationFrame(checkGeneration);
			function checkGeneration() {
				if (settled) return;
				if (request !== generation) { finish(new DOMException('Editor transition cancelled.', 'AbortError')); return; }
				if (++frames > 300) { finish(new Error('The Editor viewport did not produce a ready frame within five seconds.')); return; }
				raf = requestAnimationFrame(checkGeneration);
			}
			timer = window.setTimeout(() => finish(new Error('The Editor viewport readiness wait expired.')), 30_000);
			target.setOnReady(() => finish());
		});
	}

	async function openModel(file: File = sourceFile!, sidecar: File | null = provenanceFile) {
		if (!clientReady || !file || busy || saveBusy) return;
		const previous = snapshotLoadedState();
		const request = ++generation;
		evidenceGeneration += 1;
		activeLoadSnapshot = previous;
		lastCancelledSnapshot = null; lastCancelGeneration = -1;
		controller?.abort();
		const importController = new AbortController(); controller = importController;
		busy = true; activeOperation = 'import'; loadStatus = sidecar ? 'Checking BOMC and provenance…' : 'Checking BOMC format and artifact hash…';
		error = ''; projectionError = '';
		let importedViewport: PreparedSceneViewport | null = null;
		let writableViewport: PreparedSceneViewport | null = null;
		let candidateSession: EditorSession | null = null;
		let candidateClient: AuthoringClient | null = null;
		try {
			const parsedSidecar = sidecar ? JSON.parse(await readBoundedJsonText(sidecar, 'Provenance sidecar')) as unknown : undefined;
			const admitted = await admitE4File(file, parsedSidecar);
			if (request !== generation || importController.signal.aborted) return;
			loadStatus = 'Starting E4 import worker…';
			const loaded = await loadE4InWorker(admitted.buffer, file.name, importController.signal, (progress) => { if (request === generation) loadStatus = progress.message; });
			if (admitted.provenance && loaded.encodingContract?.profile !== admitted.provenance.artifact.profile) throw new Error('BOMC encoding profile does not match the admitted provenance profile.');
			if (request !== generation || importController.signal.aborted) return;
			const nextSceneId = loaded.activeSceneId ?? loaded.scenes[0]?.id ?? '';
			await waitForViewportLayout(request);
			const { PreparedSceneViewport } = await import('@sibambo/viewport');
			importedViewport = await PreparedSceneViewport.mount(viewportHost!, {
				scene: loaded.preparedRuntimeScene, appearance: loaded.appearance, scenes: loaded.scenes, activeSceneId: nextSceneId,
				clipPlanes: loaded.clipPlanes, encodingProfile: loaded.encodingContract?.profile, editorMode: false
			});
			pendingCandidateViewports.add(importedViewport);
			if (request !== generation || importController.signal.aborted) { importedViewport.dispose(); pendingCandidateViewports.delete(importedViewport); return; }
			importedViewport.setScene(loaded.scenes.find((scene) => scene.id === nextSceneId) ?? null);
			importedViewport.setDisplayState({ faceStyle, effects: viewEffects });
			importedViewport.setOrbitControlsEnabled(false);
			await waitForPreparedViewportReady(importedViewport, request);
			if (request !== generation || importController.signal.aborted) return;

			loadStatus = 'Inspecting the real file for the exact writable BOMC subset…';
			candidateClient = new AuthoringClient({ sessionId: crypto.randomUUID() });
			pendingCandidateClient = candidateClient;
			const inspection: OpenResult = await candidateClient.open(await file.arrayBuffer());
			if (request !== generation || importController.signal.aborted) return;
			if (inspection.kind === 'authoring') {
				const checkpoint = inspection.checkpoint;
				await waitForViewportLayout(request);
				writableViewport = await PreparedSceneViewport.mount(viewportHost!, { scene: EMPTY_AUTHORING_SCENE, scenes: [], activeSceneId: null, editorMode: true });
				pendingCandidateViewports.add(writableViewport);
				if (request !== generation || importController.signal.aborted) { writableViewport.dispose(); pendingCandidateViewports.delete(writableViewport); return; }
				writableViewport.setDisplayState({ faceStyle, effects: viewEffects });
				const bounds = setAuthoringProjection(writableViewport, checkpoint, true);
				await waitForPreparedViewportReady(writableViewport, request);
				if (request !== generation || importController.signal.aborted) return;
				mode = 'authoring'; result = null; session = null; editorController = null;
				provenance = admitted.provenance; artifactSha256 = admitted.artifactSha256; activeSourceName = file.name;
				sceneId = ''; viewport = writableViewport; authoringClient = candidateClient; authoringCheckpoint = checkpoint;
				authoringBounds = bounds; authoringTool = 'select'; extrusionDistanceText = ''; selectedEntityId = ''; picked = null; selectedOccurrenceHandles = [];
				activeTool = 'select'; activeCameraTool = null; selectionBox = null; pointerGesture = null; activeTouchPoints.clear();
				ready = true; authoringTools = makeAuthoringTools(candidateClient, writableViewport, checkpoint, request);
				modelTabTitle = authoringTitle(checkpoint); editorNotice = 'Writable BOMC · This file is inside the supported Editor rectangle/extrusion subset.';
				writableViewport.setOnReady(() => { if (viewport === writableViewport && request === generation) ready = true; });
				pendingCandidateViewports.delete(writableViewport); pendingCandidateViewports.delete(importedViewport);
				importedViewport.dispose(); importedViewport = null;
				pendingCandidateClient = null; candidateClient = null;
				disposePreviousOwners(previous, writableViewport);
				activeLoadSnapshot = null;
			} else {
				await candidateClient.close(); candidateClient = null; pendingCandidateClient = null;
				candidateSession = new EditorSession(file, admitted.provenance, admitted.artifactSha256, loaded.encodingContract?.profile ?? null);
				pendingCandidateSession = candidateSession;
				mode = 'imported'; result = loaded; session = candidateSession; editorController = new EditorController(candidateSession.editableGeometry);
				provenance = admitted.provenance; artifactSha256 = admitted.artifactSha256; activeSourceName = file.name; modelTabTitle = resolveLoadedModelTabTitle({ modelName: loaded.modelName, sourceFileName: loaded.sourceFileName, selectedFileName: file.name }, 'Sibambo Editor');
				sceneId = nextSceneId; viewport = importedViewport; authoringClient = null; authoringCheckpoint = null; authoringTools = null; authoringBounds = null;
				ready = false; picked = null; selectedOccurrenceHandles = []; activeTool = 'select'; authoringTool = 'select'; extrusionDistanceText = ''; activeCameraTool = null;
				moveDistanceText = ''; moveAxis = null; editorNotice = inspection.reason; selectionBox = null; importedViewport.setSelectedOccurrences([]);
				unsubscribeOccurrenceTransforms?.();
				unsubscribeOccurrenceTransforms = candidateSession.editableGeometry.subscribeOccurrenceTransforms((transforms) => {
					if (viewport !== importedViewport || request !== generation) return;
					importedViewport!.setOccurrenceTransforms(new Map(transforms.map((item) => [item.occurrenceHandle, item.translation])));
				});
				const committedViewport = importedViewport;
				committedViewport.setOnPick(handleViewportPick);
				committedViewport.setOnReady(() => { if (viewport === committedViewport && request === generation) ready = true; });
				pendingCandidateViewports.delete(importedViewport); pendingCandidateSession = null;
				disposePreviousOwners(previous, committedViewport);
				activeLoadSnapshot = null;
			}
			if (sourceInput) sourceInput.value = '';
			if (provenanceInput) provenanceInput.value = '';
			sourceFile = null; provenanceFile = null;
		} catch (cause) {
			for (const candidate of [writableViewport, importedViewport]) if (candidate && candidate !== previous.viewport) { candidate.dispose(); pendingCandidateViewports.delete(candidate); }
			if (candidateSession && candidateSession !== previous.session) candidateSession.dispose();
			if (candidateClient && candidateClient !== previous.authoringClient) void candidateClient.close();
			if (request === generation) {
				for (const candidate of pendingCandidateViewports) { if (candidate !== previous.viewport) candidate.dispose(); }
				pendingCandidateViewports.clear();
				if (candidateSession && candidateSession !== previous.session) candidateSession.dispose();
				pendingCandidateSession = null;
				if (candidateClient && candidateClient !== previous.authoringClient) void candidateClient.close();
				pendingCandidateClient = null;
				restoreLoadedState(previous);
				activeLoadSnapshot = null;
				if (!(cause instanceof DOMException && cause.name === 'AbortError')) error = cause instanceof Error ? cause.message : 'The E4 model could not be opened.';
			}
		} finally { if (request === generation) { busy = false; if (controller === importController) controller = null; } }
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

	function setTool(tool: EditorTool) {
		if (mode === 'authoring') {
		if (tool === 'select') setAuthoringTool('select');
			return;
		}
		cancelEditorCameraGesture();
		if (tool === 'select' || tool === 'move') activeCameraTool = null;
		if (tool === 'move') {
			const handle = selectedOccurrenceHandles.length === 1 ? selectedOccurrenceHandles[0] : null;
			if (!handle || !viewport?.hasOccurrence(handle) || !editorController || !artifactSha256) {
				editorNotice = 'Select one imported occurrence with a stable identity before using Move.';
				activeTool = 'select';
				return;
			}
			const anchor = viewport.occurrenceAnchor(handle);
			if (!anchor) {
				editorNotice = 'The selected occurrence has no usable bounds for an editor-owned Move.';
				activeTool = 'select';
				return;
			}
			editorController.setTool('move');
			if (!editorController.beginOccurrenceMove({ artifactSha256, occurrenceHandle: handle, anchor })) {
				activeTool = 'select';
				editorNotice = 'The selected occurrence could not be anchored to this artifact.';
				return;
			}
			activeTool = 'move';
			moveDistanceText = '';
			moveAxis = null;
			editorNotice = 'Move preview · drag the selected occurrence, constrain with X/Y/Z, click to commit, or Escape to cancel.';
			refreshOccurrencePreview();
			return;
		}
		activeTool = tool;
		if (editorController) editorController.setTool(tool);
		viewport?.setOccurrencePreview(null);
		editorNotice = '';
	}
	function undoAction() {
		if (mode === 'authoring') { void runAuthoringHistory('undo'); return; }
		if (editorController) { editorController.undo(); editorController.setTool('select'); }
		activeTool = 'select';
		viewport?.setOccurrencePreview(null);
	}
	function redoAction() {
		if (mode === 'authoring') { void runAuthoringHistory('redo'); return; }
		editorController?.redo();
		editorController?.setTool('select');
		activeTool = 'select';
		activeCameraTool = null;
		viewport?.setOccurrencePreview(null);
	}
	function refreshOccurrencePreview() {
		const preview = editorController?.occurrenceMovePreview;
		viewport?.setOccurrencePreview(preview?.occurrenceHandle ?? null, preview?.translation ?? null);
	}
	function canMoveSelected() {
		return selectedOccurrenceHandles.length === 1 && Boolean(viewport?.hasOccurrence(selectedOccurrenceHandles[0]));
	}
	function updateSelection(handles: readonly string[], mode: EditorSelectionModifier, pick: ViewportPick | null = null) {
		const next = new Set(mode === 'replace' ? [] : selectedOccurrenceHandles);
		for (const handle of handles) {
			if (!viewport?.hasOccurrence(handle)) continue;
			if (mode === 'subtract') next.delete(handle);
			else if (mode === 'toggle' && next.has(handle)) next.delete(handle);
			else next.add(handle);
		}
		selectedOccurrenceHandles = [...next];
		picked = pick;
		viewport?.setSelectedOccurrences(selectedOccurrenceHandles);
		if (selectedOccurrenceHandles.length === 1) editorNotice = 'One imported occurrence selected. Camera position and anchor are unchanged.';
		else if (selectedOccurrenceHandles.length > 1) editorNotice = `${selectedOccurrenceHandles.length} imported occurrences selected. Move is available for one occurrence at a time.`;
		else editorNotice = '';
	}
	function selectPick(pick: ViewportPick | null, mode: EditorSelectionModifier) {
		if (!pick) {
			if (mode === 'replace') updateSelection([], mode, null);
			return;
		}
		if (!pick.occurrenceHandle || !viewport?.hasOccurrence(pick.occurrenceHandle)) {
			if (mode === 'replace') updateSelection([], mode, pick);
			editorNotice = 'This hit has no stable imported occurrence identity and cannot be selected for Move.';
			return;
		}
		updateSelection([pick.occurrenceHandle], mode, pick);
	}
	function handleViewportPick(pick: ViewportPick) {
		// Pointer-up owns modifier-aware selection; the viewport callback keeps
		// the latest concrete hit available to the route's pick/status UI.
		if (mode === 'imported') picked = pick;
	}
	function activateScene(nextSceneId: string) {
		cancelEditorCameraGesture();
		sceneId = nextSceneId;
		const selected = result?.scenes.find((scene) => scene.id === sceneId);
		viewport?.setScene(selected ?? null);
		viewport?.levelCamera();
		const retained = selectedOccurrenceHandles.filter((handle) => viewport?.hasOccurrence(handle));
		if (retained.length !== selectedOccurrenceHandles.length) {
			selectedOccurrenceHandles = retained;
			picked = null;
			viewport?.setSelectedOccurrences(retained);
			editorNotice = 'Selection cleared because its imported occurrence is absent from this scene.';
		}
	}
	function sceneChanged(event: Event) {
		activateScene((event.currentTarget as HTMLSelectElement).value);
	}
	function mouseButtonsFromMask(mask: number) {
		const buttons = new Set<number>();
		if (mask & 1) buttons.add(0);
		if (mask & 2) buttons.add(2);
		if (mask & 4) buttons.add(1);
		return buttons;
	}
	function currentFrameRect(event: PointerEvent) {
		return (event.currentTarget as HTMLElement).getBoundingClientRect();
	}
	function isEditorCameraGesture(gesture: any) {
		return gesture?.kind === 'camera' || gesture?.kind === 'touch-pending' || gesture?.kind === 'touch-orbit' || gesture?.kind === 'touch-pair';
	}
	function finishEditorCameraGesture(gesture: any = pointerGesture) {
		if (isEditorCameraGesture(gesture)) viewport?.endCameraDrag();
	}
	function cancelEditorCameraGesture() {
		if (!isEditorCameraGesture(pointerGesture)) return;
		finishEditorCameraGesture(pointerGesture);
		pointerGesture = null;
		activeTouchPoints.clear();
	}
	function startCameraGesture(event: PointerEvent, tool: 'orbit' | 'pan' | 'zoom') {
		if (!viewport) return;
		pointerGesture = {
			kind: 'camera', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
			lastY: event.clientY, moved: false, cameraTool: tool,
			cameraSnapshot: tool === 'zoom' ? null : viewport.beginCameraDrag(tool)
		};
	}
	function startTouchPairGesture() {
		if (!viewport || activeTouchPoints.size < 2) return;
		finishEditorCameraGesture(pointerGesture);
		const points = [...activeTouchPoints.values()];
		const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
		const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
		pointerGesture = {
			kind: 'touch-pair', pointerId: -1, startX: center.x, startY: center.y, moved: true,
			lastCenter: center, lastTouchDistance: Math.max(distance, 1)
		};
	}
	function handleViewportPointerDown(event: PointerEvent) {
		if (!viewport || busy || saveBusy || authoringOperationBusy || event.target !== viewportHost?.querySelector('canvas')) return;
		event.preventDefault();
		const frame = event.currentTarget as HTMLElement;
		try { frame.setPointerCapture(event.pointerId); } catch { /* the browser may already have captured this pointer */ }
		viewportHost?.querySelector('canvas')?.focus({ preventScroll: true });
		if (event.pointerType === 'touch') {
			authoringTools?.handlePointerDown(event, true);
			activeTouchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (activeTouchPoints.size >= 2) startTouchPairGesture();
			else pointerGesture = {
				kind: 'touch-pending', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
				moved: false, startPick: viewport.pickAt(event.clientX, event.clientY), cameraSnapshot: viewport.beginCameraDrag('orbit')
			};
			return;
		}
		const middleTool = pointerCameraTool(mouseButtonsFromMask(event.buttons), event.shiftKey);
		if (middleTool) { authoringTools?.handlePointerDown(event, true); startCameraGesture(event, middleTool); return; }
		if (event.button !== 0) { authoringTools?.handlePointerDown(event, true); return; }
		if (activeCameraTool) { authoringTools?.handlePointerDown(event, true); startCameraGesture(event, activeCameraTool); return; }
		if (mode === 'authoring') { authoringTools?.handlePointerDown(event, false); return; }
		if (activeTool === 'move') {
			const pick = viewport.pickAt(event.clientX, event.clientY);
			const movingHandle = editorController?.occurrenceMovePreview?.occurrenceHandle;
			if (pick?.occurrenceHandle && movingHandle && pick.occurrenceHandle !== movingHandle) {
				editorNotice = 'Move affects the selected occurrence; select another object before starting a new Move.';
			}
			pointerGesture = { kind: 'move', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
			return;
		}
		if (activeTool === 'select') pointerGesture = {
			kind: 'select', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false,
			modifier: selectionModifierMode(event.ctrlKey || event.metaKey, event.shiftKey)
		};
	}
	function handleViewportPointerMove(event: PointerEvent) {
		if (!viewport || busy || saveBusy || authoringOperationBusy) return;
		if (!pointerGesture) { if (mode === 'authoring') authoringTools?.handlePointerMove(event, false); return; }
		if (event.pointerType === 'touch') activeTouchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pointerGesture.kind === 'touch-pair' && activeTouchPoints.size >= 2) {
			const points = [...activeTouchPoints.values()];
			const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
			const distance = Math.max(Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y), 1);
			const panSnapshot = viewport.beginCameraDrag('pan');
			try {
				viewport.dragCamera('pan', panSnapshot, center.x - pointerGesture.lastCenter.x, center.y - pointerGesture.lastCenter.y, viewportHost?.clientHeight ?? 1);
			} finally {
				viewport.endCameraDrag();
			}
			viewport.zoomAt(center.x, center.y, pinchZoomDelta(pointerGesture.lastTouchDistance, distance));
			pointerGesture.lastCenter = center;
			pointerGesture.lastTouchDistance = distance;
			return;
		}
		if (pointerGesture.pointerId !== event.pointerId) return;
		const deltaX = event.clientX - pointerGesture.startX;
		const deltaY = event.clientY - pointerGesture.startY;
		if (Math.hypot(deltaX, deltaY) > 4) pointerGesture.moved = true;
		if (pointerGesture.kind === 'touch-pending' && pointerGesture.moved) pointerGesture.kind = 'touch-orbit';
		if (pointerGesture.kind === 'touch-orbit') {
			viewport.dragCamera('orbit', pointerGesture.cameraSnapshot as CameraDragSnapshot, deltaX, deltaY, viewportHost?.clientHeight ?? 1);
		} else if (pointerGesture.kind === 'camera') {
			if (pointerGesture.cameraTool === 'zoom') {
				viewport.zoomAt(event.clientX, event.clientY, (event.clientY - pointerGesture.lastY) * 4);
				pointerGesture.lastY = event.clientY;
			} else viewport.dragCamera(pointerGesture.cameraTool, pointerGesture.cameraSnapshot as CameraDragSnapshot, deltaX, deltaY, viewportHost?.clientHeight ?? 1);
		} else if (pointerGesture.kind === 'select') {
			if (pointerGesture.moved) {
				const rect = currentFrameRect(event);
				selectionBox = {
					left: Math.min(pointerGesture.startX, event.clientX) - rect.left,
					top: Math.min(pointerGesture.startY, event.clientY) - rect.top,
					width: Math.abs(deltaX), height: Math.abs(deltaY),
					direction: selectionDragMode(pointerGesture.startX, event.clientX)
				};
			}
		} else if (pointerGesture.kind === 'move' && activeTool === 'move') {
			const movement = viewport.moveDeltaForScreenDrag(deltaX, deltaY, viewportHost?.clientHeight ?? 1);
			editorController?.updateOccurrenceMove(movement);
			refreshOccurrencePreview();
		}
		if (mode === 'authoring') authoringTools?.handlePointerMove(event, isEditorCameraGesture(pointerGesture));
	}
	function handleViewportPointerUp(event: PointerEvent) {
		if (mode === 'authoring' && !pointerGesture) {
			authoringTools?.handlePointerUp(event, false);
			try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch { /* capture may already be released */ }
			return;
		}
		if (event.pointerType === 'touch') {
			activeTouchPoints.delete(event.pointerId);
			if (activeTouchPoints.size === 1 && pointerGesture?.kind === 'touch-pair') {
				const [remainingId, position] = [...activeTouchPoints.entries()][0];
				finishEditorCameraGesture(pointerGesture);
				pointerGesture = { kind: 'touch-orbit', pointerId: remainingId, startX: position.x, startY: position.y, moved: true, cameraSnapshot: viewport?.beginCameraDrag('orbit') };
				return;
			}
			if (activeTouchPoints.size > 0) return;
		}
		if (!pointerGesture || (pointerGesture.pointerId !== event.pointerId && pointerGesture.pointerId !== -1)) return;
		if (event.pointerType !== 'touch' && event.buttons !== 0) return;
		const gesture = pointerGesture;
		finishEditorCameraGesture(gesture);
		pointerGesture = null;
		selectionBox = null;
		if (gesture.kind === 'select') {
			if (gesture.moved && viewport) {
				const handles = viewport.selectOccurrencesInRect(gesture.startX, gesture.startY, event.clientX, event.clientY);
				updateSelection(handles, gesture.modifier);
			} else selectPick(viewport?.pickAt(event.clientX, event.clientY) ?? null, gesture.modifier);
		} else if (gesture.kind === 'touch-pending') {
			selectPick(viewport?.pickAt(event.clientX, event.clientY) ?? gesture.startPick ?? null, 'replace');
		} else if (gesture.kind === 'move') {
			editorController?.commitOccurrenceMove();
			activeTool = 'select';
			editorController?.setTool('select');
			viewport?.setOccurrencePreview(null);
			editorNotice = 'Move committed to the Editor working transform. The imported BOMC bytes are unchanged.';
		} else if (gesture.kind === 'touch-pair' || gesture.kind === 'touch-orbit' || gesture.kind === 'camera') {
			// Navigation is temporary for the duration of the pointer gesture.
		}
		if (mode === 'authoring') authoringTools?.handlePointerUp(event, isEditorCameraGesture(gesture));
		try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch { /* capture may already be released */ }
	}
	function handleViewportPointerCancel(event: PointerEvent) {
		if (mode === 'authoring') authoringTools?.handlePointerCancel();
		activeTouchPoints.delete(event.pointerId);
		selectionBox = null;
		finishEditorCameraGesture(pointerGesture);
		if (pointerGesture?.kind === 'move') {
			editorController?.cancel();
			editorController?.setTool('select');
			viewport?.setOccurrencePreview(null);
			activeTool = 'select';
			editorNotice = 'Move canceled.';
		}
		pointerGesture = null;
	}
	function handleViewportWheel(event: WheelEvent) {
		if (!viewport) return;
		event.preventDefault();
		viewport.zoomAt(event.clientX, event.clientY, event.deltaY);
	}
	function handleViewportKeyDown(event: KeyboardEvent) {
		if (event.defaultPrevented) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('input, textarea, select, [contenteditable="true"]') || event.repeat || busy || saveBusy || authoringOperationBusy) return;
		const key = event.key.toLowerCase();
		if ((event.ctrlKey || event.metaKey) && key === 'z') {
			const canChangeHistory = mode === 'authoring'
				? event.shiftKey ? !!authoringCheckpoint?.history.redo.length : !!authoringCheckpoint?.history.undo.length
				: event.shiftKey ? !!editorController?.history.canRedo : !!editorController?.history.canUndo;
			if (!canChangeHistory) return;
			event.preventDefault();
			if (event.shiftKey) redoAction(); else undoAction();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			finishEditorCameraGesture(pointerGesture);
			selectionBox = null;
			pointerGesture = null;
			activeTouchPoints.clear();
			activeCameraTool = null;
			if (mode === 'authoring') { authoringTools?.cancelPreview(); setAuthoringTool('select'); }
			if (activeTool === 'move') {
				editorController?.cancel();
				editorController?.setTool('select');
				activeTool = 'select';
				viewport?.setOccurrencePreview(null);
				editorNotice = 'Move canceled; the imported occurrence returned to its prior working transform.';
			}
			return;
		}
		if (key === ' ' || event.code === 'Space') {
			event.preventDefault();
			if (activeTool === 'move') {
				editorController?.cancel();
				editorController?.setTool('select');
				activeTool = 'select';
				viewport?.setOccurrencePreview(null);
				editorNotice = 'Move canceled; Select is active.';
			} else setTool('select');
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (key === 'z' && event.shiftKey) { if (!viewport) return; event.preventDefault(); cancelEditorCameraGesture(); zoomExtents(); activeCameraTool = null; return; }
		if (key === 'm') { event.preventDefault(); setTool('move'); return; }
		if (key === 'o' || key === 'h' || key === 'z') {
			event.preventDefault();
			setCameraTool(key === 'o' ? 'orbit' : key === 'h' ? 'pan' : 'zoom');
			return;
		}
		if (key === 'enter' && activeTool === 'move') {
			event.preventDefault();
			editorController?.commitOccurrenceMove();
			activeTool = 'select';
			editorController?.setTool('select');
			viewport?.setOccurrencePreview(null);
			editorNotice = 'Move committed to the Editor working transform. The imported BOMC bytes are unchanged.';
			return;
		}
		if (activeTool === 'move' && event.key === 'Backspace') {
			event.preventDefault();
			moveDistanceText = moveDistanceText.slice(0, -1);
			const distance = moveDistanceText === '' || moveDistanceText === '-' ? null : Number(moveDistanceText);
			editorController?.setOccurrenceMoveDistance(Number.isFinite(distance) ? distance : null);
			refreshOccurrencePreview();
			return;
		}
		if (activeTool === 'move' && (/^[0-9]$/.test(event.key) || ['.', '-'].includes(event.key))) {
			event.preventDefault();
			if (event.key === '-') moveDistanceText = moveDistanceText.startsWith('-') ? moveDistanceText.slice(1) : `-${moveDistanceText}`;
			else if (event.key !== '.' || !moveDistanceText.includes('.')) moveDistanceText += event.key;
			const distance = moveDistanceText === '-' || moveDistanceText.endsWith('.') ? null : Number(moveDistanceText);
			if (distance === null || Number.isFinite(distance)) { editorController?.setOccurrenceMoveDistance(distance); refreshOccurrencePreview(); }
		}
	}

	function applyDisplayState(nextFaceStyle: FaceStyle = faceStyle, nextEffects: ViewEffects = viewEffects) {
		faceStyle = nextFaceStyle;
		viewEffects = { ...nextEffects };
		viewport?.setDisplayState({ faceStyle, effects: viewEffects });
		if (mode === 'authoring') refreshAuthoringProjection(false);
	}
	function setFaceStyle(style: FaceStyle) { applyDisplayState(style, viewEffects); }
	function toggleXray(event: Event) {
		applyDisplayState(faceStyle, { ...viewEffects, xray: (event.currentTarget as HTMLInputElement).checked });
	}
	function toggleAmbientOcclusion(event: Event) {
		applyDisplayState(faceStyle, { ...viewEffects, ambientOcclusion: (event.currentTarget as HTMLInputElement).checked });
	}
	function setCameraTool(tool: 'orbit' | 'pan' | 'zoom') {
		cancelEditorCameraGesture();
		if (activeTool === 'move') {
			editorController?.cancel();
			editorController?.setTool('select');
			viewport?.setOccurrencePreview(null);
			activeTool = 'select';
		}
		activeCameraTool = tool;
		editorNotice = `${tool === 'orbit' ? 'Orbit' : tool === 'pan' ? 'Pan' : 'Zoom'} · left-drag the viewport. Camera and anchor stay coupled during pan/zoom.`;
	}
	function activateSelectTool() {
		activeCameraTool = null;
		setTool('select');
	}
	function zoomExtents() {
		cancelEditorCameraGesture();
		if (mode === 'authoring' && authoringBounds) {
			viewport?.setAuthoringBounds(authoringBounds);
			viewport?.focusBounds(authoringBounds);
			editorNotice = 'Zoom Extents · camera framed to canonical document bounds.';
		} else {
			viewport?.fit();
			viewport?.levelCamera();
			editorNotice = 'Zoom Extents · camera and anchor reframed to the visible model.';
		}
	}
	function levelCamera() {
		cancelEditorCameraGesture();
		viewport?.levelCamera();
		editorNotice = 'Camera leveled · imported roll removed while preserving the current view direction.';
	}
	function setCameraView(name: 'top' | 'front' | 'iso') {
		cancelEditorCameraGesture();
		if (mode === 'authoring' && authoringBounds) {
			viewport?.setAuthoringBounds(authoringBounds);
			viewport?.viewBounds(name, authoringBounds);
		} else viewport?.view(name);
	}
	function applyTheme() {
		document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
	}
	function toggleTheme() {
		darkMode = !darkMode;
		localStorage.setItem('sibambo-theme', darkMode ? 'dark' : 'light');
		applyTheme();
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
		authoringOperationBusy = false;
		for (const candidate of pendingCandidateViewports) { if (candidate !== activeLoadSnapshot?.viewport) candidate.dispose(); }
		pendingCandidateViewports.clear();
		if (pendingCandidateClient && pendingCandidateClient !== activeLoadSnapshot?.authoringClient) void pendingCandidateClient.close();
		pendingCandidateClient = null;
		if (pendingCandidateSession && pendingCandidateSession !== activeLoadSnapshot?.session) pendingCandidateSession.dispose();
		pendingCandidateSession = null;
		if (activeLoadSnapshot) restoreLoadedState(activeLoadSnapshot);
		activeLoadSnapshot = null;
		busy = false;
		loadStatus = cancelledOperation === 'provenance' ? 'Provenance check cancelled.' : 'Model load cancelled.';
		error = loadStatus;
	}
	function unload() {
		cancelEditorCameraGesture();
		generation += 1;
		evidenceGeneration += 1;
		controller?.abort();
		controller = null;
		activeLoadSnapshot = null;
		unsubscribeOccurrenceTransforms?.();
		unsubscribeOccurrenceTransforms = null;
		authoringTools?.dispose();
		authoringTools = null;
		viewport?.dispose();
		viewport = null;
		session?.dispose();
		session = null;
		if (authoringClient) void authoringClient.close();
		authoringClient = null;
		authoringCheckpoint = null;
		authoringBounds = null;
		activeSourceName = null;
		selectedEntityId = '';
		authoringTool = 'select';
		mode = 'empty';
		authoringOperationBusy = false;
		editorController = null;
		editorNotice = '';
		result = null;
		modelTabTitle = 'Sibambo Editor';
		sceneId = '';
		provenance = null;
		artifactSha256 = '';
		projectionError = '';
		ready = false;
		picked = null;
		selectedOccurrenceHandles = [];
		selectionBox = null;
		pointerGesture = null;
		activeTouchPoints.clear();
		activeTool = 'select';
		activeCameraTool = null;
		busy = false;
		if (sourceInput) sourceInput.value = '';
		if (provenanceInput) provenanceInput.value = '';
		if (provenanceUpgradeInput) provenanceUpgradeInput.value = '';
		sourceFile = null;
		provenanceFile = null;
		loadStatus = 'Choose a BOMC 1.2 model file.';
	}

	function handleGlobalKeyDown(event: KeyboardEvent) {
		if (!clientReady) return;
		const key = event.key.toLowerCase();
		const target = event.target as HTMLElement | null;
		const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]');
		if (pendingTransition && key === 'escape') {
			event.preventDefault();
			cancelTransition();
			return;
		}
		if (typing || event.repeat || !(event.ctrlKey || event.metaKey) || event.altKey) return;
		if (pendingTransition) {
			if (key === 's' && canAuthor()) { event.preventDefault(); void saveBomc(); }
			return;
		}
		if (busy || saveBusy || authoringOperationBusy) return;
		if (key === 'n') { event.preventDefault(); requestTransition({ kind: 'new' }, target); return; }
		if (key === 'o') { if (!sourceInput?.disabled) { event.preventDefault(); openFilePicker(target); } return; }
		if (key === 's') { if (mode === 'authoring' && canAuthor()) { event.preventDefault(); void saveBomc(); } return; }
		if (key === 'z' && event.shiftKey) {
			const canRedo = mode === 'authoring' ? !!authoringCheckpoint?.history.redo.length : !!editorController?.history.canRedo;
			if (canRedo) { event.preventDefault(); redoAction(); }
			return;
		}
		if (key === 'z') {
			const canUndo = mode === 'authoring' ? !!authoringCheckpoint?.history.undo.length : !!editorController?.history.canUndo;
			if (canUndo) { event.preventDefault(); undoAction(); }
		}
	}

	function handleBeforeUnload(event: BeforeUnloadEvent) {
		if (mode !== 'authoring' || !isAuthoringDirty()) return;
		event.preventDefault();
		event.returnValue = '';
	}

	onMount(() => {
		if (!sourceInput) throw new Error('Editor source input binding is unavailable.');
		const saved = localStorage.getItem('sibambo-theme');
		darkMode = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
		applyTheme();

		const closeMenusOutside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			for (const menu of document.querySelectorAll<HTMLDetailsElement>('main[data-app="editor"] .menu-root[open]')) {
				if (!target || !menu.contains(target)) menu.open = false;
			}
		};
		const closeMenusOnEscape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			for (const menu of document.querySelectorAll<HTMLDetailsElement>('main[data-app="editor"] .menu-root[open]')) menu.open = false;
		};
		document.addEventListener('pointerdown', closeMenusOutside, true);
		document.addEventListener('keydown', closeMenusOnEscape);
		globalKeydownHandler = handleGlobalKeyDown;
		beforeUnloadHandler = handleBeforeUnload;
		window.addEventListener('keydown', globalKeydownHandler, true);
		window.addEventListener('beforeunload', beforeUnloadHandler);
		clientReady = true;
		return () => {
			clientReady = false;
			document.removeEventListener('pointerdown', closeMenusOutside, true);
			document.removeEventListener('keydown', closeMenusOnEscape);
			if (globalKeydownHandler) window.removeEventListener('keydown', globalKeydownHandler, true);
			if (beforeUnloadHandler) window.removeEventListener('beforeunload', beforeUnloadHandler);
			globalKeydownHandler = null;
			beforeUnloadHandler = null;
		};
	});
	onDestroy(() => {
		generation += 1; evidenceGeneration += 1; controller?.abort(); saveController?.abort();
		unsubscribeOccurrenceTransforms?.(); authoringTools?.dispose(); viewport?.dispose(); session?.dispose();
		if (authoringClient) void authoringClient.close();
		for (const candidate of pendingCandidateViewports) candidate.dispose();
		pendingCandidateViewports.clear();
		if (pendingCandidateClient) void pendingCandidateClient.close();
		pendingCandidateClient = null;
		pendingCandidateSession?.dispose(); pendingCandidateSession = null;
		for (const [timer, url] of ownedUrlTimers) { window.clearTimeout(timer); URL.revokeObjectURL(url); ownedObjectUrls.delete(url); }
		ownedUrlTimers.clear();
		for (const url of ownedObjectUrls) URL.revokeObjectURL(url);
		ownedObjectUrls.clear();
		if (globalKeydownHandler) window.removeEventListener('keydown', globalKeydownHandler, true);
		if (beforeUnloadHandler) window.removeEventListener('beforeunload', beforeUnloadHandler);
	});
</script>

<svelte:head>
	<title>{modelTabTitle}</title>
	<meta name="description" content="Sibambo Editor model workspace with SketchUp-style camera navigation." />
	<meta name="theme-color" content={darkMode ? '#15181C' : '#F7F8FA'} />
</svelte:head>

<main data-app="editor" data-editor-ready={clientReady ? 'true' : 'false'} class:is-loaded={hasModel}>
	<div class="visually-hidden">
		<label>BOMC 1.2 file<input bind:this={sourceInput} type="file" accept=".bomc,application/octet-stream" onchange={stageSource} disabled={busy || saveBusy || authoringOperationBusy || !clientReady} tabindex="-1" /></label>
		<label>Provenance JSON for next model<input bind:this={provenanceInput} type="file" accept=".json,application/json" onchange={stageProvenance} disabled={busy} tabindex="-1" /></label>
		<label>Provenance JSON for current model<input bind:this={provenanceUpgradeInput} type="file" accept=".json,application/json" onchange={stageUpgradeProvenance} disabled={busy || !session || !!provenance} tabindex="-1" /></label>
	</div>

	<nav class="editor-menubar" aria-label="Editor application menu">
		<a class="editor-wordmark" href="https://sibambo.vercel.app/" aria-label="Sibambo home"><span class="wordmark-cube" aria-hidden="true">◇</span><strong>Sibambo</strong><span>Editor</span></a>
		<details class="menu-root">
			<summary>File</summary>
			<div class="menu-popover">
				<button type="button" onclick={(event) => requestTransition({ kind: 'new' }, event.currentTarget)} disabled={busy || saveBusy || authoringOperationBusy || !clientReady || !!pendingTransition}>New<kbd>Ctrl+N</kbd></button>
				<button type="button" onclick={(event) => openFilePicker(event.currentTarget)} disabled={busy || saveBusy || authoringOperationBusy || !clientReady || !!pendingTransition}>Open Model…<kbd>Ctrl+O</kbd></button>
				{#if mode === 'authoring'}<button type="button" onclick={() => void saveBomc()} disabled={!canAuthor()}>Save BOMC…<kbd>Ctrl+S</kbd></button>{/if}
				{#if mode === 'imported' && result}<button type="button" onclick={downloadCapture} disabled={!ready}>Save View…</button>{/if}
				{#if result && !provenance}<button type="button" onclick={() => provenanceUpgradeInput?.click()} disabled={busy}>Add Provenance…</button>{/if}
				{#if hasModel}<span class="menu-separator"></span><button type="button" onclick={(event) => requestTransition({ kind: 'close' }, event.currentTarget)} disabled={busy || saveBusy || authoringOperationBusy || !!pendingTransition}>Close Model</button>{/if}
				{#if saveBusy}<span class="menu-separator"></span><span class="menu-status" role="status">{saveProgress}</span><button type="button" onclick={cancelSave}>Cancel Save</button>{/if}
				{#if saveError}<span class="menu-status menu-error" role="status">{saveError}</span>{/if}
			</div>
		</details>
		<details class="menu-root">
			<summary>Edit</summary>
			<div class="menu-popover">
				<button type="button" onclick={undoAction} disabled={mode === 'authoring' ? !authoringCheckpoint?.history.undo.length || busy || saveBusy || authoringOperationBusy : !editorController?.history.canUndo}>Undo<kbd>Ctrl+Z</kbd></button>
				<button type="button" onclick={redoAction} disabled={mode === 'authoring' ? !authoringCheckpoint?.history.redo.length || busy || saveBusy || authoringOperationBusy : !editorController?.history.canRedo}>Redo<kbd>Ctrl+Shift+Z</kbd></button>
			</div>
		</details>
		<details class="menu-root">
			<summary>View</summary>
			<div class="menu-popover menu-form">
				<label>Face Style<select value={faceStyle} onchange={(event) => setFaceStyle((event.currentTarget as HTMLSelectElement).value as FaceStyle)}><option value="wireframe">Wireframe</option><option value="hidden-line">Hidden Line</option><option value="shaded">Shaded</option><option value="shaded-textures">Shaded With Textures</option><option value="monochrome">Monochrome</option><option value="photoreal">Photoreal (fallback)</option></select></label>
				<label class="menu-check"><input type="checkbox" checked={viewEffects.xray} onchange={toggleXray} />X-Ray</label>
				<label class="menu-check"><input type="checkbox" checked={viewEffects.ambientOcclusion} onchange={toggleAmbientOcclusion} />Ambient Occlusion</label>
			</div>
		</details>
		<details class="menu-root">
			<summary>Camera</summary>
			<div class="menu-popover">
				<button type="button" onclick={zoomExtents} disabled={!viewport}>Zoom Extents<kbd>Shift+Z</kbd></button>
				<button type="button" onclick={levelCamera} disabled={!viewport}>Level Camera</button>
				<span class="menu-separator"></span>
				<button type="button" onclick={() => setCameraView('top')} disabled={!viewport}>Top</button>
				<button type="button" onclick={() => setCameraView('front')} disabled={!viewport}>Front</button>
				<button type="button" onclick={() => setCameraView('iso')} disabled={!viewport}>Iso</button>
			</div>
		</details>
		<details class="menu-root">
			<summary>Draw</summary>
			<div class="menu-popover">
				<button type="button" onclick={() => setAuthoringTool('rectangle')} disabled={!canAuthor()} title={mode === 'authoring' ? 'Draw a ground-plane rectangle from two ray hits.' : 'Available for writable BOMC documents.'}>Rectangle</button>
				<button type="button" onclick={() => setAuthoringTool('extrude')} disabled={!canAuthor()} title={mode === 'authoring' ? 'Push or pull an eligible flat rectangle.' : 'Available for writable BOMC documents.'}>Push/Pull</button>
				{#if mode === 'authoring'}
					<button type="button" disabled title="Line authoring is outside the supported rectangle and extrusion subset.">Line</button>
					<button type="button" disabled title="Circle authoring is outside the supported rectangle and extrusion subset.">Circle</button>
					<button type="button" disabled title="Arbitrary polygons are outside the supported rectangle and extrusion subset.">Polygon</button>
					<span class="menu-status">Only Editor rectangles and their first signed extrusion are writable.</span>
				{/if}
			</div>
		</details>
		<details class="menu-root">
			<summary>Tools</summary>
			<div class="menu-popover">
				<button type="button" onclick={() => setTool('move')} disabled={mode !== 'imported' || !canMoveSelected()}>Move Selected<kbd>M</kbd></button>
				{#if mode === 'authoring'}<span class="menu-status">Only Editor rectangles and their first signed extrusion are editable.</span>{/if}
			</div>
		</details>
		<details class="menu-root">
			<summary>Window</summary>
			<div class="menu-popover"><button type="button" onclick={toggleTheme}>{darkMode ? 'Light Theme' : 'Dark Theme'}</button></div>
		</details>
		<button type="button" class="menu-label" aria-label="Extensions menu placeholder">Extensions</button>
		<button type="button" class="menu-label" aria-label="Help menu placeholder">Help</button>
	</nav>
	{#if pendingTransition}
		<div class="transition-backdrop">
				<dialog open class="transition-dialog" data-transition-dialog aria-modal="true" aria-labelledby="transition-title" aria-describedby="transition-description" onkeydown={trapTransitionFocus}>
				<h2 id="transition-title">Save changes?</h2>
				<p id="transition-description">This document has unsaved canonical BOMC edits. Save and wait for the download acknowledgment, discard the edits, or cancel this action.</p>
				{#if transitionError}<p class="transition-error" role="alert">{transitionError}</p>{/if}
				<div class="transition-actions">
					<button type="button" class="transition-primary" onclick={() => void saveBomc()} disabled={saveBusy || !canAuthor()}>{saveBusy ? saveProgress || 'Saving…' : 'Save'}</button>
					<button type="button" onclick={discardTransition} disabled={saveBusy || busy}>Discard</button>
					<button type="button" data-cancel onclick={cancelTransition} disabled={saveBusy}>Cancel</button>
					{#if saveBusy}<button type="button" onclick={cancelSave}>Cancel Save</button>{/if}
				</div>
			</dialog>
		</div>
	{/if}

	<nav class="editor-toolstrip" aria-label="Camera and selection tools">
		<div class="tool-group">
			<button type="button" class:active={mode === 'authoring' ? authoringTool === 'select' && activeCameraTool === null : activeTool === 'select' && activeCameraTool === null} onclick={() => mode === 'authoring' ? setAuthoringTool('select') : activateSelectTool()} aria-label="Select" title="Select (Space)" disabled={!viewport || busy || saveBusy}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5 18.5 12l-6.1 1.2 3.4 6-2.6 1.4-3.3-6.1L5 18.3V3.5Z"/></svg>
			</button>
			{#if mode === 'authoring'}
				<button type="button" class:active={authoringTool === 'rectangle'} onclick={() => setAuthoringTool('rectangle')} aria-label="Rectangle" title="Rectangle (two ground-plane ray hits)" disabled={!canAuthor()}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="1"/></svg></button>
				<button type="button" class:active={authoringTool === 'extrude'} onclick={() => setAuthoringTool('extrude')} aria-label="Push/Pull" title="Push/Pull selected rectangle" disabled={!canAuthor()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9 12 5l8 4-8 4-8-4Z"/><path d="M4 9v7l8 4v-7M20 9v7l-8 4M12 5v4"/></svg></button>
			{/if}
			<span class="tool-separator"></span>
			<button type="button" class:active={activeCameraTool === 'orbit'} onclick={() => setCameraTool('orbit')} aria-label="Orbit" title="Orbit (O)" disabled={!viewport || busy || saveBusy}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.1 5.5A8 8 0 0 1 20 11h-2.2a5.9 5.9 0 0 0-9.1-3.8L11 9.5H4.7V3.2l2.4 2.3Zm9.8 13A8 8 0 0 1 4 13h2.2a5.9 5.9 0 0 0 9.1 3.8L13 14.5h6.3v6.3l-2.4-2.3Z"/></svg>
			</button>
			<button type="button" class:active={activeCameraTool === 'pan'} onclick={() => setCameraTool('pan')} aria-label="Pan" title="Pan (H)" disabled={!viewport || busy || saveBusy}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 11V6.8a1.4 1.4 0 1 1 2.8 0V10h.5V5.7a1.4 1.4 0 1 1 2.8 0V10h.5V6.6a1.4 1.4 0 1 1 2.8 0v5.8l1-1a1.5 1.5 0 0 1 2.1 2.1l-4.5 5A4.3 4.3 0 0 1 13.3 20H11a4 4 0 0 1-3.2-1.6L4.3 14a1.5 1.5 0 0 1 2.3-1.9L8.5 14V11Z"/></svg>
			</button>
			<button type="button" class:active={activeCameraTool === 'zoom'} onclick={() => setCameraTool('zoom')} aria-label="Zoom" title="Zoom (Z)" disabled={!viewport || busy || saveBusy}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5M10.5 8v5M8 10.5h5"/></svg>
			</button>
			<button type="button" onclick={zoomExtents} aria-label="Zoom Extents" title="Zoom Extents (Shift+Z)" disabled={!viewport || busy || saveBusy}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><circle cx="11" cy="11" r="3.5"/><path d="m13.7 13.7 3 3"/></svg>
			</button>
		</div>
		{#if mode === 'authoring' && authoringCheckpoint}<div class="tool-context"><span>{authoringCheckpoint.snapshot.graph.name || 'Untitled'}</span><span class="mode-badge">Writable BOMC</span><span>{isAuthoringDirty() ? 'Unsaved' : 'Saved'}</span></div>
		{:else if mode === 'imported' && result}<div class="tool-context"><span>{result.modelName ?? session?.source.file.name ?? 'BOMC model'}</span><span>{result.encodingContract?.profile?.toUpperCase() ?? 'PROFILE'}</span><span title="BOMC editing is limited to Editor-created rectangles and their first extrusion.">Viewer · supported authoring subset only</span></div>{/if}
	</nav>

	{#if result?.scenes.length}
		<div class="scene-tabs" role="tablist" aria-label="Scenes">
			{#each result.scenes as scene}
				<button type="button" role="tab" aria-selected={scene.id === sceneId} class:active={scene.id === sceneId} onclick={() => activateScene(scene.id)}>{scene.name || scene.id}</button>
			{/each}
		</div>
	{:else}
		<div class="scene-tabs scene-tabs-empty" aria-hidden="true"><span>No scenes</span></div>
	{/if}

	<section class="editor-stage">
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="viewport-frame" onpointerdown={handleViewportPointerDown} onpointermove={handleViewportPointerMove} onpointerup={handleViewportPointerUp} onpointercancel={handleViewportPointerCancel} onkeydown={handleViewportKeyDown} role="application" aria-label="3D model workspace" tabindex="0">
			<div class="viewport" bind:this={viewportHost} aria-label="3D viewport"></div>
			{#if !hasModel && !busy}
				<div class="empty-workspace">
				<div class="empty-dropzone">
					<span class="empty-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m21 16-9 5-9-5V8l9-5 9 5v8Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg></span>
					<p class="eyebrow">SIBAMBO EDITOR</p>
					<h1>New or open a model</h1>
					<p>Create a canonical writable BOMC document or open a BOMC 1.2 model for inspection.</p>
					<div class="empty-actions"><button type="button" class="empty-open" onclick={(event) => requestTransition({ kind: 'new' }, event.currentTarget)} disabled={busy || saveBusy || !clientReady}>{busy ? 'Creating…' : 'New BOMC'}</button><button type="button" class="empty-open empty-secondary" onclick={(event) => openFilePicker(event.currentTarget)} disabled={busy || saveBusy || !clientReady}>{busy ? 'Opening…' : 'Open Model…'}</button></div>
					{#if error}<p class="empty-error" role="alert">{error}</p>{/if}
				</div>
				</div>
			{/if}
			{#if mode === 'imported' && activeTool === 'move'}
					<div class="move-hud" aria-label="Move controls">
						<div class="axis-controls"><button type="button" class:chosen={moveAxis === 'x'} onclick={() => { moveAxis = moveAxis === 'x' ? null : 'x'; editorController?.setOccurrenceMoveAxis(moveAxis); refreshOccurrencePreview(); }}>X</button><button type="button" class:chosen={moveAxis === 'y'} onclick={() => { moveAxis = moveAxis === 'y' ? null : 'y'; editorController?.setOccurrenceMoveAxis(moveAxis); refreshOccurrencePreview(); }}>Y</button><button type="button" class:chosen={moveAxis === 'z'} onclick={() => { moveAxis = moveAxis === 'z' ? null : 'z'; editorController?.setOccurrenceMoveAxis(moveAxis); refreshOccurrencePreview(); }}>Z</button></div>
						<label>Distance <input type="number" step="0.01" placeholder="metres" value={moveDistanceText} oninput={(event) => { moveDistanceText = (event.currentTarget as HTMLInputElement).value; const distance = moveDistanceText === '' ? null : Number(moveDistanceText); editorController?.setOccurrenceMoveDistance(Number.isFinite(distance) ? distance : null); refreshOccurrencePreview(); }} /></label>
						<button type="button" class="hud-primary" onclick={() => { editorController?.commitOccurrenceMove(); activeTool = 'select'; editorController?.setTool('select'); viewport?.setOccurrencePreview(null); editorNotice = 'Move committed.'; }}>Commit</button>
						<button type="button" onclick={() => { editorController?.cancel(); activeTool = 'select'; editorController?.setTool('select'); viewport?.setOccurrencePreview(null); editorNotice = 'Move canceled.'; }}>Cancel</button>
					</div>
				{/if}
			{#if mode === 'authoring' && authoringTool === 'extrude'}
				<div class="extrude-hud" aria-label="Push/Pull controls">
					<label>Extrusion (m) <input type="text" inputmode="decimal" autocomplete="off" value={extrusionDistanceText} aria-describedby="extrude-help" oninput={(event) => { extrusionDistanceText = (event.currentTarget as HTMLInputElement).value; authoringTools?.setExtrusionDistance(extrusionDistanceText); }} onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); authoringTools?.commitExtrusionDistance(); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); authoringTools?.cancelPreview(); setAuthoringTool('select'); } }} /> </label>
					<span id="extrude-help">Enter commits the complete finite distance; negative values pull below the source plane.</span>
					<button type="button" class="hud-primary" onclick={() => authoringTools?.commitExtrusionDistance()} disabled={!canAuthor()}>Commit</button>
					<button type="button" onclick={() => { authoringTools?.cancelPreview(); setAuthoringTool('select'); }}>Cancel</button>
				</div>
			{/if}
			{#if selectionBox}<div class="selection-box" class:intersect={selectionBox.direction === 'intersect'} style:left={`${selectionBox.left}px`} style:top={`${selectionBox.top}px`} style:width={`${selectionBox.width}px`} style:height={`${selectionBox.height}px`} aria-hidden="true"></div>{/if}
			{#if busy || error || projectionError}<div class="viewport-status" class:error-state={!!error || !!projectionError} role="status"><span>{error || projectionError || loadStatus}</span>{#if busy}<button type="button" onclick={cancelLoad}>Cancel</button>{/if}{#if projectionError && mode === 'authoring'}<button type="button" onclick={() => refreshAuthoringProjection(false)}>Retry Render</button>{/if}</div>{/if}
			<p class="viewport-hint">Middle-drag Orbit · Shift+Middle Pan · Wheel Zoom · O/H/Z camera tools</p>
		</div>
	</section>

	<footer class="editor-footer">
		<div class="footer-brand"><strong>Sibambo Editor</strong><span>BOMC workspace</span></div>
		<div class="footer-status" aria-live="polite">
			{#if hasModel}
				<span>{editorNotice || (ready ? 'Ready' : 'Preparing viewport…')}</span>
				{#if mode === 'authoring'}<span>{isAuthoringDirty() ? 'Unsaved BOMC' : 'Saved BOMC'}</span>{/if}
				{#if mode === 'imported' && selectedOccurrenceHandles.length}<span>{selectedOccurrenceHandles.length} selected</span>{/if}
				{#if picked?.sourceFaceIndex !== null && picked?.sourceFaceIndex !== undefined}<span>Face {picked.sourceFaceIndex}</span>{/if}
			{:else}<span>{busy ? loadStatus : 'No model loaded'}</span>{/if}
		</div>
		<div class="footer-build">
			{#if mode === 'imported' && result}<span>{result.counts.faces.toLocaleString()} faces · {result.counts.instances.toLocaleString()} instances · {result.counts.meshes.toLocaleString()} meshes</span>{:else if mode === 'authoring' && authoringCheckpoint}<span>{authoringCheckpoint.snapshot.graph.meshes.length.toLocaleString()} meshes · rev {authoringCheckpoint.snapshot.revision}</span>{/if}
			<span>Build {build.commit.slice(0, 8)} · {build.dirty ? 'dirty' : 'clean'}</span>
		</div>
	</footer>
</main>
