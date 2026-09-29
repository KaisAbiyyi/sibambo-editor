<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import SibamboHeader from '$lib/components/SibamboHeader.svelte';
	import '$lib/ui/sibambo.css';
	import type { AdaptedBomcResult } from '@sibambo/e4-import';
	import { EditorSession } from '$lib/editor/EditorSession';
	import { EditorController } from '$lib/editor/EditorController';
	import type { EditorTool } from '$lib/editor/EditorState';
	import { pinchZoomDelta, pointerCameraTool, selectionDragMode, selectionModifierMode, type EditorSelectionModifier } from '$lib/editor/camera-navigation';
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
	let activeTool = $state<EditorTool>('select');
	let editorNotice = $state('');
	let editorController = $state.raw<EditorController | null>(null);
	let picked = $state<ViewportPick | null>(null);
	let selectedOccurrenceHandles = $state<string[]>([]);
	let selectionBox = $state<{ left: number; top: number; width: number; height: number; direction: 'enclose' | 'intersect' } | null>(null);
	let activeCameraTool = $state<'orbit' | 'pan' | 'zoom' | null>(null);
	let moveDistanceText = $state('');
	let moveAxis = $state<'x' | 'y' | 'z' | null>(null);
	let viewMode = $state<ViewMode>('solid');
	let sceneId = $state('');
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
		if (selectedOccurrenceHandles.length === 1) viewport?.focusOccurrence(selectedOccurrenceHandles[0]);
		if (selectedOccurrenceHandles.length === 1) editorNotice = 'One imported occurrence selected. Use Move or press M to edit its working transform.';
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
	function sceneChanged(event: Event) {
		sceneId = (event.currentTarget as HTMLSelectElement).value;
		const selected = result?.scenes.find((scene) => scene.id === sceneId);
		viewport?.setScene(selected ?? null);
		const retained = selectedOccurrenceHandles.filter((handle) => viewport?.hasOccurrence(handle));
		if (retained.length !== selectedOccurrenceHandles.length) {
			selectedOccurrenceHandles = retained;
			picked = null;
			viewport?.setSelectedOccurrences(retained);
			editorNotice = 'Selection cleared because its imported occurrence is absent from this scene.';
		}
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
			activeCameraTool = key === 'o' ? 'orbit' : key === 'h' ? 'pan' : 'zoom';
			editorNotice = `${activeCameraTool === 'orbit' ? 'Orbit' : activeCameraTool === 'pan' ? 'Pan' : 'Zoom'} selected · drag with the left button. Middle mouse remains available for navigation.`;
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

	function setMode(mode: ViewMode) { viewMode = mode; viewport?.setViewMode(mode); }
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
	onDestroy(() => { generation += 1; evidenceGeneration += 1; controller?.abort(); unsubscribeOccurrenceTransforms?.(); viewport?.dispose(); session?.dispose(); });
</script>

<svelte:head>
	<title>Sibambo Editor</title>
	<meta name="description" content="Open a local BOMC 1.2 file and inspect it with basic camera and navigation controls. Provenance matching is optional." />
</svelte:head>

<main data-app="editor" class:is-loaded={!!result}>
	<SibamboHeader current="editor" />
	<div class="visually-hidden">
		<label>BOMC 1.2 file<input bind:this={sourceInput} type="file" accept=".bomc,application/octet-stream" onchange={stageSource} disabled={busy} tabindex="-1" /></label>
		<label>Provenance JSON for next model<input bind:this={provenanceInput} type="file" accept=".json,application/json" onchange={stageProvenance} disabled={busy} tabindex="-1" /></label>
		<label>Provenance JSON for current model<input bind:this={provenanceUpgradeInput} type="file" accept=".json,application/json" onchange={stageUpgradeProvenance} disabled={busy || !session || !!provenance} tabindex="-1" /></label>
	</div>
	{#if result || busy || error || editorNotice}
		<div class="loaded-meta">
			{#if result}
				<section class="toolbar" aria-label="Model and camera controls">
					<div class="primary-tools" aria-label="Primary editing tools">
						<button type="button" class:chosen={activeTool === 'select'} onclick={() => setTool('select')}>Select</button>
						{#if canMoveSelected()}<button type="button" class:chosen={activeTool === 'move'} onclick={() => setTool('move')}>Move</button>{/if}
						<button type="button" onclick={() => { viewport?.fit(); }}>Fit</button>
						<button type="button" onclick={undoAction} disabled={!editorController?.history.canUndo}>Undo</button>
					</div>
					<details class="secondary-tools">
						<summary>More</summary>
						<div class="secondary-menu">
							<button type="button" onclick={() => viewport?.view('top')}>Top</button><button type="button" onclick={() => viewport?.view('front')}>Front</button><button type="button" onclick={() => viewport?.view('iso')}>Iso</button>
							<label>Display<select value={viewMode} onchange={(event) => setMode((event.currentTarget as HTMLSelectElement).value as ViewMode)}><option value="solid">Solid</option><option value="xray">X-Ray</option><option value="wireframe">Wireframe</option></select></label>
							{#if result.scenes.length}<label>Scene<select aria-label="Visible scene" value={sceneId} onchange={sceneChanged}>{#each result.scenes as scene}<option value={scene.id}>{scene.name || scene.id}</option>{/each}</select></label>{/if}
							<button type="button" onclick={downloadCapture} disabled={!ready}>Save view</button>
							<button type="button" class="primary" onclick={openModel} disabled={busy || !sourceFile}>{busy ? 'Opening…' : 'Open model file'}</button>
							<button type="button" onclick={() => sourceInput?.click()} disabled={busy}>Change artifact</button>
							<button type="button" onclick={() => provenanceInput?.click()} disabled={busy}>Choose sidecar for next model</button>
							<button type="button" onclick={unload} disabled={busy}>Unload</button>
						</div>
					</details>
				</section>
			{/if}
			{#if busy || error || (editorNotice && !result)}
				<section class="status-row" aria-live="polite">
					{#if busy}<div class="status-progress"><output class="load-progress">{loadStatus}</output><button type="button" class="secondary" onclick={cancelLoad}>Cancel</button></div>{/if}
					{#if error}<p class="error" role="alert">{error}</p>{/if}
					{#if editorNotice && !result}<p class="notice" role="status">{editorNotice}</p>{/if}
				</section>
			{/if}
			{#if result}
		<section class="source-bar" aria-label="Imported source status">
			<strong>{provenance?.model.id ?? result.modelName ?? session?.source.file.name}</strong>
			<span class="evidence-level" aria-label="Evidence level" data-evidence-level={session?.source.evidenceLevel ?? 'file-only'}>{provenance ? 'Provenance-matched · operator-attested source record' : 'File-only · source not recorded'}</span>
			<span>{result.encodingContract?.profile?.toUpperCase()} · BOMC {result.diagnostics.version}</span>
			<span>{result.counts.faces.toLocaleString()} faces · {result.counts.instances.toLocaleString()} instances · {result.counts.meshes.toLocaleString()} meshes</span>
			<span class:ready>{ready ? 'Textures settled and first frame observed' : 'Preparing viewport'}</span>
		</section>
			{/if}
		</div>
	{/if}
	{#if result}
		<div class="workspace">
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div class="viewport-frame" onpointerdown={handleViewportPointerDown} onpointermove={handleViewportPointerMove} onpointerup={handleViewportPointerUp} onpointercancel={handleViewportPointerCancel} onwheel={handleViewportWheel} onkeydown={handleViewportKeyDown} role="application" aria-label="3D model workspace">
				<div class="viewport" bind:this={viewportHost} aria-label="3D viewport"></div>
				{#if selectionBox}<div class="selection-box" class:intersect={selectionBox.direction === 'intersect'} style:left={`${selectionBox.left}px`} style:top={`${selectionBox.top}px`} style:width={`${selectionBox.width}px`} style:height={`${selectionBox.height}px`} aria-hidden="true"></div>{/if}
				<p class="touch-hint" data-testid="touch-hint">Tap selects · drag empty space to orbit · two fingers pan and zoom</p>
			</div>
			<aside class="task-panel" aria-label="Current selection and model details">
				<div class="current-selection" class:is-moving={activeTool === 'move'} class:has-selection={selectedOccurrenceHandles.length > 0} aria-live="polite">
					<span class="eyebrow">CURRENT SELECTION</span>
					<strong>{selectedOccurrenceHandles.length === 0 ? 'Select an occurrence' : selectedOccurrenceHandles.length === 1 ? '1 imported occurrence' : `${selectedOccurrenceHandles.length} imported occurrences`}</strong>
					<span>{activeTool === 'move' ? editorController?.preview.label ?? 'Move preview' : selectedOccurrenceHandles.length === 1 ? 'Move is available for this occurrence.' : 'Left click selects · drag selects a region'}</span>
					{#if editorNotice && activeTool !== 'move'}<span class="selection-notice">{editorNotice}</span>{/if}
				</div>
				<div class="mobile-loaded-controls" aria-label="Mobile model controls">
					<div class="mobile-primary-actions">
						<button type="button" class:chosen={activeTool === 'select'} onclick={() => setTool('select')}>Select</button>
						{#if canMoveSelected()}<button type="button" class:chosen={activeTool === 'move'} onclick={() => setTool('move')}>Move</button>{:else}<span class="mobile-control-placeholder" aria-hidden="true"></span>{/if}
						<button type="button" class="secondary" onclick={() => viewport?.fit()}>Fit</button>
						<button type="button" class="secondary" onclick={undoAction} disabled={!editorController?.history.canUndo}>Undo</button>
					</div>
					<details class="secondary-tools">
						<summary aria-label="More model controls">More</summary>
						<div class="secondary-menu">
							<button type="button" onclick={() => viewport?.view('top')}>Top</button><button type="button" onclick={() => viewport?.view('front')}>Front</button><button type="button" onclick={() => viewport?.view('iso')}>Iso</button>
							<label>Display<select aria-label="Display mode" value={viewMode} onchange={(event) => setMode((event.currentTarget as HTMLSelectElement).value as ViewMode)}><option value="solid">Solid</option><option value="xray">X-Ray</option><option value="wireframe">Wireframe</option></select></label>
							{#if result.scenes.length}<label>Scene<select aria-label="Visible scene" value={sceneId} onchange={sceneChanged}>{#each result.scenes as scene}<option value={scene.id}>{scene.name || scene.id}</option>{/each}</select></label>{/if}
							<button type="button" onclick={downloadCapture} disabled={!ready}>Save view</button>
							<button type="button" class="primary" onclick={openModel} disabled={busy || !sourceFile}>{busy ? 'Opening…' : 'Open model file'}</button>
							<button type="button" onclick={() => sourceInput?.click()} disabled={busy}>Change artifact · {sourceFile?.name ?? 'choose file'}</button>
							<button type="button" onclick={() => provenanceInput?.click()} disabled={busy}>Choose sidecar for next model</button>
							{#if provenanceFile}<output>{provenanceFile.name}</output><button type="button" onclick={clearStagedProvenance} disabled={busy}>Remove sidecar</button>{/if}
							<button type="button" onclick={unload} disabled={busy}>Unload</button>
						</div>
					</details>
				</div>
				<details class="inspection-details" open={activeTool === 'move'}>
					<summary>{activeTool === 'move' ? 'Move controls' : 'Model and source details'}</summary>
					<div class="inspection-content">
						{#if activeTool === 'move'}
							<div class="move-controls" aria-label="Move transform controls">
								<div class="axis-controls" aria-label="Move axis constraint">
									<button type="button" class:chosen={moveAxis === 'x'} onclick={() => { moveAxis = moveAxis === 'x' ? null : 'x'; editorController?.setOccurrenceMoveAxis(moveAxis); refreshOccurrencePreview(); }}>X</button>
									<button type="button" class:chosen={moveAxis === 'y'} onclick={() => { moveAxis = moveAxis === 'y' ? null : 'y'; editorController?.setOccurrenceMoveAxis(moveAxis); refreshOccurrencePreview(); }}>Y</button>
									<button type="button" class:chosen={moveAxis === 'z'} onclick={() => { moveAxis = moveAxis === 'z' ? null : 'z'; editorController?.setOccurrenceMoveAxis(moveAxis); refreshOccurrencePreview(); }}>Z</button>
								</div>
								<label>Distance in metres<input type="number" step="0.01" value={moveDistanceText} oninput={(event) => { moveDistanceText = (event.currentTarget as HTMLInputElement).value; const distance = moveDistanceText === '' ? null : Number(moveDistanceText); editorController?.setOccurrenceMoveDistance(Number.isFinite(distance) ? distance : null); refreshOccurrencePreview(); }} /></label>
								<button type="button" class="primary" onclick={() => { editorController?.commitOccurrenceMove(); activeTool = 'select'; editorController?.setTool('select'); viewport?.setOccurrencePreview(null); editorNotice = 'Move committed to the Editor working transform. The imported BOMC bytes are unchanged.'; }}>Commit Move</button>
								<button type="button" onclick={() => { editorController?.cancel(); activeTool = 'select'; editorController?.setTool('select'); viewport?.setOccurrencePreview(null); editorNotice = 'Move canceled.'; }}>Cancel Move</button>
							</div>
						{/if}
						<h1>Model inspection</h1>
						<p>Imported BOMC bytes stay read-only. Move changes are held in this Editor session.</p>
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
					<p class="validation-note">Editor checks BOMC 1.2 structure and data integrity before loading. A matching source record is shown separately.</p>
				</div>
			</section>
			<aside class="guide" aria-label="Editor workflow">
				<p class="eyebrow">EDITOR WORKSPACE</p><h2>Inspect the model</h2>
				<p>Use the viewport to inspect the checked file and its available source evidence.</p>
				<ol class="workflow-steps"><li><strong>Choose one BOMC file</strong><span>A matching provenance JSON is optional.</span></li><li><strong>Open the model</strong><span>File structure and data integrity are checked before loading.</span></li><li><strong>Explore the view</strong><span>Change camera, scene, display mode, and inspect source geometry.</span></li></ol>
				<p class="note">The imported source stays read-only. Editor does not load Rooms or Benchmark sessions.</p>
			</aside>
		</div>
	{/if}
</main>
