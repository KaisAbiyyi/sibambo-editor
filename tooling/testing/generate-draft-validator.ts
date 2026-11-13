/** Build-time only: static validation in the worker must not need CSP unsafe-eval. */
import Ajv2020 from 'ajv/dist/2020';
import standaloneCode from 'ajv/dist/standalone';
import { createHash } from 'node:crypto';
import path from 'node:path';
const repo = path.resolve(import.meta.dir, '../..');
const builder = process.env.SE05_BUILDER_ROOT ?? path.join(repo, '../sibambo-bomc-builder');
const source = (await Bun.file(path.join(builder, 'schemas/module-ir-v1.schema.json')).text()).replace(/\r\n/g, '\n');
const schema = JSON.parse(source);
const ajv = new Ajv2020({ strict: false, code: { source: true, esm: true } });
ajv.addSchema(schema);
const validate = ajv.compile({ $ref: schema.$id + '#/$defs/module' });
let code = standaloneCode(ajv, validate);
// Ajv's emitted Unicode length helper is a static import, never a runtime schema compiler.
code = code.replace(/require\("ajv\/dist\/runtime\/ucs2length"\)\.default/g, 'ucs2length');
code = code.replace(/require\("ajv\/dist\/runtime\/equal"\)\.default/g, 'equal');
if (/\brequire\(|\beval\(|new Function\b/.test(code)) throw Error('Unexpected dynamic validator dependency: ' + code.match(/require\([^)]*\)|eval\(|new Function/g));
const hash = createHash('sha256').update(source).digest('hex');
const generated = '// @ts-nocheck\n// GENERATED from the public Builder module-ir-v1 schema; do not edit.\n' +
  '// LF source SHA-256: ' + hash + '\n// Regenerate: bun tooling/testing/generate-draft-validator.ts --write\n' +
  'import * as unicodeRuntime from "ajv/dist/runtime/ucs2length";\nimport * as equalRuntime from "ajv/dist/runtime/equal";\n' +
  'const ucs2length = typeof unicodeRuntime.default === "function" ? unicodeRuntime.default : unicodeRuntime.default.default;\n' +
  'const equal = typeof equalRuntime.default === "function" ? equalRuntime.default : equalRuntime.default.default;\n' + code + '\n';
const target = Bun.file(path.join(repo, 'apps/editor/src/lib/mcp/module-ir-validator.generated.js'));
if (process.argv.includes('--write')) await Bun.write(target, generated);
else if ((await target.text()).replace(/\r\n/g, '\n') !== generated) throw Error('Draft validator differs from the pinned Builder schema; regenerate and review');
console.log('SE05_MODULE_SCHEMA_SHA256=' + hash);
