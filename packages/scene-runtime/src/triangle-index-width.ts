/** Choose an index buffer from the highest referenced vertex, not triangle count. */
export function triangleIndexArray(indices: ArrayLike<number>): Uint16Array | Uint32Array {
	let maximumReferencedVertex = 0;
	for (let index = 0; index < indices.length; index += 1) maximumReferencedVertex = Math.max(maximumReferencedVertex, indices[index]);
	return maximumReferencedVertex > 0xffff ? new Uint32Array(Array.from(indices)) : new Uint16Array(Array.from(indices));
}
