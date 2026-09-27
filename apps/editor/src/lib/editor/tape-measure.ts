import { Vector3 } from 'three';

export type TapePhase = 'idle' | 'preview';

export class TapeMeasure {
	phase: TapePhase = 'idle';
	first: Vector3 | null = null;
	preview: Vector3 | null = null;

	click(point: Vector3) {
		if (!this.first) {
			this.first = point.clone();
			this.preview = point.clone();
			this.phase = 'preview';
			return null;
		}
		const measurement = { a: this.first.clone(), b: point.clone(), distanceM: this.first.distanceTo(point) };
		this.cancel();
		return measurement;
	}

	move(point: Vector3) { if (this.first) this.preview = point.clone(); }
	cancel() { this.phase = 'idle'; this.first = null; this.preview = null; }
	get distanceM() { return this.first && this.preview ? this.first.distanceTo(this.preview) : 0; }
}
export function formatTapeDistance(distanceM: number) {
	return distanceM < 1 ? `${(distanceM * 100).toFixed(1)} cm` : `${distanceM.toFixed(3)} m`;
}
