export function assertBomcCount(count: number, label: string) {
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new Error(`BOMC invalid: ${label} count is not a non-negative safe integer.`);
	}
	return count;
}

export function assertExpectedBomcCount(count: number, expected: number | undefined, label: string) {
	if (expected !== undefined && count !== expected) throw new Error(`BOMC invalid: ${label} count ${count} does not match the model count ${expected}.`);
	return count;
}

export function assertBomcArrayBytes(count: number, components: number, bytesPerValue: number, label: string) {
	const values = count * components;
	const bytes = values * bytesPerValue;
	if (!Number.isSafeInteger(values) || !Number.isSafeInteger(bytes)) {
		throw new Error(`BOMC invalid: ${label} array size exceeds the JavaScript safe integer range.`);
	}
	return values;
}

export class BomcBinaryReader {
	readonly bytes: Uint8Array;
	readonly view: DataView;
	offset: number;

	constructor(source: ArrayBuffer | Uint8Array, offset = 0, length?: number) {
		this.bytes = source instanceof Uint8Array
			? new Uint8Array(source.buffer, source.byteOffset + offset, length ?? source.byteLength - offset)
			: new Uint8Array(source, offset, length ?? source.byteLength - offset);
		this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
		this.offset = 0;
	}

	get remaining() { return this.bytes.byteLength - this.offset; }

	private ensure(length: number, label = 'binary data') {
		if (!Number.isInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) {
			throw new Error(`BOMC invalid: truncated ${label}.`);
		}
	}

	readBytes(length: number, label?: string) {
		this.ensure(length, label);
		const result = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return result;
	}

	readUint8() { this.ensure(1); return this.view.getUint8(this.offset++); }
	readInt16() { this.ensure(2); const value = this.view.getInt16(this.offset, true); this.offset += 2; return value; }
	readUint16() { this.ensure(2); const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
	readInt32() { this.ensure(4); const value = this.view.getInt32(this.offset, true); this.offset += 4; return value; }
	readUint32() { this.ensure(4); const value = this.view.getUint32(this.offset, true); this.offset += 4; return value; }
	readFloat32() { this.ensure(4); const value = this.view.getFloat32(this.offset, true); this.offset += 4; return value; }
	readFloat64() { this.ensure(8); const value = this.view.getFloat64(this.offset, true); this.offset += 8; return value; }
	readUint64(label = 'uint64') {
		this.ensure(8, label);
		const value = this.view.getBigUint64(this.offset, true);
		this.offset += 8;
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`BOMC invalid: ${label} exceeds JavaScript safe range.`);
		return Number(value);
	}

	readCount(label: string) {
		return assertBomcCount(this.readUint32(), label);
	}

	readVaruintCount(label: string) {
		return assertBomcCount(this.readVaruint(), label);
	}

	assertRemainingCount(count: number, minimumBytesPerEntry: number, label: string) {
		assertBomcCount(count, label);
		const requiredBytes = count * minimumBytesPerEntry;
		if (!Number.isSafeInteger(minimumBytesPerEntry) || minimumBytesPerEntry < 0 || !Number.isSafeInteger(requiredBytes) || requiredBytes > this.remaining) {
			throw new Error(`BOMC invalid: ${label} count exceeds the remaining section data.`);
		}
	}

	readVaruint() {
		let value = 0;
		let factor = 1;
		for (let byteIndex = 0; byteIndex < 10; byteIndex += 1) {
			if (!this.remaining) throw new Error('BOMC invalid: truncated varint.');
			const byte = this.readUint8();
			value += (byte & 0x7f) * factor;
			if (!Number.isSafeInteger(value)) throw new Error('BOMC invalid: varint overflow.');
			if ((byte & 0x80) === 0) return value;
			factor *= 128;
		}
		throw new Error('BOMC invalid: varint overflow.');
	}

	readZigZag() {
		const encoded = this.readVaruint();
		return encoded % 2 === 0 ? encoded / 2 : -((encoded + 1) / 2);
	}

	readIndices(width: number, count: number, required = false) {
		if (width !== 1 && width !== 2 && width !== 4) throw new Error(`BOMC invalid: adaptive-width code ${width}.`);
		assertBomcCount(count, 'adaptive reference');
		const encodedBytes = count * width;
		if (!Number.isSafeInteger(encodedBytes) || encodedBytes > this.remaining) throw new Error('BOMC invalid: adaptive reference count exceeds the remaining section data.');
		const sentinel = width === 1 ? 0xff : width === 2 ? 0xffff : 0xffffffff;
		const result = new Uint32Array(count);
		const present = new Uint8Array(count);
		for (let index = 0; index < count; index += 1) {
			const value = width === 1 ? this.readUint8() : width === 2 ? this.readUint16() : this.readUint32();
			if (value === sentinel) {
				if (required) throw new Error('BOMC invalid: required adaptive reference is missing.');
				result[index] = 0xffffffff;
			} else {
				result[index] = value;
				present[index] = 1;
			}
		}
		return { values: result, present };
	}

	finish(label = 'table section') {
		if (this.remaining !== 0) throw new Error(`BOMC invalid: trailing ${label} bytes.`);
	}
}

export function readFixedArray(bytes: Uint8Array, kind: 'u8' | 'u16' | 'u32' | 'i16' | 'i32' | 'f32' | 'f64', count: number) {
	const reader = new BomcBinaryReader(bytes);
	assertBomcCount(count, 'fixed array');
	const bytesPerValue = kind === 'u8' ? 1 : kind === 'u16' || kind === 'i16' ? 2 : kind === 'f64' ? 8 : 4;
	const expectedBytes = count * bytesPerValue;
	assertBomcArrayBytes(count, 1, bytesPerValue, 'fixed array');
	if (expectedBytes !== reader.remaining) throw new Error('BOMC invalid: fixed array byte count.');
	const output = kind === 'u8' ? new Uint8Array(count)
		: kind === 'u16' ? new Uint16Array(count)
		: kind === 'u32' ? new Uint32Array(count)
		: kind === 'i16' ? new Int16Array(count)
		: kind === 'i32' ? new Int32Array(count)
		: kind === 'f32' ? new Float32Array(count)
		: new Float64Array(count);
	for (let index = 0; index < count; index += 1) {
		output[index] = (kind === 'u8' ? reader.readUint8()
			: kind === 'u16' ? reader.readUint16()
			: kind === 'u32' ? reader.readUint32()
			: kind === 'i16' ? reader.readInt16()
			: kind === 'i32' ? reader.readInt32()
			: kind === 'f32' ? reader.readFloat32()
			: reader.readFloat64()) as never;
	}
	reader.finish('fixed array');
	return output;
}
