import { BomcBinaryReader } from './binary-reader';
import {
	BOMC_COMPACT_DIRECTORY,
	BOMC_ENDIAN_MARKER,
	BOMC_MAGIC,
	type BomcHeader,
	type BomcSectionDescriptor,
	type BomcSectionMetric
} from './types';

const HEADER_BYTES = 32;
const ALIGNMENT = 8;
// Conservative parser policy while E4 is still pending cross-model corpus validation.
export const BOMC_RESOURCE_LIMITS = Object.freeze({
	maxInputBytes: 256 * 1024 * 1024,
	maxSections: 128,
	maxSectionRawBytes: 128 * 1024 * 1024,
	maxTotalRawBytes: 512 * 1024 * 1024
});

export type BomcResourceLimits = {
	maxInputBytes: number;
	maxSections: number;
	maxSectionRawBytes: number;
	maxTotalRawBytes: number;
};

export function isBomcBuffer(buffer: ArrayBuffer | Uint8Array) {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	return bytes.byteLength >= BOMC_MAGIC.length && BOMC_MAGIC.every((value, index) => bytes[index] === value);
}

export class BomcContainer {
	readonly buffer: ArrayBuffer;
	readonly bytes: Uint8Array;
	readonly header: BomcHeader;
	readonly sections = new Map<number, BomcSectionDescriptor>();
	readonly metrics: BomcSectionMetric[] = [];
	readonly headerMs: number;
	readonly directoryMs: number;
	private decoded = new Map<number, Uint8Array>();

	constructor(buffer: ArrayBuffer, private readonly limits: BomcResourceLimits = BOMC_RESOURCE_LIMITS) {
		const headerStarted = performance.now();
		this.buffer = buffer;
		this.bytes = new Uint8Array(buffer);
		if (buffer.byteLength > limits.maxInputBytes) throw new Error(`BOMC invalid: input exceeds the ${limits.maxInputBytes}-byte resource limit.`);
		if (buffer.byteLength < HEADER_BYTES) throw new Error('BOMC invalid: truncated header.');
		if (!isBomcBuffer(buffer)) throw new Error('BOMC invalid: magic mismatch.');
		const reader = new BomcBinaryReader(buffer);
		reader.readBytes(8);
		const major = reader.readUint16();
		const minor = reader.readUint16();
		const endian = reader.readUint32();
		const flags = reader.readUint32();
		const sectionCount = reader.readUint32();
		if (sectionCount > limits.maxSections) throw new Error(`BOMC invalid: section count ${sectionCount} exceeds the supported limit ${limits.maxSections}.`);
		const directoryOffset = reader.readUint64('directory offset');
		if (major !== 1 || minor > 2) throw new Error(`BOMC invalid: unsupported version ${major}.${minor}.`);
		if (endian !== BOMC_ENDIAN_MARKER) throw new Error('BOMC invalid: unsupported byte order.');
		if (directoryOffset < HEADER_BYTES) throw new Error('BOMC invalid: directory precedes fixed header.');
		const compact = (flags & BOMC_COMPACT_DIRECTORY) !== 0;
		if (compact && minor < 1) throw new Error('BOMC invalid: compact directory flag requires BOMC 1.1.');
		const directoryEntryBytes = compact ? 24 : 40;
		this.header = { major, minor, flags, sectionCount, directoryOffset, directoryEntryBytes };
		this.headerMs = performance.now() - headerStarted;

		const directoryStarted = performance.now();
		const directoryEnd = directoryOffset + sectionCount * directoryEntryBytes;
		if (!Number.isSafeInteger(directoryEnd) || directoryEnd > buffer.byteLength) throw new Error('BOMC invalid: directory outside file.');
		const directory = new BomcBinaryReader(buffer, directoryOffset, sectionCount * directoryEntryBytes);
		const descriptors: BomcSectionDescriptor[] = [];
		let totalRawLength = 0;
		for (let index = 0; index < sectionCount; index += 1) {
			const type = directory.readUint16();
			const codec = directory.readUint8();
			const sectionFlags = directory.readUint8();
			const offset = compact ? directory.readUint32() : directory.readUint64(`section ${index} offset`);
			const storedLength = compact ? directory.readUint32() : directory.readUint64(`section ${index} stored length`);
			const rawLength = compact ? directory.readUint32() : directory.readUint64(`section ${index} raw length`);
			const count = directory.readUint32();
			const crc32 = directory.readUint32();
			if (!compact && directory.readUint32() !== 0) throw new Error(`BOMC invalid: section ${index} reserved field.`);
			if (codec > 3) throw new Error(`BOMC invalid: section ${index} codec ${codec}.`);
			if (offset % ALIGNMENT !== 0) throw new Error(`BOMC invalid: section ${index} alignment.`);
			if (offset < align8(directoryEnd) || !Number.isSafeInteger(offset + storedLength) || offset + storedLength > buffer.byteLength) {
				throw new Error(`BOMC invalid: section ${index} outside file.`);
			}
			if (this.sections.has(type)) throw new Error(`BOMC invalid: duplicate section type ${type}.`);
			const descriptor = { index, type, codec, flags: sectionFlags, offset, storedLength, rawLength, count, crc32 };
			if (rawLength > limits.maxSectionRawBytes) {
				throw new Error(`BOMC invalid: section ${index} raw size exceeds the ${limits.maxSectionRawBytes}-byte resource limit.`);
			}
			totalRawLength += rawLength;
			if (!Number.isSafeInteger(totalRawLength) || totalRawLength > limits.maxTotalRawBytes) {
				throw new Error(`BOMC invalid: declared raw sections exceed the ${limits.maxTotalRawBytes}-byte resource limit.`);
			}
			this.sections.set(type, descriptor);
			descriptors.push(descriptor);
			this.metrics.push({ ...descriptor, inflateMs: 0, loaded: false });
		}
		const sorted = [...descriptors].sort((left, right) => left.offset - right.offset || left.index - right.index);
		for (let index = 1; index < sorted.length; index += 1) {
			const left = sorted[index - 1];
			const right = sorted[index];
			if (left.offset + left.storedLength > right.offset) throw new Error(`BOMC invalid: section ${right.index} overlaps section ${left.index}.`);
		}
		this.directoryMs = performance.now() - directoryStarted;
	}

	has(type: number) { return this.sections.has(type); }
	descriptor(type: number) { return this.sections.get(type); }

	async load(type: number, required = true) {
		const cached = this.decoded.get(type);
		if (cached) return cached;
		const descriptor = this.sections.get(type);
		if (!descriptor) {
			if (required) throw new Error(`BOMC invalid: missing section ${type}.`);
			return undefined;
		}
		const started = performance.now();
		const stored = this.bytes.subarray(descriptor.offset, descriptor.offset + descriptor.storedLength);
		if (crc32(stored) !== descriptor.crc32) throw new Error(`BOMC invalid: section ${descriptor.index} checksum mismatch.`);
		let raw: Uint8Array;
		if (descriptor.codec === 0) {
			raw = stored;
		} else if (descriptor.codec === 1) {
			try {
				const stream = new Blob([stored as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
				const output = new Uint8Array(descriptor.rawLength);
				const reader = stream.getReader();
				let offset = 0;
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						if (offset + value.byteLength > descriptor.rawLength) {
							await reader.cancel('BOMC declared raw size exceeded');
							throw new Error('decoded data exceeds the declared raw size.');
						}
						output.set(value, offset);
						offset += value.byteLength;
					}
				} finally {
					reader.releaseLock();
				}
				if (offset !== descriptor.rawLength) throw new Error('decoded data does not match the declared raw size.');
				raw = output;
			} catch (error) {
				throw new Error(`BOMC invalid: compressed section ${descriptor.index}: ${error instanceof Error ? error.message : 'DEFLATE failed'}.`);
			}
		} else {
			throw new Error(`BOMC invalid: section ${descriptor.index} uses unsupported codec ${descriptor.codec}.`);
		}
		if (raw.byteLength !== descriptor.rawLength) throw new Error(`BOMC invalid: section ${descriptor.index} raw size mismatch.`);
		this.decoded.set(type, raw);
		const metric = this.metrics[descriptor.index];
		metric.inflateMs = performance.now() - started;
		metric.loaded = true;
		return raw;
	}

	release(type: number) {
		const descriptor = this.sections.get(type);
		if (descriptor?.codec === 1) this.decoded.delete(type);
	}
}

function align8(value: number) { return value + ((ALIGNMENT - value % ALIGNMENT) % ALIGNMENT); }

let crcTable: Uint32Array | undefined;
export function crc32(bytes: Uint8Array) {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let index = 0; index < 256; index += 1) {
			let value = index;
			for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
			crcTable[index] = value >>> 0;
		}
	}
	let value = 0xffffffff;
	for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}
