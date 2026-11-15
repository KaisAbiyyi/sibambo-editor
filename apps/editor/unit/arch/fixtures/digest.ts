import { createHash } from 'node:crypto';
import type { EvaluatedModule } from '../../../src/lib/arch/evaluate';

/** SHA-256 over every part's exported mesh (partId, positions, triangles, triTag) in partId order. */
export function exportDigest(evaluated: EvaluatedModule): string {
	const hash = createHash('sha256');
	for (const part of evaluated.parts) {
		hash.update(`${part.partId}\n`);
		for (const array of [part.mesh.positions, part.mesh.triangles, part.mesh.triTag])
			hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
	}
	return hash.digest('hex');
}
