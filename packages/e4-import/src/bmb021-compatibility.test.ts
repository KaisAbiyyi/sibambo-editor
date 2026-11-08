import './bmb021-browser-test-stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { BomcLoader } from './bomc-loader';
import { BomcContainer, crc32 } from './container';

// Repack the exact pinned source sections; only the requested bytes change.
// This is fixture transport, never a substitute semantic reader.
const buffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const root = process.env.BMB021_BUILDER_DIR;
if (!root) throw new Error('BMB021_BUILDER_DIR required');
const fixtures = join(root, 'tests/interop/goldens');
const manifest = JSON.parse(readFileSync(join(fixtures, 'manifest.json'), 'utf8'));
const source = new Uint8Array(readFileSync(join(fixtures, 'floor-front-back.bomc')));
const load = (b: Uint8Array) => new BomcLoader().load(buffer(b), 'bmb021-compatibility.bomc', { prepareSolid: false });
const align = (n: number) => Math.ceil(n / 8) * 8;

async function rewrite(input: Uint8Array, type: number, edit: (raw: Uint8Array) => Uint8Array, compact = true, extras: Array<[number, Uint8Array]> = []) {
  const c = new BomcContainer(buffer(input));
  const entries = [...c.sections.values(), ...extras.map(([type]) => ({ type, flags: 0, count: 0 }))];
  const parts = await Promise.all(entries.map(async e => {
    const raw = extras.find(([type]) => type === e.type)?.[1] ?? (await c.load(e.type))!;
    return e.type === type ? edit(raw.slice()) : raw;
  }));
  const entryBytes = compact ? 24 : 40;
  let offset = align(32 + entries.length * entryBytes);
  const offsets = parts.map(p => { const here = offset; offset = align(offset + p.length); return here; });
  const out = new Uint8Array(offset);
  out.set(input.subarray(0, 32));
  const v = new DataView(out.buffer);
  v.setUint32(20, entries.length, true);
  v.setUint32(16, compact ? c.header.flags | 16 : c.header.flags & ~16, true);
  v.setBigUint64(24, 32n, true);
  entries.forEach((e, i) => {
    const d = 32 + i * entryBytes, raw = parts[i]!;
    v.setUint16(d, e.type, true); out[d + 3] = e.flags;
    if (compact) {
      v.setUint32(d + 4, offsets[i]!, true);
      v.setUint32(d + 8, raw.length, true); v.setUint32(d + 12, raw.length, true);
    } else {
      v.setBigUint64(d + 4, BigInt(offsets[i]!), true);
      v.setBigUint64(d + 12, BigInt(raw.length), true); v.setBigUint64(d + 20, BigInt(raw.length), true);
    }
    v.setUint32(d + (compact ? 16 : 28), e.count, true);
    v.setUint32(d + (compact ? 20 : 32), crc32(raw), true);
    out.set(raw, offsets[i]!);
  });
  return out;
}

describe('BMB-021 directory count is a semantic contract, not a CRC substitute', () => {
  test('all interpreted sections reject count-only tampering in compact and wide directories', async () => {
    const inputs = manifest.fixtures.map((f: { file: string }) => new Uint8Array(readFileSync(join(fixtures, f.file))));
    const rubyDir = process.env.BMB021_RUBY_FIXTURE_DIR;
    if (!rubyDir) throw new Error('Ruby fixture mandatory');
    inputs.push(new Uint8Array(readFileSync(join(rubyDir, 'ruby-producer-synthetic.bomc'))));
    const checked = new Set<number>();
    for (const input of inputs) {
      for (const compact of [true, false]) {
        const valid = await rewrite(input, -1, raw => raw, compact);
        const accepted = await load(valid);
        expect(accepted.diagnostics.coverage.unaccounted).toBe(0);
        const c = new BomcContainer(buffer(valid));
        for (const e of c.sections.values()) {
          if (e.type > 21) continue; // Uninterpreted optional/debug/authoring sections are viewer policy.
          checked.add(e.type);
          const bad = valid.slice();
          const d = c.header.directoryOffset + e.index * c.header.directoryEntryBytes;
          new DataView(bad.buffer).setUint32(d + (compact ? 16 : 28), e.count + 1, true);
          await expect(load(bad), 'section ' + e.type + ' compact=' + compact).rejects.toThrow(/directory.*count/i);
        }
      }
    }
    expect([...checked].sort((a,b) => a-b)).toEqual([1,2,3,4,5,6,7,8,9,11,12,13,17,20]);
  });

  test('legal empty optional sections retain their distinct zero-count rules', async () => {
    const header = (bytes: number, prefix: number[]) => { const raw = new Uint8Array(bytes); raw.set(prefix); return raw; };
    const extras: Array<[number, Uint8Array]> = [
      [10, new Uint8Array()], [14, header(12, [1,1,0,0])],
      [15, header(8, [1,0,0,0])], [16, new Uint8Array()],
      [18, header(8, [1,1,1,1])], [19, header(6, [1,0])], [21, header(8, [1,0,0,0])]
    ];
    for (const compact of [true, false]) {
      const valid = await rewrite(source, -1, raw => raw, compact, extras);
      expect((await load(valid)).counts.faces).toBe(6);
      const c = new BomcContainer(buffer(valid));
      for (const [type] of extras) {
        const e = c.descriptor(type)!;
        const bad = valid.slice();
        new DataView(bad.buffer).setUint32(32 + e.index * c.header.directoryEntryBytes + (compact ? 16 : 28), 1, true);
        await expect(load(bad), 'optional section ' + type).rejects.toThrow(/directory.*count/i);
      }
    }
  });

  test('material v1 and v2 preserve front/back colors, alpha and geometry', async () => {
    const current = await load(source);
    const legacy = await rewrite(source, 3, raw => {
      const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const n = v.getUint32(4, true);
      expect(raw[0]).toBe(2);
      const out = raw.slice(0, raw.length - n * 58);
      out[0] = 1;
      return out;
    });
    const old = await load(legacy);
    expect(old.counts).toEqual(current.counts);
    expect(old.materialRows).toEqual(current.materialRows);
    expect(old.diagnostics.coverage).toEqual(current.diagnostics.coverage);
    const appearance = (value: typeof current) => value.preparedRuntimeScene.groups.map(g => ({
      material: g.materialIndex, side: g.renderSide, rgba: g.baseColorRgba, opacity: g.opacity,
      indices: [...g.indices], matrices: [...g.matrices]
    }));
    expect(appearance(old)).toEqual(appearance(current));
    expect(current.diagnostics.triangleOwnership.explicitBackMaterialFaces).toBeGreaterThan(0);
  });

  test('unsupported and CRC-repaired malformed material payloads fail closed', async () => {
    await load(source); // Positive control rules out vacuous rejection.
    for (const version of [0, 3, 255]) {
      await expect(load(await rewrite(source, 3, raw => { raw[0] = version; return raw; })))
        .rejects.toThrow(/material section version/);
    }
    for (const cut of [0, 1, 7, 8, 25, 64]) {
      await expect(load(await rewrite(source, 3, raw => raw.slice(0, cut)))).rejects.toThrow();
    }
    await expect(load(await rewrite(source, 3, raw => {
      const out = new Uint8Array(raw.length + 1); out.set(raw); return out;
    }))).rejects.toThrow();
    await expect(load(await rewrite(source, 3, raw => { raw[1] = 3; return raw; }))).rejects.toThrow();
    await expect(load(await rewrite(source, 3, raw => {
      new DataView(raw.buffer).setUint32(4, 0xffffffff, true); return raw;
    }))).rejects.toThrow();
  });
});
