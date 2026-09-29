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
	import { type FaceStyle, type PreparedSceneViewport, type ViewEffects, type ViewportPick } from '@sibambo/viewport';
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
	let provenanceUpgradeInput: HTMLInputElement;
	let busy = $state(false);
	let loadStatus = $state('Choose a BOMC 1.2 model file.');
	let ready = $state(false);
	let error = $state('');
	let activeOperation: 'import' | 'provenance' = 'import';
	let activeTool = $state<EditorTool>('select');
	let editorNotice = $state('');
	let editorController = $state.raw<EditorController | null>(null);
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
	type CameraPose = ReturnType<PreparedSceneViewport['getCameraPose']>;
	type LoadedEditorState = {
		provenance: ResearchProvenance | null;
		artifactSha256: string;
		result: AdaptedBomcResult | null;
		session: EditorSession | null;
		viewport: PreparedSceneViewport | null;
		ready: boolean;
		picked: ViewportPick | null;
		selectedOccurrenceHandles: string[];
		activeTool: EditorTool;
		sceneId: string;
		hostChildren: Node[];
	};
	let activeLoadSnapshot: LoadedEditorState | null = null;

	function snapshotLoadedState(): LoadedEditorState {
		return {
			provenance, artifactSha256, result, session, viewport, ready, picked,
			selectedOccurrenceHandles: [...selectedOccurrenceHandles], activeTool, sceneId,
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
		selectedOccurrenceHandles = [...snapshot.selectedOccurrenceHandles];
		activeTool = snapshot.activeTool;
		sceneId = snapshot.sceneId;
		snapshot.viewport?.setSelectedOccurrences(snapshot.selectedOccurrenceHandles);
		restoreHostChildren(snapshot.hostChildren);
	}

	function stageSource(event: Event) {
		sourceFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
		// File > Open behaves like a desktop editor: choosing a file starts loading it.
		// Provenance can be attached independently after the model is open.
		provenanceFile = null;
		if (provenanceInput) provenanceInput.value = '';
		error = '';
		if (sourceFile) void openModel();
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
			nextViewport.setDisplayState({ faceStyle, effects: viewEffects });
			nextViewport.setOrbitControlsEnabled(false);
			provenance = admitted.provenance;
			artifactSha256 = admitted.artifactSha256;
			result = loaded;
			session = nextSession;
			editorController = new EditorController(nextSession.editableGeometry);
			sceneId = nextSceneId;
			viewport = nextViewport;
			ready = false;
			picked = null;
			selectedOccurrenceHandles = [];
			activeTool = 'select';
			activeCameraTool = null;
			moveDistanceText = '';
			moveAxis = null;
			editorNotice = '';
			selectionBox = null;
			nextViewport.setSelectedOccurrences([]);
			unsubscribeOccurrenceTransforms?.();
			unsubscribeOccurrenceTransforms = nextSession.editableGeometry.subscribeOccurrenceTransforms((transforms) => {
				if (viewport !== nextViewport || request !== generation) return;
				nextViewport.setOccurrenceTransforms(new Map(transforms.map((item) => [item.occurrenceHandle, item.translation])));
			});
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

	function setTool(tool: EditorTool) {
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
		if (editorController) { editorController.undo(); editorController.setTool('select'); }
		activeTool = 'select';
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
	function activateScene(nextSceneId: string) {
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
	function startCameraGesture(event: PointerEvent, tool: 'orbit' | 'pan' | 'zoom') {
		if (!viewport) return;
		pointerGesture = {
			kind: 'camera', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
			lastY: event.clientY, moved: false, cameraTool: tool, cameraPose: viewport.getCameraPose()
		};
	}
	function startTouchPairGesture() {
		if (!viewport || activeTouchPoints.size < 2) return;
		const points = [...activeTouchPoints.values()];
		const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
		const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
		pointerGesture = {
			kind: 'touch-pair', pointerId: -1, startX: center.x, startY: center.y, moved: true,
			lastCenter: center, lastTouchDistance: Math.max(distance, 1)
		};
	}
	function handleViewportPointerDown(event: PointerEvent) {
		if (!viewport || event.target !== viewportHost?.querySelector('canvas')) return;
		event.preventDefault();
		const frame = event.currentTarget as HTMLElement;
		try { frame.setPointerCapture(event.pointerId); } catch { /* the browser may already have captured this pointer */ }
		viewportHost?.querySelector('canvas')?.focus({ preventScroll: true });
		if (event.pointerType === 'touch') {
			activeTouchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (activeTouchPoints.size >= 2) startTouchPairGesture();
			else pointerGesture = {
				kind: 'touch-pending', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
				moved: false, startPick: viewport.pickAt(event.clientX, event.clientY), cameraPose: viewport.getCameraPose()
			};
			return;
		}
		const middleTool = pointerCameraTool(mouseButtonsFromMask(event.buttons), event.shiftKey);
		if (middleTool) { startCameraGesture(event, middleTool); return; }
		if (event.button !== 0) return;
		if (activeCameraTool) { startCameraGesture(event, activeCameraTool); return; }
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
		if (!viewport || !pointerGesture) return;
		if (event.pointerType === 'touch') activeTouchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pointerGesture.kind === 'touch-pair' && activeTouchPoints.size >= 2) {
			const points = [...activeTouchPoints.values()];
			const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
			const distance = Math.max(Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y), 1);
			viewport.dragCamera('pan', viewport.getCameraPose(), center.x - pointerGesture.lastCenter.x, center.y - pointerGesture.lastCenter.y, viewportHost?.clientHeight ?? 1);
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
			viewport.dragCamera('orbit', pointerGesture.cameraPose as CameraPose, deltaX, deltaY, viewportHost?.clientHeight ?? 1);
		} else if (pointerGesture.kind === 'camera') {
			if (pointerGesture.cameraTool === 'zoom') {
				viewport.zoomAt(event.clientX, event.clientY, (event.clientY - pointerGesture.lastY) * 4);
				pointerGesture.lastY = event.clientY;
			} else viewport.dragCamera(pointerGesture.cameraTool, pointerGesture.cameraPose as CameraPose, deltaX, deltaY, viewportHost?.clientHeight ?? 1);
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
	}
	function handleViewportPointerUp(event: PointerEvent) {
		if (event.pointerType === 'touch') {
			activeTouchPoints.delete(event.pointerId);
			if (activeTouchPoints.size === 1 && pointerGesture?.kind === 'touch-pair') {
				const [remainingId, position] = [...activeTouchPoints.entries()][0];
				pointerGesture = { kind: 'touch-orbit', pointerId: remainingId, startX: position.x, startY: position.y, moved: true, cameraPose: viewport?.getCameraPose() };
				return;
			}
			if (activeTouchPoints.size > 0) return;
		}
		if (!pointerGesture || (pointerGesture.pointerId !== event.pointerId && pointerGesture.pointerId !== -1)) return;
		if (event.pointerType !== 'touch' && event.buttons !== 0) return;
		const gesture = pointerGesture;
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
		try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch { /* capture may already be released */ }
	}
	function handleViewportPointerCancel(event: PointerEvent) {
		activeTouchPoints.delete(event.pointerId);
		selectionBox = null;
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
		const target = event.target as HTMLElement | null;
		if (target?.closest('input, textarea, select, [contenteditable="true"]') || event.repeat) return;
		const key = event.key.toLowerCase();
		if ((event.ctrlKey || event.metaKey) && key === 'z') {
			event.preventDefault();
			if (event.shiftKey) {
				editorController?.redo();
				editorController?.setTool('select');
				activeTool = 'select';
				viewport?.setOccurrencePreview(null);
			} else undoAction();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			selectionBox = null;
			pointerGesture = null;
			activeTouchPoints.clear();
			activeCameraTool = null;
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
		if (key === 'z' && event.shiftKey) { event.preventDefault(); viewport?.fit(); activeCameraTool = null; return; }
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
	}
	function setFaceStyle(style: FaceStyle) { applyDisplayState(style, viewEffects); }
	function toggleXray(event: Event) {
		applyDisplayState(faceStyle, { ...viewEffects, xray: (event.currentTarget as HTMLInputElement).checked });
	}
	function toggleAmbientOcclusion(event: Event) {
		applyDisplayState(faceStyle, { ...viewEffects, ambientOcclusion: (event.currentTarget as HTMLInputElement).checked });
	}
	function setCameraTool(tool: 'orbit' | 'pan' | 'zoom') {
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
		viewport?.fit();
		viewport?.levelCamera();
		editorNotice = 'Zoom Extents · camera and anchor reframed to the visible model.';
	}
	function levelCamera() {
		viewport?.levelCamera();
		editorNotice = 'Camera leveled · imported roll removed while preserving the current view direction.';
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
		unsubscribeOccurrenceTransforms?.();
		unsubscribeOccurrenceTransforms = null;
		viewport?.dispose();
		viewport = null;
		session?.dispose();
		session = null;
		editorController = null;
		editorNotice = '';
		result = null;
		sceneId = '';
		provenance = null;
		artifactSha256 = '';
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
	onMount(() => {
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
		return () => {
			document.removeEventListener('pointerdown', closeMenusOutside, true);
			document.removeEventListener('keydown', closeMenusOnEscape);
		};
	});
	onDestroy(() => { generation += 1; evidenceGeneration += 1; controller?.abort(); unsubscribeOccurrenceTransforms?.(); viewport?.dispose(); session?.dispose(); });
</script>

<svelte:head>
	<title>Sibambo Editor</title>
	<meta name="description" content="Sibambo Editor model workspace with SketchUp-style camera navigation." />
	<meta name="theme-color" content={darkMode ? '#15181C' : '#F7F8FA'} />
</svelte:head>

<main data-app="editor" class:is-loaded={!!result}>
	<div class="visually-hidden">
		<label>BOMC 1.2 file<input bind:this={sourceInput} type="file" accept=".bomc,application/octet-stream" onchange={stageSource} disabled={busy} tabindex="-1" /></label>
		<label>Provenance JSON for next model<input bind:this={provenanceInput} type="file" accept=".json,application/json" onchange={stageProvenance} disabled={busy} tabindex="-1" /></label>
		<label>Provenance JSON for current model<input bind:this={provenanceUpgradeInput} type="file" accept=".json,application/json" onchange={stageUpgradeProvenance} disabled={busy || !session || !!provenance} tabindex="-1" /></label>
	</div>

	<nav class="editor-menubar" aria-label="Editor application menu">
		<a class="editor-wordmark" href="https://sibambo.vercel.app/" aria-label="Sibambo home"><span class="wordmark-cube" aria-hidden="true">◇</span><strong>Sibambo</strong><span>Editor</span></a>
		<details class="menu-root">
			<summary>File</summary>
			<div class="menu-popover">
				<button type="button" onclick={() => sourceInput?.click()} disabled={busy}>Open Model…<kbd>Ctrl+O</kbd></button>
				{#if result}<button type="button" onclick={downloadCapture} disabled={!ready}>Save View…</button>{/if}
				{#if result && !provenance}<button type="button" onclick={() => provenanceUpgradeInput?.click()} disabled={busy}>Add Provenance…</button>{/if}
				{#if result}<span class="menu-separator"></span><button type="button" onclick={unload} disabled={busy}>Close Model</button>{/if}
			</div>
		</details>
		<details class="menu-root">
			<summary>Edit</summary>
			<div class="menu-popover">
				<button type="button" onclick={undoAction} disabled={!editorController?.history.canUndo}>Undo<kbd>Ctrl+Z</kbd></button>
				<button type="button" onclick={() => { editorController?.redo(); editorController?.setTool('select'); activeTool = 'select'; activeCameraTool = null; viewport?.setOccurrencePreview(null); }} disabled={!editorController?.history.canRedo}>Redo<kbd>Ctrl+Shift+Z</kbd></button>
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
				<button type="button" onclick={() => viewport?.view('top')} disabled={!viewport}>Top</button>
				<button type="button" onclick={() => viewport?.view('front')} disabled={!viewport}>Front</button>
				<button type="button" onclick={() => viewport?.view('iso')} disabled={!viewport}>Iso</button>
			</div>
		</details>
		<button type="button" class="menu-label" aria-label="Draw menu placeholder">Draw</button>
		<details class="menu-root">
			<summary>Tools</summary>
			<div class="menu-popover">
				<button type="button" onclick={() => setTool('move')} disabled={!canMoveSelected()}>Move Selected<kbd>M</kbd></button>
			</div>
		</details>
		<details class="menu-root">
			<summary>Window</summary>
			<div class="menu-popover"><button type="button" onclick={toggleTheme}>{darkMode ? 'Light Theme' : 'Dark Theme'}</button></div>
		</details>
		<button type="button" class="menu-label" aria-label="Extensions menu placeholder">Extensions</button>
		<button type="button" class="menu-label" aria-label="Help menu placeholder">Help</button>
	</nav>

	<nav class="editor-toolstrip" aria-label="Camera and selection tools">
		<div class="tool-group">
			<button type="button" class:active={activeTool === 'select' && activeCameraTool === null} onclick={activateSelectTool} aria-label="Select" title="Select (Space)" disabled={!result}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5 18.5 12l-6.1 1.2 3.4 6-2.6 1.4-3.3-6.1L5 18.3V3.5Z"/></svg>
			</button>
			<span class="tool-separator"></span>
			<button type="button" class:active={activeCameraTool === 'orbit'} onclick={() => setCameraTool('orbit')} aria-label="Orbit" title="Orbit (O)" disabled={!result}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.1 5.5A8 8 0 0 1 20 11h-2.2a5.9 5.9 0 0 0-9.1-3.8L11 9.5H4.7V3.2l2.4 2.3Zm9.8 13A8 8 0 0 1 4 13h2.2a5.9 5.9 0 0 0 9.1 3.8L13 14.5h6.3v6.3l-2.4-2.3Z"/></svg>
			</button>
			<button type="button" class:active={activeCameraTool === 'pan'} onclick={() => setCameraTool('pan')} aria-label="Pan" title="Pan (H)" disabled={!result}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 11V6.8a1.4 1.4 0 1 1 2.8 0V10h.5V5.7a1.4 1.4 0 1 1 2.8 0V10h.5V6.6a1.4 1.4 0 1 1 2.8 0v5.8l1-1a1.5 1.5 0 0 1 2.1 2.1l-4.5 5A4.3 4.3 0 0 1 13.3 20H11a4 4 0 0 1-3.2-1.6L4.3 14a1.5 1.5 0 0 1 2.3-1.9L8.5 14V11Z"/></svg>
			</button>
			<button type="button" class:active={activeCameraTool === 'zoom'} onclick={() => setCameraTool('zoom')} aria-label="Zoom" title="Zoom (Z)" disabled={!result}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5M10.5 8v5M8 10.5h5"/></svg>
			</button>
			<button type="button" onclick={zoomExtents} aria-label="Zoom Extents" title="Zoom Extents (Shift+Z)" disabled={!result}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><circle cx="11" cy="11" r="3.5"/><path d="m13.7 13.7 3 3"/></svg>
			</button>
		</div>
		{#if result}<div class="tool-context"><span>{result.modelName ?? session?.source.file.name ?? 'BOMC model'}</span><span>{result.encodingContract?.profile?.toUpperCase() ?? 'PROFILE'}</span></div>{/if}
	</nav>

	{#if result?.scenes.length}
		<nav class="scene-tabs" role="tablist" aria-label="Scenes">
			{#each result.scenes as scene}
				<button type="button" role="tab" aria-selected={scene.id === sceneId} class:active={scene.id === sceneId} onclick={() => activateScene(scene.id)}>{scene.name || scene.id}</button>
			{/each}
		</nav>
	{:else}
		<div class="scene-tabs scene-tabs-empty" aria-hidden="true"><span>No scenes</span></div>
	{/if}

	<section class="editor-stage">
		{#if result}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div class="viewport-frame" onpointerdown={handleViewportPointerDown} onpointermove={handleViewportPointerMove} onpointerup={handleViewportPointerUp} onpointercancel={handleViewportPointerCancel} onkeydown={handleViewportKeyDown} role="application" aria-label="3D model workspace">
				<div class="viewport" bind:this={viewportHost} aria-label="3D viewport"></div>
				{#if selectionBox}<div class="selection-box" class:intersect={selectionBox.direction === 'intersect'} style:left={`${selectionBox.left}px`} style:top={`${selectionBox.top}px`} style:width={`${selectionBox.width}px`} style:height={`${selectionBox.height}px`} aria-hidden="true"></div>{/if}
				{#if activeTool === 'move'}
					<div class="move-hud" aria-label="Move controls">
						<div class="axis-controls"><button type="button" class:chosen={moveAxis === 'x'} onclick={() => { moveAxis = moveAxis === 'x' ? null : 'x'; editorController?.setOccurrenceMoveAxis(moveAxis); refreshOccurrencePreview(); }}>X</button><button type="button" class:chosen={moveAxis === 'y'} onclick={() => { moveAxis = moveAxis === 'y' ? null : 'y'; editorController?.setOccurrenceMoveAxis(moveAxis); refreshOccurrencePreview(); }}>Y</button><button type="button" class:chosen={moveAxis === 'z'} onclick={() => { moveAxis = moveAxis === 'z' ? null : 'z'; editorController?.setOccurrenceMoveAxis(moveAxis); refreshOccurrencePreview(); }}>Z</button></div>
						<label>Distance <input type="number" step="0.01" placeholder="metres" value={moveDistanceText} oninput={(event) => { moveDistanceText = (event.currentTarget as HTMLInputElement).value; const distance = moveDistanceText === '' ? null : Number(moveDistanceText); editorController?.setOccurrenceMoveDistance(Number.isFinite(distance) ? distance : null); refreshOccurrencePreview(); }} /></label>
						<button type="button" class="hud-primary" onclick={() => { editorController?.commitOccurrenceMove(); activeTool = 'select'; editorController?.setTool('select'); viewport?.setOccurrencePreview(null); editorNotice = 'Move committed.'; }}>Commit</button>
						<button type="button" onclick={() => { editorController?.cancel(); activeTool = 'select'; editorController?.setTool('select'); viewport?.setOccurrencePreview(null); editorNotice = 'Move canceled.'; }}>Cancel</button>
					</div>
				{/if}
				{#if busy || error}<div class="viewport-status" class:error-state={!!error} role="status"><span>{error || loadStatus}</span>{#if busy}<button type="button" onclick={cancelLoad}>Cancel</button>{/if}</div>{/if}
				<p class="viewport-hint">Middle-drag Orbit · Shift+Middle Pan · Wheel Zoom · O/H/Z camera tools</p>
			</div>
		{:else}
			<div class="empty-workspace">
				<div class="empty-dropzone">
					<span class="empty-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m21 16-9 5-9-5V8l9-5 9 5v8Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg></span>
					<p class="eyebrow">SIBAMBO EDITOR</p>
					<h1>Open a model</h1>
					<p>Open a BOMC 1.2 file to inspect it with the editor camera and scene tools.</p>
					<button type="button" class="empty-open" onclick={() => sourceInput?.click()} disabled={busy}>{busy ? 'Opening…' : 'Open Model…'}</button>
					{#if busy}<p class="empty-status">{loadStatus}</p>{/if}
					{#if error}<p class="empty-error" role="alert">{error}</p>{/if}
				</div>
			</div>
		{/if}
	</section>

	<footer class="editor-footer">
		<div class="footer-brand"><strong>Sibambo Editor</strong><span>BOMC workspace</span></div>
		<div class="footer-status" aria-live="polite">
			{#if result}
				<span>{editorNotice || (ready ? 'Ready' : 'Preparing viewport…')}</span>
				{#if selectedOccurrenceHandles.length}<span>{selectedOccurrenceHandles.length} selected</span>{/if}
				{#if picked?.sourceFaceIndex !== null && picked?.sourceFaceIndex !== undefined}<span>Face {picked.sourceFaceIndex}</span>{/if}
			{:else}<span>{busy ? loadStatus : 'No model loaded'}</span>{/if}
		</div>
		<div class="footer-build">
			{#if result}<span>{result.counts.faces.toLocaleString()} faces · {result.counts.instances.toLocaleString()} instances · {result.counts.meshes.toLocaleString()} meshes</span>{/if}
			<span>Build {build.commit.slice(0, 8)} · {build.dirty ? 'dirty' : 'clean'}</span>
		</div>
	</footer>
</main>
