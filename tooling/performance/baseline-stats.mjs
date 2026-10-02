export function computePercentiles(
	durations,
	failedCount = 0,
	timeoutsCount = 0
) {
	if (!durations || durations.length === 0) {
		return {
			count: 0,
			p50: NaN,
			p95: NaN,
			min: NaN,
			max: NaN,
			mean: NaN,
			failedCount,
			timeoutsCount
		};
	}

	const sorted = [...durations].sort((a, b) => a - b);
	const n = sorted.length;

	// P50 = median (average middle pair if even)
	let p50;
	if (n % 2 === 1) {
		p50 = sorted[Math.floor(n / 2)];
	} else {
		p50 = (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
	}

	// P95 = nearest rank ceil(0.95 * n)
	const rankIndex = Math.max(0, Math.min(n - 1, Math.ceil(0.95 * n) - 1));
	const p95 = sorted[rankIndex];

	const min = sorted[0];
	const max = sorted[n - 1];
	const sum = sorted.reduce((acc, v) => acc + v, 0);
	const mean = sum / n;

	return {
		count: n,
		p50,
		p95,
		min,
		max,
		mean,
		failedCount,
		timeoutsCount
	};
}
