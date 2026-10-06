import { BomcDocumentError } from './document.js';
import type { SourceSectionMetadata } from './types.js';
import { parseDirectory, type ParsedDirectory } from './binary.js';

export type RetainedBomcSource = {
	readonly header: ParsedDirectory['header'];
	readonly sections: readonly SourceSectionMetadata[];
	readonly integrityLevel: 'directory-and-stored-crc';
	copyUnchanged(): Uint8Array;
	dispose(): void;
};

export function retainBomcSource(input: Uint8Array): RetainedBomcSource {
	if (!(input instanceof Uint8Array)) throw new BomcDocumentError('INVALID_SOURCE', 'BOMC source must be a Uint8Array.');
	let retained: Uint8Array;
	try { retained = new Uint8Array(input); }
	catch (error) { throw new BomcDocumentError('RESOURCE_LIMIT', 'Unable to retain BOMC source bytes.', error); }
	let directory: ParsedDirectory;
	try { directory = parseDirectory(retained, 'source-envelope'); }
	catch (error) { retained = new Uint8Array(); throw error; }
	for (const section of directory.sections) {
		if (section.codec === 0 && section.storedLength !== section.rawLength) {
			retained = new Uint8Array();
			throw new BomcDocumentError('INVALID_SOURCE', `Stored section ${section.type} has unequal STORE lengths.`);
		}
	}
	const metadata = Object.freeze(directory.sections.map((section) => Object.freeze({
		type: section.type, codec: section.codec, flags: section.flags, offset: section.offset,
		storedLength: section.storedLength, rawLength: section.rawLength, count: section.count,
		crc32: section.crc32, wide: section.wide
	})));
	let closed = false;
	const source: RetainedBomcSource = {
		header: directory.header,
		sections: metadata,
		integrityLevel: 'directory-and-stored-crc',
		copyUnchanged() {
			if (closed) throw new BomcDocumentError('CLOSED', 'Retained BOMC source is disposed.');
			return new Uint8Array(retained);
		},
		dispose() {
			if (closed) return;
			closed = true;
			retained = new Uint8Array();
		}
	};
	return Object.freeze(source);
}
