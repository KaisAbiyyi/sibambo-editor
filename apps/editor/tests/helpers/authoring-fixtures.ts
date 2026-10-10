import { createHash } from 'node:crypto';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { BomcWriter } from '@sibambo/bomc-document/writer';
import { parseDirectory, loadSection, assembleContainer, type StoredSection } from '../../../../packages/bomc-document/src/binary.js';
import { createExtrusionPositiveGraph } from '../../../../packages/bomc-document/src/test-fixtures/documents.js';

export type AuthoringFaultFixture = { id: string; classification: 'viewer' | 'reject'; bytes: Buffer; sha256: string };

function sha256(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }

async function unpackWebCore(bytes: Uint8Array): Promise<StoredSection[]> {
	const directory = parseDirectory(bytes, 'web-core');
	const sections: StoredSection[] = [];
	for (const entry of directory.sections) {
		sections.push({ type: entry.type, codec: 0, rawLength: entry.rawLength, count: entry.count, bytes: await loadSection(bytes, entry) });
	}
	return sections;
}

function pack(sections: readonly StoredSection[]) { return Buffer.from(assembleContainer(sections)); }

/** Use the existing valid kernel prism fixture to prove unsupported nonflat BWEB stays viewer-only. */
export async function buildNonflatKernelBwebFixture(): Promise<AuthoringFaultFixture> {
	const document = BomcDocument.fromGraph(createExtrusionPositiveGraph());
	const writer = new BomcWriter(document, { compressionMode: 'store-only' });
	try {
		const output = await writer.write();
		const bytes = Buffer.from(output.bytes);
		return { id: 'valid-nonflat-kernel-bweb', classification: 'viewer', bytes, sha256: sha256(bytes) };
	} finally {
		writer.dispose();
		document.dispose();
	}
}

/** Build only the named malformed/unsupported section-241 browser fixtures. */
export async function buildAuthoringFaultFixtures(validDownloadedBytes: Uint8Array): Promise<AuthoringFaultFixture[]> {
	const sections = await unpackWebCore(validDownloadedBytes);
	const authoring = sections.find((section) => section.type === 241);
	if (!authoring || authoring.bytes.byteLength < 20 || new TextDecoder().decode(authoring.bytes.subarray(0, 4)) !== 'BWEB') {
		throw new Error('The actual UI download did not contain a complete BWEB authoring section.');
	}
	const copied = () => sections.map((section) => ({ ...section, bytes: Uint8Array.from(section.bytes) }));
	const outputs: Array<{ id: string; classification: 'viewer' | 'reject'; bytes: Buffer }> = [];

	outputs.push({ id: 'section241-missing', classification: 'viewer', bytes: pack(sections.filter((section) => section.type !== 241)) });

	for (const [id, mutate] of [
		['section241-nonmagic', (payload: Uint8Array) => { payload[0] = 0x58; }],
		['section241-schema-2', (payload: Uint8Array) => { payload[4] = 2; payload[5] = 0; }]
	] as const) {
		const next = copied();
		mutate(next.find((section) => section.type === 241)!.bytes);
		outputs.push({ id, classification: 'viewer', bytes: pack(next) });
	}

	for (const codec of [2, 3]) {
		const bytes = pack(sections);
		const directory = parseDirectory(bytes, 'web-core');
		const index = directory.sections.findIndex((entry) => entry.type === 241);
		if (index < 0) throw new Error('The BWEB fixture directory lost section 241.');
		bytes[32 + index * 24 + 2] = codec;
		outputs.push({ id: `section241-codec-${codec}`, classification: 'viewer', bytes });
	}

	{
		const next = copied();
		const section = next.find((item) => item.type === 241)!;
		section.bytes = section.bytes.subarray(0, section.bytes.byteLength - 1);
		section.rawLength = section.bytes.byteLength;
		outputs.push({ id: 'section241-truncated-bweb', classification: 'reject', bytes: pack(next) });
	}

	{
		const bytes = pack(sections);
		const directory = parseDirectory(bytes, 'web-core');
		const entry = directory.sections.find((section) => section.type === 241)!;
		bytes[entry.offset] ^= 0xff;
		outputs.push({ id: 'section241-stored-crc', classification: 'reject', bytes });
	}

	return outputs.map((fixture) => ({ ...fixture, sha256: sha256(fixture.bytes) }));
}
