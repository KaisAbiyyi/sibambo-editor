export type Point3 = readonly [number, number, number];

export const MIN_AUTHORING_EDGE_METRES = 1e-6;

export class AuthoringPolygonError extends Error {
	constructor(message: string) { super(message); this.name = 'AuthoringPolygonError'; }
}

export type PreparedPolygon = Readonly<{
	points: readonly Point3[];
	normal: Point3;
	triangles: readonly number[];
}>;

type Point2 = readonly [number, number];

function finitePoint(point: Point3): boolean {
	return point.length === 3 && point.every(Number.isFinite);
}

function subtract(a: Point3, b: Point3): Point3 {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Point3, b: Point3): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Point3, b: Point3): Point3 {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0]
	];
}

function length(vector: Point3): number { return Math.hypot(vector[0], vector[1], vector[2]); }

function cleanZero(value: number): number { return value === 0 ? 0 : value; }

function normalize(vector: Point3): Point3 {
	const magnitude = length(vector);
	if (!Number.isFinite(magnitude) || magnitude < 1e-15) throw new AuthoringPolygonError('Polygon has zero area.');
	return [cleanZero(vector[0] / magnitude), cleanZero(vector[1] / magnitude), cleanZero(vector[2] / magnitude)];
}

function lexicographicPoint(left: Point3, right: Point3): number {
	for (let axis = 0; axis < 3; axis += 1) {
		if (left[axis] !== right[axis]) return left[axis] < right[axis] ? -1 : 1;
	}
	return 0;
}

function pointsEqual(left: Point3, right: Point3): boolean {
	return Object.is(left[0], right[0]) && Object.is(left[1], right[1]) && Object.is(left[2], right[2]);
}

function newell(points: readonly Point3[]): Point3 {
	let x = 0; let y = 0; let z = 0;
	for (let index = 0; index < points.length; index += 1) {
		const current = points[index]!;
		const next = points[(index + 1) % points.length]!;
		x += (current[1] - next[1]) * (current[2] + next[2]);
		y += (current[2] - next[2]) * (current[0] + next[0]);
		z += (current[0] - next[0]) * (current[1] + next[1]);
	}
	return [x, y, z];
}

function diagonal(points: readonly Point3[]): number {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const point of points) for (let axis = 0; axis < 3; axis += 1) {
		min[axis] = Math.min(min[axis]!, point[axis]);
		max[axis] = Math.max(max[axis]!, point[axis]);
	}
	return Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
}

function dominantProjection(normal: Point3): 0 | 1 | 2 {
	const values = normal.map(Math.abs);
	return values[0]! >= values[1]! && values[0]! >= values[2]! ? 0 : values[1]! >= values[2]! ? 1 : 2;
}

function project(point: Point3, drop: 0 | 1 | 2): Point2 {
	return drop === 0 ? [point[1], point[2]] : drop === 1 ? [point[0], point[2]] : [point[0], point[1]];
}

function orient2d(a: Point2, b: Point2, c: Point2): number {
	return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function signedArea(points: readonly Point2[]): number {
	let sum = 0;
	for (let index = 0; index < points.length; index += 1) {
		const a = points[index]!; const b = points[(index + 1) % points.length]!;
		sum += a[0] * b[1] - b[0] * a[1];
	}
	return sum / 2;
}

function onSegment(a: Point2, b: Point2, p: Point2, epsilon: number): boolean {
	return Math.abs(orient2d(a, b, p)) <= epsilon
		&& p[0] >= Math.min(a[0], b[0]) - epsilon && p[0] <= Math.max(a[0], b[0]) + epsilon
		&& p[1] >= Math.min(a[1], b[1]) - epsilon && p[1] <= Math.max(a[1], b[1]) + epsilon;
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2, epsilon: number): boolean {
	const abC = orient2d(a, b, c); const abD = orient2d(a, b, d);
	const cdA = orient2d(c, d, a); const cdB = orient2d(c, d, b);
	if (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
		&& ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) return true;
	return Math.abs(abC) <= epsilon && onSegment(a, b, c, epsilon)
		|| Math.abs(abD) <= epsilon && onSegment(a, b, d, epsilon)
		|| Math.abs(cdA) <= epsilon && onSegment(c, d, a, epsilon)
		|| Math.abs(cdB) <= epsilon && onSegment(c, d, b, epsilon);
}

function pointInTriangle(point: Point2, a: Point2, b: Point2, c: Point2, orientation: number, epsilon: number): boolean {
	const first = orient2d(a, b, point) * orientation;
	const second = orient2d(b, c, point) * orientation;
	const third = orient2d(c, a, point) * orientation;
	return first >= -epsilon && second >= -epsilon && third >= -epsilon;
}

function triangulate(projected: readonly Point2[]): number[] {
	const area = signedArea(projected);
	if (!Number.isFinite(area) || Math.abs(area) < 1e-18) throw new AuthoringPolygonError('Polygon has zero projected area.');
	const orientation = area > 0 ? 1 : -1;
	const scale = Math.max(1, ...projected.flatMap((point) => [Math.abs(point[0]), Math.abs(point[1])]));
	const epsilon = 1e-12 * scale * scale;
	const remaining = projected.map((_point, index) => index);
	const triangles: number[] = [];
	let guard = 0;
	while (remaining.length > 3) {
		let clipped = false;
		for (let slot = 0; slot < remaining.length; slot += 1) {
			const previous = remaining[(slot - 1 + remaining.length) % remaining.length]!;
			const current = remaining[slot]!;
			const next = remaining[(slot + 1) % remaining.length]!;
			if (orient2d(projected[previous]!, projected[current]!, projected[next]!) * orientation <= epsilon) continue;
			let contains = false;
			for (const candidate of remaining) {
				if (candidate === previous || candidate === current || candidate === next) continue;
				if (pointInTriangle(projected[candidate]!, projected[previous]!, projected[current]!, projected[next]!, orientation, epsilon)) {
					contains = true; break;
				}
			}
			if (contains) continue;
			triangles.push(previous, current, next);
			remaining.splice(slot, 1);
			clipped = true;
			break;
		}
		guard += 1;
		if (!clipped || guard > projected.length * projected.length) throw new AuthoringPolygonError('Polygon could not be triangulated deterministically.');
	}
	triangles.push(remaining[0]!, remaining[1]!, remaining[2]!);
	return triangles;
}

export function preparePolygon(
	input: readonly Point3[],
	preferredNormal?: Point3,
	options: { canonicalizeStart?: boolean } = {}
): PreparedPolygon {
	if (input.length < 3 || input.length > 256) throw new AuthoringPolygonError('Face loop must contain 3 to 256 vertices.');
	const points = input.map((point) => [point[0], point[1], point[2]] as Point3);
	if (points.some((point) => !finitePoint(point))) throw new AuthoringPolygonError('Face loop coordinates must be finite doubles.');
	for (let index = 0; index < points.length; index += 1) {
		const next = (index + 1) % points.length;
		if (length(subtract(points[index]!, points[next]!)) < MIN_AUTHORING_EDGE_METRES) throw new AuthoringPolygonError('Every face-loop edge must be at least 1e-6 metres.');
		for (let other = index + 1; other < points.length; other += 1) {
			if (pointsEqual(points[index]!, points[other]!)) throw new AuthoringPolygonError('Face loop contains a repeated vertex.');
		}
	}

	let normal = normalize(newell(points));
	if (preferredNormal !== undefined) {
		if (!finitePoint(preferredNormal) || length(preferredNormal) < 1e-12) throw new AuthoringPolygonError('Construction normal must be a finite nonzero vector.');
		const preferred = normalize(preferredNormal);
		if (dot(normal, preferred) < 0) { points.reverse(); normal = normalize([-normal[0], -normal[1], -normal[2]]); }
	} else {
		const dominant = dominantProjection(normal);
		if (normal[dominant] < 0) { points.reverse(); normal = normalize([-normal[0], -normal[1], -normal[2]]); }
	}

	const tolerance = 1e-9 * Math.max(1, diagonal(points));
	const anchor = points[0]!;
	for (const point of points) if (Math.abs(dot(subtract(point, anchor), normal)) > tolerance) {
		throw new AuthoringPolygonError('Face loop vertices are not coplanar within tolerance.');
	}

	if (options.canonicalizeStart !== false) {
		let first = 0;
		for (let index = 1; index < points.length; index += 1) if (lexicographicPoint(points[index]!, points[first]!) < 0) first = index;
		if (first > 0) points.push(...points.splice(0, first));
	}

	const drop = dominantProjection(normal);
	const projected = points.map((point) => project(point, drop));
	const scale = Math.max(1, diagonal(points));
	const intersectionEpsilon = 1e-12 * scale * scale;
	for (let first = 0; first < projected.length; first += 1) {
		const firstNext = (first + 1) % projected.length;
		for (let second = first + 1; second < projected.length; second += 1) {
			const secondNext = (second + 1) % projected.length;
			if (first === second || firstNext === second || secondNext === first) continue;
			if (segmentsIntersect(projected[first]!, projected[firstNext]!, projected[second]!, projected[secondNext]!, intersectionEpsilon)) {
				throw new AuthoringPolygonError('Face loop self-intersects.');
			}
		}
	}

	const triangles = triangulate(projected);
	return Object.freeze({ points: Object.freeze(points), normal: Object.freeze(normal), triangles: Object.freeze(triangles) });
}
