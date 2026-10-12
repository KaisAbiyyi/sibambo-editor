/** Canonical lengths are metres. Explicit suffixes override the default metre unit. */
export function parseLength(text: string): number {
	const value = text.trim().toLowerCase();
	const imperial = value.match(/^([+-]?\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in)?)?$/);
	if (imperial) {
		const feet = Number(imperial[1]);
		return feet * 0.3048 + (feet < 0 ? -1 : 1) * Number(imperial[2] ?? 0) * 0.0254;
	}
	const match = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(mm|cm|m|in|ft|"|')?$/);
	if (!match) throw new Error('Enter a finite length, for example 250mm, 2.5m, 12in, or 5\' 6".');
	const scale: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048, '"': 0.0254, "'": 0.3048 };
	const result = Number(match[1]) * (scale[match[2] ?? 'm'] ?? 1);
	if (!Number.isFinite(result)) throw new Error('Length must be finite.');
	return result;
}
