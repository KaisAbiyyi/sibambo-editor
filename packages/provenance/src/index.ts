import type { EngineFormat, EngineId, ResearchProvenance } from '@sibambo/contracts';

const hash64 = /^[a-f0-9]{64}$/;
const nonempty = (value: unknown) => typeof value === 'string' && Boolean(value.trim());

export type EnginePolicy = {
	engine: EngineId;
	format: EngineFormat;
	profiles: readonly string[];
	producer: {
		commitSha?: readonly string[];
		sourceTreeSha256?: readonly string[];
	};
};

/** Validate evidence against caller-owned policy and return a plain structured-clone-safe record. */
export function validateProvenance(value: unknown, policy: EnginePolicy): ResearchProvenance {
	const p = value as ResearchProvenance | null;
	if (!p || p.schema !== 'sibambo-research-provenance-v1') {
		throw new Error('Provenance required: choose a registered capture or upload its research provenance JSON. Unverified files are rejected.');
	}
	if (p.engine !== policy.engine) {
		throw new Error(`Wrong engine: this route accepts ${policy.engine.toUpperCase()} only; provenance declares ${String(p.engine).toUpperCase()}.`);
	}
	if (p.artifact?.format !== policy.format || !hash64.test(p.artifact?.sha256 ?? '') || !Number.isSafeInteger(p.artifact?.bytes) || p.artifact.bytes <= 0) {
		throw new Error('Invalid artifact provenance: format, SHA-256 and byte count must match this engine.');
	}
	if (!nonempty(p.producer?.label) || !nonempty(p.model?.id) || !nonempty(p.capture?.id) || !nonempty(p.capture?.evidence) || !nonempty(p.capture?.exportedAt) || !Number.isFinite(Date.parse(p.capture.exportedAt)) || !['operator-attested', 'exporter-capture'].includes(p.capture.method)) {
		throw new Error('Incomplete provenance: producer, model, capture date, method and evidence source are required.');
	}
	const producerAllowed = policy.engine === 'e4'
		? Boolean(p.producer.sourceTreeSha256 && policy.producer.sourceTreeSha256?.includes(p.producer.sourceTreeSha256))
		: Boolean(p.producer.commitSha && policy.producer.commitSha?.includes(p.producer.commitSha));
	if (!producerAllowed) {
		throw new Error(`Unrecognized ${policy.engine.toUpperCase()} producer identity. Historical snapshots and E4 source trees must be explicitly registered.`);
	}
	if (!policy.profiles.includes(p.artifact.profile)) throw new Error('Profile is not valid for this engine.');
	if (p.model.sourceSha256 !== undefined && !hash64.test(p.model.sourceSha256)) throw new Error('Invalid source model SHA-256.');
	if (p.model.sourceBytes !== undefined && (!Number.isSafeInteger(p.model.sourceBytes) || p.model.sourceBytes <= 0)) throw new Error('Invalid source model byte count.');

	return {
		schema: p.schema,
		engine: p.engine,
		artifact: { sha256: p.artifact.sha256, bytes: p.artifact.bytes, format: p.artifact.format, profile: p.artifact.profile },
		producer: {
			label: p.producer.label,
			...(p.producer.commitSha === undefined ? {} : { commitSha: p.producer.commitSha }),
			...(p.producer.sourceTreeSha256 === undefined ? {} : { sourceTreeSha256: p.producer.sourceTreeSha256 })
		},
		model: {
			id: p.model.id,
			...(p.model.sourceSha256 === undefined ? {} : { sourceSha256: p.model.sourceSha256 }),
			...(p.model.sourceBytes === undefined ? {} : { sourceBytes: p.model.sourceBytes })
		},
		capture: { id: p.capture.id, exportedAt: p.capture.exportedAt, evidence: p.capture.evidence, method: p.capture.method }
	};
}

export async function sha256(bytes: ArrayBuffer) {
	return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
