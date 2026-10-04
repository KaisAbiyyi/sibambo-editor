import { resolvePointerNavigationAction, type CameraDragSnapshot, type NavigationTool } from './camera-navigation.js';

export type PreparedNavigationInputCallbacks = {
	beginCameraDrag(tool: NavigationTool): CameraDragSnapshot;
	dragCamera(tool: NavigationTool, start: CameraDragSnapshot, deltaX: number, deltaY: number, viewportHeight: number): void;
	endCameraDrag(): void;
	zoomAt(clientX: number, clientY: number, deltaPixels: number): void;
	getPrimaryTool(): NavigationTool;
	getViewportHeight(): number;
};

type PointerState = {
	id: number;
	type: string;
	x: number;
	y: number;
	buttons: number;
	shift: boolean;
	ctrl: boolean;
	meta: boolean;
	action: NavigationTool | null;
	snapshot: CameraDragSnapshot | null;
	startX: number;
	startY: number;
};

/** Owns camera-only pointer gestures for the prepared viewport. */
export class PreparedNavigationInput {
	private readonly document: Document;
	private readonly view: Window | null;
	private readonly pointers = new Map<number, PointerState>();
	private readonly capturedPointers = new Set<number>();
	private enabled = false;
	private disposed = false;
	private touchMode: 'none' | 'one' | 'pair' = 'none';
	private touchSnapshot: CameraDragSnapshot | null = null;
	private touchStartX = 0;
	private touchStartY = 0;
	private pairCenterX = 0;
	private pairCenterY = 0;
	private pairDistance = 0;
	private mousePointerId: number | null = null;

	constructor(private readonly canvas: HTMLCanvasElement, private readonly callbacks: PreparedNavigationInputCallbacks) {
		this.document = canvas.ownerDocument;
		this.view = this.document.defaultView;
		canvas.addEventListener('pointerdown', this.onPointerDown);
		this.document.addEventListener('pointermove', this.onPointerMove, true);
		this.document.addEventListener('pointerup', this.onPointerUp, true);
		this.document.addEventListener('pointercancel', this.onPointerCancel, true);
		this.document.addEventListener('lostpointercapture', this.onLostPointerCapture, true);
		this.view?.addEventListener('blur', this.onBlur);
	}

	setEnabled(enabled: boolean) {
		if (this.disposed) return;
		this.enabled = enabled;
		if (!enabled) this.cancel();
	}

	cancel() {
		if (this.touchMode === 'one' && this.touchSnapshot) this.callbacks.endCameraDrag();
		if (this.mousePointerId !== null) this.endMouseGesture(this.pointers.get(this.mousePointerId));
		this.touchSnapshot = null;
		this.touchMode = 'none';
		this.mousePointerId = null;
		for (const pointerId of [...this.pointers.keys()]) this.removePointer(pointerId, true);
		this.pointers.clear();
		this.resetPair();
	}

	dispose() {
		if (this.disposed) return;
		this.cancel();
		this.disposed = true;
		this.canvas.removeEventListener('pointerdown', this.onPointerDown);
		this.document.removeEventListener('pointermove', this.onPointerMove, true);
		this.document.removeEventListener('pointerup', this.onPointerUp, true);
		this.document.removeEventListener('pointercancel', this.onPointerCancel, true);
		this.document.removeEventListener('lostpointercapture', this.onLostPointerCapture, true);
		this.view?.removeEventListener('blur', this.onBlur);
	}

	private onPointerDown = (event: PointerEvent) => {
		if (!this.enabled || this.disposed || !this.isCanvasGestureTarget(event.target)) return;
		if (event.pointerType === 'touch') {
			if (this.mousePointerId !== null || this.pointers.has(event.pointerId) || this.touchPointers().length >= 2) return;
			const pointer: PointerState = {
				id: event.pointerId, type: 'touch', x: event.clientX, y: event.clientY, buttons: event.buttons,
				shift: false, ctrl: false, meta: false, action: null, snapshot: null, startX: event.clientX, startY: event.clientY
			};
			this.pointers.set(pointer.id, pointer);
			this.capture(pointer.id);
			if (this.touchPointers().length === 1) this.beginSingleTouch(pointer);
			else this.beginTouchPair();
			event.preventDefault();
			return;
		}
		if (event.pointerType !== 'mouse') return;
		if (this.touchPointers().length) return;
		if (this.mousePointerId !== null) {
			if (this.mousePointerId !== event.pointerId) return;
			const existing = this.pointers.get(event.pointerId);
			if (!existing) return;
			this.updatePointer(existing, event);
			this.updateMouseGesture(existing);
			if (existing.action) event.preventDefault();
			return;
		}
		const pointer: PointerState = {
			id: event.pointerId, type: 'mouse', x: event.clientX, y: event.clientY, buttons: event.buttons,
			shift: event.shiftKey, ctrl: event.ctrlKey, meta: event.metaKey, action: null, snapshot: null,
			startX: event.clientX, startY: event.clientY
		};
		const action = this.mouseAction(pointer);
		if (!action) return;
		this.pointers.set(pointer.id, pointer);
		this.mousePointerId = pointer.id;
		this.capture(pointer.id);
		this.updateMouseGesture(pointer);
		event.preventDefault();
	};

	private onPointerMove = (event: PointerEvent) => {
		if (!this.enabled || this.disposed) return;
		const pointer = this.pointers.get(event.pointerId);
		if (!pointer) return;
		this.updatePointer(pointer, event);
		if (pointer.type === 'mouse') {
			if (pointer.buttons === 0) { this.endMousePointer(pointer.id, false); return; }
			if (this.updateMouseGesture(pointer)) event.preventDefault();
			return;
		}
		this.moveTouchPointers();
		event.preventDefault();
	};

	private onPointerUp = (event: PointerEvent) => {
		const pointer = this.pointers.get(event.pointerId);
		if (!pointer) return;
		if (pointer.type === 'mouse') {
			this.updatePointer(pointer, event);
			if (pointer.buttons > 0) this.updateMouseGesture(pointer);
			else this.endMousePointer(pointer.id, true);
			return;
		}
		this.updatePointer(pointer, event);
		this.removePointer(pointer.id, true);
		this.reconcileTouchCount();
	};

	private onPointerCancel = (event: PointerEvent) => this.endPointer(event.pointerId);
	private onLostPointerCapture = (event: PointerEvent) => this.endPointer(event.pointerId);
	private onBlur = () => this.cancel();

	private updateMouseGesture(pointer: PointerState) {
		const nextAction = this.mouseAction(pointer);
		if (nextAction !== pointer.action) {
			this.endMouseGesture(pointer);
			pointer.action = nextAction;
			pointer.startX = pointer.x;
			pointer.startY = pointer.y;
			pointer.snapshot = nextAction ? this.callbacks.beginCameraDrag(nextAction) : null;
		}
		if (!pointer.action || !pointer.snapshot) return false;
		const deltaX = pointer.x - pointer.startX;
		const deltaY = pointer.y - pointer.startY;
		if (deltaX !== 0 || deltaY !== 0) this.callbacks.dragCamera(pointer.action, pointer.snapshot, deltaX, deltaY, this.callbacks.getViewportHeight());
		return true;
	}

	private mouseAction(pointer: PointerState): NavigationTool | null {
		const buttons = this.buttonSet(pointer.buttons);
		if (buttons.has(0) && (pointer.shift || pointer.ctrl || pointer.meta)) return 'pan';
		return resolvePointerNavigationAction(buttons, pointer.shift, this.callbacks.getPrimaryTool());
	}

	private beginSingleTouch(pointer: PointerState) {
		this.touchMode = 'one';
		this.touchStartX = pointer.x;
		this.touchStartY = pointer.y;
		this.touchSnapshot = this.callbacks.beginCameraDrag('orbit');
	}

	private beginTouchPair() {
		if (this.touchMode === 'one' && this.touchSnapshot) this.callbacks.endCameraDrag();
		this.touchSnapshot = null;
		this.touchMode = 'pair';
		this.setPairBaseline();
	}

	private moveTouchPointers() {
		const pointers = this.touchPointers();
		if (pointers.length === 1 && this.touchMode === 'one' && this.touchSnapshot) {
			const pointer = pointers[0]!;
			this.callbacks.dragCamera('orbit', this.touchSnapshot, pointer.x - this.touchStartX, pointer.y - this.touchStartY, this.callbacks.getViewportHeight());
			return;
		}
		if (pointers.length !== 2 || this.touchMode !== 'pair') return;
		const [first, second] = pointers;
		const centerX = (first!.x + second!.x) / 2;
		const centerY = (first!.y + second!.y) / 2;
		const distance = Math.hypot(first!.x - second!.x, first!.y - second!.y);
		const deltaX = centerX - this.pairCenterX;
		const deltaY = centerY - this.pairCenterY;
		if (deltaX !== 0 || deltaY !== 0) {
			const snapshot = this.callbacks.beginCameraDrag('pan');
			try { this.callbacks.dragCamera('pan', snapshot, deltaX, deltaY, this.callbacks.getViewportHeight()); }
			finally { this.callbacks.endCameraDrag(); }
		}
		if (distance > 0 && this.pairDistance > 0 && Number.isFinite(distance) && Number.isFinite(this.pairDistance)) {
			const delta = -Math.log(distance / this.pairDistance) * 1000;
			if (Number.isFinite(delta) && delta !== 0) this.callbacks.zoomAt(centerX, centerY, delta);
		}
		this.pairCenterX = centerX;
		this.pairCenterY = centerY;
		this.pairDistance = distance;
	}

	private reconcileTouchCount() {
		const pointers = this.touchPointers();
		if (pointers.length === 0) {
			if (this.touchMode === 'one' && this.touchSnapshot) this.callbacks.endCameraDrag();
			this.touchSnapshot = null;
			this.touchMode = 'none';
			this.resetPair();
		} else if (pointers.length === 1) {
			if (this.touchMode === 'one' && this.touchSnapshot) this.callbacks.endCameraDrag();
			this.beginSingleTouch(pointers[0]!);
		} else if (pointers.length === 2) this.beginTouchPair();
	}

	private endPointer(pointerId: number) {
		const pointer = this.pointers.get(pointerId);
		if (!pointer) return;
		if (pointer.type === 'mouse') this.endMousePointer(pointerId, true);
		else { this.removePointer(pointerId, true); this.reconcileTouchCount(); }
	}

	private endMousePointer(pointerId: number, release: boolean) {
		const pointer = this.pointers.get(pointerId);
		this.endMouseGesture(pointer);
		this.mousePointerId = null;
		this.removePointer(pointerId, release);
	}

	private endMouseGesture(pointer?: PointerState) {
		if (pointer?.snapshot) this.callbacks.endCameraDrag();
		if (pointer) { pointer.snapshot = null; pointer.action = null; }
	}

	private removePointer(pointerId: number, release: boolean) {
		this.pointers.delete(pointerId);
		if (release) this.release(pointerId);
	}

	private updatePointer(pointer: PointerState, event: PointerEvent) {
		pointer.x = event.clientX;
		pointer.y = event.clientY;
		pointer.buttons = event.buttons;
		pointer.shift = event.shiftKey;
		pointer.ctrl = event.ctrlKey;
		pointer.meta = event.metaKey;
	}

	private touchPointers() {
		return [...this.pointers.values()].filter((pointer) => pointer.type === 'touch').sort((a, b) => a.id - b.id);
	}

	private setPairBaseline() {
		const pointers = this.touchPointers();
		if (pointers.length !== 2) { this.resetPair(); return; }
		const [first, second] = pointers;
		this.pairCenterX = (first!.x + second!.x) / 2;
		this.pairCenterY = (first!.y + second!.y) / 2;
		this.pairDistance = Math.hypot(first!.x - second!.x, first!.y - second!.y);
	}

	private resetPair() {
		this.pairCenterX = 0;
		this.pairCenterY = 0;
		this.pairDistance = 0;
	}

	private buttonSet(buttons: number) {
		const active = new Set<number>();
		if (buttons & 1) active.add(0);
		if (buttons & 4) active.add(1);
		if (buttons & 2) active.add(2);
		return active;
	}

	private isCanvasGestureTarget(target: EventTarget | null) {
		if (!target || target === this.canvas) return true;
		const element = target as Element;
		if (typeof element.closest !== 'function') return false;
		return !element.closest('input,button,select,textarea,summary,a,[contenteditable="true"],canvas');
	}

	private capture(pointerId: number) {
		if (this.capturedPointers.has(pointerId)) return;
		try {
			this.canvas.setPointerCapture(pointerId);
			this.capturedPointers.add(pointerId);
		} catch { /* The browser may already have cancelled the pointer. */ }
	}

	private release(pointerId: number) {
		if (!this.capturedPointers.delete(pointerId)) return;
		try { this.canvas.releasePointerCapture(pointerId); } catch { /* Capture can be lost before pointerup. */ }
	}
}
