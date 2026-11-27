/**
 * SIB-MCP-MODELING-001 v2.0 WP1 / E-K1 evidence probe (manifold-3d@3.5.5).
 *
 * Pure function over an initialised manifold-3d module so the same code runs in
 * Bun (unit test) and in a Chromium worker (scratch Vite harness). It records
 * the API names actually used, mesh export precision, double-precision vertex
 * access through warpBatch, original-ID tracking, slicing, 2D union/area and a
 * determinism fingerprint per case. Evidence only: not product code.
 */

type Wasm = any;

export type CaseReceipt = {
	name: string;
	numVert: number;
	numTri: number;
	volume: number;
	float32Sha256: string;
	triSha256: string;
	float64RoundedSha256: string;
	float64MatchesFloat32Order: boolean;
	maxFloat32Error: number;
	runOriginalIds: number[];
	trianglesPerRun: number[];
	faceIdCount: number;
};

export type ProbeReceipt = {
	manifoldExports: string[];
	api: Record<string, boolean>;
	vertPropertiesType: string;
	cases: CaseReceipt[];
	slice: { polygons: number; area: number };
	crossSection: { unionArea: number };
	timingsMs: { room: number[]; roomMedian: number };
};

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesOf(view: ArrayBufferView): Uint8Array {
	return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

const square = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function prism(wasm: Wasm, ring: number[][], z0: number, z1: number) {
	const { Manifold, CrossSection } = wasm;
	const section = CrossSection.ofPolygons([ring]);
	const raw = Manifold.extrude(section, z1 - z0);
	const moved = raw.translate([0, 0, z0]);
	section.delete();
	raw.delete();
	return moved;
}

function roomUnion(wasm: Wasm) {
	const { Manifold } = wasm;
	const t = 0.15, h = 2.7, half = t / 2;
	const walls = [
		square(-half, -half, 4 + half, half),
		square(4 - half, -half, 4 + half, 3 + half),
		square(-half, 3 - half, 4 + half, 3 + half),
		square(-half, -half, half, 3 + half)
	].map((ring) => prism(wasm, ring, 0, h).asOriginal());
	const union = Manifold.union(walls);
	const door = prism(wasm, square(1.0, -half - 0.01, 1.9, half + 0.01), 0, 2.1).asOriginal();
	const result = Manifold.difference([union, door]);
	for (const item of [...walls, union, door]) item.delete();
	return result;
}

async function describe(wasm: Wasm, name: string, solid: any): Promise<CaseReceipt> {
	const mesh = solid.getMesh();
	const f32: Float32Array = mesh.vertProperties;
	const numProp: number = mesh.numProp;
	const tris: Uint32Array = mesh.triVerts;
	let doubles: Float64Array | null = null;
	const copy = solid.warpBatch((verts: Float64Array, count: number) => {
		doubles = new Float64Array(verts.subarray(0, count * 3));
	});
	copy.delete();
	let matches = doubles !== null && (doubles as Float64Array).length / 3 === f32.length / numProp;
	let maxError = 0;
	const rounded = new Float64Array(doubles ? (doubles as Float64Array).length : 0);
	if (doubles) {
		const d = doubles as Float64Array;
		for (let v = 0; v < d.length / 3; v++) {
			for (let k = 0; k < 3; k++) {
				const value = d[v * 3 + k]!;
				rounded[v * 3 + k] = Math.round(value * 1e6) / 1e6 + 0;
				const single = f32[v * numProp + k];
				if (single === undefined || Math.fround(value) !== single) matches = false;
				else maxError = Math.max(maxError, Math.abs(single - value));
			}
		}
	}
	const runIndex: Uint32Array | undefined = mesh.runIndex;
	const runIds: Uint32Array | undefined = mesh.runOriginalID;
	const trianglesPerRun: number[] = [];
	if (runIndex && runIds) for (let r = 0; r < runIds.length; r++) trianglesPerRun.push((runIndex[r + 1]! - runIndex[r]!) / 3);
	const receipt: CaseReceipt = {
		name,
		numVert: solid.numVert(),
		numTri: solid.numTri(),
		volume: Math.round(solid.volume() * 1e9) / 1e9,
		float32Sha256: await sha256(bytesOf(f32)),
		triSha256: await sha256(bytesOf(tris)),
		float64RoundedSha256: await sha256(bytesOf(rounded)),
		float64MatchesFloat32Order: matches,
		maxFloat32Error: maxError,
		runOriginalIds: runIds ? [...runIds] : [],
		trianglesPerRun,
		faceIdCount: mesh.faceID ? new Set(mesh.faceID as Uint32Array).size : -1
	};
	return receipt;
}

export async function runProbe(wasm: Wasm): Promise<ProbeReceipt> {
	const { Manifold, CrossSection } = wasm;
	const api: Record<string, boolean> = {
		'CrossSection.ofPolygons': typeof CrossSection.ofPolygons === 'function',
		'CrossSection.union(list)': typeof CrossSection.union === 'function',
		'CrossSection#area': typeof CrossSection.prototype.area === 'function',
		'CrossSection#toPolygons': typeof CrossSection.prototype.toPolygons === 'function',
		'Manifold.extrude': typeof Manifold.extrude === 'function',
		'Manifold.union(list)': typeof Manifold.union === 'function',
		'Manifold.difference(list)': typeof Manifold.difference === 'function',
		'Manifold#asOriginal': typeof Manifold.prototype.asOriginal === 'function',
		'Manifold#originalID': typeof Manifold.prototype.originalID === 'function',
		'Manifold#getMesh': typeof Manifold.prototype.getMesh === 'function',
		'Manifold#warpBatch': typeof Manifold.prototype.warpBatch === 'function',
		'Manifold#slice': typeof Manifold.prototype.slice === 'function',
		'Manifold#delete': typeof Manifold.prototype.delete === 'function',
		'Manifold.levelSet': typeof Manifold.levelSet === 'function',
		'Manifold#minGap': typeof Manifold.prototype.minGap === 'function'
	};

	const cases: CaseReceipt[] = [];
	{
		const a = prism(wasm, square(0, 0, 1, 1), 0, 1).asOriginal();
		const b = prism(wasm, square(1, 0, 2, 1), 0, 1).asOriginal();
		const u = Manifold.union([a, b]);
		cases.push(await describe(wasm, 'two-touching-prisms', u));
		for (const item of [a, b, u]) item.delete();
	}
	{
		const big = Manifold.cube([2, 2, 2], true).asOriginal();
		const small = Manifold.cube([1, 1, 1], false).asOriginal();
		const d = Manifold.difference([big, small]);
		cases.push(await describe(wasm, 'box-minus-box', d));
		for (const item of [big, small, d]) item.delete();
	}
	const room = roomUnion(wasm);
	cases.push(await describe(wasm, 'four-wall-room-with-door', room));
	const sliced = room.slice(1.2);
	const slice = { polygons: sliced.toPolygons().length, area: Math.round(sliced.area() * 1e9) / 1e9 };
	sliced.delete();
	room.delete();

	const s1 = CrossSection.ofPolygons([square(0, 0, 2, 1)]);
	const s2 = CrossSection.ofPolygons([square(1, 0, 3, 1)]);
	const su = CrossSection.union([s1, s2]);
	const crossSection = { unionArea: su.area() };
	for (const item of [s1, s2, su]) item.delete();

	const room0 = roomUnion(wasm); room0.delete(); // warm-up
	const timings: number[] = [];
	for (let i = 0; i < 10; i++) {
		const t0 = performance.now();
		const r = roomUnion(wasm);
		r.getMesh();
		r.delete();
		timings.push(Math.round((performance.now() - t0) * 1000) / 1000);
	}
	const sorted = [...timings].sort((x, y) => x - y);
	const probeMesh = Manifold.cube(1);
	const vertPropertiesType = probeMesh.getMesh().vertProperties.constructor.name;
	probeMesh.delete();
	return {
		manifoldExports: Object.keys(wasm).filter((k) => /^[A-Z]/.test(k)).sort(),
		api,
		vertPropertiesType,
		cases,
		slice,
		crossSection,
		timingsMs: { room: timings, roomMedian: (sorted[4]! + sorted[5]!) / 2 }
	};
}
