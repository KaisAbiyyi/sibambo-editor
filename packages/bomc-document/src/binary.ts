import { BomcDocumentError } from './document.js';

export const BOMC_MAGIC_BYTES = new Uint8Array([0x42, 0x4f, 0x4d, 0x43, 0x0d, 0x0a, 0x1a, 0x0a]);
export const BOMC_HEADER_BYTES = 32;
export const BOMC_COMPACT_DESCRIPTOR_BYTES = 24;
export const BOMC_WIDE_DESCRIPTOR_BYTES = 40;
export const BOMC_WEB_FLAGS = 0x11;
export const BOMC_ENDIAN_MARKER = 0x01020304;
export const WEB_SECTION_TYPES = new Set([1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 14, 17, 20, 241]);

export type DirectoryMode = 'web-core' | 'source-envelope';
export type BomcHeader = Readonly<{
	major: number;
	minor: number;
	flags: number;
	sectionCount: number;
	directoryOffset: number;
	directoryEntryBytes: 24 | 40;
}>;
export type DirectoryEntry = Readonly<{
	type: number;
	codec: number;
	flags: number;
	offset: number;
	storedLength: number;
	rawLength: number;
	count: number;
	crc32: number;
	reserved: number;
	wide: boolean;
}>;
export type ParsedDirectory = Readonly<{ header: BomcHeader; sections: readonly DirectoryEntry[] }>;
export type StoredSection = { type: number; codec: number; flags?: number; rawLength: number; count: number; bytes: Uint8Array };

const crcTable = (() => {
	const table = new Uint32Array(256);
	for (let value = 0; value < 256; value += 1) {
		let crc = value;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		table[value] = crc >>> 0;
	}
	return table;
})();

export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const value of bytes) crc = crcTable[(crc ^ value) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

export function indexWidth(count: number): 1 | 2 | 4 {
	if (!Number.isSafeInteger(count) || count < 0) throw new BomcDocumentError('RESOURCE_LIMIT', 'Reference count is outside the safe integer range.');
	if (count <= 0xff) return 1;
	if (count <= 0xffff) return 2;
	if (count <= 0xffffffff) return 4;
	throw new BomcDocumentError('RESOURCE_LIMIT', 'Reference table exceeds uint32 capacity.');
}

export class BinaryReader {
	private readonly view: DataView;
	private offsetValue: number;
	private readonly end: number;

	constructor(bytes: Uint8Array, offset = 0, length = bytes.byteLength - offset) {
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.byteLength) {
			throw new BomcDocumentError('INVALID_SOURCE', 'Binary reader range is outside its input.');
		}
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.offsetValue = offset;
		this.end = offset + length;
	}

	get offset() { return this.offsetValue; }
	get remaining() { return this.end - this.offsetValue; }

	private require(bytes: number) {
		if (!Number.isSafeInteger(bytes) || bytes < 0 || this.offsetValue + bytes > this.end) {
			throw new BomcDocumentError('INVALID_SOURCE', 'Binary field is truncated.');
		}
	}

	readU8() { this.require(1); return this.view.getUint8(this.offsetValue++); }
	readU16() { this.require(2); const value = this.view.getUint16(this.offsetValue, true); this.offsetValue += 2; return value; }
	readU32() { this.require(4); const value = this.view.getUint32(this.offsetValue, true); this.offsetValue += 4; return value; }
	readF32() { this.require(4); const value = this.view.getFloat32(this.offsetValue, true); this.offsetValue += 4; return value; }
	readF64() { this.require(8); const value = this.view.getFloat64(this.offsetValue, true); this.offsetValue += 8; return value; }

	readU64() {
		this.require(8);
		const value = this.view.getBigUint64(this.offsetValue, true);
		this.offsetValue += 8;
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new BomcDocumentError('RESOURCE_LIMIT', 'Binary uint64 exceeds the safe integer range.');
		return Number(value);
	}

	readBytes(length: number): Uint8Array {
		this.require(length);
		const result = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offsetValue, length);
		this.offsetValue += length;
		return result;
	}

	skip(length: number) { this.require(length); this.offsetValue += length; }
}

export class BinaryWriter {
	private bytes: Uint8Array<ArrayBuffer>;
	private view: DataView;
	private offsetValue = 0;

	constructor(initialCapacity = 256) {
		if (!Number.isSafeInteger(initialCapacity) || initialCapacity < 0) throw new BomcDocumentError('RESOURCE_LIMIT', 'Invalid binary writer capacity.');
		try { this.bytes = new Uint8Array(Math.max(16, initialCapacity)); }
		catch (error) { throw new BomcDocumentError('RESOURCE_LIMIT', 'Unable to allocate binary output.', error); }
		this.view = new DataView(this.bytes.buffer);
	}

	get length() { return this.offsetValue; }

	private ensure(extra: number) {
		const required = this.offsetValue + extra;
		if (!Number.isSafeInteger(required) || required < this.offsetValue || required > 0xffffffff) throw new BomcDocumentError('RESOURCE_LIMIT', 'Binary section exceeds uint32 capacity.');
		if (required <= this.bytes.length) return;
		let capacity = this.bytes.length;
		while (capacity < required) {
			const next = Math.min(0xffffffff, Math.max(capacity * 2, required));
			if (next <= capacity) throw new BomcDocumentError('RESOURCE_LIMIT', 'Binary section capacity is exhausted.');
			capacity = next;
		}
		try {
			const expanded = new Uint8Array(capacity);
			expanded.set(this.bytes.subarray(0, this.offsetValue));
			this.bytes = expanded;
			this.view = new DataView(expanded.buffer);
		} catch (error) {
			throw new BomcDocumentError('RESOURCE_LIMIT', 'Unable to grow binary output.', error);
		}
	}

	writeU8(value: number) { this.ensure(1); this.view.setUint8(this.offsetValue++, checkedInteger(value, 0xff)); }
	writeU16(value: number) { this.ensure(2); this.view.setUint16(this.offsetValue, checkedInteger(value, 0xffff), true); this.offsetValue += 2; }
	writeU32(value: number) { this.ensure(4); this.view.setUint32(this.offsetValue, checkedInteger(value, 0xffffffff), true); this.offsetValue += 4; }
	writeF32(value: number) { this.ensure(4); if (!Number.isFinite(value)) throw new BomcDocumentError('INVALID_DOCUMENT', 'Cannot encode a non-finite Float32.'); this.view.setFloat32(this.offsetValue, value, true); this.offsetValue += 4; }
	writeF64(value: number) { this.ensure(8); if (!Number.isFinite(value)) throw new BomcDocumentError('INVALID_DOCUMENT', 'Cannot encode a non-finite Float64.'); this.view.setFloat64(this.offsetValue, value, true); this.offsetValue += 8; }
	writeU64(value: number) {
		if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw new BomcDocumentError('RESOURCE_LIMIT', 'Binary uint64 input must be a nonnegative safe integer.');
		this.ensure(8); this.view.setBigUint64(this.offsetValue, BigInt(value), true); this.offsetValue += 8;
	}
	writeBytes(value: Uint8Array) { this.ensure(value.byteLength); this.bytes.set(value, this.offsetValue); this.offsetValue += value.byteLength; }
	writeZeros(count: number) { this.ensure(count); this.bytes.fill(0, this.offsetValue, this.offsetValue + count); this.offsetValue += count; }
	patchU32(offset: number, value: number) {
		if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > this.offsetValue) throw new BomcDocumentError('INTERNAL_ERROR', 'Binary patch offset is outside written data.');
		this.view.setUint32(offset, checkedInteger(value, 0xffffffff), true);
	}
	finish(): Uint8Array<ArrayBuffer> { return this.bytes.slice(0, this.offsetValue); }
}

function checkedInteger(value: number, max: number) {
	if (!Number.isSafeInteger(value) || value < 0 || value > max || Object.is(value, -0)) throw new BomcDocumentError('RESOURCE_LIMIT', 'Binary integer is outside its unsigned field range.');
	return value;
}

export function writeVaruint(writer: BinaryWriter, value: number) {
	if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw new BomcDocumentError('INVALID_DOCUMENT', 'Varuint must be a nonnegative safe integer.');
	let remaining = value;
	while (remaining >= 0x80) {
		const remainder = remaining % 0x80;
		writer.writeU8(remainder + 0x80);
		remaining = Math.floor(remaining / 0x80);
	}
	writer.writeU8(remaining);
}

export function readVaruint(reader: BinaryReader): number {
	let result = 0;
	let multiplier = 1;
	for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
		const byte = reader.readU8();
		const payload = byte % 0x80;
		result += payload * multiplier;
		if (!Number.isSafeInteger(result)) throw new BomcDocumentError('RESOURCE_LIMIT', 'Varuint exceeds the safe integer range.');
		if (byte < 0x80) return result;
		multiplier *= 0x80;
	}
	throw new BomcDocumentError('INVALID_SOURCE', 'Varuint continuation exceeds its supported width.');
}

export function writeZigzag(writer: BinaryWriter, value: number) {
	if (!Number.isSafeInteger(value)) throw new BomcDocumentError('INVALID_DOCUMENT', 'Zigzag value must be a safe integer.');
	const encoded = value >= 0 ? value * 2 : -value * 2 - 1;
	if (!Number.isSafeInteger(encoded)) throw new BomcDocumentError('RESOURCE_LIMIT', 'Zigzag encoding exceeds the safe integer range.');
	writeVaruint(writer, encoded);
}

export function readZigzag(reader: BinaryReader): number {
	const encoded = readVaruint(reader);
	const result = encoded % 2 === 0 ? encoded / 2 : -(Math.floor(encoded / 2) + 1);
	if (!Number.isSafeInteger(result)) throw new BomcDocumentError('RESOURCE_LIMIT', 'Decoded zigzag value exceeds the safe integer range.');
	return result;
}

export function align8(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 7) throw new BomcDocumentError('RESOURCE_LIMIT', 'Alignment offset exceeds the safe integer range.');
	return Math.ceil(value / 8) * 8;
}

export function parseDirectory(bytes: Uint8Array, mode: DirectoryMode): ParsedDirectory {
	if (bytes.byteLength < BOMC_HEADER_BYTES) throw new BomcDocumentError('INVALID_SOURCE', 'BOMC header is truncated.');
	const reader = new BinaryReader(bytes);
	for (const expected of BOMC_MAGIC_BYTES) if (reader.readU8() !== expected) throw new BomcDocumentError('INVALID_SOURCE', 'BOMC magic is invalid.');
	const major = reader.readU16();
	const minor = reader.readU16();
	const endian = reader.readU32();
	const flags = reader.readU32();
	const sectionCount = reader.readU32();
	const directoryOffset = reader.readU64();
	if (endian !== BOMC_ENDIAN_MARKER) throw new BomcDocumentError('INVALID_SOURCE', 'BOMC endian marker is invalid.');
	if (major !== 1 || minor !== 2) throw new BomcDocumentError('UNSUPPORTED_FEATURE', `BOMC ${major}.${minor} is outside the supported container version.`);
	const compact = (flags & 0x10) !== 0;
	const directoryEntryBytes = compact ? BOMC_COMPACT_DESCRIPTOR_BYTES : BOMC_WIDE_DESCRIPTOR_BYTES;
	if (directoryOffset < BOMC_HEADER_BYTES) throw new BomcDocumentError('INVALID_SOURCE', 'BOMC directory precedes its header.');
	const directoryLength = sectionCount * directoryEntryBytes;
	const directoryEnd = directoryOffset + directoryLength;
	if (!Number.isSafeInteger(directoryLength) || !Number.isSafeInteger(directoryEnd) || directoryEnd > bytes.byteLength) {
		throw new BomcDocumentError('INVALID_SOURCE', 'BOMC directory exceeds the input.');
	}
	if (mode === 'web-core') {
		if (!compact || directoryEntryBytes !== BOMC_COMPACT_DESCRIPTOR_BYTES || directoryOffset !== BOMC_HEADER_BYTES || flags !== BOMC_WEB_FLAGS) {
			throw new BomcDocumentError('INVALID_SOURCE', 'Web-core BOMC header is not the locked compact profile.');
		}
	}
	const entriesReader = new BinaryReader(bytes, directoryOffset, directoryLength);
	const sections: DirectoryEntry[] = [];
	const seenTypes = new Set<number>();
	let priorType = -1;
	for (let index = 0; index < sectionCount; index += 1) {
		const type = entriesReader.readU16();
		const codec = entriesReader.readU8();
		const sectionFlags = entriesReader.readU8();
		const offset = compact ? entriesReader.readU32() : entriesReader.readU64();
		const storedLength = compact ? entriesReader.readU32() : entriesReader.readU64();
		const rawLength = compact ? entriesReader.readU32() : entriesReader.readU64();
		const count = entriesReader.readU32();
		const checksum = entriesReader.readU32();
		const reserved = compact ? 0 : entriesReader.readU32();
		if (!compact && reserved !== 0) throw new BomcDocumentError('INVALID_SOURCE', `BOMC section ${type} has a nonzero reserved field.`);
		if (seenTypes.has(type)) throw new BomcDocumentError('INVALID_SOURCE', `BOMC section ${type} is duplicated.`);
		seenTypes.add(type);
		if (mode === 'web-core') {
			if (type <= priorType) throw new BomcDocumentError('INVALID_SOURCE', 'Web-core sections are not in ascending numeric order.');
			if (!WEB_SECTION_TYPES.has(type)) throw new BomcDocumentError('UNSUPPORTED_FEATURE', `Web-core section ${type} is unsupported.`);
			if (sectionFlags !== 0) throw new BomcDocumentError('INVALID_SOURCE', `Web-core section ${type} has unsupported flags.`);
			if (codec !== 0 && codec !== 1) throw new BomcDocumentError('UNSUPPORTED_FEATURE', `Web-core section ${type} codec ${codec} is unsupported.`);
		} else if (codec > 3) throw new BomcDocumentError('UNSUPPORTED_FEATURE', `Source-envelope codec ${codec} is unsupported.`);
		priorType = type;
		sections.push(Object.freeze({ type, codec, flags: sectionFlags, offset, storedLength, rawLength, count, crc32: checksum, reserved, wide: !compact }));
	}
	const minimumDataOffset = align8(directoryEnd);
	let priorEnd = minimumDataOffset;
	const byOffset = [...sections].sort((a, b) => a.offset - b.offset);
	for (const section of byOffset) {
		const end = section.offset + section.storedLength;
		if (!Number.isSafeInteger(end) || section.offset < minimumDataOffset || section.offset % 8 !== 0 || end > bytes.byteLength) {
			throw new BomcDocumentError('INVALID_SOURCE', `BOMC section ${section.type} has an invalid data range.`);
		}
		if (section.offset < priorEnd) throw new BomcDocumentError('INVALID_SOURCE', `BOMC section ${section.type} overlaps another range.`);
		if (mode === 'web-core' && !allZero(bytes.subarray(priorEnd, section.offset))) throw new BomcDocumentError('INVALID_SOURCE', 'Web-core inter-section padding must be zero.');
		const stored = bytes.subarray(section.offset, end);
		if (crc32(stored) !== section.crc32) throw new BomcDocumentError('INVALID_SOURCE', `BOMC section ${section.type} stored CRC32 is invalid.`);
		priorEnd = end;
	}
	if (mode === 'web-core') {
		if (sections.length > 0 && priorEnd !== bytes.byteLength) throw new BomcDocumentError('INVALID_SOURCE', 'Web-core BOMC has trailing bytes after its last section.');
		if (sections.length === 0 && minimumDataOffset !== bytes.byteLength) throw new BomcDocumentError('INVALID_SOURCE', 'Web-core empty container has trailing bytes.');
		if (!allZero(bytes.subarray(directoryEnd, minimumDataOffset))) throw new BomcDocumentError('INVALID_SOURCE', 'Web-core directory padding must be zero.');
		if (byOffset.length > 0 && byOffset[0]!.offset !== minimumDataOffset) throw new BomcDocumentError('INVALID_SOURCE', 'Web-core first section does not begin at the aligned directory end.');
		for (let index = 1; index < byOffset.length; index += 1) {
			if (align8(byOffset[index - 1]!.offset + byOffset[index - 1]!.storedLength) !== byOffset[index]!.offset) {
				throw new BomcDocumentError('INVALID_SOURCE', 'Web-core sections are not in exact aligned order.');
			}
		}
	}
	return Object.freeze({
		header: Object.freeze({ major, minor, flags, sectionCount, directoryOffset, directoryEntryBytes }),
		sections: Object.freeze(sections)
	});
}

function allZero(bytes: Uint8Array) {
	for (const value of bytes) if (value !== 0) return false;
	return true;
}

export function assembleContainer(sectionsInput: readonly StoredSection[]): Uint8Array<ArrayBuffer> {
	const sections = [...sectionsInput].sort((a, b) => a.type - b.type);
	if (sections.length === 0 || sections.length > 0xffffffff) throw new BomcDocumentError('RESOURCE_LIMIT', 'BOMC must contain a representable section directory.');
	const seen = new Set<number>();
	let cursor = align8(BOMC_HEADER_BYTES + sections.length * BOMC_COMPACT_DESCRIPTOR_BYTES);
	const descriptors: Array<StoredSection & { flags: number; offset: number; crc32: number }> = [];
	for (const section of sections) {
		checkedInteger(section.type, 0xffff);
		if (seen.has(section.type)) throw new BomcDocumentError('INTERNAL_ERROR', `Duplicate generated section ${section.type}.`);
		seen.add(section.type);
		if (!WEB_SECTION_TYPES.has(section.type)) throw new BomcDocumentError('UNSUPPORTED_FEATURE', `Cannot emit web-core section ${section.type}.`);
		if (section.codec !== 0 && section.codec !== 1) throw new BomcDocumentError('INTERNAL_ERROR', `Generated codec ${section.codec} is unsupported.`);
		checkedInteger(section.rawLength, 0xffffffff);
		checkedInteger(section.count, 0xffffffff);
		checkedInteger(section.bytes.byteLength, 0xffffffff);
		if (section.flags !== undefined && section.flags !== 0) throw new BomcDocumentError('INTERNAL_ERROR', 'Generated web-core section flags must be zero.');
		const offset = cursor;
		const end = offset + section.bytes.byteLength;
		if (!Number.isSafeInteger(end) || end > 0xffffffff) throw new BomcDocumentError('RESOURCE_LIMIT', 'BOMC section ranges exceed uint32 offsets.');
		descriptors.push({ ...section, flags: 0, offset, crc32: crc32(section.bytes) });
		cursor = align8(end);
	}
	const fileLength = descriptors[descriptors.length - 1]!.offset + descriptors[descriptors.length - 1]!.bytes.byteLength;
	if (!Number.isSafeInteger(fileLength) || fileLength > 0xffffffff) throw new BomcDocumentError('RESOURCE_LIMIT', 'BOMC file exceeds uint32 capacity.');
	const writer = new BinaryWriter(fileLength);
	writer.writeBytes(BOMC_MAGIC_BYTES);
	writer.writeU16(1); writer.writeU16(2); writer.writeU32(BOMC_ENDIAN_MARKER);
	writer.writeU32(BOMC_WEB_FLAGS); writer.writeU32(descriptors.length); writer.writeU64(BOMC_HEADER_BYTES);
	for (const descriptor of descriptors) {
		writer.writeU16(descriptor.type); writer.writeU8(descriptor.codec); writer.writeU8(0);
		writer.writeU32(descriptor.offset); writer.writeU32(descriptor.bytes.byteLength); writer.writeU32(descriptor.rawLength);
		writer.writeU32(descriptor.count); writer.writeU32(descriptor.crc32);
	}
	writer.writeZeros(align8(writer.length) - writer.length);
	for (const descriptor of descriptors) {
		if (writer.length > descriptor.offset) throw new BomcDocumentError('INTERNAL_ERROR', 'BOMC descriptor offsets are not ordered.');
		writer.writeZeros(descriptor.offset - writer.length);
		writer.writeBytes(descriptor.bytes);
		if (descriptor !== descriptors[descriptors.length - 1]) writer.writeZeros(align8(writer.length) - writer.length);
	}
	const output = writer.finish();
	if (output.byteLength !== fileLength) throw new BomcDocumentError('INTERNAL_ERROR', 'BOMC file length differs from its final section range.');
	return output;
}

export async function loadSection(bytes: Uint8Array, section: DirectoryEntry): Promise<Uint8Array> {
	const stored = bytes.subarray(section.offset, section.offset + section.storedLength);
	if (crc32(stored) !== section.crc32) throw new BomcDocumentError('INVALID_SOURCE', `BOMC section ${section.type} stored CRC32 is invalid.`);
	if (section.codec === 0) {
		if (section.storedLength !== section.rawLength) throw new BomcDocumentError('INVALID_SOURCE', `BOMC section ${section.type} STORE lengths differ.`);
		return Uint8Array.from(stored);
	}
	if (section.codec !== 1) throw new BomcDocumentError('UNSUPPORTED_FEATURE', `BOMC section ${section.type} codec ${section.codec} is unsupported.`);
	if (typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined') throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'Deflate decompression APIs are unavailable.');
	let expected: Uint8Array;
	try { expected = new Uint8Array(section.rawLength); }
	catch (error) { throw new BomcDocumentError('RESOURCE_LIMIT', `Unable to allocate section ${section.type} output.`, error); }
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const body = new Blob([Uint8Array.from(stored).buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate'));
		reader = body.getReader();
		let written = 0;
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			const chunk = result.value;
			if (chunk.byteLength > expected.byteLength - written) throw new BomcDocumentError('INVALID_SOURCE', `BOMC section ${section.type} expands beyond its declared length.`);
			expected.set(chunk, written);
			written += chunk.byteLength;
		}
		if (written !== expected.byteLength) throw new BomcDocumentError('INVALID_SOURCE', `BOMC section ${section.type} decoded length is short.`);
		return expected;
	} catch (error) {
		if (error instanceof BomcDocumentError) throw error;
		if (error instanceof TypeError && /not supported|unsupported/i.test(error.message)) throw new BomcDocumentError('UNSUPPORTED_FEATURE', 'Deflate decompression is unsupported in this runtime.', error);
		throw new BomcDocumentError('INVALID_SOURCE', `BOMC section ${section.type} deflate stream is invalid.`, error);
	} finally {
		if (reader) {
			try { await reader.cancel(); } catch { /* the stream may already be closed */ }
			try { reader.releaseLock(); } catch { /* preserve the section outcome */ }
		}
	}
}
