/**
 * Build-time only (SIB-MCP-MODELING-001 v2.1 WP1A, v2.3 WP6): standalone AJV validators for
 * ArchModule v2 and edit_model schemas so validation in the authoring worker and main thread
 * never needs CSP unsafe-eval. Without --write it checks that committed files are current.
 */
import Ajv2020 from 'ajv/dist/2020';
import standaloneCode from 'ajv/dist/standalone';
import { createHash } from 'node:crypto';
import path from 'node:path';

type TargetSpec = {
	schemaRel: string;
	outRel: string;
	label: string;
	envVar: string;
};

const TARGETS: readonly TargetSpec[] = [
	{
		schemaRel: 'apps/editor/src/lib/arch/schemas/arch-module-v2.schema.json',
		outRel: 'apps/editor/src/lib/arch/arch-module-v2.validator.generated.js',
		label: 'ArchModule v2',
		envVar: 'ARCH_MODULE_V2_SCHEMA_SHA256'
	},
	{
		schemaRel: 'apps/editor/src/lib/arch/schemas/edit-model.schema.json',
		outRel: 'apps/editor/src/lib/arch/edit-model.validator.generated.js',
		label: 'edit_model',
		envVar: 'EDIT_MODEL_SCHEMA_SHA256'
	},
	{
		schemaRel: 'apps/editor/src/lib/arch/schemas/model-ops.schema.json',
		outRel: 'apps/editor/src/lib/arch/model-ops.validator.generated.js',
		label: 'model_ops',
		envVar: 'MODEL_OPS_SCHEMA_SHA256'
	}
];

const repo = path.resolve(import.meta.dir, '../..');
const writeMode = process.argv.includes('--write');

for (const spec of TARGETS) {
	const schemaPath = path.join(repo, spec.schemaRel);
	const source = (await Bun.file(schemaPath).text()).replace(/\r\n/g, '\n');
	const schema = JSON.parse(source);
	const ajv = new Ajv2020({ strict: false, code: { source: true, esm: true } });
	const validate = ajv.compile(schema);
	let code = standaloneCode(ajv, validate);
	code = code.replace(/require\("ajv\/dist\/runtime\/ucs2length"\)\.default/g, 'ucs2length');
	code = code.replace(/require\("ajv\/dist\/runtime\/equal"\)\.default/g, 'equal');
	if (/\brequire\(|\beval\(|new Function\b/.test(code)) {
		throw Error('Unexpected dynamic validator dependency: ' + code.match(/require\([^)]*\)|eval\(|new Function/g));
	}
	const hash = createHash('sha256').update(source).digest('hex');
	const generated =
		'// @ts-nocheck\n// GENERATED from ' + spec.schemaRel + '; do not edit.\n' +
		'// LF source SHA-256: ' + hash + '\n// Regenerate: bun tooling/testing/generate-arch-validators.ts --write\n' +
		// Explicit .js: this module is reached from SSR, Bun and Playwright's Node loader (via
		// authoring/model.ts), and Node ESM cannot resolve extensionless deep imports into ajv.
		'import * as unicodeRuntime from "ajv/dist/runtime/ucs2length.js";\nimport * as equalRuntime from "ajv/dist/runtime/equal.js";\n' +
		'const ucs2length = typeof unicodeRuntime.default === "function" ? unicodeRuntime.default : unicodeRuntime.default.default;\n' +
		'const equal = typeof equalRuntime.default === "function" ? equalRuntime.default : equalRuntime.default.default;\n' +
		code + '\n';
	const target = Bun.file(path.join(repo, spec.outRel));
	if (writeMode) {
		await Bun.write(target, generated);
	} else if (!(await target.exists()) || (await target.text()).replace(/\r\n/g, '\n') !== generated) {
		throw Error(`${spec.label} validator differs from its schema; regenerate and review`);
	}
	console.log(`${spec.envVar}=${hash}`);
}
