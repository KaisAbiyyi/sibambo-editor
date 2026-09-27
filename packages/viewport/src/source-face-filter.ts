export type ViewportIndexArray = Uint16Array | Uint32Array;
export type OccurrenceSourceFaces = { occurrenceHandle?: string; sourceFaceIndices: ReadonlySet<number> };

/** Keeps each selected face set paired with its source occurrence. */
export function partitionOccurrenceSourceFaces(references: readonly { sourceFaceIndex: number; occurrenceHandle?: string }[]): OccurrenceSourceFaces[] {
	const partitions = new Map<string, Set<number>>();
	for (const reference of references) {
		const key = reference.occurrenceHandle ?? '*';
		const faces = partitions.get(key) ?? new Set<number>();
		faces.add(reference.sourceFaceIndex);
		partitions.set(key, faces);
	}
	return [...partitions].map(([key, sourceFaceIndices]) => ({ occurrenceHandle: key === '*' ? undefined : key, sourceFaceIndices }));
}

/** Resolves the hit triangle from this rendered mesh record, including solid-triangle remaps. */
export function resolveSourceFaceIndex(
	renderedTriangleIndex: number | null,
	sourceFaceIndicesByTriangle: Uint32Array | undefined,
	renderedToSourceTriangleIndices?: Uint32Array
): number | null {
	if (renderedTriangleIndex === null || !sourceFaceIndicesByTriangle) return null;
	const sourceTriangle = renderedToSourceTriangleIndices?.[renderedTriangleIndex] ?? renderedTriangleIndex;
	return Number.isInteger(sourceTriangle) && sourceTriangle >= 0 ? sourceFaceIndicesByTriangle[sourceTriangle] ?? null : null;
}

/**
 * Selects complete triangles by their preserved source-face attribution.
 * A missing or misaligned attribution map fails closed whenever a filter is active.
 */
export function filterTrianglesBySourceFaces<T extends ViewportIndexArray>(
	indices: T,
	sourceFaceIndicesByTriangle: Uint32Array | undefined,
	visibleSourceFaces: ReadonlySet<number> | null
): T {
	if (visibleSourceFaces === null) return indices;
	const triangleCount = indices.length / 3;
	if (!Number.isInteger(triangleCount)) throw new Error('Viewport triangle indices must be grouped in triples.');
	if (!sourceFaceIndicesByTriangle) return indices.slice(0, 0) as T;
	if (sourceFaceIndicesByTriangle.length !== triangleCount) {
		throw new Error('Viewport source face map must contain one attribution per triangle.');
	}
	const selected: number[] = [];
	for (let triangle = 0; triangle < triangleCount; triangle += 1) {
		if (!visibleSourceFaces.has(sourceFaceIndicesByTriangle[triangle])) continue;
		const offset = triangle * 3;
		selected.push(indices[offset], indices[offset + 1], indices[offset + 2]);
	}
	return (indices instanceof Uint16Array ? Uint16Array.from(selected) : Uint32Array.from(selected)) as T;
}
