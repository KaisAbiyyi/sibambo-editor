import { assertBomcArrayBytes, assertExpectedBomcCount, BomcBinaryReader } from './binary-reader';

export function decodePositionBlock(block: Uint8Array, expectedCount?: number) {
	if (block.byteLength < 60) throw new Error('BOMC invalid: truncated position block.');
	const reader = new BomcBinaryReader(block);
	if (reader.readUint8() !== 1) throw new Error('BOMC invalid: position block version.');
	const codec = reader.readUint8();
	if (reader.readUint16() !== 0) throw new Error('BOMC invalid: position block reserved fields.');
	const count = reader.readCount('position');
	assertExpectedBomcCount(count, expectedCount, 'position');
	const payloadLength = reader.readUint32();
	const origin = [reader.readFloat64(), reader.readFloat64(), reader.readFloat64()];
	const scale = [reader.readFloat64(), reader.readFloat64(), reader.readFloat64()];
	if (reader.remaining !== payloadLength) throw new Error('BOMC invalid: position block byte count.');
	if (![1, 2, 3, 4, 5].includes(codec)) throw new Error(`BOMC invalid: unsupported position codec ${codec}.`);
	const valueCount = assertBomcArrayBytes(count, 3, 4, 'positions');
	const positionBytesByCodec: Record<number, number> = { 1: valueCount * 8, 2: valueCount * 4, 3: valueCount * 4, 4: valueCount * 2 };
	if (codec in positionBytesByCodec && payloadLength !== positionBytesByCodec[codec]) throw new Error('BOMC invalid: position codec payload size.');
	if (codec === 5 && payloadLength < valueCount) throw new Error('BOMC invalid: position codec payload is truncated.');
	const payload = new BomcBinaryReader(reader.readBytes(payloadLength, 'position payload'));
	const result = new Float32Array(valueCount);
	let previous = 0;
	for (let index = 0; index < result.length; index += 1) {
		const axis = index % 3;
		if (codec === 1) result[index] = payload.readFloat64();
		else if (codec === 2) result[index] = origin[axis] + payload.readFloat32();
		else if (codec === 3) result[index] = origin[axis] + payload.readInt32() * scale[axis];
		else if (codec === 4) result[index] = origin[axis] + payload.readInt16() * scale[axis];
		else if (codec === 5) {
			previous += payload.readZigZag();
			result[index] = origin[axis] + previous * scale[axis];
		} else throw new Error(`BOMC invalid: unsupported position codec ${codec}.`);
		if (!Number.isFinite(result[index])) throw new Error('BOMC invalid: non-finite position value.');
	}
	payload.finish('position payload');
	return { codec, positions: result };
}

export function decodeTopologyBlock(block: Uint8Array, expectedLoopCount?: number, expectedTriangleCount?: number) {
	if (block.byteLength < 20) throw new Error('BOMC invalid: truncated topology block.');
	const reader = new BomcBinaryReader(block);
	if (reader.readUint8() !== 1 || reader.readUint8() !== 0 || reader.readUint8() !== 0 || reader.readUint8() !== 0) {
		throw new Error('BOMC invalid: topology block header.');
	}
	const loopCount = reader.readCount('topology loop');
	const triangleCount = reader.readCount('topology triangle');
	assertExpectedBomcCount(loopCount, expectedLoopCount, 'topology loop');
	assertExpectedBomcCount(triangleCount, expectedTriangleCount, 'topology triangle');
	const loopLength = reader.readUint32();
	const triangleLength = reader.readUint32();
	if (reader.remaining !== loopLength + triangleLength) throw new Error('BOMC invalid: topology block byte count.');
	if (loopCount > loopLength || triangleCount > triangleLength) throw new Error('BOMC invalid: topology count exceeds encoded payload.');
	const loops = decodeDeltaIndices(reader.readBytes(loopLength), loopCount);
	const triangles = decodeDeltaIndices(reader.readBytes(triangleLength), triangleCount);
	return { loops, triangles };
}

function decodeDeltaIndices(bytes: Uint8Array, count: number) {
	if (count > bytes.byteLength) throw new Error('BOMC invalid: topology count exceeds encoded payload.');
	const checkedCount = assertBomcArrayBytes(count, 1, 4, 'topology indices');
	const reader = new BomcBinaryReader(bytes);
	const values = new Uint32Array(checkedCount);
	let previous = 0;
	for (let index = 0; index < count; index += 1) {
		previous += reader.readZigZag();
		if (previous < 0 || !Number.isSafeInteger(previous)) throw new Error('BOMC invalid: topology index is negative or invalid.');
		values[index] = previous;
	}
	reader.finish('topology');
	return values;
}

export function decodeNormalSection(bytes: Uint8Array, expectedCount?: number) {
	const { codec, count, payload } = decodeGenericCodecHeader(bytes, 'normal');
	assertExpectedBomcCount(count, expectedCount, 'normal');
	const reader = new BomcBinaryReader(payload);
	const valueCount = assertBomcArrayBytes(count, 3, 4, 'normals');
	const bytesPerNormal = codec === 1 ? 12 : codec === 2 ? 4 : codec === 3 ? 24 : undefined;
	if (bytesPerNormal === undefined || reader.remaining !== count * bytesPerNormal) throw new Error('BOMC invalid: normal codec payload size.');
	const values = new Float32Array(valueCount);
	if (codec === 1) {
		for (let index = 0; index < values.length; index += 1) values[index] = reader.readFloat32();
	} else if (codec === 2) {
		for (let index = 0; index < count; index += 1) {
			const packedX = reader.readInt16();
			const packedY = reader.readInt16();
			if (packedX === -32768 && packedY === -32768) continue;
			let x = packedX / 32767;
			let y = packedY / 32767;
			let z = 1 - Math.abs(x) - Math.abs(y);
			if (z < 0) {
				const oldX = x;
				x = (1 - Math.abs(y)) * (oldX < 0 ? -1 : 1);
				y = (1 - Math.abs(oldX)) * (y < 0 ? -1 : 1);
			}
			const length = Math.hypot(x, y, z) || 1;
			values[index * 3] = x / length;
			values[index * 3 + 1] = y / length;
			values[index * 3 + 2] = z / length;
		}
	} else if (codec === 3) {
		for (let index = 0; index < values.length; index += 1) values[index] = reader.readFloat64();
	} else throw new Error(`BOMC invalid: unsupported normal codec ${codec}.`);
	for (const value of values) if (!Number.isFinite(value)) throw new Error('BOMC invalid: non-finite normal value.');
	reader.finish('normal payload');
	return { codec, normals: values };
}

export function decodeUvBlock(block: Uint8Array, expectedCount?: number) {
	if (block.byteLength < 44) throw new Error('BOMC invalid: truncated UV block.');
	const reader = new BomcBinaryReader(block);
	if (reader.readUint8() !== 1) throw new Error('BOMC invalid: UV block version.');
	const codec = reader.readUint8();
	if (reader.readUint16() !== 0) throw new Error('BOMC invalid: UV block reserved fields.');
	const count = reader.readCount('UV');
	assertExpectedBomcCount(count, expectedCount, 'UV');
	const payloadLength = reader.readUint32();
	const origin = [reader.readFloat64(), reader.readFloat64()];
	const scale = [reader.readFloat64(), reader.readFloat64()];
	if (reader.remaining !== payloadLength) throw new Error('BOMC invalid: UV block byte count.');
	if (![1, 2, 3, 4, 5].includes(codec)) throw new Error(`BOMC invalid: unsupported UV codec ${codec}.`);
	const valueCount = assertBomcArrayBytes(count, 2, 4, 'UVs');
	const bytesPerUv = codec === 1 ? 8 : codec === 2 || codec === 3 ? 4 : codec === 4 ? undefined : codec === 5 ? 16 : undefined;
	if (bytesPerUv !== undefined && payloadLength !== count * bytesPerUv) throw new Error('BOMC invalid: UV codec payload size.');
	if (codec === 4 && payloadLength < valueCount) throw new Error('BOMC invalid: UV codec payload is truncated.');
	const payload = new BomcBinaryReader(reader.readBytes(payloadLength));
	const values = new Float32Array(valueCount);
	let previous = 0;
	for (let index = 0; index < values.length; index += 1) {
		const axis = index % 2;
		if (codec === 1) values[index] = payload.readFloat32();
		else if (codec === 2) values[index] = halfToFloat(payload.readUint16());
		else if (codec === 3) values[index] = origin[axis] + payload.readInt16() * scale[axis];
		else if (codec === 4) {
			previous += payload.readZigZag();
			values[index] = origin[axis] + previous * scale[axis];
		} else if (codec === 5) values[index] = payload.readFloat64();
		else throw new Error(`BOMC invalid: unsupported UV codec ${codec}.`);
		if (!Number.isFinite(values[index])) throw new Error('BOMC invalid: non-finite UV value.');
	}
	payload.finish('UV payload');
	return { codec, uvs: values };
}

export function decodeTransformSection(bytes: Uint8Array, expectedCount?: number) {
	const { codec, count, payload } = decodeGenericCodecHeader(bytes, 'transform');
	assertExpectedBomcCount(count, expectedCount, 'transform');
	const reader = new BomcBinaryReader(payload);
	const valueCount = assertBomcArrayBytes(count, 16, 8, 'transforms');
	const bytesBySubtype: Record<number, number> = { 0: 0, 1: 96, 2: 48, 3: 40, 4: 32, 6: 128 };
	if (codec === 5) {
		const preflight = new BomcBinaryReader(payload);
		for (let index = 0; index < count; index += 1) {
			const subtype = preflight.readUint8();
			const byteLength = bytesBySubtype[subtype];
			if (byteLength === undefined) throw new Error(`BOMC invalid: hybrid transform subtype ${subtype}.`);
			preflight.readBytes(byteLength, `hybrid transform ${index} payload`);
		}
		preflight.finish('hybrid transform payload');
	} else {
		const byteLength = bytesBySubtype[codec];
		if (byteLength === undefined || count * byteLength !== reader.remaining) {
			throw new Error('BOMC invalid: transform codec payload size.');
		}
	}
	const transforms = new Float64Array(valueCount);
	for (let index = 0; index < count; index += 1) {
		const subtype = codec === 5 ? reader.readUint8() : codec;
		let matrix: number[];
		if (subtype === 0) matrix = identityMatrix();
		else if (subtype === 1 || subtype === 2) {
			const affine = new Array<number>(12);
			for (let component = 0; component < 12; component += 1) affine[component] = subtype === 1 ? reader.readFloat64() : reader.readFloat32();
			matrix = restoreAffine(affine);
		} else if (subtype === 3) {
			const translation = [reader.readFloat32(), reader.readFloat32(), reader.readFloat32()];
			const quaternion = [reader.readFloat32(), reader.readFloat32(), reader.readFloat32(), reader.readFloat32()];
			const scale = [reader.readFloat32(), reader.readFloat32(), reader.readFloat32()];
			matrix = composeTransform(translation, quaternion, scale);
		} else if (subtype === 4) {
			const translation = [reader.readFloat32(), reader.readFloat32(), reader.readFloat32()];
			const quaternion = [reader.readInt16() / 32767, reader.readInt16() / 32767, reader.readInt16() / 32767, reader.readInt16() / 32767];
			const scale = [reader.readFloat32(), reader.readFloat32(), reader.readFloat32()];
			matrix = composeTransform(translation, quaternion, scale);
		} else if (subtype === 6) {
			matrix = new Array<number>(16);
			for (let component = 0; component < 16; component += 1) matrix[component] = reader.readFloat64();
		} else throw new Error(`BOMC invalid: ${codec === 5 ? 'hybrid transform subtype' : 'unsupported transform codec'} ${subtype}.`);
		if (!matrix.every(Number.isFinite)) throw new Error(`BOMC invalid: transform ${index} contains a non-finite value.`);
		transforms.set(matrix, index * 16);
	}
	reader.finish('transform payload');
	return { codec, transforms };
}

function decodeGenericCodecHeader(bytes: Uint8Array, label: string) {
	if (bytes.byteLength < 12) throw new Error(`BOMC invalid: truncated ${label} section.`);
	const reader = new BomcBinaryReader(bytes);
	if (reader.readUint8() !== 1) throw new Error(`BOMC invalid: ${label} section version.`);
	const codec = reader.readUint8();
	if (reader.readUint16() !== 0) throw new Error(`BOMC invalid: ${label} section reserved fields.`);
	const count = reader.readCount(`${label}`);
	const payloadLength = reader.readUint32();
	if (reader.remaining !== payloadLength) throw new Error(`BOMC invalid: ${label} section byte count.`);
	return { codec, count, payload: reader.readBytes(payloadLength) };
}

function restoreAffine(values: number[]) {
	const matrix = identityMatrix();
	const indices = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14];
	for (let index = 0; index < indices.length; index += 1) matrix[indices[index]] = values[index];
	return matrix;
}

function identityMatrix() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }

function composeTransform(translation: number[], quaternion: number[], scale: number[]) {
	let [x, y, z, w] = quaternion;
	const length = Math.hypot(x, y, z, w) || 1;
	x /= length; y /= length; z /= length; w /= length;
	const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
	return restoreAffine([
		(1 - 2 * (yy + zz)) * scale[0], (2 * (xy + wz)) * scale[0], (2 * (xz - wy)) * scale[0],
		(2 * (xy - wz)) * scale[1], (1 - 2 * (xx + zz)) * scale[1], (2 * (yz + wx)) * scale[1],
		(2 * (xz + wy)) * scale[2], (2 * (yz - wx)) * scale[2], (1 - 2 * (xx + yy)) * scale[2],
		translation[0], translation[1], translation[2]
	]);
}

export function halfToFloat(value: number) {
	const sign = value & 0x8000 ? -1 : 1;
	const exponent = (value >> 10) & 0x1f;
	const fraction = value & 0x03ff;
	if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
	if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
	return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}
